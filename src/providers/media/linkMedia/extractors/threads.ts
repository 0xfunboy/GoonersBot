import { genericHtmlExtractor } from '../genericHtmlExtractor.js';
import type { LinkExtractor } from '../types.js';

export const threadsExtractor: LinkExtractor = {
  platform: 'threads',
  match(url) {
    const h = url.hostname.replace(/^www\./, '').toLowerCase();
    return h === 'threads.net' || h === 'threads.com';
  },
  async extract(url, ctx) {
    const post = await genericHtmlExtractor.extract(url, ctx);
    return post ? { ...post, platform: 'threads' as const } : null;
  },
};
