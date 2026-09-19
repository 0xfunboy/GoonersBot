import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient } from 'mongodb';

const candidates = [
  '/usr/bin/mongod',
  '/usr/local/bin/mongod',
  '/home/funboy/.local/mongodb/bin/mongod',
];
let executable: string | undefined;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executable = candidate;
    break;
  } catch {
    /* no install */
  }
}
if (!executable) throw new Error('No existing mongod binary; no installation attempted');
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const address = probe.address();
assert(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const directory = await mkdtemp(join(tmpdir(), 'goonerbot-isolated-mongo-'));
const mongo = spawn(
  executable,
  [
    '--dbpath',
    directory,
    '--bind_ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--wiredTigerCacheSizeGB',
    '0.25',
    '--maxConns',
    '20',
    '--nounixsocket',
    '--logpath',
    join(directory, 'mongod.log'),
    '--setParameter',
    'diagnosticDataCollectionEnabled=false',
  ],
  { stdio: 'ignore' },
);
let exited = false;
const closed = new Promise<void>((resolve) => {
  mongo.once('exit', () => {
    exited = true;
    resolve();
  });
  mongo.once('error', () => {
    exited = true;
    resolve();
  });
});
try {
  const uri = `mongodb://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 30 && !exited; attempt += 1) {
    const probeClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 200,
      connectTimeoutMS: 200,
      maxPoolSize: 1,
    });
    try {
      await probeClient.connect();
      await probeClient.db('admin').command({ ping: 1 });
      ready = true;
      break;
    } catch {
      await delay(100);
    } finally {
      await probeClient.close();
    }
  }
  assert(ready, 'Isolated mongod did not become ready');
  const test = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-companion-mongo.ts'], {
    stdio: 'inherit',
    env: { ...process.env, MONGO_URI: uri },
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    test.once('error', reject);
    test.once('exit', resolve);
  });
  process.exitCode = code === 0 ? 0 : 1;
} finally {
  if (!exited) mongo.kill('SIGTERM');
  await Promise.race([closed, delay(5000)]);
  if (!exited) {
    mongo.kill('SIGKILL');
    await closed;
  }
  assert(basename(directory).startsWith('goonerbot-isolated-mongo-'));
  await rm(directory, { recursive: true, force: true });
  process.stdout.write(
    JSON.stringify({
      isolatedMongodStopped: true,
      temporaryDirectoryRemoved: true,
      productionDatabaseTouched: false,
    }) + '\n',
  );
}
