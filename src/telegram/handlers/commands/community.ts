import type { CommandSpec } from '../types.js';
import { Priority } from '../types.js';

const ACTIVE_DAYS = 30;

/**
 * /community - privacy-safe social-memory health summary. It exposes aggregate coverage and public
 * culture themes, never relationship direction, affinity/trust scores, confidence or provenance.
 */
export const communityCommand: CommandSpec = {
  command: 'community',
  aliases: ['social'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.LAST,
  async handle({ services, context }) {
    const [members, state] = await Promise.all([
      services.storage.socialProfiles.listMembers(context.chatId, 500),
      services.storage.socialProfiles.getChatState(context.chatId),
    ]);
    const activeSince = Date.now() - ACTIVE_DAYS * 86_400_000;
    const activeMembers = members.filter(
      (member) => member.lastSeenAt.getTime() >= activeSince,
    ).length;
    const facets = members.reduce(
      (count, member) => count + member.facets.filter((facet) => facet.state === 'active').length,
      0,
    );
    const jokes = state?.runningJokes.filter((joke) => joke.state === 'active') ?? [];
    const norms = state?.norms.filter((norm) => norm.state === 'active') ?? [];
    return {
      text: 'community_summary',
      vars: {
        members: members.length,
        active_members: activeMembers,
        facets,
        jokes: jokes.length,
        norms: norms.length,
        themes:
          jokes.length > 0
            ? jokes
                .slice(0, 5)
                .map((joke) => escapeHtml(joke.label))
                .join(' · ')
            : '—',
      },
    };
  },
};

/**
 * /socialstatus - admin observability for coverage and lifecycle only. Even admins do not receive
 * private relationship scores through a public Telegram message.
 */
export const socialstatusCommand: CommandSpec = {
  command: 'socialstatus',
  aliases: ['communitystatus'],
  permissions: ['admin', 'allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.ADMIN,
  adminOnly: true,
  async handle({ services, context }) {
    const [members, state] = await Promise.all([
      services.storage.socialProfiles.listMembers(context.chatId, 500),
      services.storage.socialProfiles.getChatState(context.chatId),
    ]);
    const allFacets = members.flatMap((member) => member.facets);
    const activeFacets = allFacets.filter((facet) => facet.state === 'active').length;
    const revisedFacets = allFacets.filter((facet) =>
      ['superseded', 'retracted', 'disputed', 'stale'].includes(facet.state),
    ).length;
    return {
      text: 'socialstatus_summary',
      vars: {
        members: members.length,
        active_facets: activeFacets,
        lifecycle_facets: revisedFacets,
        relationships: state?.relationships.length ?? 0,
        jokes: state?.runningJokes.length ?? 0,
        norms: state?.norms.length ?? 0,
        version: state?.version ?? 0,
      },
    };
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
