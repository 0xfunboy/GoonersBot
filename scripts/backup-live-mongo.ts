import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { BSON, MongoClient } from 'mongodb';

// Offline application backup, not a transactionally consistent snapshot of other DB writers.
// Usage: pnpm exec tsx scripts/backup-live-mongo.ts /private/empty/directory --service-stopped
const command = promisify(execFile);
let stage = 'arguments';

async function serviceStopped(): Promise<void> {
  const { stdout } = await command(
    'systemctl',
    ['--user', 'show', 'goonerbot.service', '--property=LoadState', '--property=ActiveState'],
    { timeout: 10_000, maxBuffer: 4096 },
  );
  const state = Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
  assert.equal(state['LoadState'], 'loaded');
  assert(['inactive', 'failed'].includes(state['ActiveState'] ?? ''));
}

async function verifyFile(
  path: string,
  bson: boolean,
): Promise<{ sha256: string; bytes: number; documents: number }> {
  const hash = createHash('sha256');
  const header = Buffer.alloc(4);
  let headerBytes = 0,
    remaining = 0,
    bytes = 0,
    documents = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    assert(Buffer.isBuffer(chunk));
    hash.update(chunk);
    bytes += chunk.length;
    if (!bson) continue;
    let offset = 0;
    while (offset < chunk.length) {
      if (!remaining) {
        const take = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + take);
        headerBytes += take;
        offset += take;
        if (headerBytes < 4) continue;
        const length = header.readInt32LE(0);
        assert(length >= 5 && length <= 16 * 1024 * 1024);
        remaining = length - 4;
        headerBytes = 0;
      }
      const take = Math.min(remaining, chunk.length - offset);
      offset += take;
      remaining -= take;
      if (remaining === 0) {
        assert.equal(chunk[offset - 1], 0);
        documents++;
      }
    }
  }
  assert.equal(headerBytes, 0);
  assert.equal(remaining, 0);
  return { sha256: hash.digest('hex'), bytes, documents };
}

async function writeJson(path: string, value: unknown): Promise<{ sha256: string; bytes: number }> {
  const content = Buffer.from(BSON.EJSON.stringify(value, undefined, 2, { relaxed: false }) + '\n');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const verified = await verifyFile(path, false);
  assert.equal(verified.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(verified.bytes, content.length);
  return { sha256: verified.sha256, bytes: verified.bytes };
}

async function main(): Promise<void> {
  const [directory, flag, ...extra] = process.argv.slice(2);
  assert(directory && flag === '--service-stopped' && !extra.length);
  const root = resolve(directory);
  const info = await lstat(root);
  assert(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid?.());
  assert.equal(info.mode & 0o077, 0);
  assert.equal(await realpath(root), root);
  assert.equal((await readdir(root)).length, 0);
  stage = 'service-state';
  await serviceStopped();
  stage = 'configuration';
  const env = parse(await readFile('.env', 'utf8'));
  const uri = process.env['MONGO_URI'] ?? env['MONGO_URI'];
  const database = process.env['MONGO_DB'] ?? env['MONGO_DB'];
  assert(uri && database);
  const client = new MongoClient(uri, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 120_000,
  });
  const startedAt = new Date();
  try {
    stage = 'connect';
    await client.connect();
    const db = client.db(database);
    const build = await db.command({ buildInfo: 1 });
    const collections = await db.listCollections({}, { nameOnly: false }).toArray();
    const files: Record<string, unknown>[] = [];
    for (const [index, collection] of collections.entries()) {
      stage = `collection-${index + 1}`;
      await serviceStopped();
      const stem = `${String(index + 1).padStart(4, '0')}-${createHash('sha256').update(collection.name).digest('hex').slice(0, 20)}`;
      assert(/^[0-9]+-[a-f0-9]{20}$/.test(stem));
      const metadataName = `${stem}.metadata.json`;
      const indexes =
        collection.type === 'view'
          ? []
          : await db.collection(collection.name).listIndexes().toArray();
      const metadata = await writeJson(join(root, metadataName), {
        name: collection.name,
        type: collection.type,
        options: collection.options,
        indexes,
      });
      if (collection.type === 'view') {
        files.push({ collection: collection.name, type: collection.type, metadataName, metadata });
        continue;
      }
      const filename = `${stem}.bson`;
      const handle = await open(join(root, filename), 'wx', 0o600);
      const hash = createHash('sha256');
      let bytes = 0,
        documents = 0;
      const cursor = db.collection(collection.name).find({}, { raw: true, batchSize: 100 });
      try {
        for await (const document of cursor) {
          assert(Buffer.isBuffer(document));
          await handle.writeFile(document);
          hash.update(document);
          bytes += document.length;
          documents++;
        }
        await handle.sync();
      } finally {
        await cursor.close();
        await handle.close();
      }
      const verified = await verifyFile(join(root, filename), true);
      assert.deepEqual(verified, { sha256: hash.digest('hex'), bytes, documents });
      files.push({
        collection: collection.name,
        type: collection.type,
        filename,
        ...verified,
        metadataName,
        metadata,
      });
    }
    stage = 'final-service-state';
    await serviceStopped();
    stage = 'manifest';
    const manifest = await writeJson(join(root, 'manifest.pending.json'), {
      format: 'goonerbot-raw-bson-v1',
      complete: true,
      database,
      serverVersion: build['version'],
      startedAt,
      finishedAt: new Date(),
      consistency:
        'Application service stopped; other writers and Mongo TTL deletion are not fenced.',
      collections: files,
    });
    await rename(join(root, 'manifest.pending.json'), join(root, 'manifest.json'));
    const directoryHandle = await open(root, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    process.stdout.write(
      JSON.stringify({
        complete: true,
        collections: files.length,
        manifestSha256: manifest.sha256,
      }) + '\n',
    );
  } finally {
    await client.close();
  }
}

main().catch(() => {
  // Driver messages can contain credentials, endpoints or document contents. Never print them.
  process.stderr.write(
    `Backup failed at ${stage}; partial directory must not be used as a completed backup.\n`,
  );
  process.exitCode = 1;
});
