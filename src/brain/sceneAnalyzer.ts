import type { LLMProvider } from '../providers/llm/types.js';
import type { StoredMessage } from '../storage/repositories/messages.js';
import { sceneSchema } from './schemas.js';
import type { SceneAnalysis } from './types.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('scene');

export interface SceneInput {
  history: StoredMessage[];
  currentMessage: string;
  currentHandle: string;
  mentionedHandles: string[];
  botIsAddressed: boolean;
  botLabel: string;
}

export interface SceneAnalyzerConfig {
  model: string | undefined;
  temperature: number;
}

const CRITICISM_RE =
  /\b(ripetitiv|sempre uguale|sei rotto|bot rotto|npc|noios|stupid|non fa ridere|che cazzo dici|deterministic|robotic|smonto)\b/i;

function renderHistory(history: StoredMessage[], botLabel: string): string {
  return history
    .slice(-14)
    .map((m) => `${m.isBot ? botLabel : m.handle}: ${m.message.messageText ?? ''}`)
    .join('\n');
}

export class SceneAnalyzer {
  constructor(
    private readonly llm: LLMProvider,
    private readonly cfg: SceneAnalyzerConfig,
  ) {}

  async analyze(input: SceneInput): Promise<SceneAnalysis> {
    const heuristic = this.heuristic(input);
    const system =
      'You analyze the live state of a chaotic Telegram group for a group-native bot. ' +
      'Return ONLY JSON matching the schema. Be terse. This is internal, not shown to users.';
    const prompt = [
      `RECENT CHAT:\n${renderHistory(input.history, input.botLabel)}`,
      '',
      `CURRENT MESSAGE from ${input.currentHandle}: ${input.currentMessage}`,
      `Bot directly addressed (mention/reply): ${input.botIsAddressed ? 'yes' : 'no'}`,
      `Mentioned handles: ${input.mentionedHandles.join(', ') || 'none'}`,
      '',
      'Fields: currentTopic, energy(dead|low|medium|high|chaotic), humorStyle[], activeUsers[],',
      'mentionedUsers[], openThreads[], botIsBeingAddressed, botIsBeingCriticized,',
      'userIntent(ask_bot|insult_bot|continue_banter|request_summary|request_memory|command_like|random_chatter|dangerous_request|unknown),',
      'shouldUseMemory, shouldBeDefensive, bestAngle, risk(low|medium|high). Return the JSON.',
    ].join('\n');

    try {
      const parsed = await this.llm.jsonCompletion({
        system,
        prompt,
        schema: sceneSchema,
        temperature: this.cfg.temperature,
        ...(this.cfg.model ? { model: this.cfg.model } : {}),
        maxTokens: 1200,
      });
      if (!parsed) return heuristic;
      // Trust the model but keep hard signals from the platform/heuristic.
      return {
        currentTopic: parsed.currentTopic ?? heuristic.currentTopic,
        energy: parsed.energy ?? heuristic.energy,
        humorStyle: parsed.humorStyle ?? heuristic.humorStyle,
        activeUsers: parsed.activeUsers ?? heuristic.activeUsers,
        openThreads: parsed.openThreads ?? heuristic.openThreads,
        shouldUseMemory: parsed.shouldUseMemory ?? heuristic.shouldUseMemory,
        shouldBeDefensive: parsed.shouldBeDefensive ?? heuristic.shouldBeDefensive,
        bestAngle: parsed.bestAngle ?? heuristic.bestAngle,
        botIsBeingAddressed: input.botIsAddressed || Boolean(parsed.botIsBeingAddressed),
        botIsBeingCriticized:
          heuristic.botIsBeingCriticized || Boolean(parsed.botIsBeingCriticized),
        mentionedUsers: input.mentionedHandles.length
          ? input.mentionedHandles
          : (parsed.mentionedUsers ?? []),
        userIntent: parsed.userIntent ?? heuristic.userIntent,
        risk: parsed.risk ?? heuristic.risk,
      };
    } catch (err) {
      log.warn({ err }, 'scene analysis failed; using heuristic');
      return heuristic;
    }
  }

  /** Deterministic fallback so the bot always has a usable scene. */
  heuristic(input: SceneInput): SceneAnalysis {
    const msg = input.currentMessage ?? '';
    const criticized = CRITICISM_RE.test(msg);
    const isQuestion = msg.includes('?');
    const energy: SceneAnalysis['energy'] =
      input.history.length > 18 ? 'high' : input.history.length > 6 ? 'medium' : 'low';
    let userIntent: SceneAnalysis['userIntent'] = 'random_chatter';
    if (criticized) userIntent = 'insult_bot';
    else if (input.botIsAddressed && isQuestion) userIntent = 'ask_bot';
    else if (input.botIsAddressed) userIntent = 'continue_banter';
    return {
      currentTopic: '',
      energy,
      humorStyle: ['roast', 'degen'],
      activeUsers: [...new Set(input.history.filter((m) => !m.isBot).map((m) => m.handle))].slice(
        -6,
      ),
      mentionedUsers: input.mentionedHandles,
      openThreads: [],
      botIsBeingAddressed: input.botIsAddressed,
      botIsBeingCriticized: criticized,
      userIntent,
      shouldUseMemory: !criticized && Math.random() < 0.5,
      shouldBeDefensive: criticized,
      bestAngle: criticized ? 'admit the loop with self-roast, then answer differently' : '',
      risk: 'low',
    };
  }
}
