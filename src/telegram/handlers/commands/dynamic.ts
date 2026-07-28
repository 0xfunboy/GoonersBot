import type { CapabilityExecution } from '../../../capabilities/types.js';
import type { ChatContext, Person } from '../../../domain/types.js';
import { runWithGroupPlan } from '../../../providers/llm/requestContext.js';
import type { Services } from '../../../services/index.js';
import type { QuotaDenyReason } from '../../../services/groupQuota.js';

export type DynamicCapabilityTurnResult =
  | { status: 'not_found' }
  | { status: 'usage_denied'; limit: number }
  | { status: 'quota_denied'; reason: QuotaDenyReason | 'limit'; retryAfterSeconds: number }
  | { status: 'completed'; execution: CapabilityExecution };

/** Dynamic routes use the exact same per-chat/per-user cooldown key as static commands. */
export function tryAcquireDynamicCommandRateLimit(
  services: Pick<Services, 'commandRateLimit'>,
  chatId: number,
  telegramId: number,
): boolean {
  return services.commandRateLimit.tryAcquire(`${chatId}:${telegramId}`);
}

/**
 * Execute one installed capability through the normal request accounting boundary.
 *
 * CapabilityForge accounts for its own web-search resource reservations. This wrapper adds the
 * conversational admission, monthly per-user ledger and daily group token settlement that a
 * normal addressed request receives. A reserved token estimate is always released, including
 * provider failures.
 */
export async function executeDynamicCapabilityTurn(params: {
  services: Services;
  person: Person;
  context: ChatContext;
  command: string;
  input: string;
  language: string;
}): Promise<DynamicCapabilityTurnResult> {
  const { services, person, context } = params;
  if (!services.capabilities.hasCommand(params.command)) return { status: 'not_found' };

  if (!(await services.usage.isUnderLimit(person.userHandle, params.input, false, false))) {
    return { status: 'usage_denied', limit: await services.usage.getLimit(person.userHandle) };
  }

  const bypassGroupPlan = services.bypassesGroupPlan(person, context);
  const admission = bypassGroupPlan
    ? { allowed: true as const, tokenReservation: 0 }
    : await services.quota.admitConversation({
        chatId: context.chatId,
        telegramId: person.telegramId,
        passive: false,
        reserveTokens: true,
      });
  if (!admission.allowed) {
    return {
      status: 'quota_denied',
      reason: admission.reason ?? 'limit',
      retryAfterSeconds: admission.retryAfterSeconds ?? 0,
    };
  }

  let actualTokens = 0;
  try {
    const plan = await services.planForTurn(person, context);
    const execution = await runWithGroupPlan(plan.id, () =>
      services.capabilities.executeCommand({
        command: params.command,
        input: params.input,
        language: params.language,
        ...(bypassGroupPlan ? {} : { chatId: context.chatId }),
        ...(services.modelForPlan(plan) ? { model: services.modelForPlan(plan) } : {}),
      }),
    );
    if (!execution) return { status: 'not_found' };

    actualTokens = execution.usage.inputTokens + execution.usage.outputTokens;
    await services.usage.record({
      handle: person.userHandle,
      chatId: context.chatId,
      provider: services.llm.name,
      model: execution.model,
      inputTokens: execution.usage.inputTokens,
      outputTokens: execution.usage.outputTokens,
      estimatedTokens: execution.usage.estimated ? actualTokens : 0,
      imageCalls: 0,
      transcriptionCalls: 0,
      visionCalls: 0,
      points: actualTokens,
      costEstimate: 0,
    });
    return { status: 'completed', execution };
  } finally {
    if (!bypassGroupPlan) {
      await services.quota.recordLlmTokens(
        context.chatId,
        actualTokens,
        admission.tokenReservation ?? 0,
      );
    }
  }
}
