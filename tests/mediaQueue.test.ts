import { describe, expect, it } from 'vitest';
import { MediaProcessor } from '../src/providers/media/index.js';
import type { ImageGenerator } from '../src/providers/image/stableDiffusion.js';
import { fakeLLM } from './helpers.js';

describe('MediaProcessor image queue', () => {
  it('never runs image jobs concurrently across callers', async () => {
    let active = 0;
    let peak = 0;
    const generator: ImageGenerator = {
      enabled: true,
      async generate() {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { buffer: Buffer.from('image'), model: 'test' };
      },
    };
    const media = new MediaProcessor(fakeLLM({}), undefined, undefined, generator);

    await Promise.all([
      media.generateImage('first'),
      media.generateImage('second'),
      media.generateImage('third'),
    ]);

    expect(peak).toBe(1);
  });

  it('does not deadlock or let later jobs leapfrog when a queued caller aborts', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const generator: ImageGenerator = {
      enabled: true,
      async generate() {
        calls += 1;
        if (calls === 1) await firstGate;
        return { buffer: Buffer.from(`image-${calls}`), model: 'test' };
      },
    };
    const media = new MediaProcessor(fakeLLM({}), undefined, undefined, generator);
    const controller = new AbortController();

    const first = media.generateImage('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const aborted = media.generateImage('aborted', { signal: controller.signal });
    const third = media.generateImage('third');
    controller.abort(new Error('caller cancelled'));

    await expect(aborted).rejects.toThrow('caller cancelled');
    expect(calls).toBe(1);
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ model: 'test' });
    await expect(third).resolves.toMatchObject({ model: 'test' });
    expect(calls).toBe(2);
  });
});
