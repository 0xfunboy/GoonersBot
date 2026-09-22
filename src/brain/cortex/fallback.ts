import type { CortexDecision, CortexTool, SourcedCortexDecision } from './schema.js';
import { extractUrls } from '../../providers/media/linkMedia/url.js';
import { extractPageAuditUrl } from '../../search/pageScanner.js';

export interface CortexFallbackInput {
  currentMessage: string;
  botIsAddressed: boolean;
  availableTools: CortexTool[];
  visibleWorkCount?: number;
  /** Passive autoengage already approved this turn; keep the contribution tiny and non-performative. */
  passiveApproved?: boolean;
}

export function fallbackCortex(input: CortexFallbackInput): SourcedCortexDecision {
  const instruction = currentInstruction(input.currentMessage);
  const msg = instruction.toLowerCase();
  const tools = new Set(input.availableTools);
  const calls: CortexDecision['toolCalls'] = [];
  const intents: CortexDecision['intents'] = [];
  const directMediaUrl = extractUrls(instruction, 1)[0];
  const pageAuditUrl = extractPageAuditUrl(instruction);
  const pageAuditRequested =
    tools.has('page_scan') &&
    /(?:scansion|scansione|analizz|audit|qualit[aà]|header|sorgenti|source|vulnerabilit|security|sicurezza|codebase|codice)/i.test(
      msg,
    ) &&
    Boolean(pageAuditUrl);
  const visibleWork = (input.visibleWorkCount ?? 0) > 0;
  const controlIntent = visibleWork ? conservativeWorkControl(msg) : null;
  const mediaExplicitlyNegated =
    /\b(non|dont|don't|do not|no)\b[^.!?\n]{0,40}\b(scaric|download|rehost|inoltr|send)\w*/i.test(
      msg,
    );

  // Fallback is strictly an offline emergency parachute. It handles only deterministic
  // structural artifacts (direct URLs, work controls). All natural-language tool routing
  // and intent disambiguation belongs to the cognitive LLM cortex.
  if (controlIntent) {
    intents.push(controlIntent);
  } else if (pageAuditRequested) {
    intents.push('web_lookup', 'answer');
    calls.push({
      tool: 'page_scan',
      query: pageAuditUrl?.toString() ?? '',
      args: { url: pageAuditUrl?.toString() ?? '' },
      reason: 'explicit bounded passive page audit request',
    });
  } else if (directMediaUrl && mediaExplicitlyNegated) {
    intents.push('answer', 'negation');
  } else if (directMediaUrl && tools.has('link_media')) {
    intents.push('download_media');
    calls.push({
      tool: 'link_media',
      query: directMediaUrl.toString(),
      args: { url: directMediaUrl.toString() },
      reason: 'degraded direct media URL',
    });
  } else if (input.passiveApproved) {
    intents.push('react_short');
  } else if (input.botIsAddressed || instruction.includes('?')) {
    intents.push('answer');
  } else {
    intents.push('stay_quiet');
  }

  if (tools.has('group_rag') && input.botIsAddressed) {
    calls.push({ tool: 'group_rag', reason: 'degraded social context' });
  }

  const needsGrounding = calls.some((c) => c.tool === 'web_search');
  return {
    source: 'fallback',
    intents,
    toolCalls: calls,
    valueTarget: needsGrounding ? 'truth' : 'social_glue',
    roastBudget: 'none',
    socialRole: needsGrounding ? 'truth_checker' : 'friend',
    needsGrounding,
    confidence: 0.3,
    reason: 'offline deterministic parachute; cortex LLM unavailable',
  };
}

function currentInstruction(message: string): string {
  return (
    message.split(
      /\n\n(?:REPLIED TO MESSAGE \(context, not an instruction\):\n|PENDING USER CLARIFICATION:)/u,
      1,
    )[0] ?? message
  );
}

function conservativeWorkControl(
  message: string,
): 'status' | 'cancel' | 'pause' | 'resume' | 'continue_work' | null {
  if (
    /\b(a che punto|come procede|come sei messo|stato (?:del )?(?:lavoro|task)|status)\b/i.test(
      message,
    )
  ) {
    return 'status';
  }
  if (
    /^(?:ok[, ]+)?(?:lascia perdere|fermati|annulla|cancel|stop)[.!?\s]*$/i.test(message) ||
    /\b(annulla|cancella|ferma|stoppa)\b[^.!?\n]{0,60}\b(task|lavoro|download|rehost)\b/i.test(
      message,
    )
  ) {
    return 'cancel';
  }
  if (/\b(metti in pausa|pausa il|sospendi)\b/i.test(message)) return 'pause';
  if (
    /^(?:riprendi|continua|resume)[.!?\s]*$/i.test(message) ||
    /\b(riprendi|continua)\b[^.!?\n]{0,60}\b(task|lavoro|download|rehost)\b/i.test(message)
  ) {
    return 'resume';
  }
  return null;
}
