import type { LinkExtractor, LinkMediaKind } from '../types.js';

const EXT_KIND: Record<string, LinkMediaKind> = {
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  avif: 'image',
  gif: 'gif',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
};

export const directExtractor: LinkExtractor = {
  platform: 'direct',
  match(url) {
    const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
    return ext in EXT_KIND;
  },
  async extract(url) {
    const ext = url.pathname.split('.').pop()?.toLowerCase() ?? 'bin';
    return {
      platform: 'direct',
      originalUrl: url.toString(),
      canonicalUrl: url.toString(),
      contentId: url.toString(),
      items: [{ kind: EXT_KIND[ext] ?? 'document', url: url.toString(), ext }],
    };
  },
};
