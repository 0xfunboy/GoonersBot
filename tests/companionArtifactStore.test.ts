import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionArtifactStore } from '../src/companion/artifacts/store.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'companion-artifacts-test-'));
  temporary.push(directory);
  return { directory, store: new CompanionArtifactStore(directory) };
}
const metadata = {
  ownerTelegramId: 10,
  chatId: -20,
  threadId: 3,
  kind: 'document' as const,
  mime: 'text/plain',
  name: 'report.txt',
};

describe('private durable artifacts', () => {
  it('rejects cross-topic access and changed bytes rather than sending the wrong artifact', async () => {
    const { directory, store } = await fixture();
    const ref = await store.put(Buffer.from('original'), metadata);
    expect((await store.read(ref, metadata)).toString()).toBe('original');
    await expect(store.read(ref, { ...metadata, threadId: 4 })).rejects.toThrow('conversation');
    await writeFile(join(directory, `${metadata.ownerTelegramId}-${ref.id}.bin`), 'tampered');
    await expect(store.read(ref, metadata)).rejects.toThrow('hash');
  });

  it('erases an owner including unreferenced files while retaining another owner', async () => {
    const { store } = await fixture();
    const first = await store.put(Buffer.from('one'), metadata);
    const second = await store.put(Buffer.from('two'), { ...metadata, ownerTelegramId: 11 });
    await store.eraseOwner(10);
    await expect(store.read(first, metadata)).rejects.toThrow();
    expect((await store.read(second, { ...metadata, ownerTelegramId: 11 })).toString()).toBe('two');
  });
});
