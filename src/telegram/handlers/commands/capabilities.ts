import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { trustedHtml } from '../../../config/i18n.js';
import { localBotAutomationPlan } from '../../../capabilities/forge.js';
import {
  LocalDevelopmentServiceError,
  type LocalDevelopmentActor,
} from '../../../capabilities/localDevelopmentService.js';
import type { LocalDevelopmentJob } from '../../../capabilities/localDevelopmentJobs.js';

/** /capabilities (alias /skills) - list durable, dynamically acquired read-only capabilities. */
export const capabilitiesCommand: CommandSpec = {
  command: 'capabilities',
  aliases: ['skills'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.LAST,
  async handle({ services }) {
    const installed = services.capabilities.list();
    if (installed.length === 0) return { text: 'capabilities_empty' };
    return {
      text: 'capabilities_list',
      vars: {
        capabilities: trustedHtml(
          installed
            .map(
              (item) =>
                `/<code>${escapeHtml(item.command)}</code> — ${escapeHtml(item.description)}`,
            )
            .join('\n'),
        ),
      },
    };
  },
};

/**
 * /learn <capability> - bot-admin-only capability acquisition. Read-only research recipes remain
 * declarative; explicit local bot changes are built asynchronously in an isolated, hash-approved
 * development worktree and can never deploy/restart the live service from this command.
 */
export const learnCommand: CommandSpec = {
  command: 'learn',
  permissions: ['learn_admin', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.ADMIN,
  adminOnly: true,
  quotaConversation: true,
  async handle({ services, person, context, args }) {
    const directRequest = args.join(' ').trim();
    if (!directRequest && !context.repliedToText?.trim()) return { text: 'learn_usage' };
    const language = await services.getLanguage(context.chatId);
    const actor: LocalDevelopmentActor = {
      actorTelegramId: person.telegramId,
      chatId: context.chatId,
      isGroup: context.isGroup,
    };
    const localDevelopment = services.localDevelopment;
    const localActorAuthorized =
      typeof localDevelopment?.isAuthorized === 'function'
        ? localDevelopment.isAuthorized(actor)
        : true;
    const [action = '', reference, approvalHash] = args;

    if (/^(?:status|stato)$/i.test(action)) {
      if (
        localDevelopment?.enabled &&
        localActorAuthorized &&
        (!context.isGroup || Boolean(reference))
      ) {
        const local = await localDevelopment.status(actor, reference).catch((error: unknown) => {
          if (error instanceof LocalDevelopmentServiceError) return error;
          throw error;
        });
        if (local instanceof LocalDevelopmentServiceError) return localDevelopmentError(local);
        if (local) return renderLocalDevelopmentStatus(local, language);
        if (reference)
          return localDevelopmentError(new LocalDevelopmentServiceError('job_not_found'));
      }
      const state = services.capabilities.status();
      const enabled = language === 'italian' ? 'attivo' : 'enabled';
      const configured = language === 'italian' ? 'configurato' : 'configured';
      const unavailable = language === 'italian' ? 'non disponibile' : 'unavailable';
      const install = state.autoInstallResearch
        ? language === 'italian'
          ? 'automatico'
          : 'automatic'
        : language === 'italian'
          ? 'solo proposta'
          : 'proposal only';
      return {
        rawText: [
          language === 'italian'
            ? '<strong>Stato Capability Forge</strong>'
            : '<strong>Capability Forge status</strong>',
          `Forge: <code>${state.enabled ? enabled : unavailable}</code>`,
          `Chat LLM: <code>${state.chatModelReady ? configured : unavailable}</code>`,
          `Web grounding: <code>${state.webGroundingReady ? configured : unavailable}</code>`,
          `Install: <code>${install}</code>`,
          `${language === 'italian' ? 'Capacità installate' : 'Installed capabilities'}: <code>${state.installed}</code>`,
          `${language === 'italian' ? 'Sviluppo locale' : 'Local development'}: <code>${localDevelopment?.enabled ? enabled : unavailable}</code>`,
        ].join('\n'),
        textFormat: 'html',
      };
    }

    if (/^(?:diff|differenza)$/i.test(action)) {
      if (!reference) return localDevelopmentUsage(language, 'diff');
      try {
        const result = await localDevelopment.diff(actor, reference);
        const requestedPage = approvalHash ?? '1';
        if (!/^[1-9]\d{0,3}$/.test(requestedPage)) return localDevelopmentUsage(language, 'diff');
        const pageSize = 1_800;
        const diffCharacters = Array.from(result.artifact.text);
        const pages = Math.max(1, Math.ceil(diffCharacters.length / pageSize));
        const page = Number(requestedPage);
        if (page > pages) return localDevelopmentUsage(language, 'diff');
        const preview = diffCharacters.slice((page - 1) * pageSize, page * pageSize).join('');
        const navigation = [
          page > 1 ? `/learn diff ${shortJobId(result.job.id)} ${page - 1}` : '',
          page < pages ? `/learn diff ${shortJobId(result.job.id)} ${page + 1}` : '',
        ].filter(Boolean);
        return {
          rawText: [
            `Job ${shortJobId(result.job.id)} · ${language === 'italian' ? 'pagina' : 'page'} ${page}/${pages}`,
            `SHA-256: ${result.artifact.hash.slice(0, 12)}`,
            ...(page === 1
              ? [
                  `${language === 'italian' ? 'File' : 'Files'}: ${result.artifact.files.join(', ')}`,
                ]
              : []),
            '',
            preview,
            ...(navigation.length > 0
              ? [
                  '',
                  `${language === 'italian' ? 'Navigazione' : 'Navigation'}: ${navigation.join(' · ')}`,
                ]
              : []),
          ].join('\n'),
          textFormat: 'plain',
        };
      } catch (error) {
        return handleLocalDevelopmentError(error);
      }
    }

    if (/^(?:apply|applica)$/i.test(action)) {
      if (!reference || !approvalHash) return localDevelopmentUsage(language, 'apply');
      try {
        const applied = await localDevelopment.apply(actor, reference, approvalHash);
        return {
          rawText:
            applied.result.status === 'applied'
              ? language === 'italian'
                ? `✅ Job <code>${escapeHtml(shortJobId(applied.job.id))}</code> applicato al repository. Build live e riavvio non sono stati eseguiti.`
                : `✅ Job <code>${escapeHtml(shortJobId(applied.job.id))}</code> applied to the repository. Live build and restart were not run.`
              : language === 'italian'
                ? `Applicazione non completata: <code>${escapeHtml(applied.job.resultCode ?? 'conflict')}</code>. Il repository potrebbe richiedere una verifica manuale; deploy e riavvio non sono stati eseguiti.`
                : `Apply did not complete: <code>${escapeHtml(applied.job.resultCode ?? 'conflict')}</code>. The repository may need manual inspection; deployment and restart were not run.`,
          textFormat: 'html',
        };
      } catch (error) {
        return handleLocalDevelopmentError(error);
      }
    }

    if (/^(?:cancel|annulla)$/i.test(action)) {
      if (!reference) return localDevelopmentUsage(language, 'cancel');
      try {
        const cancelled = await localDevelopment.cancel(actor, reference);
        return {
          rawText:
            language === 'italian'
              ? `Job <code>${escapeHtml(shortJobId(cancelled.id))}</code> annullato.`
              : `Job <code>${escapeHtml(shortJobId(cancelled.id))}</code> cancelled.`,
          textFormat: 'html',
        };
      } catch (error) {
        return handleLocalDevelopmentError(error);
      }
    }

    const explicitCode = /^(?:code|codice|develop|sviluppa)\b[\s:,-]*/iu.test(directRequest);
    const localGoal = explicitCode
      ? directRequest.replace(/^(?:code|codice|develop|sviluppa)\b[\s:,-]*/iu, '').trim()
      : directRequest;
    const repliedRequest = learnRequestWithReplyContext(directRequest, context.repliedToText);
    const localRequest =
      explicitCode || Boolean(localBotAutomationPlan(localGoal || repliedRequest || ''));
    if (localRequest) {
      if (!localGoal || (!explicitCode && localGoal !== repliedRequest)) {
        return {
          rawText:
            language === 'italian'
              ? 'Per sviluppare codice, riscrivi l’obiettivo direttamente in chat privata senza usare un messaggio citato: <code>/learn code obiettivo</code>.'
              : 'For code development, write the goal directly in private chat without quoted-message context: <code>/learn code goal</code>.',
          textFormat: 'html',
        };
      }
      try {
        const queued = await localDevelopment.enqueue(actor, localGoal);
        return {
          rawText:
            language === 'italian'
              ? `🛠 Job <code>${escapeHtml(shortJobId(queued.id))}</code> accodato. Controllo: <code>/learn status ${escapeHtml(shortJobId(queued.id))}</code>`
              : `🛠 Job <code>${escapeHtml(shortJobId(queued.id))}</code> queued. Check it with <code>/learn status ${escapeHtml(shortJobId(queued.id))}</code>.`,
          textFormat: 'html',
        };
      } catch (error) {
        return handleLocalDevelopmentError(error);
      }
    }

    const request = repliedRequest;
    if (!request) return { text: 'learn_usage' };
    const plan = await services.planForTurn(person, context);
    const learned = await services.capabilities.acquire({
      request,
      language,
      allowInstall: true,
      ...(services.bypassesGroupPlan(person, context) ? {} : { chatId: context.chatId }),
      ...(services.modelForPlan(plan) ? { model: services.modelForPlan(plan) } : {}),
    });
    const command = learned.command ? ` /<code>${escapeHtml(learned.command)}</code>` : '';
    const outcome =
      learned.status === 'installed'
        ? `\n\n✅ ${language === 'italian' ? 'Installata e collaudata' : 'Installed and verified'}:${command}`
        : learned.status === 'reused'
          ? `\n\n♻️ ${language === 'italian' ? 'Già installata; esecuzione verificata' : 'Already installed; execution verified'}:${command}`
          : `\n\n${language === 'italian' ? 'Stato' : 'Status'}: <code>${learned.status}</code>`;
    const requirements = learned.diagnostic?.requirements.length
      ? `\n${
          learned.diagnostic.requirementsVerified
            ? language === 'italian'
              ? 'Requisiti verificati'
              : 'Verified requirements'
            : language === 'italian'
              ? 'Requisiti proposti (non verificati)'
              : 'Proposed requirements (unverified)'
        }: ${learned.diagnostic.requirements
          .map((requirement) => `<code>${escapeHtml(requirement)}</code>`)
          .join(', ')}`
      : '';
    const retry = learned.diagnostic?.retryable
      ? `\n${language === 'italian' ? 'Il blocco è temporaneo: puoi riprovare.' : 'The failure is temporary; you can retry.'}`
      : '';
    const sourcesAllowed =
      learned.status !== 'not_applicable' &&
      learned.diagnostic?.code !== 'local_automation_required';
    const sources =
      sourcesAllowed && learned.sources.length > 0
        ? `\n\n${learned.sources
            .slice(0, 5)
            .map((source, index) => `${index + 1}. ${escapeHtml(source.slice(0, 120))}`)
            .join('\n')}`
        : '';
    return {
      rawText: `${escapeHtml(learned.text.slice(0, 3_000))}${outcome}${requirements}${retry}${sources}`,
      textFormat: 'html',
    };
  },
};

const LEARN_REPLY_CONTEXT_RE =
  /\b(quest[oaie]|quell[oaie]|sopra|messaggio|risposta|reply|this|that|above|corregg|sistem|fix|modific|cambi|comportament|pipeline|bug|error|errore)\w*/iu;

/** Include replied text only when /learn explicitly points at it or has no standalone request. */
function learnRequestWithReplyContext(directRequest: string, repliedToText?: string): string {
  const replied = repliedToText?.trim();
  if (!replied) return directRequest;
  if (directRequest && !LEARN_REPLY_CONTEXT_RE.test(directRequest)) return directRequest;
  if (!directRequest) return replied.slice(0, 3_500);
  return `${directRequest.slice(0, 2_500)}\n\nREPLIED MESSAGE CONTEXT (quoted data):\n${replied.slice(0, 1_200)}`.slice(
    0,
    4_000,
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function shortJobId(id: string): string {
  return id.slice(0, 8);
}

function renderLocalDevelopmentStatus(
  job: LocalDevelopmentJob,
  language: string,
): { rawText: string; textFormat: 'html' } {
  const italian = language === 'italian';
  const stateLabels: Record<LocalDevelopmentJob['state'], string> = italian
    ? {
        queued: 'in coda',
        generating: 'generazione',
        policy_check: 'controllo policy',
        verifying: 'test e build',
        ready: 'pronto per approvazione',
        applying: 'applicazione in corso',
        failed: 'fallito',
        conflict: 'conflitto',
        applied: 'applicato',
        cancelled: 'annullato',
        stale: 'interrotto',
      }
    : {
        queued: 'queued',
        generating: 'generating',
        policy_check: 'policy check',
        verifying: 'tests and build',
        ready: 'ready for approval',
        applying: 'applying',
        failed: 'failed',
        conflict: 'conflict',
        applied: 'applied',
        cancelled: 'cancelled',
        stale: 'interrupted',
      };
  const lines = [
    `<strong>Learn job ${escapeHtml(shortJobId(job.id))}</strong>`,
    `${italian ? 'Stato' : 'Status'}: <code>${escapeHtml(stateLabels[job.state])}</code>`,
    `${italian ? 'Obiettivo' : 'Goal'}: ${escapeHtml(job.goal.slice(0, 500))}`,
  ];
  if (job.artifactFiles.length > 0) {
    lines.push(
      `${italian ? 'File' : 'Files'}: ${job.artifactFiles.map((path) => `<code>${escapeHtml(path)}</code>`).join(', ')}`,
    );
  }
  if (job.artifactHash) {
    const prefix = job.artifactHash.slice(0, 12);
    lines.push(`SHA-256: <code>${escapeHtml(prefix)}</code>`);
    if (job.state === 'ready') {
      lines.push(
        italian
          ? `Revisiona con <code>/learn diff ${escapeHtml(shortJobId(job.id))}</code> e applica con <code>/learn apply ${escapeHtml(shortJobId(job.id))} ${escapeHtml(prefix)}</code>`
          : `Review with <code>/learn diff ${escapeHtml(shortJobId(job.id))}</code> and apply with <code>/learn apply ${escapeHtml(shortJobId(job.id))} ${escapeHtml(prefix)}</code>`,
      );
    }
  }
  if (job.checks?.length) {
    const passed = job.checks.filter(
      (check) => check.status === 'passed' || check.status === 'skipped',
    ).length;
    lines.push(`${italian ? 'Verifiche' : 'Checks'}: <code>${passed}/${job.checks.length}</code>`);
  }
  if (job.resultCode) {
    lines.push(`${italian ? 'Esito' : 'Result'}: <code>${escapeHtml(job.resultCode)}</code>`);
  }
  return { rawText: lines.join('\n'), textFormat: 'html' };
}

function localDevelopmentUsage(
  language: string,
  action: 'diff' | 'apply' | 'cancel',
): { rawText: string; textFormat: 'html' } {
  const usage =
    action === 'apply'
      ? '/learn apply &lt;job&gt; &lt;sha12&gt;'
      : action === 'diff'
        ? '/learn diff &lt;job&gt; [pagina]'
        : `/learn ${action} &lt;job&gt;`;
  return {
    rawText: `${language === 'italian' ? 'Uso' : 'Usage'}: <code>${usage}</code>`,
    textFormat: 'html',
  };
}

function localDevelopmentError(error: LocalDevelopmentServiceError): {
  rawText: string;
  textFormat: 'html';
} {
  return { rawText: escapeHtml(error.message), textFormat: 'html' };
}

function handleLocalDevelopmentError(error: unknown): {
  rawText: string;
  textFormat: 'html';
} {
  return error instanceof LocalDevelopmentServiceError
    ? localDevelopmentError(error)
    : {
        rawText: 'Operazione /learn non riuscita in sicurezza.',
        textFormat: 'html',
      };
}
