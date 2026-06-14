import { describe, expect, it, vi } from 'vitest';
import { ModeService } from '../src/services/modes.js';
import { FactService, isSensitiveFact } from '../src/services/facts.js';
import { BanService } from '../src/services/bans.js';
import { fakeStorage, inMemoryBans } from './helpers.js';

describe('ModeService.add (name heuristic)', () => {
  it('derives the mode name from the first sentence', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new ModeService(fakeStorage({ modes: { add } }));
    const name = await svc.add(-1, 'Roast mode. Be funny and mean-ish but never hateful.', '@bob');
    expect(name).toBe('Roast mode');
    expect(add).toHaveBeenCalledWith(-1, 'Roast mode', expect.any(String), '@bob');
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

describe('FactService', () => {
  it('flags sensitive facts', () => {
    expect(isSensitiveFact('his password is hunter2')).toBe(true);
    expect(isSensitiveFact('lives at 123 Main Street')).toBe(true);
    expect(isSensitiveFact('always posts cat memes')).toBe(false);
  });
  it('rejects sensitive manual facts', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new FactService(fakeStorage({ facts: { add } }));
    const ok = await svc.addManualFact(-1, '@bob', 'his password is hunter2', '@admin');
    expect(ok).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });
  it('stores a clean manual fact', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new FactService(fakeStorage({ facts: { add } }));
    const ok = await svc.addManualFact(-1, 'bob', 'is the meme lord', '@admin');
    expect(ok).toBe(true);
    expect(add).toHaveBeenCalledWith(-1, '@bob', 'is the meme lord', 'manual', '@admin');
  });
  it('silently skips sensitive auto facts', async () => {
    const add = vi.fn().mockResolvedValue(true);
    const svc = new FactService(fakeStorage({ facts: { add } }));
    await svc.addAutoFact(-1, '@bob', 'credit card 1234');
    expect(add).not.toHaveBeenCalled();
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
