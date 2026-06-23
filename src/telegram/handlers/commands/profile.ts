import type { CommandResponse } from '../../../domain/types.js';
import { isQuotaPlanId } from '../../../quota/plans.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/** /profile [free|plus|pro] - show or change the resource plan for this group. */
export const profileCommand: CommandSpec = {
  command: 'profile',
  aliases: ['plan', 'piano', 'groupplan', 'groupquota'],
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }: HandlerInput): Promise<CommandResponse> {
    const language = await services.getLanguage(context.chatId);
    if (!context.isGroup) {
      return {
        rawText: services.localizer.t('profile_group_only', {}, language) ?? 'profile_group_only',
      };
    }
    const requested = args[0]?.toLowerCase();
    if (requested && !isQuotaPlanId(requested)) {
      return { rawText: services.localizer.t('profile_usage', {}, language) ?? 'profile_usage' };
    }
    const report = requested
      ? await setRequestedPlan(services, context.chatId, requested)
      : await services.quota.getReport(context.chatId);
    return { rawText: formatReport(services, language, report, Boolean(requested)) };
  },
};

function formatReport(
  services: HandlerInput['services'],
  language: string,
  report: Awaited<ReturnType<HandlerInput['services']['quota']['getReport']>>,
  changed: boolean,
): string {
  const p = report.plan;
  const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;
  const titleKey = changed ? 'profile_set_title' : 'profile_current_title';
  const title = services.localizer.t(titleKey, {}, language) ?? titleKey;
  return (
    services.localizer.t(
      'profile_report',
      {
        title,
        plan: p.id.toUpperCase(),
        conversations_day: report.daily.conversations,
        conversations_limit: p.conversationDaily,
        conversations_hour: report.hourly.conversations,
        conversations_hour_limit: p.conversationHourly,
        conversations_remaining: remaining(p.conversationDaily, report.daily.conversations),
        conversations_hour_remaining: remaining(p.conversationHourly, report.hourly.conversations),
        tokens: report.daily.llmTokens,
        tokens_limit: p.llmTokensDaily,
        tokens_remaining: remaining(p.llmTokensDaily, report.daily.llmTokens),
        web: report.daily.webSearches,
        web_limit: p.webSearchDaily,
        web_remaining: remaining(p.webSearchDaily, report.daily.webSearches),
        pages: report.daily.pageScans,
        pages_limit: p.pageScanDaily,
        pages_remaining: remaining(p.pageScanDaily, report.daily.pageScans),
        news: report.daily.news,
        news_limit: p.newsDaily,
        news_remaining: remaining(p.newsDaily, report.daily.news),
        images: report.daily.images,
        images_limit: p.imagesDaily,
        images_remaining: remaining(p.imagesDaily, report.daily.images),
        media: report.daily.media,
        media_limit: p.mediaDaily,
        media_remaining: remaining(p.mediaDaily, report.daily.media),
        media_mb: mb(report.daily.mediaBytes),
        media_mb_limit: mb(p.mediaBytesDaily),
        media_mb_remaining: mb(remaining(p.mediaBytesDaily, report.daily.mediaBytes)),
        passive: report.hourly.passiveReplies,
        passive_limit: p.passiveHourly,
        passive_remaining: remaining(p.passiveHourly, report.hourly.passiveReplies),
        user_burst: p.antiFlood.userBurstPerMinute,
        chat_burst: p.antiFlood.chatBurstPerMinute,
      },
      language,
    ) ?? 'profile_report'
  );
}

function remaining(limit: number, used: number): number {
  return Math.max(0, limit - used);
}

async function setRequestedPlan(services: HandlerInput['services'], chatId: number, plan: string) {
  if (!isQuotaPlanId(plan)) throw new Error('validated quota plan became invalid');
  return services.quota.setPlan(chatId, plan);
}
