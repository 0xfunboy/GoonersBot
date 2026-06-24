import type { AppConfig } from '../config/index.js';
import type { LLMProvider } from '../providers/llm/types.js';
import { selectImageProfile, type ImageProfile } from '../providers/image/stableDiffusion.js';
import { isRefusal } from './modelRouter.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('image-prompt');

export interface PreparedImagePrompt {
  prompt: string;
  poseReferenceQuery?: string;
  profile: ImageProfile;
  model: string | undefined;
  usedFallback: boolean;
}

/** Turns loose user language into a checkpoint-aware English Stable Diffusion prompt. */
export class ImagePromptService {
  constructor(
    private readonly llm: LLMProvider,
    private readonly config: AppConfig,
  ) {}

  async prepare(
    request: string,
    options: { profile?: ImageProfile; model?: string } = {},
  ): Promise<PreparedImagePrompt> {
    const profile = options.profile ?? selectImageProfile(request);
    // Keep one reachable prompt model for every image profile; PonyXL still handles explicit images.
    const model = options.model ?? this.config.llm.model;
    const fallback = fallbackPrompt(request, profile);
    try {
      const result = await this.llm.chatCompletion({
        system: promptSystem(profile),
        messages: [{ role: 'user', content: request }],
        model,
        temperature: 0.35,
        maxTokens: 220,
      });
      const prompt = cleanPrompt(result.text);
      if (!prompt || isRefusal(prompt))
        throw new Error('image prompt model returned no usable prompt');
      const compiled = finalizeScenePrompt(prompt, request);
      log.info(
        { profile, model, usedFallback: false, promptChars: compiled.length },
        'prepared image prompt',
      );
      return {
        prompt: compiled,
        poseReferenceQuery: poseReferenceQuery(request),
        profile,
        model,
        usedFallback: false,
      };
    } catch (err) {
      log.warn(
        { err, profile, model },
        'image prompt generation failed; using structured fallback',
      );
      return {
        prompt: finalizeScenePrompt(fallback, request),
        poseReferenceQuery: poseReferenceQuery(request),
        profile,
        model,
        usedFallback: true,
      };
    }
  }
}

function promptSystem(profile: ImageProfile): string {
  if (profile === 'nsfw') {
    return [
      'You are a Stable Diffusion prompt engineer for adult-only content.',
      'Translate the user request into 18-55 concise ENGLISH comma-separated Danbooru-style scene tags for PonyXL.',
      'Preserve the requested adult sexual act and visible composition exactly; do not sanitize, omit, euphemize, or add commentary.',
      'For two people, start with exact count tags (for example 1girl, 1boy), describe both separately, then the interaction, then full body, wide shot, both faces visible.',
      'Never include minors or age-ambiguous wording. Do not include score, source, rating, quality tags or a negative prompt. Output only tags, no quotes or explanation.',
    ].join(' ');
  }
  if (profile === 'anime') {
    return [
      'You are a Stable Diffusion prompt engineer for PonyXL.',
      'Translate the user request into 18-55 concise ENGLISH comma-separated Danbooru-style scene tags.',
      'Preserve subject, action, camera framing, environment and mood. Add only useful visual detail.',
      'For two people, begin with exact count tags (1girl, 1boy, 2girls or 2boys), describe both separately, then their interaction, then full body, wide shot, both faces visible.',
      'Do not include score, source, rating, quality tags or a negative prompt. Output only tags, no quotes or explanation.',
    ].join(' ');
  }
  if (profile === 'manga') {
    return [
      'You are a Stable Diffusion prompt engineer for PonyXL manga illustrations.',
      'Translate the request into 18-55 concise ENGLISH comma-separated Danbooru-style manga scene tags.',
      'Start with exact subject counts such as 1girl, 1boy, 2girls; then list subject appearance, action, camera framing, props, setting and mood in that order.',
      'When two or more subjects are requested, explicitly include every subject, their separate action, and a medium-wide or wide shot; never collapse it into a portrait.',
      'Use visual tags for full-color manga key visual, clean lineart, controlled screentone accents, visible faces, cinematic composition and a detailed background when relevant.',
      'Do not invent brand logos or readable text. Avoid silhouettes unless the request explicitly asks for them. Do not include score, source, rating, quality tags or a negative prompt. Output only tags, no quotes or explanation.',
    ].join(' ');
  }
  return [
    'You are a Stable Diffusion prompt engineer for PonyXL.',
    'Translate the user request into 18-55 concise ENGLISH comma-separated visual scene tags for PonyXL.',
    'Preserve subject, action, camera framing, environment and mood. Do not invent a real person identity.',
    'For two people, begin with exact count tags (1girl, 1boy, 2girls or 2boys), describe both separately, then their interaction, then full body, wide shot, both faces visible.',
    'Do not include score, source, rating, quality tags or a negative prompt. Output only tags, no quotes or explanation.',
  ].join(' ');
}

function fallbackPrompt(request: string, profile: ImageProfile): string {
  const clean = translateFallbackTerms(request).replace(/\s+/g, ' ').trim().slice(0, 800);
  if (profile === 'nsfw') {
    return `adult, consenting adults, ${twoSubjectFallback(request)}, ${clean}`;
  }
  if (profile === 'manga') {
    return `${twoSubjectFallback(request)}, full-color manga key visual, precise ink lineart, controlled screentone accents, visible faces, ${clean}`;
  }
  if (profile === 'anime') {
    return `${twoSubjectFallback(request)}, ${clean}`;
  }
  return `${twoSubjectFallback(request)}, photorealistic, ${clean}`;
}

