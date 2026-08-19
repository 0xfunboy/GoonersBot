import { describe, expect, it, vi } from 'vitest';
import {
  animeCommand,
  followCommand,
  followingCommand,
  unfollowCommand,
} from '../src/telegram/handlers/commands/anime.js';
import {
  describeCandidates,
  describeSeries,
  describeSeriesCompact,
  summarizeSeries,
} from '../src/anime/answers.js';
import { commandHandlers } from '../src/telegram/handlers/commands/index.js';
import { translations } from '../src/config/i18n.js';
import { formatAnimeAnswer } from '../src/services/reply.js';
import type { AnimeSeries } from '../src/anime/types.js';
import type { HandlerInput } from '../src/telegram/handlers/types.js';

const SERIES: AnimeSeries = {
  source: 'anilist',
  sourceId: '207141',
  title: 'Chainsmoker Cat',
  aliases: [],
  titleKeys: ['chainsmoker cat'],
  url: 'https://anilist.co/anime/207141',
  status: 'ongoing',
  genres: ['Comedy'],
  studios: ['Bibury'],
  externalIds: {},
  latestEpisode: 7,
  nextEpisode: { episode: 8, airingAt: new Date('2026-08-20T00:00:00Z') },
  airingWeekday: 4,
  score: 67,
};

function input(overrides: {
  args?: string[];
  follows?: Record<string, unknown>;
  anime?: Record<string, unknown>;
}): HandlerInput {
  return {
    services: {
      animeFollows: {
        enabled: true,
        follow: vi.fn(async () => ({ ok: true, created: true, series: SERIES })),
        unfollow: vi.fn(async () => ({ ok: true, series: SERIES })),
        list: vi.fn(async () => []),
        ...overrides.follows,
      },
      anime: {
        enabled: true,
        handle: vi.fn(async () => ({
          resolved: true,
          summary: 'Titolo: Chainsmoker Cat',
          candidates: [],
          sources: [],
        })),
        ...overrides.anime,
      },
    },
    person: { userHandle: '@u', telegramId: 1 },
    context: { chatId: -100, threadId: undefined },
    args: overrides.args ?? [],
  } as unknown as HandlerInput;
}

describe('/follow', () => {
  it('creates the subscription deterministically, without any intent classification', async () => {
    const follows = {
      follow: vi.fn(async () => ({ ok: true, created: true, series: SERIES })),
    };
    const result = await followCommand.handle(input({ args: ['Chainsmoker', 'Cat'], follows }));

    // The whole point: "segui X" as free text depended on the planner and silently did nothing
    // when it guessed banter instead.
    expect(follows.follow).toHaveBeenCalledOnce();
    expect(follows.follow.mock.calls[0]?.[0]).toBe('Chainsmoker Cat');
    expect(result?.text).toBe('follow_created');
  });

  it('says so instead of pretending, when the series is already followed', async () => {
    const follows = {
      follow: vi.fn(async () => ({ ok: false as const, reason: 'not_found', candidates: [] })),
    };
    const result = await followCommand.handle(input({ args: ['Roba', 'Inesistente'], follows }));
    expect(result?.text).toBe('follow_not_found');
  });

  it('lists candidates rather than picking one when the title is ambiguous', async () => {
    const follows = {
      follow: vi.fn(async () => ({
        ok: false as const,
        reason: 'ambiguous',
        candidates: [SERIES, { ...SERIES, sourceId: '2', title: 'Chainsmoker Cat Minis' }],
      })),
    };
    const result = await followCommand.handle(input({ args: ['chainsmoker'], follows }));
    expect(result?.text).toBe('follow_ambiguous');
  });

  it('shows usage with no argument and never touches the service', async () => {
    const follows = { follow: vi.fn() };
    const result = await followCommand.handle(input({ args: [], follows }));
    expect(result?.text).toBe('follow_usage');
    expect(follows.follow).not.toHaveBeenCalled();
  });

  it('reports the per-chat limit', async () => {
    const follows = {
      follow: vi.fn(async () => ({ ok: false as const, reason: 'limit_reached', candidates: [] })),
    };
    expect((await followCommand.handle(input({ args: ['X Y'], follows })))?.text).toBe(
      'follow_limit',
    );
  });

  it('reports a disabled catalog rather than failing silently', async () => {
    const result = await followCommand.handle(input({ args: ['X'], follows: { enabled: false } }));
    expect(result?.text).toBe('anime_disabled');
  });
});

describe('/unfollow and /following', () => {
  it('removes a subscription', async () => {
    expect((await unfollowCommand.handle(input({ args: ['Chainsmoker Cat'] })))?.text).toBe(
      'unfollow_done',
    );
  });

  it('reports a series that was not followed', async () => {
    const follows = {
      unfollow: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_following',
        candidates: [],
      })),
    };
    expect((await unfollowCommand.handle(input({ args: ['X Y'], follows })))?.text).toBe(
      'unfollow_not_following',
    );
  });

  it('reports an empty subscription list', async () => {
    expect((await followingCommand.handle(input({})))?.text).toBe('following_empty');
  });

  it('lists what the chat follows', async () => {
    const follows = {
      list: vi.fn(async () => [
        {
          sourceId: '207141',
          title: 'Chainsmoker Cat',
          lastNotifiedEpisode: 99,
          archiveLastNotifiedEpisode: 7,
        },
      ]),
    };
    const result = await followingCommand.handle(input({ follows }));
    expect(result?.text).toBe('following_list');
    // `trustedHtml` wraps the rendered list, so read through the wrapper.
    const series = result?.vars?.['series'] as { kind: string; value: string };
    expect(series.kind).toBe('trusted_html');
    expect(series.value).toContain('Chainsmoker Cat');
    expect(series.value).toContain('ep. 7');
    expect(series.value).not.toContain('ep. 99');
    expect(series.value).not.toMatch(/href=|https?:\/\//i);
  });
});

