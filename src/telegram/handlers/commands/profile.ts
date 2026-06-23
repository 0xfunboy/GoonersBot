import type { CommandResponse } from '../../../domain/types.js';
import { isQuotaPlanId } from '../../../quota/plans.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/** /profile [free|plus|pro] - show or change the resource plan for this group. */
export const profileCommand: CommandSpec = {
  command: 'profile',
  aliases: ['plan', 'piano'],
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse> {
    if (!context.isGroup) {
      return { rawText: 'Questo comando si usa in un gruppo.' };
    }
    const requested = args[0]?.toLowerCase();
    if (requested && !isQuotaPlanId(requested)) {
      return { rawText: 'Uso: /profile free | plus | pro' };
    }
    const report = requested
      ? await setRequestedPlan(services, context.chatId, requested)
      : await services.quota.getReport(context.chatId);
    return { rawText: formatReport(report, Boolean(requested)) };
  },
};

function formatReport(
  report: Awaited<ReturnType<HandlerInput['services']['quota']['getReport']>>,
  changed: boolean,
): string {
  const p = report.plan;
  const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
  return [
    changed
      ? `Profilo gruppo impostato: ${p.id.toUpperCase()}`
      : `Profilo gruppo: ${p.id.toUpperCase()}`,
    `Conversazioni: ${report.daily.conversations}/${p.conversationDaily} oggi, ${report.hourly.conversations}/${p.conversationHourly} ora`,
    `Token LLM: ${report.daily.llmTokens}/${p.llmTokensDaily} oggi`,
    `Web: ${report.daily.webSearches}/${p.webSearchDaily} | pagine: ${report.daily.pageScans}/${p.pageScanDaily}`,
    `News: ${report.daily.news}/${p.newsDaily} | immagini: ${report.daily.images}/${p.imagesDaily}`,
    `Media: ${report.daily.media}/${p.mediaDaily}, ${mb(report.daily.mediaBytes)}/${mb(p.mediaBytesDaily)}`,
    `Passive: ${report.hourly.passiveReplies}/${p.passiveHourly} ora`,
    `Anti-flood: utente ${p.antiFlood.userBurstPerMinute}/min, chat ${p.antiFlood.chatBurstPerMinute}/min`,
  ].join('\n');
}

async function setRequestedPlan(services: HandlerInput['services'], chatId: number, plan: string) {
  if (!isQuotaPlanId(plan)) throw new Error('validated quota plan became invalid');
  return services.quota.setPlan(chatId, plan);
}
