import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { normalizeHandle } from '../../../utils/handles.js';

/** /introduce <text> — save the caller's self-introduction. */
export const introduceCommand: CommandSpec = {
  command: 'introduce',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const introduction = args.join(' ').trim();
    if (introduction.length === 0) return { text: 'inappropriate_introduction' };
    const ok = await services.facts.addIntroduction(context.chatId, person.userHandle, introduction);
    if (!ok) return { text: 'inappropriate_introduction' };
    return { text: 'introduction_added', vars: { user_handle: person.userHandle } };
  },
};

/** /fact @handle <fact> — save a fact about a Gooner. */
export const factCommand: CommandSpec = {
  command: 'fact',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    if (args.length < 2) return { text: 'invalid_fact_args' };
    const target = normalizeHandle(args[0] ?? '');
    const fact = args.slice(1).join(' ').trim();
    if (target.length === 0 || fact.length === 0) return { text: 'invalid_fact_args' };
    const ok = await services.facts.addManualFact(context.chatId, target, fact, person.userHandle);
    if (!ok) return { text: 'inappropriate_fact' };
    return { text: 'fact_added', vars: { user_handle: target } };
  },
};

/** /facts [@handle] — show stored facts (self if no handle). Undocumented in original; preserved. */
export const factsCommand: CommandSpec = {
  command: 'facts',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const target = args[0] ? normalizeHandle(args[0]) : person.userHandle;
    const facts = await services.facts.getForUser(context.chatId, target);
    if (facts.length === 0) {
      const empty: CommandResponse = { text: 'user_facts_empty', vars: { user_handle: target } };
      return empty;
    }
    const resp: CommandResponse = {
      text: 'user_facts',
      vars: { user_handle: target, facts: facts.join('\n- ') },
    };
    return resp;
  },
};

/**
 * /clearfacts [@handle] — clear facts. Adapted from the original: self-clear is allowed for
 * anyone; clearing another Gooner's facts requires group admin.
 */
export const clearfactsCommand: CommandSpec = {
  command: 'clearfacts',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context, person, args }) {
    const target = args[0] ? normalizeHandle(args[0]) : person.userHandle;
    const isSelf = target === person.userHandle;
    if (!isSelf && !context.isGroupAdmin) {
      return { text: 'clearfacts_forbidden' };
    }
    await services.facts.clearForUser(context.chatId, target);
    return { text: 'facts_cleared', vars: { user_handle: target } };
  },
};
