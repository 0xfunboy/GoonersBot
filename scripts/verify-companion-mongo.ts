import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { MongoClient } from 'mongodb';
import {
  CompanionTaskRepository,
  createRequestContract,
  type CompanionTask,
  type TaskClaim,
} from '../src/companion/tasks/index.js';
import { UpdateInboxRepo } from '../src/storage/repositories/updateInbox.js';
import { JobsRepo } from '../src/storage/repositories/jobs.js';
import { AnimeArchiveRepo } from '../src/storage/repositories/animeArchive.js';
import { MongoIntegrationRepository } from '../src/integrations/index.js';
import { ReminderService } from '../src/companion/workflows/reminders.js';
import {
  CompanionMemoryService,
  MongoMemoryRepository,
  MemoryPrivacyGuard,
  type MemoryOwnerDocument,
} from '../src/companion/memory/index.js';
import {
  MemoryItemsRepo,
  ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX,
} from '../src/storage/repositories/memoryItems.js';

// This script must never select/drop the configured production database. The URI only supplies
// local connectivity/authentication; all reads, writes and index migration use this fresh name.
const environment = parse(await readFile('.env', 'utf8').catch(() => ''));
const uri = process.env['MONGO_URI'] ?? environment['MONGO_URI'] ?? 'mongodb://127.0.0.1:27017';
const host = new URL(uri).hostname;
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(host),
  'Only a local Mongo server is permitted',
);
const name = `goonerbot_rework_verify_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
assert(/^goonerbot_rework_verify_\d+_[a-f0-9]{16}$/.test(name));
const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 3000,
  connectTimeoutMS: 3000,
  maxPoolSize: 2,
});
let created = false;
let checks = 0;
try {
  await client.connect();
  const db = client.db(name);
  await db.createCollection('update_inbox');
  created = true;
  await db.collection('update_inbox').createIndex({ updateId: 1 }, { unique: true });
  await db.collection('update_inbox').insertOne({
    updateId: 1,
    conversationKey: '-20:3',
    payload: { sample: true },
    status: 'done',
  });
  const inbox = new UpdateInboxRepo(db);
  assert.equal(await inbox.adoptLegacy('test-bot-a'), 1);
  await UpdateInboxRepo.ensureIndexes(db);
  await UpdateInboxRepo.ensureIndexes(db);
  const ingress = {
    botId: 'test-bot-b',
    updateId: 1,
    conversationKey: '-20:3',
    actorTelegramId: 10,
    chatId: -20,
    payload: { message: 'hello' },
  };
  assert.equal(await inbox.enqueue(ingress, 10, 10000), 'inserted');
  assert.equal(await inbox.enqueue(ingress, 10, 10000), 'duplicate');
  checks += 3;

  await CompanionTaskRepository.ensureIndexes(db);
  await JobsRepo.ensureIndexes(db);
  await AnimeArchiveRepo.ensureIndexes(db);
  await MongoIntegrationRepository.ensureIndexes(db);
  await ReminderService.ensureIndexes(db);
  const tasks = new CompanionTaskRepository(db);
  const scope = { actorTelegramId: 10, chatId: -20, threadId: 3 };
  const contract = createRequestContract({ ...scope, goal: 'Local recovery verification only' });
  const safe = await tasks.enqueue({ key: 'test-safe', contract, payload: {}, replaySafe: true });
  assert.equal(
    (await tasks.enqueue({ key: 'test-safe', contract, payload: {}, replaySafe: true })).id,
    safe.id,
  );
  const claims = await Promise.all([
    tasks.claim('worker-a', 60000),
    tasks.claim('worker-b', 60000),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const first = claims.find(Boolean)!;
  const claimOf = (value: CompanionTask): TaskClaim => ({
    id: value.id,
    ownerId: value.ownerId!,
    fence: value.fence,
    version: value.version,
  });
  const claim = claimOf(first);
  assert.equal(
    await tasks.checkpoint(claim, 'read:1', { summary: '$literal content must survive' }),
    true,
  );
  assert.equal(await tasks.beginEffect(claim, 'send:1'), true);
  assert.equal(
    await tasks.confirmEffect(claim, 'send:1', { externalId: 'mock:no-live-send' }),
    true,
  );
  assert.equal(await tasks.beginEffect(claim, 'send:1'), false);
  await db
    .collection('companion_tasks')
    .updateOne({ id: safe.id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await tasks.recoverExpired(), 1);
  const resumed = (await tasks.claim('worker-c', 60000))!;
  assert.equal(resumed.id, safe.id);
  assert(resumed.fence > first.fence);
  assert.equal(resumed.effects[0]?.status, 'confirmed');
  assert.equal(
    resumed.checkpoints[0]?.value && (resumed.checkpoints[0].value as { summary: string }).summary,
    '$literal content must survive',
  );
  assert.equal(await tasks.beginEffect(claim, 'stale:send'), false);
  assert.equal(await tasks.getVisible(safe.id, { ...scope, actorTelegramId: 20 }), null);
  assert.equal(
    await tasks.finish(claimOf(resumed), { status: 'completed', summary: 'local check complete' }),
    true,
  );
  checks += 8;

  const uncertain = await tasks.enqueue({
    key: 'test-uncertain',
    contract,
    payload: {},
    replaySafe: true,
  });
  const unsafeClaim = (await tasks.claim('worker-d', 60000))!;
  assert.equal(await tasks.beginEffect(claimOf(unsafeClaim), 'send:unknown'), true);
  await db
    .collection('companion_tasks')
    .updateOne({ id: uncertain.id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await tasks.recoverExpired(), 1);
  assert.equal((await tasks.getVisible(uncertain.id, scope))?.status, 'delivery_unknown');
  assert.equal(await tasks.claim('worker-e', 60000), null);
  checks += 3;
  const memoryRepo = new MongoMemoryRepository(db);

  const scheduled = await tasks.enqueue({
    key: 'test-scheduled-read',
    contract,
    payload: {},
    replaySafe: true,
  });
  const scheduledClaim = (await tasks.claim('before-restart', 60000))!;
  assert.equal(scheduledClaim.id, scheduled.id);
  assert.equal(await tasks.checkpoint(claimOf(scheduledClaim), 'read:attempts', 2), true);
  assert.equal(
    await tasks.finish(claimOf(scheduledClaim), {
      status: 'retry_scheduled',
      summary: 'Temporary provider failure',
      resumeAt: new Date(Date.now() + 60000),
    }),
    true,
  );
  const restarted = new CompanionTaskRepository(db);
  assert.equal(await restarted.claim('after-restart', 60000), null);
  // Advance only this disposable test row's due time, without sleeping or changing the host clock.
  await db
    .collection('companion_tasks')
    .updateOne({ id: scheduled.id }, { $set: { resumeAt: new Date(Date.now() - 1000) } });
  const due = (await restarted.claim('after-restart', 60000))!;
  assert.equal(due.id, scheduled.id);
  assert.equal(due.attempts, scheduledClaim.attempts + 1);
  assert.equal(due.checkpoints.find((entry) => entry.key === 'read:attempts')?.value, 2);
  assert(due.fence > scheduledClaim.fence);
  assert.equal(await tasks.beginEffect(claimOf(scheduledClaim), 'stale:retry'), false);
  assert.equal(
    await restarted.finish(claimOf(due), { status: 'completed', summary: 'Resumed at due time' }),
    true,
  );
  checks += 2;

  const initialOwner: MemoryOwnerDocument = {
    _id: 42,
    version: 1,
    memories: [],
    forgotten: [],
    updatedAt: new Date(),
  };
  const concurrentMemoryClaims = await Promise.all([
    memoryRepo.compareAndSwap(initialOwner, 0),
    memoryRepo.compareAndSwap(initialOwner, 0),
  ]);
  assert.equal(concurrentMemoryClaims.filter(Boolean).length, 1);
  assert.equal(await memoryRepo.compareAndSwap({ ...initialOwner, version: 2 }, 1), true);
  assert.equal(await memoryRepo.compareAndSwap({ ...initialOwner, version: 2 }, 1), false);
  const memory = new CompanionMemoryService(memoryRepo);
  const memoryScope = { ownerTelegramId: 42, chatId: -100, telegramTopicId: 7 };
  const sourceAt = new Date(Date.now() - 60000);
  const firstEvidence = {
    source: 'human' as const,
    messageId: 1,
    requestKey: 'memory-u1',
    sourceAt,
  };
  await Promise.all([
    memory.execute(
      memoryScope,
      { operation: 'remember', text: 'Preferisco report brevi' },
      firstEvidence,
    ),
    memory.execute(
      memoryScope,
      { operation: 'remember', text: 'Il progetto usa il tema verde' },
      { ...firstEvidence, messageId: 2, requestKey: 'memory-u2' },
    ),
  ]);
  const remembered = (await memory.execute(memoryScope, { operation: 'list' })).memories;
  assert.equal(remembered.length, 2);
  assert.equal(
    (await memory.execute({ ...memoryScope, ownerTelegramId: 43 }, { operation: 'list' })).memories
      .length,
    0,
  );
  assert.equal(
    (await memory.execute({ ...memoryScope, telegramTopicId: 8 }, { operation: 'list' })).memories
      .length,
    0,
  );
  const forgotten = remembered.find((item) => item.text === 'Preferisco report brevi')!;
  assert.equal(
    (await memory.execute(memoryScope, { operation: 'forget', memoryId: forgotten.id })).changed,
    1,
  );
  assert.equal(
    (
      await memory.execute(
        memoryScope,
        { operation: 'remember', text: forgotten.text },
        firstEvidence,
      )
    ).changed,
    0,
  );
  assert.equal(
    JSON.stringify((await memoryRepo.get(42))?.forgotten).includes(forgotten.text),
    false,
  );
  await memory.eraseActor(42);
  assert.equal(
    (
      await memory.execute(
        memoryScope,
        { operation: 'remember', text: 'Il progetto usa il tema verde' },
        { ...firstEvidence, messageId: 2, requestKey: 'memory-u2' },
      )
    ).changed,
    0,
  );
  assert.equal((await memory.execute(memoryScope, { operation: 'list' })).memories.length, 0);
  const privacy = new MemoryPrivacyGuard(db);
  await privacy.blockMemory(-100, 'Dato dimenticato', [9]);
  assert.equal(await privacy.allowsSources(-100, [9]), false);
  assert.equal(
    await privacy.allowsMemory(-100, { text: 'Dato dimenticato', sourceMessageIds: [] }),
    false,
  );
  assert.equal(
    JSON.stringify(await db.collection('memory_erasure_tombstones').find().toArray()).includes(
      'Dato dimenticato',
    ),
    false,
  );
  checks += 7;

  const legacyMemories = db.collection('memory_items');
  await legacyMemories.createIndex(
    { chatId: 1, normalizedText: 1 },
    { name: 'legacy_memory_unique', unique: true, partialFilterExpression: { status: 'active' } },
  );
  await legacyMemories.createIndex(
    { chatId: 1, subjectType: 1, subjectHandle: 1, normalizedText: 1 },
    {
      name: 'legacy_memory_subject_v2',
      unique: true,
      partialFilterExpression: { status: 'active' },
    },
  );
  const oldMemory = {
    chatId: -100,
    subjectType: 'user',
    subjectHandle: '@test',
    normalizedText: 'prefers brief reports',
    text: 'Prefers brief reports',
    status: 'active',
  };
  const originalMemory = await legacyMemories.insertOne({ ...oldMemory });
  await MemoryItemsRepo.ensureIndexes(db);
  await MemoryItemsRepo.ensureIndexes(db);
  const memoryIndexes = await legacyMemories.indexes();
  assert(
    memoryIndexes.some(
      (index) =>
        index.name === ACTIVE_MEMORY_SUBJECT_TEXT_UNIQUE_INDEX &&
        index.key['telegramTopicId'] === 1,
    ),
  );
  assert(
    !memoryIndexes.some(
      (index) => index.name === 'legacy_memory_unique' || index.name === 'legacy_memory_subject_v2',
    ),
  );
  assert(await legacyMemories.findOne({ _id: originalMemory.insertedId }));
  await legacyMemories.insertMany([
    { ...oldMemory, telegramTopicId: 7 },
    { ...oldMemory, telegramTopicId: 8 },
  ]);
  assert.equal(await legacyMemories.countDocuments(), 3);
  await assert.rejects(
    legacyMemories.insertOne({ ...oldMemory, telegramTopicId: 7 }),
    (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000),
  );
  checks += 3;
  process.stdout.write(
    JSON.stringify({
      result: 'passed',
      database: name,
      checks,
      externalEffects: 0,
      productionDatabaseTouched: false,
    }) + '\n',
  );
} catch (error) {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  process.stderr.write(
    JSON.stringify({
      result: 'failed',
      errorType: error instanceof Error ? error.name : 'unknown',
      code,
      database: name,
      productionDatabaseTouched: false,
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  if (created) {
    assert(/^goonerbot_rework_verify_\d+_[a-f0-9]{16}$/.test(name));
    await client.db(name).dropDatabase();
    process.stdout.write(JSON.stringify({ removedIsolatedVerificationDatabase: name }) + '\n');
  }
  await client.close();
}
