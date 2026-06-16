import { describe, expect, it } from 'vitest';
import { KnowledgeRetriever } from '../src/knowledge/knowledgeRetriever.js';
import type { Storage } from '../src/storage/index.js';
import type { KnowledgeDoc } from '../src/storage/repositories/knowledge.js';

const docs: KnowledgeDoc[] = [
  {
    key: 'waifu-icons',
    topic: 'Iconic waifus',
    aliases: ['waifu', 'rem', 'zero two', 'makima'],
    text: 'Rem, Zero Two, Makima…',
    tags: ['waifu', 'anime'],
    salience: 0.8,
    updatedAt: new Date(),
  },
  {
    key: 'crypto-degen',
    topic: 'Crypto / degen finance',
    aliases: ['crypto', 'bitcoin', 'hodl', 'dca'],
    text: 'HODL, DCA, rug pulls…',
    tags: ['crypto'],
    salience: 0.6,
    updatedAt: new Date(),
  },
];

const storage = (entries: KnowledgeDoc[]): Storage =>
  ({ knowledge: { listAll: async () => entries } }) as unknown as Storage;

describe('KnowledgeRetriever', () => {
  it('returns only entries that match the message', async () => {
    const r = new KnowledgeRetriever(storage(docs), { enabled: true, maxItems: 2 });
    const hit = await r.retrieve('chi è la tua waifu preferita?', '');
    expect(hit.length).toBe(1);
    expect(hit[0]?.topic).toBe('Iconic waifus');
  });

  it('matches crypto talk and ignores the rest', async () => {
    const r = new KnowledgeRetriever(storage(docs), { enabled: true, maxItems: 2 });
    const hit = await r.retrieve('conviene fare DCA su bitcoin?', '');
    expect(hit.map((h) => h.topic)).toContain('Crypto / degen finance');
    expect(hit.some((h) => h.topic === 'Iconic waifus')).toBe(false);
  });

  it('returns nothing on an unrelated message (no prompt weight)', async () => {
    const r = new KnowledgeRetriever(storage(docs), { enabled: true, maxItems: 2 });
    expect(await r.retrieve('che tempo fa oggi a milano', '')).toEqual([]);
  });

  it('is disabled when configured off', async () => {
    const r = new KnowledgeRetriever(storage(docs), { enabled: false, maxItems: 2 });
    expect(await r.retrieve('waifu', '')).toEqual([]);
  });
});
