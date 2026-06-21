import { genericHtmlExtractor } from '../genericHtmlExtractor.js';
import type { LinkExtractor } from '../types.js';

export const tenorExtractor: LinkExtractor = {
  platform: 'tenor',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'tenor.com' || h === 'media.tenor.com' || h.endsWith('.tenor.com');
  },
  async extract(url, ctx) {
    const post = await genericHtmlExtractor.extract(url, ctx);
    return post ? { ...post, platform: 'tenor' as const } : null;
  },
};
