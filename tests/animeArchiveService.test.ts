import { describe, expect, it, vi } from 'vitest';
import type { GroupQuotaService } from '../src/services/groupQuota.js';
import type { Storage } from '../src/storage/index.js';
import {
  animeArchiveJobIdempotencyKey,
  animeArchiveOfferDedupeKey,
  classifyAnimeArchiveOfferTransition,
  mergeAnimeArchiveSeriesSnapshot,
  type AnimeArchiveJobDoc,
  type AnimeArchiveOfferActor,
  type AnimeArchiveOfferDoc,
  type CreateAnimeArchiveJobInput,
  type CreateAnimeArchiveOfferInput,
} from '../src/storage/repositories/animeArchive.js';
import { AnimeSourceRegistry } from '../src/anime/archive/registry.js';
import { classifyAnimeUnityUrl } from '../src/anime/archive/animeUnity.js';
import { classifyHentaiSaturnUrl } from '../src/anime/archive/hentaiSaturn.js';
import {
  AnimeArchiveService,
  animeArchiveConfirmationKeyboard,
  parseAnimeArchiveCallbackArgs,
  parseAnimeArchiveConfirmationDecision,
  type AnimeArchiveServiceConfig,
} from '../src/anime/archive/service.js';
import type {
  AnimeArchiveEpisode,
  AnimeArchiveSearchResult,
  AnimeArchiveSeries,
  AnimeSourceAdapter,
} from '../src/anime/archive/types.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const ANIMEUNITY_SERIES_URL = 'https://www.animeunity.so/anime/1-frieren';
const ANIMEUNITY_EPISODE_URL = `${ANIMEUNITY_SERIES_URL}/101`;
const HENTAI_SERIES_URL = 'https://www.hentaisaturn.tv/hentai/night-shift-nurses';
const HENTAI_EPISODE_URL = 'https://www.hentaisaturn.tv/episode/night-shift-nurses/ep-1';

function animeUnityEpisode(
  sourceId: string,
  number: string,
  title = `Frieren — Episodio ${number}`,
): AnimeArchiveEpisode {
  return {
    source: 'animeunity',
    sourceId,
    seriesId: '1',
    seriesSlug: 'frieren',
    seriesTitle: 'Frieren',
    number,
    order: Number(number),
    title,
    canonicalUrl: `${ANIMEUNITY_SERIES_URL}/${sourceId}`,
    canonicalSeriesUrl: ANIMEUNITY_SERIES_URL,
  };
}

function animeUnitySeries(overrides: Partial<AnimeArchiveSeries> = {}): AnimeArchiveSeries {
  return {
    source: 'animeunity',
    sourceId: '1',
    slug: 'frieren',
    title: 'Frieren',
    aliases: ['Sousou no Frieren'],
    canonicalUrl: ANIMEUNITY_SERIES_URL,
    status: 'ongoing',
    genres: ['Fantasy'],
    episodes: [animeUnityEpisode('100', '1'), animeUnityEpisode('101', '2')],
    externalIds: { anilist: 154587 },
    ...overrides,
  };
}

function hentaiEpisode(): AnimeArchiveEpisode {
  return {
    source: 'hentaisaturn',
    sourceId: 'night-shift-nurses:ep-1',
    seriesId: 'night-shift-nurses',
    seriesSlug: 'night-shift-nurses',
    seriesTitle: 'Night Shift Nurses',
    number: '1',
    order: 1,
    title: 'Night Shift Nurses — Episodio 1',
    canonicalUrl: HENTAI_EPISODE_URL,
    canonicalSeriesUrl: HENTAI_SERIES_URL,
  };
}

function hentaiSeries(): AnimeArchiveSeries {
  return {
    source: 'hentaisaturn',
    sourceId: 'night-shift-nurses',
    slug: 'night-shift-nurses',
    title: 'Night Shift Nurses',
    aliases: [],
    canonicalUrl: HENTAI_SERIES_URL,
    status: 'completed',
    genres: ['Hentai'],
    episodes: [hentaiEpisode()],
    externalIds: {},
  };
}

function adapter(
  source: AnimeSourceAdapter['source'],
  series: AnimeArchiveSeries,
  searchResults: AnimeArchiveSearchResult[] = [],
): AnimeSourceAdapter & {
  getSeries: ReturnType<typeof vi.fn>;
  getEpisode: ReturnType<typeof vi.fn>;
  listEpisodes: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  const classify = source === 'animeunity' ? classifyAnimeUnityUrl : classifyHentaiSaturnUrl;
  return {
    source,
    classify,
    getSeries: vi.fn(async () => series),
    getEpisode: vi.fn(async () => series.episodes[0] as AnimeArchiveEpisode),
    listEpisodes: vi.fn(async () => series.episodes),
    resolveMedia: vi.fn(async () => ({
      source,
      episode: series.episodes[0] as AnimeArchiveEpisode,
      candidates: [],
      resolvedAt: NOW,
    })),
    search: vi.fn(async () => searchResults),
  };
}

