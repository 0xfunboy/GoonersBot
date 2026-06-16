import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

/** /brain - admin: human-readable summary of the last brain turn in this chat. */
export const brainCommand: CommandSpec = {
  command: 'brain',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context }) {
    if (!services.config.env.BRAIN_DEBUG_ENABLED) return { rawText: 'Brain debug disabled.' };
    const turn = await services.storage.brainDebug.getLast(context.chatId);
    if (!turn) return { rawText: 'No brain turns recorded yet.' };
    const mem = turn.retrievedMemories
      .map((m) => `  • ${m.text} (rel ${m.relevance.toFixed(2)})`)
      .join('\n');
    const lines = [
      `🧠 last turn @ ${turn.createdAt.toISOString().slice(0, 19)}`,
      `scene: topic="${turn.scene.currentTopic}" energy=${turn.scene.energy} intent=${turn.scene.userIntent}`,
      `  addressed=${turn.scene.botIsBeingAddressed} criticized=${turn.scene.botIsBeingCriticized} risk=${turn.scene.risk}`,
      `plan: intent=${turn.plan.replyIntent} tone=${turn.plan.tone} memory=${turn.plan.memoryUseMode} maxLines=${turn.plan.maxLines}`,
      `style: ${turn.styleVariant}`,
      `memories used:\n${mem || '  (none)'}`,
      `candidates: ${turn.candidates.length}`,
      `repetition: ${turn.repetitionChecks.map((r) => (r.allowed ? 'ok' : `blocked(${r.reason})`)).join(', ') || '(none)'}`,
      `final: ${turn.finalText.slice(0, 200)}`,
    ];
    return { rawText: lines.join('\n') };
  },
};

/** /debuglast - admin: compact JSON of the last brain turn. */
export const debuglastCommand: CommandSpec = {
  command: 'debuglast',
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context }) {
    if (!services.config.env.BRAIN_DEBUG_ENABLED) return { rawText: 'Brain debug disabled.' };
    const turn = await services.storage.brainDebug.getLast(context.chatId);
    if (!turn) return { rawText: 'No brain turns recorded yet.' };
    const compact = {
      scene: turn.scene,
      plan: turn.plan,
      styleVariant: turn.styleVariant,
      memories: turn.retrievedMemories,
      candidates: turn.candidates,
      ranked: turn.ranked,
      repetition: turn.repetitionChecks,
      finalText: turn.finalText,
    };
    const json = JSON.stringify(compact, null, 2).slice(0, 3500);
    return { rawText: '```\n' + json + '\n```' };
  },
};
