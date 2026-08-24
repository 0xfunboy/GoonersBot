import type { AppConfig } from '../config/index.js';
import type { ChatContext } from '../domain/types.js';
import type { CapabilityForge } from '../capabilities/forge.js';
import type { Storage } from '../storage/index.js';
import {
  aliasesForCommand,
  registeredCommandCatalog,
} from '../telegram/handlers/commands/aliases.js';
import { helpDefinition } from '../telegram/handlers/commands/helpCatalog.js';

const SELF_TOPIC_RE =
  /(?:\b(?:come|perch[eé]|why|how|cosa|che cosa)\b.{0,80}\b(?:funzion|hai fatto|hai detto|hai risposto|usi|leggi|vedi|sai|access|log|cronolog|notific|modello|model|tool|skill|capabilit|comando|command|runtime|repo|codice|code)\b|\b(?:formatted[_ ]?id|log di sistema|system logs?|journalctl|cronologia|notifiche|hai accesso|puoi leggere|come funzioni|come sei fatto|stai allucinando|hai mentito|ti sei inventato)\b|\/(?:id|admin|unadmin|admins|learn|brain|debuglast)\b)/iu;

const SELF_CORRECTION_RE =
  /\b(?:sbagli\p{L}*|errat\p{L}*|fals\p{L}*|mentit\p{L}*|allucinat\p{L}*|inventat\p{L}*|non [eè] vero|non funziona|perch[eé] hai|come mai hai|hai confuso|hai perso il contesto|hai detto una cazzata)\b/iu;

export interface SelfKnowledgeInput {
  chatId: number;
  message: string;
  context: ChatContext;
}

/**
 * Runtime-grounded self model used only when the room asks how the bot itself works or challenges
 * one of its previous actions. It deliberately describes capabilities/limits, never hidden chain of
 * thought, and can attach the previous persisted brain turn as an audit record.
 */