function config(
  overrides: { enabled?: boolean; bulkEnabled?: boolean; nsfwAllow?: boolean } = {},
): AnimeArchiveServiceConfig {
  return {
    animeArchive: {
      enabled: overrides.enabled ?? true,
      bulkEnabled: overrides.bulkEnabled ?? true,
      maxDurationSeconds: 7_200,
      maxDownloadBytes: 2_048 * 1_024 * 1_024,
      bulkConcurrency: 1,
      timeoutMs: 30_000,
      offerTtlMinutes: 15,
      maxRetries: 3,
      tmpDir: '/tmp/anime-archive-test',
    },
    linkMedia: { nsfwAllow: overrides.nsfwAllow ?? false },
  };
}

interface Harness {
  service: AnimeArchiveService;
  animeUnity: ReturnType<typeof adapter>;
  hentaiSaturn: ReturnType<typeof adapter>;
  offers: InMemoryOffers;
  jobs: InMemoryJobs;
  canReserveMedia: ReturnType<typeof vi.fn>;
  kick: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    config?: AnimeArchiveServiceConfig;
    animeUnitySeries?: AnimeArchiveSeries;
    animeUnitySearch?: AnimeArchiveSearchResult[];
    hentaiSearch?: AnimeArchiveSearchResult[];
    quota?: { allowed: boolean; reason?: 'media' | 'media_bytes' };
    now?: () => Date;
  } = {},
): Harness {
  const auSeries = options.animeUnitySeries ?? animeUnitySeries();
  const au = adapter('animeunity', auSeries, options.animeUnitySearch ?? []);
  au.getEpisode.mockImplementation(async () => auSeries.episodes.at(-1));
  const hs = adapter('hentaisaturn', hentaiSeries(), options.hentaiSearch ?? []);
  const registry = new AnimeSourceRegistry([au, hs]);
  const offers = new InMemoryOffers();
  const jobs = new InMemoryJobs();
  const storage = { animeArchive: { offers, jobs } } as unknown as Storage;
  const canReserveMedia = vi.fn(async () => options.quota ?? { allowed: true });
  const quota = { canReserveMedia } as unknown as GroupQuotaService;
  const kick = vi.fn();
  return {
    service: new AnimeArchiveService(
      options.config ?? config(),
      storage,
      quota,
      registry,
      kick,
      options.now ?? (() => NOW),
    ),
    animeUnity: au,
    hentaiSaturn: hs,
    offers,
    jobs,
    canReserveMedia,
    kick,
  };
}

const context = {
  chatId: -100,
  threadId: 42,
  replyToMessageId: 7,
  requesterTelegramId: 123,
  isAdmin: false,
};

describe('AnimeArchiveService direct URL routing', () => {
  it('classifies supported URLs in text and exposes the NSFW policy result', () => {
    const { service } = harness();
    const matches = service.classifyText(
      `uno ${ANIMEUNITY_EPISODE_URL}?tracking=1, due ${HENTAI_EPISODE_URL}.`,
    );

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      allowed: true,
      classification: { source: 'animeunity', kind: 'episode' },
    });
    expect(matches[0]?.url).not.toContain('?tracking');
    expect(matches[1]).toMatchObject({
      allowed: false,
      blockedReason: 'nsfw_disabled',
      classification: { source: 'hentaisaturn', kind: 'episode' },
    });
  });

  it('prechecks quota, resolves metadata and creates one idempotent episode job', async () => {
    const { service, canReserveMedia, animeUnity, jobs, kick } = harness();
    const result = await service.prepareDirectEpisode({
      ...context,
      url: ANIMEUNITY_EPISODE_URL,
    });

    expect(result).toMatchObject({ status: 'queued', created: true });
    expect(canReserveMedia).toHaveBeenCalledWith(-100, 1);
    expect(canReserveMedia.mock.invocationCallOrder[0]).toBeLessThan(
      animeUnity.getEpisode.mock.invocationCallOrder[0] as number,
    );
    expect(jobs.inputs[0]).toMatchObject({
      scope: 'episode',
      source: 'animeunity',
      destination: { chatId: -100, threadId: 42, replyToMessageId: 7 },
      requesterTelegramId: 123,
      quotaBypass: false,
      maxAttempts: 4,
      episodes: [{ id: '101', number: 2 }],
    });
    expect(kick).toHaveBeenCalledOnce();
  });

  it('stops before metadata when quota preflight denies the request', async () => {
    const { service, animeUnity, jobs, kick } = harness({
      quota: { allowed: false, reason: 'media' },
    });
    const result = await service.prepareDirectEpisode({
      ...context,
      url: ANIMEUNITY_EPISODE_URL,
    });

    expect(result).toMatchObject({
      status: 'rejected',
      reason: 'quota_denied',
      quota: { allowed: false, reason: 'media' },
    });
    expect(animeUnity.getEpisode).not.toHaveBeenCalled();
    expect(jobs.inputs).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it('persists a trusted quota bypass and does not consume a preflight check', async () => {
    const { service, canReserveMedia, jobs } = harness();
    await service.prepareDirectEpisode({
      ...context,
      url: ANIMEUNITY_EPISODE_URL,
      quotaBypass: true,
    });
    expect(canReserveMedia).not.toHaveBeenCalled();
    expect(jobs.inputs[0]?.quotaBypass).toBe(true);
  });

  it('never contacts HentaiSaturn while the existing NSFW media policy is off', async () => {
    const { service, hentaiSaturn } = harness();
    const result = await service.prepareDirectEpisode({
      ...context,
      url: HENTAI_EPISODE_URL,
    });
    expect(result).toEqual({ status: 'rejected', reason: 'nsfw_disabled' });
    expect(hentaiSaturn.getEpisode).not.toHaveBeenCalled();
  });
});

