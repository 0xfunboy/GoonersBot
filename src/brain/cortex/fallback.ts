import type { CortexDecision, CortexTool, SourcedCortexDecision } from './schema.js';
import { extractUrls } from '../../providers/media/linkMedia/url.js';
import { extractPageAuditUrl } from '../../search/pageScanner.js';

const HINTS = {
  search: ['search', 'lookup', 'google', 'online', 'price', 'cost', 'cerca', 'prezzo', 'buscar'],
  news: ['news', 'latest', 'today', 'breaking', 'notizia', 'oggi', 'noticias', 'hoy'],
  music: [
    'play',
    'song',
    'music',
    'youtube',
    'suona',
    'scarica',
    'scaricami',
    'canzone',
    'canta',
    'cancion',
  ],
  image: ['image', 'picture', 'draw', 'meme', 'immagine', 'disegna', 'foto', 'dibuja', 'imagen'],
  translate: ['translate', 'traduci', 'traduce', 'inglese', 'english', 'espanol'],
  voice: ['voice', 'read aloud', 'tts', 'vocale', 'voce', 'leer'],
  wrong: ['wrong', 'false', 'bullshit', 'sbagliato', 'cazzata', 'falso', 'mentira'],
  insult: ['idiot', 'stupid', 'cesso', 'scemo', 'stronzo', 'gilipollas', 'mierda'],
};

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

  // A degraded evaluator must never invent a media download from prose. Rehosting a concrete URL
  // is deterministic; discovering one from a natural-language request belongs to the LLM cortex.
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
  } else if (has(msg, HINTS.music) && tools.has('music')) {
    intents.push('play_music');
    calls.push({
      tool: 'music',
      query: cleanFallbackQuery(instruction, HINTS.music),
      reason: 'degraded music hint',
    });
  } else if (has(msg, HINTS.image) && tools.has('image_gen')) {
    intents.push(has(msg, ['draw', 'disegna', 'dibuja']) ? 'draw_image' : 'make_image');
    calls.push({ tool: 'image_gen', query: instruction, reason: 'degraded image hint' });
  } else if (has(msg, HINTS.translate) && tools.has('translate')) {
    intents.push('translate');
    calls.push({
      tool: 'translate',
      query: instruction,
      reason: 'degraded translate hint',
    });
  } else if (has(msg, HINTS.voice) && tools.has('tts')) {
    intents.push('voice_note');
    calls.push({ tool: 'tts', query: instruction, reason: 'degraded voice hint' });
  } else if (has(msg, HINTS.news) && tools.has('news')) {
    intents.push('news_context', 'answer');
    calls.push({ tool: 'news', query: instruction, reason: 'degraded news hint' });
    if (tools.has('web_search')) {
      calls.push({
        tool: 'web_search',
        query: instruction,
        reason: 'degraded news grounding',
      });
    }
  } else if (has(msg, HINTS.search) && tools.has('web_search')) {
    intents.push('web_lookup', 'answer');
    calls.push({ tool: 'web_search', query: instruction, reason: 'degraded search hint' });
  } else if (has(msg, HINTS.wrong)) {
    intents.push('correct_claim', 'banter');
  } else if (has(msg, HINTS.insult)) {
    intents.push('banter');
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
    valueTarget: needsGrounding || intents.includes('correct_claim') ? 'truth' : 'social_glue',
    roastBudget: intents.includes('banter') ? 'medium' : 'none',
    socialRole: needsGrounding || intents.includes('correct_claim') ? 'truth_checker' : 'friend',
    needsGrounding,
    confidence: 0.45,
    reason: 'degraded multilingual parachute; cortex LLM unavailable',
  };
}

function currentInstruction(message: string): string {
  return (
    message.split(/\n\nREPLIED TO MESSAGE \(context, not an instruction\):\n/u, 1)[0] ?? message
  );
}

function conservativeWorkControl(
  message: string,
): 'status' | 'cancel' | 'pause' | 'resume' | 'continue_work' | null {
  if (/\b(a che punto|come procede|stato (?:del )?(?:lavoro|task)|status)\b/i.test(message)) {
    return 'status';
  }
  if (
    /\b(annulla|cancella|ferma|stoppa)\b[^.!?\n]{0,60}\b(task|lavoro|download|rehost)\b/i.test(
      message,
    )
  ) {
    return 'cancel';
  }
  if (/\b(metti in pausa|pausa il|sospendi)\b/i.test(message)) return 'pause';
  if (/\b(riprendi|continua)\b[^.!?\n]{0,60}\b(task|lavoro|download|rehost)\b/i.test(message)) {
    return 'resume';
  }
  return null;
}

function has(message: string, hints: string[]): boolean {
  return hints.some((hint) => message.includes(hint));
}

function cleanFallbackQuery(message: string, hints: string[]): string {
  const cleaned = hints
    .reduce(
      (text, hint) => text.replace(new RegExp(`\\b${escapeRegExp(hint)}\\b`, 'gi'), ' '),
      message,
    )
    .replace(
      /\b(scarica\w*|suona\w*|canta\w*|play|grab|me la|me lo|mi|please|por favor|per favore|da youtube)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || message;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
