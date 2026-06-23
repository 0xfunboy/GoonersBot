import type { CortexDecision, CortexTool, SourcedCortexDecision } from './schema.js';

const HINTS = {
  search: ['search', 'lookup', 'google', 'online', 'price', 'cost', 'cerca', 'prezzo', 'buscar'],
  news: ['news', 'latest', 'today', 'breaking', 'notizia', 'oggi', 'noticias', 'hoy'],
  music: ['play', 'song', 'music', 'youtube', 'suona', 'scarica', 'canzone', 'canta', 'cancion'],
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
}

export function fallbackCortex(input: CortexFallbackInput): SourcedCortexDecision {
  const msg = input.currentMessage.toLowerCase();
  const tools = new Set(input.availableTools);
  const calls: CortexDecision['toolCalls'] = [];
  const intents: CortexDecision['intents'] = [];

  if (has(msg, HINTS.music) && tools.has('music')) {
    intents.push('play_music');
    calls.push({ tool: 'music', query: input.currentMessage, reason: 'degraded music hint' });
  } else if (has(msg, HINTS.image) && tools.has('image_gen')) {
    intents.push(has(msg, ['draw', 'disegna', 'dibuja']) ? 'draw_image' : 'make_image');
    calls.push({ tool: 'image_gen', query: input.currentMessage, reason: 'degraded image hint' });
  } else if (has(msg, HINTS.translate) && tools.has('translate')) {
    intents.push('translate');
    calls.push({
      tool: 'translate',
      query: input.currentMessage,
      reason: 'degraded translate hint',
    });
  } else if (has(msg, HINTS.voice) && tools.has('tts')) {
    intents.push('voice_note');
    calls.push({ tool: 'tts', query: input.currentMessage, reason: 'degraded voice hint' });
  } else if (has(msg, HINTS.news) && tools.has('news')) {
    intents.push('news_context', 'answer');
    calls.push({ tool: 'news', query: input.currentMessage, reason: 'degraded news hint' });
    if (tools.has('web_search')) {
      calls.push({
        tool: 'web_search',
        query: input.currentMessage,
        reason: 'degraded news grounding',
      });
    }
  } else if (has(msg, HINTS.search) && tools.has('web_search')) {
    intents.push('web_lookup', 'answer');
    calls.push({ tool: 'web_search', query: input.currentMessage, reason: 'degraded search hint' });
  } else if (has(msg, HINTS.wrong)) {
    intents.push('correct_claim', 'banter');
  } else if (has(msg, HINTS.insult)) {
    intents.push('banter');
  } else if (input.botIsAddressed || input.currentMessage.includes('?')) {
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
    roastBudget: intents.includes('banter') ? 'heavy' : 'light',
    socialRole: needsGrounding || intents.includes('correct_claim') ? 'truth_checker' : 'friend',
    needsGrounding,
    confidence: 0.45,
    reason: 'degraded multilingual parachute; cortex LLM unavailable',
  };
}

function has(message: string, hints: string[]): boolean {
  return hints.some((hint) => message.includes(hint));
}