describe('AnimeArchiveService secure series confirmation', () => {
  it('rejects a non-admin before source lookup and never starts a series immediately', async () => {
    const { service, animeUnity, offers, jobs } = harness();
    const result = await service.prepareSeries({
      ...context,
      url: ANIMEUNITY_SERIES_URL,
    });

    expect(result).toEqual({ status: 'rejected', reason: 'admin_required' });
    expect(animeUnity.getSeries).not.toHaveBeenCalled();
    expect(offers.docs).toHaveLength(0);
    expect(jobs.inputs).toHaveLength(0);
  });

  it('stores an expiring admin offer and returns a one-row opaque SI/NO keyboard', async () => {
    const { service, offers, jobs } = harness();
    const result = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });

    expect(result).toMatchObject({
      status: 'confirmation_required',
      offer: {
        state: 'pending',
        requiresAdmin: true,
        chatId: -100,
        threadId: 42,
        requesterTelegramId: 123,
      },
      keyboard: { columns: 2 },
    });
    if (result.status !== 'confirmation_required') throw new Error('expected offer');
    expect(result.offer.expiresAt).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    expect(result.keyboard.options.map((option) => option.id)).toEqual([
      `yes|${result.offer.id}`,
      `no|${result.offer.id}`,
    ]);
    expect(JSON.stringify(result.keyboard)).not.toContain(ANIMEUNITY_SERIES_URL);
    expect(jobs.inputs).toHaveLength(0);
    expect(offers.docs).toHaveLength(1);
  });

  it('re-checks admin for YES but always lets the owner invalidate with NO', async () => {
    const { service, offers } = harness();
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');

    expect(
      await service.confirm({
        offerId: prepared.offer.id,
        decision: 'yes',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: false,
      }),
    ).toEqual({ status: 'rejected', reason: 'admin_required' });
    expect(offers.docs[0]?.state).toBe('pending');

    expect(
      await service.confirm({
        offerId: prepared.offer.id,
        decision: 'no',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: false,
      }),
    ).toMatchObject({ status: 'cancelled', offer: { state: 'cancelled' } });
  });

  it('enumerates, atomically accepts and queues one numerically ordered bulk job', async () => {
    const series = animeUnitySeries({
      episodes: [animeUnityEpisode('110', '10'), animeUnityEpisode('102', '2')],
    });
    const { service, jobs, kick } = harness({ animeUnitySeries: series });
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');

    const accepted = await service.confirmCallback(['yes', prepared.offer.id], {
      actorTelegramId: 123,
      chatId: -100,
      threadId: 42,
      isAdmin: true,
    });
    expect(accepted).toMatchObject({ status: 'queued', created: true });
    expect(jobs.inputs[0]).toMatchObject({
      scope: 'series',
      offerId: prepared.offer.id,
      episodes: [
        { id: '102', number: 2 },
        { id: '110', number: 10 },
      ],
    });
    expect(kick).toHaveBeenCalledOnce();

    expect(
      await service.confirmCallback(['yes', prepared.offer.id], {
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).toMatchObject({
      status: 'queued',
      created: false,
      job: { offerId: prepared.offer.id },
      offer: { id: prepared.offer.id, state: 'accepted' },
    });
    expect(jobs.inputs).toHaveLength(1);
  });

  it('repairs an accepted offer when job persistence failed after the CAS', async () => {
    const { service, offers, jobs, kick } = harness();
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');
    jobs.failNextCreate = true;

    await expect(
      service.confirm({
        offerId: prepared.offer.id,
        decision: 'yes',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).rejects.toThrow('injected job persistence failure');
    expect(offers.docs[0]?.state).toBe('accepted');
    expect(jobs.docs).toHaveLength(0);

    await expect(
      service.confirm({
        offerId: prepared.offer.id,
        decision: 'yes',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).resolves.toMatchObject({
      status: 'queued',
      created: true,
      offer: { id: prepared.offer.id, state: 'accepted' },
    });
    expect(jobs.docs).toHaveLength(1);
    expect(kick).toHaveBeenCalledOnce();
  });

  it('merges a newly available series episode without ever requeueing completed rows', async () => {
    const series = animeUnitySeries();
    const { service, jobs, kick } = harness({ animeUnitySeries: series });
    const first = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (first.status !== 'confirmation_required') throw new Error('expected offer');
    await service.confirm({
      offerId: first.offer.id,
      decision: 'yes',
      actorTelegramId: 123,
      chatId: -100,
      threadId: 42,
      isAdmin: true,
    });
    const durable = jobs.docs[0] as AnimeArchiveJobDoc;
    for (const [index, row] of durable.episodes.entries()) {
      row.status = 'done';
      row.receipt = { chatId: -100, messageId: 900 + index };
      row.completedAt = NOW;
    }
    durable.state = 'done';
    durable.finishedAt = NOW;
    const completedBefore = structuredClone(durable.episodes);

    const noChangeOffer = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (noChangeOffer.status !== 'confirmation_required') throw new Error('expected offer');
    const noChange = await service.confirm({
      offerId: noChangeOffer.offer.id,
      decision: 'yes',
      actorTelegramId: 123,
      chatId: -100,
      threadId: 42,
      isAdmin: true,
    });
    expect(noChange).toMatchObject({ status: 'queued', created: false, changed: false });
    expect(kick).toHaveBeenCalledTimes(1);

    series.episodes.push(animeUnityEpisode('102', '3'));
    const newEpisodeOffer = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (newEpisodeOffer.status !== 'confirmation_required') throw new Error('expected offer');
    const extended = await service.confirm({
      offerId: newEpisodeOffer.offer.id,
      decision: 'yes',
      actorTelegramId: 123,
      chatId: -100,
      threadId: 42,
      isAdmin: true,
    });
    expect(extended).toMatchObject({
      status: 'queued',
      created: false,
      changed: true,
      job: {
        state: 'queued',
        episodes: [{ status: 'done' }, { status: 'done' }, { status: 'pending' }],
      },
    });
    if (extended.status !== 'queued') throw new Error('expected queued');
    expect(extended.job.episodes.slice(0, 2)).toEqual(completedBefore);
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh timestamp at the post-fetch CAS so an offer cannot expire in flight', async () => {
    let clock = NOW;
    const { service, animeUnity, jobs } = harness({ now: () => clock });
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');
    animeUnity.listEpisodes.mockImplementation(async () => {
      clock = new Date(prepared.offer.expiresAt.getTime() + 1);
      return animeUnitySeries().episodes;
    });

    expect(
      await service.confirm({
        offerId: prepared.offer.id,
        decision: 'yes',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).toEqual({ status: 'rejected', reason: 'expired' });
    expect(jobs.inputs).toHaveLength(0);
  });
});

describe('AnimeArchiveService natural availability and textual confirmation', () => {
  const frierenHit: AnimeArchiveSearchResult = {
    source: 'animeunity',
    sourceId: '1',
    slug: 'frieren',
    title: 'Frieren',
    canonicalUrl: ANIMEUNITY_SERIES_URL,
    status: 'ongoing',
    genres: ['Fantasy'],
  };
  const hentaiHit: AnimeArchiveSearchResult = {
    source: 'hentaisaturn',
    sourceId: 'night-shift-nurses',
    slug: 'night-shift-nurses',
    title: 'Night Shift Nurses',
    canonicalUrl: HENTAI_SERIES_URL,
    status: 'completed',
    genres: ['Hentai'],
  };

  it('ranks deterministic source hits, caches briefly and excludes the adult adapter when gated', async () => {
    const { service, animeUnity, hentaiSaturn } = harness({
      animeUnitySearch: [
        {
          ...frierenHit,
          sourceId: '2',
          slug: 'frieren-mini',
          title: 'Frieren Mini',
          canonicalUrl: 'https://www.animeunity.so/anime/2-frieren-mini',
        },
        frierenHit,
      ],
      hentaiSearch: [hentaiHit],
    });

    const first = await service.findLatestAvailability('Frieren', { limit: 99 });
    const second = await service.findLatestAvailability('Frieren', { limit: 99 });
    expect(first).toMatchObject({
      fromCache: false,
      match: { result: { sourceId: '1' }, episode: { sourceId: '101' } },
    });
    expect(second.fromCache).toBe(true);
    expect(animeUnity.search).toHaveBeenCalledWith('Frieren', 5, undefined);
    expect(animeUnity.search).toHaveBeenCalledOnce();
    expect(animeUnity.getSeries).toHaveBeenCalledOnce();
    expect(hentaiSaturn.search).not.toHaveBeenCalled();
  });

  it('retries conservative season-title variants before declaring a quoted episode unavailable', async () => {
    const tanyaUrl = 'https://www.animeunity.so/anime/7615-saga-of-tanya-the-evil-2';
    const tanyaHit: AnimeArchiveSearchResult = {
      source: 'animeunity',
      sourceId: '7615',
      slug: 'saga-of-tanya-the-evil-2',
      title: 'Youjo Senki 2',
      canonicalUrl: tanyaUrl,
      status: 'ongoing',
      genres: [],
      episodeCount: 7,
      year: '2026',
    };
    const tanyaEpisodes = Array.from({ length: 7 }, (_, index) => {
      const number = String(index + 1);
      return {
        ...animeUnityEpisode(`tanya-${number}`, number),
        seriesId: '7615',
        seriesSlug: 'saga-of-tanya-the-evil-2',
        seriesTitle: 'Youjo Senki 2',
        canonicalUrl: `${tanyaUrl}/tanya-${number}`,
        canonicalSeriesUrl: tanyaUrl,
      };
    });
    const { service, animeUnity } = harness();
    animeUnity.search.mockImplementation(async (query: string) =>
      query === 'Saga of Tanya the Evil 2' ? [tanyaHit] : [],
    );
    animeUnity.getSeries.mockResolvedValue(
      animeUnitySeries({
        sourceId: '7615',
        slug: 'saga-of-tanya-the-evil-2',
        title: 'Youjo Senki 2',
        aliases: ['Saga of Tanya the Evil 2'],
        canonicalUrl: tanyaUrl,
        episodeCount: 7,
        episodes: tanyaEpisodes,
      }),
    );

    const prepared = await service.prepareNaturalEpisodeOffer({
      query: 'Saga of Tanya the Evil Season 2',
      expectedEpisodeNumber: 7,
      preferredSource: 'animeunity',
      chatId: -100,
      threadId: 42,
      requesterTelegramId: 123,
    });

    expect(prepared).toMatchObject({
      status: 'confirmation_required',
      series: { sourceId: '7615', title: 'Youjo Senki 2' },
      episode: { number: '7' },
    });
    expect(animeUnity.search.mock.calls.map((call) => call[0])).toEqual([
      'Saga of Tanya the Evil Season 2',
      'Saga of Tanya the Evil 2',
    ]);
  });

  it('uses the requested episode to disambiguate the two live Chainsmoker editions', async () => {
    const itaUrl = 'https://www.animeunity.so/anime/7600-yani-neko-ita';
    const subUrl = 'https://www.animeunity.so/anime/7601-yani-neko';
    const hit = (sourceId: string, canonicalUrl: string): AnimeArchiveSearchResult => ({
      source: 'animeunity',
      sourceId,
      slug: 'chainsmoker-cat',
      title: 'Chainsmoker Cat',
      canonicalUrl,
      status: 'ongoing',
      genres: [],
    });
    const edition = (sourceId: string, canonicalUrl: string, count: number): AnimeArchiveSeries => {
      const episodes = Array.from({ length: count }, (_, index) => {
        const number = String(index + 1);
        return {
          ...animeUnityEpisode(`${sourceId}-ep-${number}`, number),
          seriesId: sourceId,
          seriesSlug: 'chainsmoker-cat',
          seriesTitle: 'Chainsmoker Cat',
          canonicalUrl: `${canonicalUrl}/${sourceId}-ep-${number}`,
          canonicalSeriesUrl: canonicalUrl,
        };
      });
      return animeUnitySeries({
        sourceId,
        slug: 'chainsmoker-cat',
        title: sourceId === '7600' ? 'Yani Neko (ITA)' : 'Yani Neko',
        aliases: ['Chainsmoker Cat'],
        canonicalUrl,
        episodes,
      });
    };
    const { service, animeUnity, jobs, offers } = harness({
      animeUnitySearch: [hit('7600', itaUrl), hit('7601', subUrl)],
    });
    animeUnity.getSeries.mockImplementation(async (url) =>
      String(url) === itaUrl ? edition('7600', itaUrl, 5) : edition('7601', subUrl, 7),
    );

    const queued = await service.prepareNaturalEpisodeRequest({
      query: 'Chainsmoker Cat',
      expectedEpisodeNumber: 7,
      preferredSource: 'animeunity',
      chatId: -100,
      threadId: 42,
      replyToMessageId: 77,
      requesterTelegramId: 123,
    });

    expect(queued).toMatchObject({
      status: 'queued',
      created: true,
      job: {
        source: 'animeunity',
        series: { id: '7601' },
        episodes: [{ id: '7601-ep-7', number: 7 }],
      },
    });
    expect(animeUnity.getSeries).toHaveBeenCalledTimes(2);
    expect(jobs.inputs).toHaveLength(1);
    expect(offers.docs).toHaveLength(0);

    await expect(
      service.prepareNaturalEpisodeRequest({
        query: 'Chainsmoker Cat',
        expectedEpisodeNumber: 99,
        preferredSource: 'animeunity',
        chatId: -100,
        threadId: 42,
        requesterTelegramId: 123,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'not_found' });
    expect(jobs.inputs).toHaveLength(1);
  });

  it('never lets episode availability promote a fuzzy sequel over an exact title', async () => {
    const narutoUrl = 'https://www.animeunity.so/anime/8000-naruto';
    const borutoUrl = 'https://www.animeunity.so/anime/8001-boruto-naruto-next-generations';
    const result = (sourceId: string, title: string, canonicalUrl: string) => ({
      source: 'animeunity' as const,
      sourceId,
      slug: title.toLowerCase().replace(/\s+/gu, '-'),
      title,
      canonicalUrl,
      status: 'ongoing' as const,
      genres: [],
    });
    const { service, animeUnity, jobs } = harness({
      animeUnitySearch: [
        result('8000', 'Naruto', narutoUrl),
        result('8001', 'Boruto: Naruto Next Generations', borutoUrl),
      ],
    });
    animeUnity.getSeries.mockImplementation(async (url) =>
      String(url) === narutoUrl
        ? animeUnitySeries({
            sourceId: '8000',
            title: 'Naruto',
            canonicalUrl: narutoUrl,
            episodes: [animeUnityEpisode('naruto-1', '1')],
          })
        : animeUnitySeries({
            sourceId: '8001',
            title: 'Boruto: Naruto Next Generations',
            canonicalUrl: borutoUrl,
            episodes: [animeUnityEpisode('boruto-500', '500')],
          }),
    );

    await expect(
      service.prepareNaturalEpisodeRequest({
        query: 'Naruto',
        expectedEpisodeNumber: 500,
        chatId: -100,
        requesterTelegramId: 123,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'not_found' });
    expect(animeUnity.getSeries).toHaveBeenCalledOnce();
    expect(jobs.inputs).toHaveLength(0);
  });

  it('uses AnimeUnity before an allowed HentaiSaturn match by default', async () => {
    const hsFrieren: AnimeArchiveSearchResult = {
      source: 'hentaisaturn',
      sourceId: 'hs-frieren',
      slug: 'frieren',
      title: 'Frieren',
      canonicalUrl: 'https://www.hentaisaturn.tv/hentai/frieren',
      status: 'ongoing',
      genres: [],
    };
    const { service, animeUnity, hentaiSaturn } = harness({
      config: config({ nsfwAllow: true }),
      animeUnitySearch: [frierenHit],
      hentaiSearch: [hsFrieren],
    });

    await expect(service.findLatestAvailability('Frieren')).resolves.toMatchObject({
      match: { result: { source: 'animeunity' } },
    });
    expect(animeUnity.search).toHaveBeenCalledOnce();
    expect(hentaiSaturn.search).not.toHaveBeenCalled();
  });

  it('keeps Cortex-selected whole-series archive actions behind the admin confirmation boundary', async () => {
    const { service, offers } = harness({ animeUnitySearch: [frierenHit] });

    await expect(
      service.prepareNaturalSeriesOffer({
        query: 'Frieren',
        chatId: -100,
        threadId: 42,
        replyToMessageId: 77,
        requesterTelegramId: 123,
        isAdmin: false,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'admin_required' });
    expect(offers.docs).toHaveLength(0);

    await expect(
      service.prepareNaturalSeriesOffer({
        query: 'Frieren',
        chatId: -100,
        threadId: 42,
        replyToMessageId: 77,
        requesterTelegramId: 123,
        isAdmin: true,
      }),
    ).resolves.toMatchObject({
      status: 'confirmation_required',
      offer: { requiresAdmin: true, target: { kind: 'series' } },
      series: { title: 'Frieren' },
    });
    expect(offers.docs).toHaveLength(1);
  });

  it('turns a downloadable natural match into a normal episode offer, then reuses enqueue on YES', async () => {
    const { service, canReserveMedia, jobs } = harness({ animeUnitySearch: [frierenHit] });
    const prepared = await service.prepareNaturalEpisodeOffer({
      query: 'Frieren',
      chatId: -100,
      threadId: 42,
      replyToMessageId: 77,
      requesterTelegramId: 123,
    });
    expect(prepared).toMatchObject({
      status: 'confirmation_required',
      offer: { requiresAdmin: false, target: { kind: 'episode' } },
      episode: { sourceId: '101' },
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');
    expect(canReserveMedia).toHaveBeenCalledOnce();

    const queued = await service.confirm({
      offerId: prepared.offer.id,
      decision: 'yes',
      actorTelegramId: 123,
      chatId: -100,
      threadId: 42,
      isAdmin: false,
    });
    expect(queued).toMatchObject({ status: 'queued' });
    expect(canReserveMedia).toHaveBeenCalledTimes(2);
    expect(jobs.inputs[0]).toMatchObject({
      scope: 'episode',
      offerId: prepared.offer.id,
      destination: { replyToMessageId: 77 },
    });
  });

  it('binds a release prompt directly to the exact already-resolved source identity', async () => {
    const series = animeUnitySeries();
    const episode = series.episodes[1] as AnimeArchiveEpisode;
    const { service, animeUnity, offers } = harness();

    await expect(
      service.prepareResolvedEpisodeOffer({
        series,
        episode,
        chatId: -100,
        threadId: 42,
        requesterTelegramId: 123,
      }),
    ).resolves.toMatchObject({
      status: 'confirmation_required',
      offer: { target: { episode: { id: episode.sourceId } } },
    });
    expect(animeUnity.search).not.toHaveBeenCalled();
    expect(offers.docs).toHaveLength(1);

    await expect(
      service.prepareResolvedEpisodeOffer({
        series,
        episode: { ...episode, seriesId: 'different-edition' },
        chatId: -100,
        requesterTelegramId: 123,
      }),
    ).resolves.toEqual({ status: 'rejected', reason: 'source_unavailable' });
  });

  it('selects an expected decimal episode exactly and rejects a live-source mismatch', async () => {
    const series = animeUnitySeries({
      episodes: [
        animeUnityEpisode('100', '1'),
        animeUnityEpisode('half', '2.5'),
        animeUnityEpisode('103', '3'),
      ],
    });
    const { service, offers, animeUnity } = harness({
      animeUnitySeries: series,
      animeUnitySearch: [frierenHit],
    });

    const exact = await service.prepareNaturalEpisodeOffer({
      query: 'Frieren',
      expectedEpisodeNumber: '2,5',
      chatId: -100,
      threadId: 42,
      requesterTelegramId: 123,
    });
    expect(exact).toMatchObject({
      status: 'confirmation_required',
      episode: { sourceId: 'half', number: '2.5' },
      offer: { target: { kind: 'episode', episode: { id: 'half', number: 2.5 } } },
    });

    const mismatch = await service.prepareNaturalEpisodeOffer({
      query: 'Frieren',
      expectedEpisodeNumber: 4,
      chatId: -100,
      threadId: 42,
      requesterTelegramId: 123,
    });
    expect(mismatch).toEqual({ status: 'rejected', reason: 'not_found' });
    expect(offers.docs).toHaveLength(1);
    expect(animeUnity.search).toHaveBeenCalledTimes(2);
  });

  it('deduplicates equivalent pending offers and keeps unquoted SI scoped to delivered prompts', async () => {
    const { service, offers } = harness();
    const first = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    const second = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (first.status !== 'confirmation_required' || second.status !== 'confirmation_required') {
      throw new Error('expected offers');
    }
    expect(second.offer.id).toBe(first.offer.id);
    expect(offers.docs).toHaveLength(1);
    await service.attachConfirmationMessage(second.offer.id, 502);

    expect(
      await service.confirmText({
        text: 'no',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: false,
      }),
    ).toMatchObject({ status: 'cancelled', offer: { id: first.offer.id } });
  });

  it('ignores invisible offers and never falls back when a quoted message does not match', async () => {
    const { service } = harness();
    const invisible = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (invisible.status !== 'confirmation_required') throw new Error('expected offer');

    expect(
      await service.confirmText({
        text: 'sì',
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).toEqual({ status: 'rejected', reason: 'not_found' });

    await service.attachConfirmationMessage(invisible.offer.id, 501);

    expect(
      await service.confirmText({
        text: 'sì',
        replyToMessageId: 999,
        actorTelegramId: 123,
        chatId: -100,
        threadId: 42,
        isAdmin: true,
      }),
    ).toEqual({ status: 'rejected', reason: 'not_found' });
  });

  it('exposes safe invalidation for a prompt that was never delivered', async () => {
    const { service, offers } = harness();
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');

    await expect(service.invalidateOffer(prepared.offer.id)).resolves.toMatchObject({
      state: 'cancelled',
    });
    expect(offers.docs[0]?.state).toBe('cancelled');
  });

  it('exposes the atomically replaced confirmation message id for Telegram cleanup', async () => {
    const { service } = harness();
    const prepared = await service.prepareSeries({
      ...context,
      isAdmin: true,
      url: ANIMEUNITY_SERIES_URL,
    });
    if (prepared.status !== 'confirmation_required') throw new Error('expected offer');

    await expect(service.replaceConfirmationMessage(prepared.offer.id, 501)).resolves.toMatchObject(
      {
        replacedMessageId: null,
        offer: { confirmationMessageId: 501 },
      },
    );
    await expect(service.replaceConfirmationMessage(prepared.offer.id, 502)).resolves.toMatchObject(
      {
        replacedMessageId: 501,
        offer: { confirmationMessageId: 502 },
      },
    );
  });
});

describe('anime archive confirmation wire helpers', () => {
  it('encodes only action, decision and opaque nonce', () => {
    expect(animeArchiveConfirmationKeyboard('ao_safe_nonce')).toEqual({
      options: [
        { id: 'yes|ao_safe_nonce', label: 'SI' },
        { id: 'no|ao_safe_nonce', label: 'NO' },
      ],
      callback: 'anime_archive',
      buttonAction: 'anime_archive',
      columns: 2,
    });
    expect(parseAnimeArchiveCallbackArgs(['yes', 'ao_safe_nonce'])).toEqual({
      decision: 'yes',
      offerId: 'ao_safe_nonce',
    });
    expect(parseAnimeArchiveCallbackArgs(['yes', ANIMEUNITY_SERIES_URL])).toBeNull();
  });

  it('accepts short explicit textual decisions without matching arbitrary prose', () => {
    expect(parseAnimeArchiveConfirmationDecision('Sì, scaricalo!')).toBe('yes');
    expect(parseAnimeArchiveConfirmationDecision('non scaricare')).toBe('no');
    expect(parseAnimeArchiveConfirmationDecision('sì però prima spiegami la trama')).toBeNull();
  });
});

class InMemoryOffers {
  readonly docs: AnimeArchiveOfferDoc[] = [];
  private sequence = 0;

  async create(input: CreateAnimeArchiveOfferInput, now: Date): Promise<AnimeArchiveOfferDoc> {
    const dedupeKey = animeArchiveOfferDedupeKey(input);
    const existing = this.docs.find(
      (entry) =>
        entry.dedupeKey === dedupeKey && entry.state === 'pending' && entry.expiresAt > now,
    );
    if (existing) {
      existing.replyToMessageId = input.replyToMessageId ?? null;
      existing.requiresAdmin = input.requiresAdmin;
      existing.expiresAt = input.expiresAt ?? new Date(now.getTime() + 15 * 60_000);
      existing.updatedAt = now;
      return structuredClone(existing);
    }
    for (const entry of this.docs) {
      if (entry.dedupeKey === dedupeKey && entry.state === 'pending' && entry.expiresAt <= now) {
        entry.state = 'cancelled';
        entry.cancelledAt = now;
        entry.updatedAt = now;
      }
    }
    this.sequence += 1;
    const doc: AnimeArchiveOfferDoc = {
      id: `ao_test_${this.sequence}`,
      dedupeKey,
      source: input.source,
      target: structuredClone(input.target),
      chatId: input.chatId,
      threadId: input.threadId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      confirmationMessageId: null,
      requesterTelegramId: input.requesterTelegramId,
      requiresAdmin: input.requiresAdmin,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + 15 * 60_000),
      acceptedAt: null,
      cancelledAt: null,
    };
    this.docs.push(doc);
    return structuredClone(doc);
  }

  async attachConfirmationMessage(id: string, messageId: number, now: Date) {
    return (await this.replaceConfirmationMessage(id, messageId, now))?.offer ?? null;
  }

  async replaceConfirmationMessage(id: string, messageId: number, now: Date) {
    const doc = this.docs.find(
      (entry) => entry.id === id && entry.state === 'pending' && entry.expiresAt > now,
    );
    if (!doc) return null;
    const replacedMessageId = doc.confirmationMessageId;
    doc.confirmationMessageId = messageId;
    doc.updatedAt = now;
    return { offer: structuredClone(doc), replacedMessageId };
  }

  async invalidatePending(id: string, now: Date) {
    const doc = this.docs.find((entry) => entry.id === id && entry.state === 'pending');
    if (!doc) return null;
    doc.state = 'cancelled';
    doc.cancelledAt = now;
    doc.updatedAt = now;
    return structuredClone(doc);
  }

  async get(id: string) {
    const doc = this.docs.find((entry) => entry.id === id);
    return doc ? structuredClone(doc) : null;
  }

  async listLatestPendingForActor(
    actor: Omit<AnimeArchiveOfferActor, 'isAdmin'>,
    limit: number,
    now: Date,
  ) {
    return this.docs
      .filter(
        (entry) =>
          entry.requesterTelegramId === actor.actorTelegramId &&
          entry.chatId === actor.chatId &&
          entry.threadId === (actor.threadId ?? null) &&
          entry.state === 'pending' &&
          entry.expiresAt > now &&
          typeof entry.confirmationMessageId === 'number',
      )
      .slice(-limit)
      .reverse()
      .map((entry) => structuredClone(entry));
  }

  async accept(id: string, actor: AnimeArchiveOfferActor, now: Date) {
    return this.transition(id, actor, 'accepted', now);
  }

  async cancel(id: string, actor: AnimeArchiveOfferActor, now: Date) {
    return this.transition(id, actor, 'cancelled', now);
  }

  private async transition(
    id: string,
    actor: AnimeArchiveOfferActor,
    state: 'accepted' | 'cancelled',
    now: Date,
  ) {
    const doc = this.docs.find((entry) => entry.id === id) ?? null;
    const reason = classifyAnimeArchiveOfferTransition(
      doc,
      actor,
      now,
      state === 'accepted' ? 'accept' : 'cancel',
    );
    if (reason) return { ok: false as const, reason };
    if (!doc) return { ok: false as const, reason: 'not_found' as const };
    doc.state = state;
    doc.updatedAt = now;
    if (state === 'accepted') doc.acceptedAt = now;
    else doc.cancelledAt = now;
    return { ok: true as const, offer: structuredClone(doc) };
  }
}

class InMemoryJobs {
  readonly inputs: CreateAnimeArchiveJobInput[] = [];
  readonly docs: AnimeArchiveJobDoc[] = [];
  failNextCreate = false;

  async create(input: CreateAnimeArchiveJobInput, now: Date) {
    this.inputs.push(structuredClone(input));
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('injected job persistence failure');
    }
    const key = animeArchiveJobIdempotencyKey(input);
    const existing = this.docs.find((doc) => doc.idempotencyKey === key);
    if (existing) return { created: false, job: structuredClone(existing) };
    const episodes = [...input.episodes]
      .sort((left, right) => left.number - right.number)
      .map((row, order) => ({
        ...row,
        order,
        status: 'pending' as const,
        attempts: 0,
        totalAttempts: 0,
        receipt: null,
        failureReason: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      }));
    const job: AnimeArchiveJobDoc = {
      id: `aj_test_${this.docs.length + 1}`,
      idempotencyKey: key,
      offerId: input.offerId ?? null,
      scope: input.scope,
      source: input.source,
      series: input.series,
      destination: {
        chatId: input.destination.chatId,
        threadId: input.destination.threadId ?? null,
        replyToMessageId: input.destination.replyToMessageId ?? null,
      },
      requesterTelegramId: input.requesterTelegramId,
      quotaBypass: input.quotaBypass ?? false,
      episodes,
      maxAttempts: input.maxAttempts ?? 3,
      state: 'queued',
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseRenewedAt: null,
      claimCount: 0,
      leaseRecoveryCount: 0,
      resumeCount: 0,
      skippedOnCurrentRun: 0,
      summary: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
    };
    this.docs.push(job);
    return { created: true, job: structuredClone(job) };
  }

  async createOrMergeSeriesSnapshot(input: CreateAnimeArchiveJobInput, now: Date) {
    const created = await this.create(input, now);
    if (created.created) {
      return {
        ...created,
        changed: true,
        addedEpisodes: created.job.episodes.length,
        resumed: false,
      };
    }
    const index = this.docs.findIndex((entry) => entry.id === created.job.id);
    if (index < 0) throw new Error('missing in-memory series job');
    const merged = mergeAnimeArchiveSeriesSnapshot(
      this.docs[index] as AnimeArchiveJobDoc,
      input.episodes,
      now,
    );
    if (merged.changed) this.docs[index] = structuredClone(merged.job);
    return { created: false, ...merged, job: structuredClone(merged.job) };
  }

  async getByOfferId(offerId: string) {
    const job = this.docs.find((entry) => entry.offerId === offerId);
    return job ? structuredClone(job) : null;
  }
}
