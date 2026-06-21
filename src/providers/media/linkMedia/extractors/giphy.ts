import { genericHtmlExtractor } from '../genericHtmlExtractor.js';
import type { LinkExtractor } from '../types.js';

export const giphyExtractor: LinkExtractor = {
  platform: 'giphy',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'giphy.com' || h === 'media.giphy.com' || h.endsWith('.giphy.com');
  },
  async extract(url, ctx) {
    const post = await genericHtmlExtractor.extract(url, ctx);
    return post ? { ...post, platform: 'giphy' as const } : null;
  },
};
