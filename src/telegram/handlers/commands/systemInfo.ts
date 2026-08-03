import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';
import type { SystemInfoScope } from '../../../services/systemInfo.js';

const HOST_DEFAULT_SCOPES = ['hardware', 'sensors', 'storage'] as const;

/** /hardware [cpu|sensori|dischi|tutto] - live, privacy-filtered host facts. */
export const hardwareCommand: CommandSpec = {
  command: 'hardware',
  aliases: ['systeminfo', 'sysinfo', 'specs'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, person, context, args }: HandlerInput) {
    return {
      rawText: await services.systemInfo.report({
        chatId: context.chatId,
        scopes: hostScopesFromArgs(args),
        operatorSession: services.bypassesGroupPlan(person, context),
      }),
      textFormat: 'plain',
    };
  },
};

/** /models - configured model identifiers only; endpoints and credentials never leave config. */
export const modelsCommand: CommandSpec = {
  command: 'models',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, person, context }: HandlerInput) {
    return {
      rawText: await services.systemInfo.report({
        chatId: context.chatId,
        scopes: ['models'],
        operatorSession: services.bypassesGroupPlan(person, context),
      }),
      textFormat: 'plain',
    };
  },
};

/** /quota - current internal group counters; it does not spend a conversational turn. */
export const quotaCommand: CommandSpec = {
  command: 'quota',
  aliases: ['quotas'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, person, context }: HandlerInput) {
    return {
      rawText: await services.systemInfo.report({
        chatId: context.chatId,
        scopes: ['quota'],
        operatorSession: services.bypassesGroupPlan(person, context),
      }),
      textFormat: 'plain',
    };
  },
};

/** /botinfo - stable project identity; operational secrets are deliberately absent. */
export const botinfoCommand: CommandSpec = {
  command: 'botinfo',
  aliases: ['aboutbot'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, context }: HandlerInput) {
    const language = await services.getLanguage(context.chatId);
    return {
      rawText:
        services.localizer.t('botinfo_text', {}, language) ??
        'GoonersBot / GooNeuroBot — created and maintained by funboy, written in strict TypeScript for Node.js ESM. GemRouter is the model gateway managed by funboy.',
      textFormat: 'plain',
    };
  },
};

export function hostScopesFromArgs(args: readonly string[]): SystemInfoScope[] {
  if (args.length === 0) return [...HOST_DEFAULT_SCOPES];
  const text = args.join(' ').toLowerCase();
  if (/\b(?:tutto|all|completo|full)\b/.test(text)) return [...HOST_DEFAULT_SCOPES];
  const scopes: SystemInfoScope[] = [];
  if (/\b(?:cpu|ram|memory|memoria|gpu|componenti?|hardware|scheda)\b/.test(text)) {
    scopes.push('hardware');
  }
  if (/\b(?:temp|temperatur\w*|sensori?|sensors?|ventol\w*|fans?|rpm)\b/.test(text)) {
    scopes.push('sensors');
  }
  if (/\b(?:dischi?|disks?|storage|spazio|filesystem|ssd|hdd|nvme)\b/.test(text)) {
    scopes.push('storage');
  }
  return scopes.length > 0 ? scopes : [...HOST_DEFAULT_SCOPES];
}
