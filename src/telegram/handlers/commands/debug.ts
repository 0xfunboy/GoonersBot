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
    const evaluation = turn.evaluation ?? {
      shouldAct: true,
      action: 'answer',
      providerRequests: [],
      valueTarget: 'truth',
      roastBudget: 'light',
      socialRole: 'friend',
      confidence: 0,
      reason: 'legacy debug turn without evaluator data',
    };
    const providerSources = turn.providerSources ?? [];
    const cortex = turn.cortex;
    const tools = cortex?.toolCalls
      .map((c) => {
        const query = c.query ? `("${c.query}")` : '';
        return `${c.tool}${query} :: ${c.reason}`;
      })
      .join(' ; ');
    const mem = turn.retrievedMemories
      .map((m) => {
        const cos = m.cosineScore !== undefined ? ` cos ${m.cosineScore.toFixed(2)}` : '';
        return `  • ${m.text} (rel ${m.relevance.toFixed(2)}${cos})`;
      })
      .join('\n');
    const lines = [
      `🧠 last turn @ ${turn.createdAt.toISOString().slice(0, 19)}`,
      `scene: topic="${turn.scene.currentTopic}" energy=${turn.scene.energy} intent=${turn.scene.userIntent}`,
      `  addressed=${turn.scene.botIsBeingAddressed} criticized=${turn.scene.botIsBeingCriticized} risk=${turn.scene.risk}`,
      cortex
        ? `cortex=${cortex.source} conf=${cortex.confidence.toFixed(2)} intents=[${cortex.intents.join(', ')}]`
        : 'cortex=(legacy)',
      cortex
        ? `tools=[ ${tools || 'none'} ] needsGrounding=${cortex.needsGrounding} valueTarget=${cortex.valueTarget} roastBudget=${cortex.roastBudget} socialRole=${cortex.socialRole}`
        : '',
      `evaluation: action=${evaluation.action} value=${evaluation.valueTarget} role=${evaluation.socialRole} roast=${evaluation.roastBudget}`,
      `  providers=${evaluation.providerRequests.join(', ') || 'none'} conf=${evaluation.confidence.toFixed(2)} reason=${evaluation.reason}`,
      `plan: intent=${turn.plan.replyIntent} action=${turn.plan.action} value=${turn.plan.valueTarget} memory=${turn.plan.memoryUseMode} maxLines=${turn.plan.maxLines}`,
      `sources: ${providerSources.length ? providerSources.slice(0, 5).join(', ') : '(none)'}`,
      `thread: ${turn.threadContext ? turn.threadContext.split('\n').slice(1, 4).join(' | ') : '(none)'}`,
      `style: ${turn.styleVariant}`,
      `RAG.group:\n${mem || '  (none)'}`,
      `RAG.knowledge: ${turn.providerBundle?.knowledgeContext ? 'present in providerBundle' : '(none)'}`,
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
    const evaluation = turn.evaluation ?? {
      shouldAct: true,
      action: 'answer',
      providerRequests: [],
      valueTarget: 'truth',
      roastBudget: 'light',
      socialRole: 'friend',
      confidence: 0,
      reason: 'legacy debug turn without evaluator data',
    };
    const compact = {
      scene: turn.scene,
      evaluation,
      cortex: turn.cortex,
      providerSources: turn.providerSources ?? [],
      threadContext: turn.threadContext,
      providerBundle: turn.providerBundle,
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
