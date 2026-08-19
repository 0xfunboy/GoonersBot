import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';
import { trustedHtml } from '../../../config/i18n.js';
import { summarizeSeries } from '../../../anime/answers.js';

/**
 * Explicit commands for the anime release catalog.
 *
 * These exist because natural language is not a reliable trigger for a *write*: "segui Chainsmoker
 * Cat" depends on the planner classifying it as a follow, and when it classifies it as banter
 * instead the subscription is silently never created - the user is told nothing and believes it
 * worked. A command cannot be misrouted.
 */

/** Escape user-controlled text before it enters an HTML response. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `/follow <title>` (alias `/segui`) - subscribe this chat to a series' new episodes. */
export const followCommand: CommandSpec = {
  command: 'follow',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, person, context, args }) {
    const title = args.join(' ').trim();
    if (!title) return { text: 'follow_usage' };
    if (!services.animeFollows.enabled) return { text: 'anime_disabled' };

    const outcome = await services.animeFollows.follow(title, {
      chatId: context.chatId,
      threadId: context.threadId,
      userHandle: person.userHandle,
    });

    if (outcome.ok) {
      const created: CommandResponse = {
        text: outcome.created ? 'follow_created' : 'follow_already',
        vars: { series: summarizeSeries(outcome.series) },
      };
      return created;
    }
    if (outcome.reason === 'limit_reached') return { text: 'follow_limit' };
    if (outcome.reason === 'ambiguous' && outcome.candidates.length > 0) {
      return {
        text: 'follow_ambiguous',
        vars: {
          title: escapeHtml(title),
          candidates: trustedHtml(
            outcome.candidates
              .slice(0, 5)
              .map((series) => `• <code>${escapeHtml(series.title)}</code>`)
              .join('\n'),
          ),
        },
      };
    }
    const notFound: CommandResponse = {
      text: 'follow_not_found',
      vars: { title: escapeHtml(title) },
    };
    return notFound;
  },
};

/** `/unfollow <title>` (alias `/smettidiseguire`) - drop a subscription. */
export const unfollowCommand: CommandSpec = {
  command: 'unfollow',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  async handle({ services, context, args }) {
    const title = args.join(' ').trim();
    if (!title) return { text: 'unfollow_usage' };
    if (!services.animeFollows.enabled) return { text: 'anime_disabled' };

    const outcome = await services.animeFollows.unfollow(title, context.chatId);
    const response: CommandResponse = outcome.ok
      ? { text: 'unfollow_done', vars: { series: summarizeSeries(outcome.series) } }
      : { text: 'unfollow_not_following', vars: { title: escapeHtml(title) } };
    return response;
  },
};

/** `/following` (alias `/seguite`) - what this chat is subscribed to. */
export const followingCommand: CommandSpec = {
  command: 'following',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, context }) {
    if (!services.animeFollows.enabled) return { text: 'anime_disabled' };
    const followed = await services.animeFollows.list(context.chatId);
    if (followed.length === 0) return { text: 'following_empty' };
    return {
      text: 'following_list',
      vars: {
        count: followed.length,
        series: trustedHtml(
          followed
            .map((entry) => {
              const lastEpisode = entry.archiveLastNotifiedEpisode ?? entry.lastNotifiedEpisode;
              const seen = lastEpisode >= 0 ? ` — ep. ${lastEpisode}` : '';
              return `• ${escapeHtml(entry.title)}${seen}`;
            })
            .join('\n'),
        ),
      },
    };
  },
};

/** `/anime <title>` (alias `/uscite`) - release status without waiting on intent classification. */
export const animeCommand: CommandSpec = {
  command: 'anime',
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: false,
  priority: Priority.DEFAULT,
  async handle({ services, person, context, args }) {
    const title = args.join(' ').trim();
    if (!title) return { text: 'anime_usage' };
    if (!services.anime.enabled) return { text: 'anime_disabled' };

    const answer = await services.anime.handle({
      intent: 'lookup',
      title,
      // A bare `/anime <title>` is a status question, so the airing entry of a franchise wins.
      question: `quando esce il prossimo episodio di ${title}`,
      chatId: context.chatId,
      threadId: context.threadId,
      userHandle: person.userHandle,
    });
    if (!answer.resolved) return { text: 'anime_not_found', vars: { title: escapeHtml(title) } };
    return { rawText: escapeHtml(answer.summary), textFormat: 'html' };
  },
};
