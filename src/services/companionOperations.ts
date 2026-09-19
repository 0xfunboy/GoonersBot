import type { AgentRuntimeInput } from './agentRuntime.js';
import type { ToolExecutionContext, ToolExecutionOutput } from '../agent/types.js';
import type { CompanionMemoryService } from '../companion/memory/service.js';
import type { MemoryInput } from '../companion/memory/contracts.js';
import type { IntegrationService } from '../integrations/service.js';
import type { LocalDevelopmentService } from '../capabilities/localDevelopmentService.js';

const arg = (context: ToolExecutionContext, key: string): string | undefined =>
  typeof context.action.args[key] === 'string'
    ? String(context.action.args[key]).trim() || undefined
    : undefined;
const answer = (summary: string, verified = true): ToolExecutionOutput => ({
  summary: summary.slice(0, 12000),
  data: { kind: 'text', text: summary },
  verified,
});

export async function memoryOperation(
  service: CompanionMemoryService | undefined,
  input: AgentRuntimeInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  if (!service) return answer('Memoria personale non disponibile.', false);
  const operation = arg(ctx, 'intent') ?? 'recall';
  if (!['remember', 'recall', 'list', 'correct', 'export', 'forget'].includes(operation))
    return answer('Operazione di memoria non riconosciuta.', false);
  if (['remember', 'correct', 'forget'].includes(operation) && !input.allowWorkflowWrite)
    return answer('Serve una richiesta diretta del titolare per cambiare la memoria.', false);
  const result = await service.execute(
    {
      ownerTelegramId: input.person.telegramId,
      chatId: input.context.chatId,
      telegramTopicId: input.context.threadId ?? null,
    },
    {
      operation: operation as MemoryInput['operation'],
      text: arg(ctx, 'text'),
      query: arg(ctx, 'query') ?? ctx.action.query,
      memoryId: arg(ctx, 'memoryId'),
      projectId: arg(ctx, 'projectId'),
      category: arg(ctx, 'category'),
      all: ctx.action.args['all'] === true || ctx.action.args['all'] === 'true',
    },
    {
      source: 'human',
      messageId: input.context.messageId,
      sourceAt: input.requestTime ? new Date(input.requestTime) : undefined,
      requestKey: input.requestKey
        ? `${input.requestKey}:${ctx.action.requestId ?? ctx.action.id}`
        : undefined,
    },
  );
  if (!result.document) return answer(result.text, !result.clarification);
  return {
    ...answer(result.text),
    data: { kind: 'document', ...result.document },
    artifacts: [
      {
        kind: 'document',
        id: `memory:${ctx.action.id}`,
        mime: result.document.mime,
        label: result.document.name,
      },
    ],
  };
}

