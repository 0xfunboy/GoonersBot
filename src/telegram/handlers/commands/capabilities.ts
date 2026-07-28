import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

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
        capabilities: installed
          .map(
            (item) => `/<code>${escapeHtml(item.command)}</code> — ${escapeHtml(item.description)}`,
          )
          .join('\n'),
      },
    };
  },
};

/**
 * /learn <capability> - bot-admin-only capability acquisition. Capability Forge itself keeps the
 * safety boundary: generated executable code is never run; low-risk research recipes can become
 * durable slash commands and integrations requiring credentials remain explicit proposals.
 */
export const learnCommand: CommandSpec = {
  command: 'learn',
  permissions: ['bot_admin', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.ADMIN,
  adminOnly: true,
  quotaConversation: true,
  async handle({ services, person, context, args }) {
    const request = args.join(' ').trim();
    if (!request) return { text: 'learn_usage' };
    const language = await services.getLanguage(context.chatId);
    const plan = await services.planForTurn(person, context);
    const learned = await services.capabilities.acquire({
      request,
      language,
      allowInstall: true,
      ...(services.bypassesGroupPlan(person, context) ? {} : { chatId: context.chatId }),
      ...(services.modelForPlan(plan) ? { model: services.modelForPlan(plan) } : {}),
    });
    const installed =
      learned.installed && learned.command
        ? `\n\n✅ /<code>${escapeHtml(learned.command)}</code>`
        : '';
    const sources =
      learned.sources.length > 0
        ? `\n\n${learned.sources
            .slice(0, 5)
            .map((source, index) => `${index + 1}. ${escapeHtml(source)}`)
            .join('\n')}`
        : '';
    return { rawText: `${escapeHtml(learned.text)}${installed}${sources}`.slice(0, 4000) };
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
