import { describe, expect, it, vi } from 'vitest';
import { ModeService } from '../src/services/modes.js';
import { BanService } from '../src/services/bans.js';
import { fakeStorage, inMemoryBans } from './helpers.js';

describe('ModeService.add (name heuristic)', () => {
  it('derives the mode name from the first sentence', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new ModeService(fakeStorage({ modes: { add } }));
    const name = await svc.add(-1, 'Roast mode. Be funny and mean-ish but never hateful.', '@bob');
    expect(name).toBe('Roast mode');
    expect(add).toHaveBeenCalledWith(-1, 'Roast mode', expect.any(String), '@bob', false);
  });

  it('flags an [nsfw]-prefixed custom mode', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new ModeService(fakeStorage({ modes: { add } }));
    const name = await svc.add(-1, '[nsfw] Filth. very explicit', '@bob');
    expect(name).toBe('Filth');
    expect(add).toHaveBeenCalledWith(-1, 'Filth', expect.any(String), '@bob', true);
  });
  it('returns null for empty description', async () => {
    const svc = new ModeService(fakeStorage({ modes: { add: vi.fn() } }));
    expect(await svc.add(-1, '   ', '@bob')).toBeNull();
  });
  it('returns null on name collision (repo rejects)', async () => {
    const svc = new ModeService(fakeStorage({ modes: { add: vi.fn().mockResolvedValue(false) } }));
    expect(await svc.add(-1, 'Hype. loud energy', '@bob')).toBeNull();
  });
});

describe('BanService', () => {
  it('defaults to permanent (0) when no duration given', async () => {
    const bans = inMemoryBans();
    const svc = new BanService(fakeStorage({ bans }), 0);
    const dur = await svc.ban('@bob', undefined, '@admin');
    expect(dur).toBe(0);
    expect(await bans.isBanned('@bob')).toBe(true);
  });
  it('honours a timed ban and expiry', async () => {
    const bans = inMemoryBans();
    const svc = new BanService(fakeStorage({ bans }), 0);
    await svc.ban('@bob', 1, '@admin');
    expect(await bans.isBanned('@bob', new Date(Date.now()))).toBe(true);
    expect(await bans.isBanned('@bob', new Date(Date.now() + 2000))).toBe(false);
  });
  it('uses the configured default duration', async () => {
    const bans = inMemoryBans();
    const svc = new BanService(fakeStorage({ bans }), 3600);
    const dur = await svc.ban('@bob', undefined, '@admin');
    expect(dur).toBe(3600);
  });
  it('unbans', async () => {
    const bans = inMemoryBans();
    const svc = new BanService(fakeStorage({ bans }), 0);
    await svc.ban('@bob', 0, null);
    await svc.unban('@bob');
    expect(await bans.isBanned('@bob')).toBe(false);
  });
});
