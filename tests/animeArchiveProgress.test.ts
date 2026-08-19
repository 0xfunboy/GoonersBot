import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimeArchiveProgressReporter } from '../src/anime/archive/progress.js';
import type {
  AnimeArchiveJobDoc,
  AnimeArchiveJobEpisode,
} from '../src/storage/repositories/animeArchive.js';

const episode = {
  id: 'ep-7',
  number: 7,
  order: 7,
} as unknown as AnimeArchiveJobEpisode;

const job = {
  id: 'job-progress',
  series: { title: 'Chainsmoker Cat' },
  episodes: [episode],
  destination: { chatId: -100, threadId: 42, replyToMessageId: 77 },
} as unknown as AnimeArchiveJobDoc;

afterEach(() => vi.useRealTimers());

describe('AnimeArchiveProgressReporter', () => {
  it('never blocks work and coalesces an in-flight send to the newest stage', async () => {
    let resolveSend: ((value: { message_id: number }) => void) | undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise<{ message_id: number }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const editMessageText = vi.fn().mockResolvedValue({});
    const reporter = new AnimeArchiveProgressReporter(
      { sendMessage, editMessageText } as never,
      job,
    );

    await expect(reporter.start()).resolves.toBeUndefined();
    await expect(reporter.during(episode, 'download', async () => 42)).resolves.toBe(42);
    await expect(reporter.delivered(episode)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith(
      -100,
      expect.stringContaining('avvio archivio'),
      expect.objectContaining({
        message_thread_id: 42,
        reply_parameters: expect.objectContaining({ message_id: 77 }),
      }),
    );
    expect(editMessageText).not.toHaveBeenCalled();

    resolveSend?.({ message_id: 501 });
    await vi.waitFor(() => {
      expect(editMessageText).toHaveBeenLastCalledWith(
        -100,
        501,
        expect.stringContaining('episodio 7 inviato'),
      );
    });
  });

  it('disables only telemetry after a hard Telegram timeout', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise<never>(() => undefined));
    const editMessageText = vi.fn();
    const reporter = new AnimeArchiveProgressReporter(
      { sendMessage, editMessageText } as never,
      job,
    );

    await reporter.start();
    await vi.advanceTimersByTimeAsync(5_001);
    await reporter.delivered(episode);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(editMessageText).not.toHaveBeenCalled();
  });
});
