import type { NsfwMode } from '../../../domain/entities.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/**
 * /nsfw [off|base|smart|on] — admin control of NSFW model routing for this chat.
 *   off   : never use the NSFW model (default)
 *   base  : the whole chat uses the NSFW model
 *   smart : per-message routing (lexicon decides; refusal backstop armed)
 *   on    : alias for base
 * With no argument, reports the current mode.
 */
export const nsfwCommand: CommandSpec = {
  command: 'nsfw',
  permissions: ['group_admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, args }) {
    if (!services.modelRouter.nsfwConfigured) {
      return { text: 'nsfw_unavailable' };
    }
    const arg = (args[0] ?? '').toLowerCase();
    if (arg === '') {
      const current = await services.storage.chats.getNsfwMode(
        context.chatId,
        services.config.env.LLM_NSFW_DEFAULT_MODE,
      );
      return { text: 'nsfw_status', vars: { mode: current } };
    }
    const map: Record<string, NsfwMode> = {
      off: 'off',
      base: 'base',
      on: 'base',
      smart: 'smart',
    };
    const mode = map[arg];
    if (!mode) return { text: 'nsfw_invalid' };
    await services.storage.chats.setNsfwMode(context.chatId, mode);
    return { text: `nsfw_set_${mode}` };
  },
};