/** Destinations and credentials come exclusively from the host; arbitrary model recipients are rejected. */
export async function connectedOperation(
  service: IntegrationService | undefined,
  input: AgentRuntimeInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  if (!service) return answer('Connessione Telegram non disponibile.', false);
  const intent = arg(ctx, 'intent') ?? 'list';
  const owner = input.person.telegramId;
  const connections = await service.descriptors(owner);
  if (intent === 'list')
    return answer(
      connections.length
        ? connections.map((c) => `${c.provider}: ${c.accountId}; scade ${c.expiresAt}`).join('\n')
        : 'Nessuna delega collegata. Sono disponibili metadati, bozze e invii tramite il bot Telegram configurato, non l’account personale.',
    );
  if (!input.allowWorkflowWrite || !input.requestKey)
    return answer('Serve una richiesta diretta con identità verificata.', false);
  const recipient = `telegram:${input.context.chatId}${input.context.threadId !== undefined ? `:${input.context.threadId}` : ''}`;
  const suppliedRecipient = arg(ctx, 'recipient');
  if (suppliedRecipient && suppliedRecipient !== recipient)
    return answer(
      'Questa delega copre solo la conversazione e il topic attuali. Nessun messaggio inviato altrove.',
      false,
    );
  if (intent === 'revoke') {
    const connectionId =
      arg(ctx, 'connectionId') ??
      (connections.length === 1 ? connections[0]!.connectionId : undefined);
    if (!connectionId) return answer('Quale connessione vuoi revocare?', false);
    return answer(
      (await service.revoke(owner, connectionId))
        ? 'Connessione e deleghe revocate.'
        : 'Connessione non trovata.',
      true,
    );
  }
  const operation =
    intent === 'read'
      ? 'chat.read'
      : intent === 'draft'
        ? 'message.draft'
        : intent === 'send'
          ? 'message.send'
          : arg(ctx, 'operation');
  if (!['chat.read', 'message.draft', 'message.send'].includes(operation ?? ''))
    return answer('Specifica lettura, bozza o invio per la delega.', false);
  const expiresAt = new Date(Date.now() + (intent === 'grant' ? 30 * 86_400_000 : 5 * 60_000));
  const connection = await service.connect(owner, {
    provider: 'telegram',
    accountId: 'configured-bot',
    credentialRef: {
      kind: 'secret_store',
      provider: 'environment',
      secretId: 'TELEGRAM_BOT_TOKEN',
    },
    expiresAt: new Date(Date.now() + 31 * 86_400_000),
  });
  // A current explicit request grants only this operation in this immutable destination for five
  // minutes. A reusable 30-day delegation requires a separate semantic grant request.
  const delegation = await service.grant(owner, {
    connectionId: connection.id,
    operation: operation!,
    resource: `chat:${input.context.chatId}`,
    recipient,
    expiresAt: new Date(Math.min(expiresAt.getTime(), connection.expiresAt.getTime())),
  });
  if (intent === 'grant')
    return answer(
      `Delega attiva per ${operation} in questa conversazione fino al ${delegation.expiresAt.toISOString()}. Puoi revocarla chiedendomelo.`,
    );
  const result = await service.execute(
    owner,
    {
      connectionId: connection.id,
      operation: operation!,
      resource: `chat:${input.context.chatId}`,
      recipient,
      input: operation === 'chat.read' ? {} : { text: arg(ctx, 'text') ?? '' },
      requestKey: `${input.requestKey}:${ctx.action.requestId ?? ctx.action.id}`,
    },
    ctx.signal,
  );
  return {
    ...answer(result.summary, result.verified),
    data: { kind: 'text', text: JSON.stringify(result) },
  };
}

export async function codeOperation(
  service: LocalDevelopmentService | undefined,
  input: AgentRuntimeInput,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionOutput> {
  if (!service?.enabled) return answer('Workspace di sviluppo locale non configurato.', false);
  const actor = {
    actorTelegramId: input.person.telegramId,
    chatId: input.context.chatId,
    isGroup: input.context.isGroup,
  };
  const intent = arg(ctx, 'intent') ?? 'status';
  if (['propose', 'cancel'].includes(intent) && !input.allowWorkflowWrite)
    return answer('Serve una richiesta diretta dell’amministratore autorizzato.', false);
  const reference = arg(ctx, 'id');
  if (intent === 'diff') {
    const job = await service.status(actor, reference);
    if (!job) return answer('Non trovo un lavoro di codice in questo ambito.', false);
    const result = await service.diff(actor, job.id);
    return {
      summary: `Patch ${job.id}, revisione ${job.revision}; stato ${job.state}. Non è un deploy.`,
      verified: true,
      data: {
        kind: 'document',
        buffer: Buffer.from(result.artifact.text),
        mime: 'text/x-diff',
        name: 'modifica.patch',
      },
      artifacts: [
        {
          kind: 'document',
          id: `patch:${job.id}:${result.artifact.hash}`,
          mime: 'text/x-diff',
          label: 'modifica.patch',
        },
      ],
    };
  }
  if (intent === 'cancel' && !reference)
    return answer('Rispondi al lavoro da annullare o indica quello desiderato.', false);
  const job =
    intent === 'propose'
      ? await service.enqueue(actor, ctx.action.query ?? input.request)
      : intent === 'cancel'
        ? await service.cancel(actor, reference!)
        : await service.status(actor, reference);
  return answer(
    job
      ? `${job.goal}\nStato: ${job.state}; revisione ${job.revision}. ${job.checks.map((c) => `${c.id}: ${c.status}`).join('; ')}\nIl worker prepara e verifica la patch. Applicazione e deploy non sono automatici.`
      : 'Nessun lavoro di codice trovato.',
    Boolean(job),
  );
}
