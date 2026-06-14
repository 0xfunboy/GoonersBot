import { describe, expect, it } from 'vitest';
import { PermissionService } from '../src/services/permissions.js';
import type { ChatContext, Person } from '../src/domain/types.js';
import { fakeStorage } from './helpers.js';

const person: Person = { telegramId: 1, userHandle: '@bob' };
const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  chatId: -1,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: false,
  ...over,
});

function svc(opts: { allowed?: string[] | null; admins?: string[] | null; banned?: string[] }) {
  const bannedSet = new Set(opts.banned ?? []);
  const storage = fakeStorage({
    bans: { isBanned: async (h: string) => bannedSet.has(h) },
  });
  return new PermissionService(storage, opts.allowed ?? null, opts.admins ?? null);
}

describe('PermissionService', () => {
  it('allowed_user: null list => everyone allowed', async () => {
    expect(await svc({ allowed: null }).check('allowed_user', person, ctx())).toBe(true);
  });
  it('allowed_user: restricts to listed handles', async () => {
    expect(await svc({ allowed: ['@alice'] }).check('allowed_user', person, ctx())).toBe(false);
    expect(await svc({ allowed: ['@bob'] }).check('allowed_user', person, ctx())).toBe(true);
  });
  it('group_admin reflects context flag', async () => {
    const s = svc({});
    expect(await s.check('group_admin', person, ctx({ isGroupAdmin: false }))).toBe(false);
    expect(await s.check('group_admin', person, ctx({ isGroupAdmin: true }))).toBe(true);
  });
  it('bot_admin requires the handle in ADMIN_HANDLES', async () => {
    expect(await svc({ admins: null }).check('bot_admin', person, ctx())).toBe(false);
    expect(await svc({ admins: ['@bob'] }).check('bot_admin', person, ctx())).toBe(true);
  });
  it('admin passes for group admins OR bot admins', async () => {
    // group admin, not a bot admin
    expect(await svc({ admins: null }).check('admin', person, ctx({ isGroupAdmin: true }))).toBe(
      true,
    );
    // bot admin, not a group admin
    expect(
      await svc({ admins: ['@bob'] }).check('admin', person, ctx({ isGroupAdmin: false })),
    ).toBe(true);
    // neither
    expect(await svc({ admins: null }).check('admin', person, ctx({ isGroupAdmin: false }))).toBe(
      false,
    );
  });
  it('not_banned fails for banned users', async () => {
    expect(await svc({ banned: ['@bob'] }).check('not_banned', person, ctx())).toBe(false);
    expect(await svc({ banned: [] }).check('not_banned', person, ctx())).toBe(true);
  });
  it('checkAll requires every permission (AND)', async () => {
    const s = svc({ allowed: ['@bob'], banned: [] });
    expect(
      await s.checkAll(['allowed_user', 'not_banned'], person, ctx({ isGroupAdmin: true })),
    ).toBe(true);
    expect(
      await s.checkAll(['allowed_user', 'group_admin'], person, ctx({ isGroupAdmin: false })),
    ).toBe(false);
  });
});
