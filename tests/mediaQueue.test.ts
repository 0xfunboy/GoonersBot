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
});