function twoSubjectFallback(request: string): string {
  const normalized = request.toLowerCase();
  const multipleSubjects = hasTwoSubjects(request);
  if (!multipleSubjects) return '';
  const hasFemale = /\b(donna|ragazza|girl|woman|female)\b/.test(normalized);
  const hasMale = /\b(uomo|ragazzo|boy|man|male)\b/.test(normalized);
  const counts = hasFemale && hasMale ? '1girl, 1boy' : '2people, two adults';
  return `${counts}, full body, wide shot, both subjects visible, detailed faces`;
}

/** Keep the SD fallback useful when an NSFW LLM backend is temporarily flaky. */
function translateFallbackTerms(text: string): string {
  return text
    .replace(/\bfoto\s+porno\b/gi, 'explicit adult photo, photo (medium)')
    .replace(/\basiatica\b/gi, 'asian adult woman')
    .replace(/\bculona\b/gi, 'large buttocks, wide hips')
    .replace(/\bgirata\s+di\s+spalle\b/gi, 'from behind, back view')
    .replace(/\ballarga\s+le\s+mele\s+del\s+culo\b/gi, 'spreading buttocks')
    .replace(
      /\blaying\s+a\s+brown\s+egg\s+over\s+([A-Z][a-z]+)/g,
      'adult woman, laying a brown egg over an adult man',
    )
    .replace(/\bcazzo\s+in\s+bocca\b/gi, 'penis in mouth, oral sex, blowjob')
    .replace(/\bpompino\b|\bbocchino\b/gi, 'oral sex, blowjob')
    .replace(/\bfiga\b|\bfica\b/gi, 'vagina, pussy')
    .replace(/\btette\b|\btettona\b/gi, 'large breasts')
    .replace(/\bcazzo\b/gi, 'penis')
    .replace(/\bpene\b/gi, 'penis')
    .replace(/\bsborra\b|\bsperma\b/gi, 'semen')
    .replace(/\bscopare\b|\bscopata\b/gi, 'sexual intercourse')
    .replace(/\bsega\b|\bseghe\b/gi, 'masturbation')
    .replace(/\buna\s+donna\b/gi, 'an adult woman')
    .replace(/\buna\s+ragazza\b/gi, 'an adult woman')
    .replace(/\buser\s+id\s*\d+\b/gi, 'an original adult character');
}

/** Enforce information Pony often drops: subject count, framing and facial visibility. */
function finalizeScenePrompt(prompt: string, request: string): string {
  const controls = hasTwoSubjects(request)
    ? '1girl, 1boy, (two people:1.45), (both subjects visible:1.35), full body, wide shot, both faces visible, clear separate bodies, detailed faces'
    : 'solo, detailed face, sharp eyes';
  return `${controls}, ${prompt}`
    .replace(/(?:,\s*){2,}/g, ', ')
    .trim()
    .slice(0, 1_000);
}

function hasTwoSubjects(request: string): boolean {
  return (
    /\b(due|two|2)\s+(?:soggetti|persone|people|characters)|soggetto\s*1.*soggetto\s*2|coppia|couple/i.test(
      request,
    ) || /\b(?:over|above|on top of|sopra|su)\s+[A-Z][a-z]+\b/.test(request)
  );
}

/** Search terms are deliberately neutral: the web image is a pose guide, never user content. */
function poseReferenceQuery(request: string): string | undefined {
  const normalized = request.toLowerCase();
  if (/\b(sulle spalle|in spalla|piggyback|shoulders)\b/.test(normalized)) {
    return 'two adults piggyback standing';
  }
  if (/\b(abbracci|abbraccio|hug|holding)\b/.test(normalized)) return 'two adults hugging standing';
  if (/\b(dance|balla|ballando|dancing)\b/.test(normalized)) return 'two adults dancing';
  if (/\b(di spalle|girata di spalle|from behind|back view)\b/.test(normalized)) {
    return 'adult full body back view standing pose';
  }
  if (/\b(testa in gi[uù]|a testa in gi[uù]|upside down|inverted|head down)\b/.test(normalized)) {
    return 'adult upside down full body pose';
  }
  if (/\b(sopra|sotto|above|below|over|under|on top of)\b/.test(normalized)) {
    return 'two adults stacked body position full body pose';
  }
  if (
    /\b(gambe|legs|incrociate|crossed|larghe|wide stance|strette|closed legs)\b/.test(normalized)
  ) {
    return 'adult full body legs stance pose reference';
  }
  if (/\b(braccia|arms|mani|hands|raised arms|arms up)\b/.test(normalized)) {
    return 'adult full body arms hands pose reference';
  }
  if (
    /\b(sdrai|lying|sedut|sitting|inginocchi|kneeling|accovacci|squatting|in piedi|standing)\b/.test(
      normalized,
    )
  ) {
    return 'adult full body pose reference';
  }
  return undefined;
}

function cleanPrompt(text: string): string {
  return text
    .replace(/```(?:text)?/gi, '')
    .replace(/[\r\n]+/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim()
    .slice(0, 1_000);
}
