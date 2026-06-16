/**
 * Smoke test for the free grounding stack: SearXNG text search + gating heuristics.
 * Run SearXNG first (scripts/searxng.sh start), then: pnpm tsx scripts/smoke-search.ts
 */
import { SearxngProvider } from '../src/search/searxng.js';
import { GroundingService } from '../src/search/groundingService.js';
import type { MediaProcessor } from '../src/providers/media/index.js';

const url = process.env.SEARXNG_URL ?? 'http://127.0.0.1:8888';

async function main(): Promise<void> {
  const searxng = new SearxngProvider({
    enabled: true,
    baseUrl: url,
    timeoutMs: 8000,
    maxResults: 5,
  });

  console.log(`SearXNG: ${url}`);
  const res = await searxng.search('chi ha vinto gli europei 2024', { language: 'italian' });
  if (!res) {
    console.error('✗ no results — is SearXNG running with JSON format enabled?');
    process.exit(1);
  }
  console.log(`✓ ${res.results.length} results${res.answer ? ` (+answer: ${res.answer.slice(0, 60)})` : ''}`);
  for (const r of res.results.slice(0, 3)) console.log(`  - ${r.title.slice(0, 60)} [${r.url.slice(0, 50)}]`);

  // No real vision model here; stub identify to exercise the web path + gating.
  const media = { identifyImage: async () => null } as unknown as MediaProcessor;
  const g = new GroundingService(searxng, media, { webEnabled: true, imageEnabled: true, maxResults: 5 });
  console.log('\nGating:');
  for (const q of ['chi ha vinto ieri?', 'chi è questo personaggio?', 'come stai stronzo']) {
    console.log(`  "${q}" → web=${g.wantsWebSearch(q)} image=${g.wantsImageLookup(q)}`);
  }
  const web = await g.groundWeb('prezzo rtx 5090', 'italian');
  console.log(`\n✓ web grounding block (${web?.sources.length ?? 0} sources):`);
  console.log(web?.block.split('\n').slice(0, 4).join('\n'));
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
