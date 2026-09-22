import crypto from 'node:crypto';
import type { CustomInlineKeyboard } from '../domain/types.js';

export interface CachedImagePrompt {
  id: string;
  prompt: string;
  profile?: string;
  aspectRatio?: '16:9' | '9:16' | '1:1';
  medium?: string;
  rating?: 'safe' | 'suggestive' | 'explicit';
  negativePrompt?: string;
  createdAt: number;
}

const MAX_CACHE_SIZE = 300;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const cache = new Map<string, CachedImagePrompt>();

/** Evict expired entries or overflow */
function pruneCache(): void {
  const now = Date.now();
  for (const [id, entry] of cache.entries()) {
    if (now - entry.createdAt > CACHE_TTL_MS) {
      cache.delete(id);
    }
  }
  while (cache.size > MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
    else break;
  }
}

/**
 * Cache an image prompt to enable interactive Telegram playground callbacks
 * (style cycling, remix, and aspect ratio modifications).
 */
export function cacheGeneratedImagePrompt(
  data: Omit<CachedImagePrompt, 'id' | 'createdAt'>,
): string {
  pruneCache();
  const id = crypto.randomBytes(6).toString('hex');
  const entry: CachedImagePrompt = {
    ...data,
    id,
    createdAt: Date.now(),
  };
  cache.set(id, entry);
  return id;
}

/** Retrieve cached image prompt for an interactive callback */
export function getCachedImagePrompt(id: string): CachedImagePrompt | undefined {
  pruneCache();
  return cache.get(id);
}

/**
 * Construct interactive inline keyboard rows for image playground:
 * [ 🎨 Altro Stile ] [ 🔁 Remix ]
 * [ 📐 16:9 ] [ 📐 9:16 ] [ 📐 1:1 ]
 */
export function buildImagePlaygroundRows(promptId: string): CustomInlineKeyboard {
  return [
    [
      { text: '🎨 Altro Stile', callback_data: `sample_style|${promptId}` },
      { text: '🔁 Remix', callback_data: `sample_remix|${promptId}` },
    ],
    [
      { text: '📐 16:9', callback_data: `sample_ratio|16:9|${promptId}` },
      { text: '📐 9:16', callback_data: `sample_ratio|9:16|${promptId}` },
      { text: '📐 1:1', callback_data: `sample_ratio|1:1|${promptId}` },
    ],
  ];
}

const MEDIUM_CYCLE = [
  'anime',
  'photo',
  'digital_illustration',
  'pixel_art',
  'comic',
  'watercolor',
  'oil_painting',
];

/** Return the next artistic medium in the style cycle */
export function nextArtisticMedium(currentMedium?: string): string {
  if (!currentMedium) return 'anime';
  const idx = MEDIUM_CYCLE.indexOf(currentMedium.toLowerCase());
  if (idx === -1 || idx === MEDIUM_CYCLE.length - 1) {
    return MEDIUM_CYCLE[0]!;
  }
  return MEDIUM_CYCLE[idx + 1]!;
}
