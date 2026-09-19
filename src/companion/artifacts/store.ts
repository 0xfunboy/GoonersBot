import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, statfs, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const artifactRefSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    ownerTelegramId: z.number().int().positive(),
    chatId: z.number().int(),
    threadId: z.number().int().optional(),
    kind: z.enum(['image', 'video', 'audio', 'document', 'input']),
    mime: z.string().min(1).max(150),
    name: z.string().min(1).max(160),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type ArtifactScope = Pick<ArtifactRef, 'ownerTelegramId' | 'chatId' | 'threadId'>;

/** Private, bounded file store. Mongo contains references, never base64 or provider buffers. */
export class CompanionArtifactStore {
  private readonly root: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    private readonly maxBytes = 1024 * 1024 * 1024,
  ) {
    this.root = resolve(root);
  }

  async put(
    buffer: Buffer,
    metadata: ArtifactScope & Pick<ArtifactRef, 'kind' | 'mime' | 'name'>,
  ): Promise<ArtifactRef> {
    // Serialize admission so concurrent generators cannot oversubscribe the same disk budget.
    const pending = this.writeChain.then(async () => {
      if (buffer.length === 0 || buffer.length > 100 * 1024 * 1024)
        throw new Error('Artifact exceeds the per-file size budget');
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.cleanup();
      let used = 0;
      let count = 0;
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.isFile() || !/^\d+-[a-f0-9-]{36}\.bin$/.test(entry.name)) continue;
        count += 1;
        const file = await open(
          resolve(this.root, entry.name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          used += (await file.stat()).size;
        } finally {
          await file.close();
        }
      }
      const disk = await statfs(this.root);
      if (
        count >= 2000 ||
        used + buffer.length > this.maxBytes ||
        disk.bavail * disk.bsize < buffer.length + 512 * 1024 * 1024
      )
        throw new Error('Artifact storage budget exhausted');
      const now = new Date();
      const ref = artifactRefSchema.parse({
        ...metadata,
        version: 1,
        id: randomUUID(),
        bytes: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86400_000).toISOString(),
      });
      const file = await open(
        this.path(ref),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(buffer);
        await file.sync();
      } finally {
        await file.close();
      }
      return ref;
    });
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async read(reference: ArtifactRef, scope: ArtifactScope): Promise<Buffer> {
    const ref = artifactRefSchema.parse(reference);
    if (
      ref.ownerTelegramId !== scope.ownerTelegramId ||
      ref.chatId !== scope.chatId ||
      ref.threadId !== scope.threadId
    )
      throw new Error('Artifact does not belong to this conversation');
    if (Date.parse(ref.expiresAt) <= Date.now()) throw new Error('Artifact has expired');
    const file = await open(this.path(ref), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== ref.bytes || stat.size > 100 * 1024 * 1024)
        throw new Error('Artifact size mismatch');
      const bytes = await file.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
        throw new Error('Artifact hash mismatch');
      return bytes;
    } finally {
      await file.close();
    }
  }

  async remove(reference: ArtifactRef): Promise<void> {
    await unlink(this.path(artifactRefSchema.parse(reference))).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  }

  /** Also erases orphaned writes whose DB receipt was interrupted before persistence. */
  async eraseOwner(ownerTelegramId: number): Promise<void> {
    if (!Number.isSafeInteger(ownerTelegramId) || ownerTelegramId <= 0)
      throw new Error('Invalid artifact owner');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const pattern = new RegExp(`^${ownerTelegramId}-[a-f0-9-]{36}\\.bin$`);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.isFile() && pattern.test(entry.name)) await unlink(resolve(this.root, entry.name));
    }
  }

  async cleanup(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const cutoff = Date.now() - 7 * 86400_000;
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^\d+-[a-f0-9-]{36}\.bin$/.test(entry.name)) continue;
      const path = resolve(this.root, entry.name);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let expired = false;
      try {
        expired = (await file.stat()).mtimeMs < cutoff;
      } finally {
        await file.close();
      }
      if (expired) await unlink(path);
    }
  }

  private path(ref: ArtifactRef): string {
    return resolve(this.root, `${ref.ownerTelegramId}-${ref.id}.bin`);
  }
}
