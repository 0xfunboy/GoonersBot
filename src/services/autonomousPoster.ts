import type { AppConfig } from '../config/index.js';
import type { LLMProvider } from '../providers/llm/types.js';
import type { NewsService } from '../news/newsService.js';
import type { ImageFinder } from '../media/imageFinder.js';
import { buildGeneratorSystem } from '../prompts/generator.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('autopost');

/**
 * Trim to <= maxChars WITHOUT cutting mid-sentence: keep the longest prefix that ends on a sentence
 * boundary (. ! ? or a URL) within the cap. Falls back to a word boundary if there is no sentence end.
 */
function trimToSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('\n'),
  );
  if (lastEnd > maxChars * 0.5) return slice.slice(0, lastEnd + 1).trim();
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

export interface AutoPost {
  text: string;
  imageBuffer?: Buffer;
  link?: string;
}

/**
 * Composes an unprompted, in-character post: either a styled take on a current event (RSS) with the
 * source link, or a commented waifu/anime image (fetched + vision-verified). Used by the scheduler's
 * probabilistic tick and by the /news command (forced). Returns null when nothing could be composed.
 */
export class AutonomousPoster {
  constructor(
    private readonly llm: LLMProvider,
    private readonly news: NewsService,
    private readonly images: ImageFinder,
    private readonly config: AppConfig,
  ) {}

  get enabled(): boolean {
    return this.news.enabled || this.images.enabled;
  }

  /** Compose a post for a chat. `prefer` forces a kind (used by /news); otherwise rolls by config. */
  async compose(language: string, prefer?: 'news' | 'image'): Promise<AutoPost | null> {
    const wantImage =
      prefer === 'image' ||
      (prefer !== 'news' &&
        this.images.enabled &&
        Math.random() < this.config.auto.autopostImageRatio);

    if (wantImage && this.images.enabled) {
      const post = await this.imagePost(language);
      if (post) return post;
    }
    const news = await this.newsPost(language);
    if (news) return news;
    // if news failed but images are on and we didn't already try them, fall back to an image
    if (!wantImage && this.images.enabled) return this.imagePost(language);
    return null;
  }

  private async imagePost(language: string): Promise<AutoPost | null> {
    const img = await this.images.find();
    if (!img) return null;
    const comment = await this.styledLine(
      language,
      `You are about to post this image in the group (you picked it). What you see: "${img.description}". ` +
        'Drop a short in-character line reacting to it / hyping it. One or two lines.',
    );
    const post: AutoPost = { text: comment || '👀', imageBuffer: img.buffer };
    return post;
  }

  private async newsPost(language: string): Promise<AutoPost | null> {
    if (!this.news.enabled) return null;
    const item = await this.news.pickOne();
    if (!item) return null;
    const comment = await this.styledLine(
      language,
      'You JUST read this news (it is from the last few hours). Talk to the group like you just saw ' +
        'it: open by telling them what happened in your own words and drop the LINK inline right in ' +
        'the first sentence (paste the raw URL inline, not at the bottom), then a sharp, witty, ' +
        'intelligent in-character rant. No preamble, no "ecco"/"here is", no neutral summary, do not ' +
        'announce that you read news. ' +
        'HARD LIMIT: stay UNDER 600 characters total and ALWAYS finish your last sentence (a clean ' +
        'punchline) - never get cut off, never trail into "...". Be punchy, not didascalic. ' +
        `Headline: "${item.title}". ${item.summary ? `Context: "${item.summary}". ` : ''}` +
        `LINK to paste inline: ${item.link}`,
      600,
    );
    if (!comment) return null;
    // the model should weave the link in; if it didn't, append it as a fallback so it is never lost
    const text = item.link && !comment.includes(item.link) ? `${comment}\n\n${item.link}` : comment;
    const post: AutoPost = { text };
    if (item.link) post.link = item.link;
    return post;
  }

  /** Generate an in-character message via the persona system prompt. `maxChars` caps the output. */
  private async styledLine(
    language: string,
    instruction: string,
    maxChars?: number,
  ): Promise<string> {
    const cap = maxChars ?? this.config.brain.maxReplyChars;
    const system = buildGeneratorSystem({
      botUsername: this.config.env.BOT_USERNAME.replace(/^@/, ''),
      chatName: undefined,
      language,
      modeName: 'Default',
      modeDescription: 'group-native chaos gremlin',
      nsfwEnabled: false,
    });
    try {
      const res = await this.llm.chatCompletion({
        system,
        messages: [{ role: 'user', content: instruction }],
        temperature: 0.95,
        maxTokens: Math.max(500, Math.ceil(cap * 2.5)),
      });
      return trimToSentence(res.text.trim(), cap);
    } catch (err) {
      log.warn({ err }, 'autopost line generation failed');
      return '';
    }
  }
}
