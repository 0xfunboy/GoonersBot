import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { normalizeHandle } from '../../../utils/handles.js';

/**
 * /introduce <text> - save the caller's self-introduction as durable lore (role).
 */
export const introduceCommand: CommandSpec = {
  command: 'introduce',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const introduction = args.join(' ').trim();
    if (introduction.length === 0) return { text: 'inappropriate_introduction' };
    const ok = await services.lore.addManual({
      chatId: context.chatId,
      subjectHandle: person.userHandle,
      text: introduction,
      createdByHandle: person.userHandle,
    });
    if (!ok) return { text: 'inappropriate_introduction' };
    return { text: 'introduction_added', vars: { user_handle: person.userHandle } };
  },
};

/**
 * /fact - mine durable lore from recent chat (or the replied-to window). Normal users can no
 * longer inject arbitrary memory (anti-poisoning); the bot extracts it from real context.
 */
export const factCommand: CommandSpec = {
  command: 'fact',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const env = services.config.env;
    const language = await services.getLanguage(context.chatId);
    const nsfwEnabled =
      (await services.storage.chats.getNsfwMode(context.chatId, env.LLM_NSFW_DEFAULT_MODE)) !==
      'off';

    const messages = context.repliedToMessageId
      ? await services.conversation.getWindowAroundMessage(
          context.chatId,
          context.repliedToMessageId,
          env.FACT_REPLY_CONTEXT_BEFORE,
          env.FACT_REPLY_CONTEXT_AFTER,
        )
      : await services.conversation.getRecent(context.chatId, env.FACT_EXTRACTION_CONTEXT_MESSAGES);

    if (messages.length === 0) return { text: 'fact_mined_none' };

    const res = await services.lore.mineAndStore({
      chatId: context.chatId,
      messages,
      language,
      nsfwEnabled,
      minConfidence: env.MEMORY_MANUAL_MIN_CONFIDENCE,
      source: 'manual_extract',
      createdByHandle: null,
    });
    if (res.stored === 0 && res.reinforced === 0) return { text: 'fact_mined_none' };
    return { text: 'fact_mined', vars: { stored: res.stored, reinforced: res.reinforced } };
  },
};

/**
 * /setfact @handle <text> | /setfact <group lore> - admin-only manual memory insertion.
 */
export const setfactCommand: CommandSpec = {
  command: 'setfact',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context, person, args }) {
    const hasHandle = args[0]?.startsWith('@') ?? false;
    const target = hasHandle ? normalizeHandle(args[0] as string) : null;
    const text = (hasHandle ? args.slice(1) : args).join(' ').trim();
    if (text.length === 0) return { text: 'setfact_usage' };
    const ok = await services.lore.addManual({
      chatId: context.chatId,
      subjectHandle: target,
      text,
      createdByHandle: person.userHandle,
    });
    if (!ok) return { text: 'inappropriate_fact' };
    return { text: 'setfact_added', vars: { user_handle: target ?? 'group' } };
  },
};

/** /facts [@handle] - show stored memory for a subject (reads memory_items). */
export const factsCommand: CommandSpec = {
  command: 'facts',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const target = args[0] ? normalizeHandle(args[0]) : person.userHandle;
    const items = await services.lore.listForSubject(context.chatId, target);
    if (items.length === 0) {
      const empty: CommandResponse = { text: 'user_facts_empty', vars: { user_handle: target } };
      return empty;
    }
    const resp: CommandResponse = {
      text: 'user_facts',
      vars: { user_handle: target, facts: items.map((i) => i.text).join('\n- ') },
    };
    return resp;
  },
};

/** /clearfacts [@handle] - expire stored memory (self anytime; others require admin). */
export const clearfactsCommand: CommandSpec = {
  command: 'clearfacts',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const target = args[0] ? normalizeHandle(args[0]) : person.userHandle;
    const isSelf = target === person.userHandle;
    const isAdmin = context.isGroupAdmin || services.permissions.isBotAdmin(person.userHandle);
    if (!isSelf && !isAdmin) return { text: 'clearfacts_forbidden' };
    await services.lore.expireForSubject(context.chatId, target);
    return { text: 'facts_cleared', vars: { user_handle: target } };
  },
};

/** /lore - show top active group lore (max 5). */
export const loreCommand: CommandSpec = {
  command: 'lore',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    const items = await services.lore.topLore(context.chatId, 5);
    if (items.length === 0) {
      const empty: CommandResponse = { text: 'lore_empty' };
      return empty;
    }
    const resp: CommandResponse = {
      text: 'lore_text',
      vars: { lore: items.map((i) => `- ${i.text}`).join('\n') },
    };
    return resp;
  },
};

/**
 * /forget - reply to a message to forget memory mined from it; admins can /forget <memoryId>.
 */
export const forgetCommand: CommandSpec = {
  command: 'forget',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const isAdmin = context.isGroupAdmin || services.permissions.isBotAdmin(person.userHandle);
    if (args[0] && isAdmin) {
      const ok = await services.lore.expireById(context.chatId, args[0]);
      return ok ? { text: 'forget_done' } : { text: 'forget_none' };
    }
    if (context.repliedToMessageId) {
      const n = await services.lore.expireBySourceMessage(
        context.chatId,
        context.repliedToMessageId,
      );
      return n > 0 ? { text: 'forget_done' } : { text: 'forget_none' };
    }
    return { text: 'forget_usage' };
  },
};
