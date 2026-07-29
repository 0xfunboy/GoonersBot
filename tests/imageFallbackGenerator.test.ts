import { describe, expect, it, vi } from 'vitest';
import { FallbackImageGenerator } from '../src/providers/image/fallbackGenerator.js';
import type { ImageGenerator } from '../src/providers/image/stableDiffusion.js';

function generator(generate: ImageGenerator['generate'], enabled = true): ImageGenerator {
  return { enabled, generate };
}

describe('FallbackImageGenerator provider routing', () => {
  it('honors an explicit Pony preference without spending a remote Agnes call', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes-image-2.1-flash',
    }));
    const ponyGenerate = vi.fn(async () => ({
      buffer: Buffer.from('pony'),
      model: 'ponyDiffusionV6XL',
    }));
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    const result = await router.generate('safe scene', {
      preferredProvider: 'pony',
      aspectRatio: '9:16',
    });

    expect(result.model).toBe('ponyDiffusionV6XL');
    expect(ponyGenerate).toHaveBeenCalledWith(
      'safe scene',
      expect.objectContaining({ preferredProvider: 'pony', aspectRatio: '9:16' }),
    );
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('falls back to Agnes when a preferred Pony generation fails', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes-image-2.1-flash',
    }));
    const ponyGenerate = vi.fn(async () => {
      throw new Error('Forge unavailable');
    });
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    const result = await router.generate('safe scene', { preferredProvider: 'pony' });

    expect(result.model).toBe('agnes-image-2.1-flash');
    expect(result.generationAttempts).toBe(2);
    expect(ponyGenerate).toHaveBeenCalledTimes(1);
    expect(primaryGenerate).toHaveBeenCalledTimes(1);
  });

  it('opens the Agnes circuit after two failures and immediately uses Pony afterwards', async () => {
    const primaryGenerate = vi.fn(async () => {
      throw new Error('Agnes timeout');
    });
    const ponyGenerate = vi.fn(async () => ({
      buffer: Buffer.from('pony'),
      model: 'ponyDiffusionV6XL',
    }));
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    await expect(router.generate('first safe scene')).resolves.toMatchObject({
      model: 'ponyDiffusionV6XL',
    });
    await expect(router.generate('second safe scene')).resolves.toMatchObject({
      model: 'ponyDiffusionV6XL',
    });
    await expect(router.generate('third safe scene')).resolves.toMatchObject({
      model: 'ponyDiffusionV6XL',
    });

    expect(primaryGenerate).toHaveBeenCalledTimes(2);
    expect(ponyGenerate).toHaveBeenCalledTimes(3);
  });

  it('routes pose-controlled work directly to Pony regardless of the preferred provider', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes-image-2.1-flash',
    }));
    const ponyGenerate = vi.fn(async () => ({
      buffer: Buffer.from('pony'),
      model: 'ponyDiffusionV6XL',
    }));
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));
    const poseReference = Buffer.from('pose');

    const result = await router.generate('safe pose scene', {
      preferredProvider: 'agnes',
      poseReference,
    });

    expect(result.model).toBe('ponyDiffusionV6XL');
    expect(ponyGenerate).toHaveBeenCalledWith(
      'safe pose scene',
      expect.objectContaining({ poseReference }),
    );
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('opens the Pony circuit after two failures and bypasses it for later preferred jobs', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes-image-2.1-flash',
    }));
    const ponyGenerate = vi.fn(async () => {
      throw new Error('Forge timeout');
    });
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    await router.generate('first', { preferredProvider: 'pony' });
    await router.generate('second', { preferredProvider: 'pony' });
    await router.generate('third', { preferredProvider: 'pony' });

    expect(ponyGenerate).toHaveBeenCalledTimes(2);
    expect(primaryGenerate).toHaveBeenCalledTimes(3);
  });

  it('does not turn a caller cancellation into a provider failure or fallback request', async () => {
    const controller = new AbortController();
    const primaryGenerate = vi.fn(async () => {
      controller.abort(new Error('caller cancelled'));
      throw controller.signal.reason;
    });
    const ponyGenerate = vi.fn(async () => ({
      buffer: Buffer.from('pony'),
      model: 'pony',
    }));
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    await expect(router.generate('cancelled', { signal: controller.signal })).rejects.toThrow(
      'caller cancelled',
    );
    expect(ponyGenerate).not.toHaveBeenCalled();
  });

  it('never sends explicit work to Agnes after Pony fails', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes',
    }));
    const ponyGenerate = vi.fn(async () => {
      throw new Error('Forge unavailable');
    });
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    await expect(
      router.generate('explicit adult scene', {
        preferredProvider: 'pony',
        rating: 'explicit',
      }),
    ).rejects.toMatchObject({ message: 'Forge unavailable', generationAttempts: 1 });
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('keeps explicit work off Agnes when the Pony circuit is already open', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes',
    }));
    const ponyGenerate = vi.fn(async () => {
      throw new Error('Forge unavailable');
    });
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    await expect(router.generate('explicit one', { rating: 'explicit' })).rejects.toThrow();
    await expect(router.generate('explicit two', { rating: 'explicit' })).rejects.toThrow();
    await expect(router.generate('explicit three', { rating: 'explicit' })).rejects.toThrow(
      'cooling down',
    );

    expect(ponyGenerate).toHaveBeenCalledTimes(2);
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('counts only the Pony call when Agnes is disabled', async () => {
    const primaryGenerate = vi.fn();
    const ponyGenerate = vi.fn(async () => ({
      buffer: Buffer.from('pony'),
      model: 'pony',
    }));
    const router = new FallbackImageGenerator(
      generator(primaryGenerate, false),
      generator(ponyGenerate),
    );

    const result = await router.generate('safe scene');

    expect(result.generationAttempts).toBe(1);
    expect(ponyGenerate).toHaveBeenCalledOnce();
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('never drops a pose reference by routing to Agnes when Pony is disabled', async () => {
    const primaryGenerate = vi.fn(async () => ({
      buffer: Buffer.from('agnes'),
      model: 'agnes',
    }));
    const router = new FallbackImageGenerator(
      generator(primaryGenerate),
      generator(vi.fn(), false),
    );

    await expect(
      router.generate('pose scene', { poseReference: Buffer.from('pose') }),
    ).rejects.toThrow('Pony is required');
    expect(primaryGenerate).not.toHaveBeenCalled();
  });

  it('does not call Agnes twice when Pony is unavailable after the first remote failure', async () => {
    const primaryGenerate = vi
      .fn()
      .mockResolvedValueOnce({ buffer: Buffer.from('agnes-1'), model: 'agnes' })
      .mockResolvedValueOnce({ buffer: Buffer.from('agnes-2'), model: 'agnes' })
      .mockRejectedValueOnce(new Error('Agnes timeout'));
    const ponyGenerate = vi.fn(async () => {
      throw new Error('Forge timeout');
    });
    const router = new FallbackImageGenerator(generator(primaryGenerate), generator(ponyGenerate));

    // Open Pony's circuit while Agnes keeps each warm-up request deliverable.
    await router.generate('warm-up one', { preferredProvider: 'pony' });
    await router.generate('warm-up two', { preferredProvider: 'pony' });
    primaryGenerate.mockClear();

    await expect(router.generate('default route')).rejects.toThrow('Agnes timeout');
    expect(primaryGenerate).toHaveBeenCalledTimes(1);
    expect(ponyGenerate).toHaveBeenCalledTimes(2);
  });
});
