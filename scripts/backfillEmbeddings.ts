/* eslint-disable no-console */

import { loadConfig } from '../src/config/index.js';
import { createLLMProvider } from '../src/providers/llm/factory.js';
import { createEmbedder } from '../src/rag/embedder.js';
import { Storage } from '../src/storage/index.js';

const BATCH = 64;

async function main(): Promise<void> {
  const config = loadConfig();
  const llm = createLLMProvider(config.llm, config.embeddings);
  const embedder = createEmbedder(llm, config.embeddings);
  if (!embedder.enabled) {
    console.error(
      'Embeddings unavailable: set EMBEDDINGS_ENABLED=true and configure bge-m3 /v1/embeddings.',
    );
    process.exitCode = 1;
    return;
  }

  const storage = await Storage.connect(config.env);
  try {
    await storage.ensureIndexes();
    let memoryTotal = 0;
    for (;;) {
      const items = await storage.memoryItems.listMissingEmbedding(config.embeddings.dim, BATCH);
      if (items.length === 0) break;
      const vectors = await embedder.embed(items.map((i) => i.text));
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const vector = vectors[i] ?? [];
        if (!item?._id || vector.length !== config.embeddings.dim) continue;
        await storage.memoryItems.setEmbedding(item._id, vector);
        memoryTotal += 1;
      }
      console.log(`memory_items embedded: ${memoryTotal}`);
      if (items.length < BATCH) break;
    }

    let knowledgeTotal = 0;
    for (;;) {
      const docs = await storage.knowledge.listMissingEmbedding(config.embeddings.dim, BATCH);
      if (docs.length === 0) break;
      const vectors = await embedder.embed(
        docs.map((d) => [d.topic, ...d.aliases, ...d.tags, d.text].join(' ')),
      );
      for (let i = 0; i < docs.length; i += 1) {
        const doc = docs[i];
        const vector = vectors[i] ?? [];
        if (!doc || vector.length !== config.embeddings.dim) continue;
        await storage.knowledge.setEmbedding(doc.key, vector);
        knowledgeTotal += 1;
      }
      console.log(`knowledge docs embedded: ${knowledgeTotal}`);
      if (docs.length < BATCH) break;
    }

    console.log(`backfill complete: memory=${memoryTotal} knowledge=${knowledgeTotal}`);
  } finally {
    await storage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
