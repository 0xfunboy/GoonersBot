import { describe, expect, it } from 'vitest';
import {
  CompanionMemoryService,
  type MemoryOwnerDocument,
  type MemoryRepository,
  type MemoryProvenance,
} from '../src/companion/memory/index.js';
import { miningRetentionGap } from '../src/jobs/memoryMiningJob.js';

class MemoryRepo implements MemoryRepository {
  readonly records = new Map<number, MemoryOwnerDocument>();
  async get(id: number): Promise<MemoryOwnerDocument | null> {
    return structuredClone(this.records.get(id) ?? null);
  }
  async compareAndSwap(document: MemoryOwnerDocument, expectedVersion: number): Promise<boolean> {
    if ((this.records.get(document._id)?.version ?? 0) !== expectedVersion) return false;
    this.records.set(document._id, structuredClone(document));
    return true;
  }
}
const scope = { ownerTelegramId: 42, chatId: -100, telegramTopicId: 7 };
const human = (key: string, messageId = 1): MemoryProvenance => ({
  source: 'human',
  requestKey: key,
  messageId,
  sourceAt: new Date('2026-09-01T00:00:00Z'),
});

describe('scoped companion memory', () => {
  it('never leaks between actors, topics, or a private DM and a group', async () => {
    const service = new CompanionMemoryService(new MemoryRepo());
    await service.execute(
      scope,
      { operation: 'remember', text: 'Preferisco report brevi', category: 'communication_style' },
      human('one'),
    );
    expect((await service.execute(scope, { operation: 'list' })).memories).toHaveLength(1);
    for (const other of [
      { ...scope, ownerTelegramId: 43 },
      { ...scope, telegramTopicId: 8 },
      { ...scope, chatId: 42 },
    ]) {
      expect((await service.execute(other, { operation: 'list' })).memories).toEqual([]);
      expect(await service.recallContext(other, 'report')).toBe('');
    }
  });

  it('CAS retains concurrent requests and stable request identities prevent duplicate writes', async () => {
    const service = new CompanionMemoryService(new MemoryRepo());
    await Promise.all([
      service.execute(scope, { operation: 'remember', text: 'Primo progetto' }, human('one')),
      service.execute(scope, { operation: 'remember', text: 'Secondo progetto' }, human('two', 2)),
    ]);
    expect((await service.execute(scope, { operation: 'list' })).memories).toHaveLength(2);
    expect(
      (
        await service.execute(
          scope,
          { operation: 'remember', text: 'Primo progetto' },
          human('one'),
        )
      ).changed,
    ).toBe(0);
  });

  it('corrects attribution, exports project references, and blocks replay after forgetting', async () => {
    const repository = new MemoryRepo();
    const service = new CompanionMemoryService(repository);
    const saved = await service.execute(
      scope,
      { operation: 'remember', text: 'Report in italiano', projectId: 'confronto' },
      human('one'),
    );
    const corrected = await service.execute(
      scope,
      { operation: 'correct', memoryId: saved.memories[0]!.id, text: 'Report in inglese' },
      human('two', 2),
    );
    expect(corrected.memories[0]).toMatchObject({
      id: saved.memories[0]!.id,
      revision: 2,
      provenance: { messageId: 2 },
    });
    expect(await service.recallContext(scope, 'riprendi il confronto')).toContain(
      'Report in inglese',
    );
    const exported = await service.execute(scope, { operation: 'export' });
    expect(JSON.parse(exported.document!.buffer.toString()).memories[0].projectId).toBe(
      'confronto',
    );
    await service.execute(scope, { operation: 'forget', memoryId: saved.memories[0]!.id });
    const replay = await service.execute(
      scope,
      { operation: 'remember', text: 'Report in inglese' },
      human('two', 2),
    );
    expect(replay.changed).toBe(0);
    expect(JSON.stringify(repository.records.get(42))).not.toContain('Report in inglese');
  });

  it('erasure fences old evidence while permitting a new explicit declaration', async () => {
    const repository = new MemoryRepo();
    const service = new CompanionMemoryService(repository);
    await service.execute(
      scope,
      { operation: 'remember', text: 'Il progetto è Atlas' },
      human('one'),
    );
    await service.eraseActor(42);
    expect(
      (
        await service.execute(
          scope,
          { operation: 'remember', text: 'Il progetto è Atlas' },
          human('one'),
        )
      ).changed,
    ).toBe(0);
    const fresh = { ...human('new'), sourceAt: new Date(Date.now() + 1_000) };
    expect(
      (
        await service.execute(
          scope,
          { operation: 'remember', text: 'Il nuovo progetto è Vega' },
          fresh,
        )
      ).changed,
    ).toBe(1);
    expect(JSON.stringify(repository.records.get(42))).not.toContain('Atlas');
  });

  it('never converts bot output into biography and asks before ambiguous changes', async () => {
    const service = new CompanionMemoryService(new MemoryRepo());
    await expect(
      service.execute(
        scope,
        { operation: 'remember', text: 'Sei avvocato', kind: 'social' },
        { source: 'task', taskId: 't', requestKey: 'bot' },
      ),
    ).rejects.toThrow('biography');
    await service.execute(scope, { operation: 'remember', text: 'Report A' }, human('one'));
    await service.execute(scope, { operation: 'remember', text: 'Report B' }, human('two'));
    expect(
      (await service.execute(scope, { operation: 'forget', query: 'report' })).clarification,
    ).toBe(true);
    expect((await service.execute(scope, { operation: 'list' })).memories).toHaveLength(2);
  });

  it('reports missing retained prefixes without pretending to count missing messages', () => {
    const messages = [
      {
        handle: '@x',
        isBot: false,
        messageId: 12,
        message: { messageText: 'ciao', timestamp: new Date(2_000) },
      },
    ];
    expect(miningRetentionGap(messages, { messageId: 1, timestamp: 1_000 })).toEqual({
      checkpointAt: 1_000,
      oldestRetainedAt: 2_000,
      gapMs: 1_000,
    });
    expect(miningRetentionGap(messages, { messageId: 0, timestamp: 0 })).toBeNull();
  });
});
