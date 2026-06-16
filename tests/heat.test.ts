import { describe, expect, it } from 'vitest';
import { HeatService } from '../src/services/heat.js';
import type { UserHeatRepo, UserHeatDoc } from '../src/storage/repositories/userHeat.js';
import type { SceneAnalysis } from '../src/brain/types.js';

function fakeRepo(): UserHeatRepo {
  const store = new Map<string, UserHeatDoc>();
  return {
    async get(chatId: number, handle: string) {
      return store.get(`${chatId}:${handle}`) ?? null;
    },
    async set(chatId: number, handle: string, heat: number) {
      store.set(`${chatId}:${handle}`, { chatId, handle, heat, updatedAt: new Date() });
    },
  } as unknown as UserHeatRepo;
}

const scene = (over: Partial<SceneAnalysis> = {}): SceneAnalysis =>
  ({
    userIntent: 'continue_banter',
    botIsBeingCriticized: false,
    risk: 'low',
    ...over,
  }) as SceneAnalysis;

const cfg = { enabled: true, baseline: 12, max: 100, decayPerMinute: 1 };

describe('HeatService', () => {
  it('escalates on an insult and de-escalates on calming words', () => {
    const h = new HeatService(fakeRepo(), cfg);
    expect(
      h.deltaFromScene(scene({ userIntent: 'insult_bot' }), 'sei un coglione'),
    ).toBeGreaterThan(20);
    expect(h.deltaFromScene(scene(), 'scusa, hai ragione, calmati')).toBeLessThan(-15);
    expect(h.deltaFromScene(scene(), 'ciao tutto bene?')).toBeLessThan(0); // natural cooldown
  });

  it('maps heat to escalating directives', () => {
    const h = new HeatService(fakeRepo(), cfg);
    expect(h.directive(5).level).toBe('baseline');
    expect(h.directive(30).level).toBe('irritato');
    expect(h.directive(50).level).toBe('ostile');
    expect(h.directive(70).level).toBe('incazzato');
    expect(h.directive(95).level).toBe('furia');
    expect(h.directive(95).aggression).toBeGreaterThan(h.directive(5).aggression);
  });

  it('persists and clamps heat across bumps', async () => {
    const h = new HeatService(fakeRepo(), cfg);
    const after = await h.bump(-1, '@bob', 30); // baseline 12 + 30
    expect(after).toBe(42);
    const capped = await h.bump(-1, '@bob', 1000);
    expect(capped).toBe(100);
    const floored = await h.bump(-1, '@bob', -1000);
    expect(floored).toBe(0);
  });
});