export class SelfKnowledgeService {
  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly capabilities: CapabilityForge,
  ) {}

  isRelevant(input: SelfKnowledgeInput): boolean {
    const text = input.message
      .replace(/\[REPLIED MEDIA TRANSCRIPT[^\]]*\]:[\s\S]*$/giu, '')
      .replace(/\[transcript of the replied audio\/video\]:[\s\S]*$/giu, '')
      .trim();
    if (!text) return false;
    if (SELF_TOPIC_RE.test(text)) return true;
    return input.context.isReplyToBot && SELF_CORRECTION_RE.test(text);
  }

  async buildContext(input: SelfKnowledgeInput): Promise<string | null> {
    if (!this.isRelevant(input)) return null;

    const commands = registeredCommandCatalog();
    const mentionedCommands = commands.filter((spec) => {
      const names = [spec.command, ...aliasesForCommand(spec)];
      return names.some((name) =>
        new RegExp(`(?:^|\\s)/${escapeRegex(name)}(?:\\s|$)`, 'iu').test(input.message),
      );
    });
    const dynamic = this.capabilities.list();
    const lines = [
      'SELF RUNTIME EVIDENCE (ground truth for claims about yourself; never embellish):',
      `- Static slash commands registered now: ${commands.length}. Dynamic installed capabilities: ${dynamic.length}${dynamic.length ? ` (${dynamic.map((item) => `/${item.command}`).join(', ')})` : ''}.`,
      `- Configured model roles right now: reply=${this.config.brain.replyModel ?? this.config.llm.model ?? 'none'}; Cortex=${this.config.brain.cortex.model ?? this.config.llm.model ?? 'none'}; scene=${this.config.brain.sceneModel ?? this.config.llm.model ?? 'none'}; evaluator=${this.config.brain.evaluatorModel ?? this.config.llm.model ?? 'none'}; planner=${this.config.brain.plannerModel ?? this.config.llm.model ?? 'none'}; NSFW=${this.config.llm.nsfwModel ?? 'none'}. A group plan/router/provider may still report a different returned model for one concrete call.`,
      '- Normal conversation input comes from the current Telegram update plus recent conversation state stored by GoonersBot. RECENT CHAT is chat history, not an operating-system log.',
      '- You do NOT have arbitrary journalctl/system-log access, Telegram-client notification history, read receipts, or arbitrary filesystem/source-code access in an ordinary chat reply. Never claim you inspected those unless an explicit supplied tool result says so.',
      '- Safe host inspection is a separate deterministic SystemInfo path and exposes only allowlisted hardware/sensors/storage/models/quota information; host/user identity is deliberately not exposed.',
      '- Current/replied media are usable only when the Telegram adapter actually downloaded/decoded them. CURRENT MEDIA and REPLIED MEDIA are different sources; never substitute one for the other.',
      '- Web/current claims are grounded only when a web/news tool result is supplied. Group memory and prior BOT messages are not proof of external facts.',
      `- Local self-development workflow enabled: ${this.config.env.CAPABILITY_LOCAL_DEVELOPMENT_ENABLED ? 'yes' : 'no'}. You cannot silently rewrite/deploy yourself from an ordinary reply. /learn can install read-only research recipes; /learn code <goal> may create reviewable local-development work when enabled, and applying code requires the explicit reviewed/hash workflow. A status such as proposal_saved is a proposal, NOT an installed command and NOT executed code.`,
      '- Previous BOT messages in this chat are YOUR previous outputs. If one was wrong, say “prima ho sbagliato / ho inventato quella parte”; never refer to the previous bot message as if another bot/person wrote it.',
      '- If asked why a previous reply happened, use the LAST STORED BRAIN TURN below when present. Call it a stored brain/debug record, never “system logs”. If the audit contradicts the previous BOT claim, admit the exact mistake instead of defending it.',
    ];

    if (/\bformatted[_ ]?id\b|(?:^|\s)\/id\b/iu.test(input.message)) {
      lines.push(
        '- /id is a native deterministic command. It resolves Telegram identity from the current/replied user or the local observed-user registry; it does not use an LLM or web search.',
        '- `formatted_id` is ONLY a GoonersBot presentation field produced with Italian digit grouping for readability. It is NOT a Telegram Bot API/MTProto standard field. Telegram user IDs themselves are ordinary integer IDs.',
      );
    }
    if (/(?:^|\s)\/(?:admin|unadmin|admins)\b/iu.test(input.message)) {
      lines.push(
        '- Runtime /admin authority is persisted in Mongo by immutable Telegram user ID; username/display name are metadata only. ADMIN_HANDLES remains the non-revocable bootstrap/root layer.',
      );
    }

    for (const spec of mentionedCommands.slice(0, 5)) {
      const definition = helpDefinition(spec.command);
      if (!definition) continue;
      lines.push(`- COMMAND /${spec.command}: ${definition.description.italian}`);
    }

    if (this.config.env.BRAIN_DEBUG_ENABLED) {
      const last = await this.storage.brainDebug.getLast(input.chatId).catch(() => null);
      if (last) {
        lines.push(
          '',
          'LAST STORED BRAIN TURN (structured audit, not hidden reasoning and not OS logs):',
          `- inputMessageId=${last.inputMessageId ?? 'unknown'}; topic=${JSON.stringify(last.scene.currentTopic)}; action=${last.evaluation.action}; value=${last.evaluation.valueTarget}`,
          `- providerSources=${last.providerSources.length ? last.providerSources.join(', ') : 'none'}`,
          `- cortex=${last.cortex ? `${last.cortex.intents.join('+')} / ${last.cortex.toolCalls.map((call) => call.tool).join('+') || 'no tools'}` : 'not recorded'}`,
          `- previous output=${JSON.stringify(last.finalText.slice(0, 500))}`,
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Deterministic last line of defence for self-claims. This is deliberately narrow: it repairs only
   * claims the runtime model can prove false from its own architecture, leaving ordinary prose alone.
   */
  repairUnsupportedSelfClaim(candidate: string, currentMessage: string): string | null {
    const falseFormattedIdClaim =
      /(?:formatted[_ ]?id.{0,100}(?:standard|formato (?:standard|ufficiale)|telegram.{0,30}api)|(?:standard|telegram.{0,30}api).{0,100}formatted[_ ]?id)/iu.test(
        candidate,
      );
    if (falseFormattedIdClaim) {
      return 'Il `formatted_id` non è uno standard Telegram: è solo una formattazione locale che aggiungo per leggibilità. L’ID Telegram reale è l’intero numerico.';
    }

    const unsupportedLogClaim =
      /\b(?:leggo|vedo|controllo|ispeziono|ho accesso (?:a|ai|alle)|posso leggere)\b.{0,100}\b(?:journalctl|log di sistema|system logs?|notifiche (?:telegram|del client)|notification history|read receipts?|ricevute di lettura)\b/iu.test(
        candidate,
      );
    if (unsupportedLogClaim) {
      return 'Posso usare gli aggiornamenti Telegram che ricevo, la cronologia della chat salvata da GoonersBot e gli eventuali dati runtime esplicitamente forniti al turno. Non leggo journal/log di sistema, notifiche del client o ricevute di lettura.';
    }

    const otheredPriorSelf =
      /\b(?:quello|il bot|quello di prima|il bot di prima)\b.{0,90}\b(?:ha scritto|ha detto|prima|precedente|boiata|fuso)\b/iu.test(
        candidate,
      );
    if (SELF_CORRECTION_RE.test(currentMessage) && otheredPriorSelf) {
      const rest = candidate.replace(/^[\s\S]*?[.!?]\s*/u, '').trim();
      return `Prima ho sbagliato.${rest ? ` ${rest}` : ''}`;
    }

    // A generic self-question with an unsupported certainty claim should be softened, not replaced.
    if (
      SELF_CORRECTION_RE.test(currentMessage) &&
      /\b(?:di sicuro|certamente|sicuramente)\b.{0,100}\b(?:internamente|nel sistema|nei log|nell'api)\b/iu.test(
        candidate,
      )
    ) {
      return 'Su quello posso essere preciso solo se il turno contiene evidenza runtime verificabile; altrimenti devo dirti che non posso stabilirlo con certezza.';
    }
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const __test = { SELF_TOPIC_RE, SELF_CORRECTION_RE };