describe('/anime', () => {
  it('asks the catalog as a timeline question so a franchise resolves to the airing entry', async () => {
    const anime = {
      handle: vi.fn(async () => ({
        resolved: true,
        summary: 'ok',
        candidates: [],
        sources: [],
      })),
    };
    await animeCommand.handle(input({ args: ['Tanya', 'the', 'Evil'], anime }));
    const request = anime.handle.mock.calls[0]?.[0] as { question: string; title: string };
    expect(request.title).toBe('Tanya the Evil');
    expect(request.question).toMatch(/prossimo episodio/i);
  });

  it('reports an unknown title', async () => {
    const anime = {
      handle: vi.fn(async () => ({
        resolved: false,
        summary: '',
        candidates: [],
        sources: [],
      })),
    };
    expect((await animeCommand.handle(input({ args: ['Boh'], anime })))?.text).toBe(
      'anime_not_found',
    );
  });
});

describe('command surface', () => {
  it('registers all four commands', () => {
    const names = commandHandlers.map((c) => c.command);
    expect(names).toEqual(expect.arrayContaining(['follow', 'unfollow', 'following', 'anime']));
  });

  it('translates every new key into all four supported languages', () => {
    const keys = [
      'follow_description',
      'unfollow_description',
      'following_description',
      'anime_description',
      'follow_usage',
      'follow_created',
      'follow_already',
      'follow_ambiguous',
      'follow_not_found',
      'follow_limit',
      'unfollow_done',
      'unfollow_not_following',
      'following_empty',
      'following_list',
      'anime_usage',
      'anime_not_found',
      'anime_disabled',
    ];
    for (const key of keys) {
      const entry = translations[key];
      expect(entry, `missing translation: ${key}`).toBeDefined();
      for (const language of ['italian', 'english', 'russian', 'spanish']) {
        expect(entry?.[language], `${key} is missing ${language}`).toBeTruthy();
      }
    }
  });

  it('documents the commands in both the Italian and English help', () => {
    const help = translations['help_text'];
    for (const language of ['italian', 'english']) {
      const text = String(help?.[language] ?? '');
      for (const command of ['/anime', '/follow', '/unfollow', '/following']) {
        expect(text, `${language} help is missing ${command}`).toContain(command);
      }
    }
    // The Italian aliases the group will actually type.
    expect(String(help?.['italian'])).toContain('/segui');
  });
});

describe('describeSeriesCompact', () => {
  it('keeps what answers the question and drops what only costs tokens', () => {
    const compact = describeSeriesCompact(SERIES);
    expect(compact).toContain('ep. 7');
    expect(compact).toContain('prossimo ep. 8');
    expect(compact).not.toMatch(/https?:\/\//i);
    expect(compact).not.toContain('Comedy');
    expect(compact).not.toContain('Bibury');
    expect(compact).not.toContain('67');
  });

  it('omits sections the source did not publish', () => {
    const bare = describeSeriesCompact({
      ...SERIES,
      latestEpisode: undefined,
      nextEpisode: undefined,
    });
    expect(bare).toContain('Chainsmoker Cat');
    expect(bare).not.toContain('prossimo');
    expect(bare).not.toContain('undefined');
  });

  it('never renders catalog or legacy gateway links in factual text', () => {
    const legacy = {
      ...SERIES,
      streamingLinks: [
        { site: 'Crunchyroll', url: 'https://www.crunchyroll.com/series/legacy' },
        { site: 'YouTube', url: 'https://youtube.com/watch?v=legacy' },
        { site: 'OceanVeil', url: 'https://oceanveil.example/watch/legacy' },
      ],
    } as AnimeSeries & { streamingLinks: Array<{ site: string; url: string }> };
    const rendered = [
      describeSeries(legacy),
      summarizeSeries(legacy),
      describeSeriesCompact(legacy),
      describeCandidates([legacy]),
    ].join('\n');

    expect(rendered).toContain('Chainsmoker Cat');
    expect(rendered).not.toMatch(/https?:\/\/|anilist|crunchyroll|youtube|oceanveil/i);
  });
});

describe('anime composer context', () => {
  it('forbids the model from suggesting watch, gateway or download links', () => {
    const prompt = formatAnimeAnswer({
      resolved: true,
      summary: 'Titolo: Chainsmoker Cat\nUltimo episodio uscito: 7',
    });

    expect(prompt).toMatch(/never suggest or invent/i);
    expect(prompt).toMatch(/watch, streaming, gateway or download links/i);
    expect(prompt).toMatch(/availability is handled separately/i);
  });
});
