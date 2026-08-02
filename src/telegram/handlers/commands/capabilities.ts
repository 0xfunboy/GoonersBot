import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { trustedHtml } from '../../../config/i18n.js';

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
    if (/^(?:status|stato)$/i.test(request)) {
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
        ].join('\n'),
        textFormat: 'html',
      };
    }
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
    const sources =
      learned.sources.length > 0
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

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
