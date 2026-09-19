import type { Storage } from '../storage/index.js';

/**
 * Terms of use state. Ports the accept/decline flow. On decline, the user's custom stored data
 * is cleared (messages, facts, long-lived memory/social state, modes they created and PII) while
 * safety bookkeeping (terms + bans) is retained - matching the documented terms text.
 */
export class TermsService {
  constructor(
    private readonly storage: Storage,
    private readonly eraseWork?: (actorTelegramId: number) => Promise<void>,
  ) {}

  hasAccepted(handle: string): Promise<boolean> {
    return this.storage.terms.hasAccepted(handle);
  }

  hasDeclined(handle: string): Promise<boolean> {
    return this.storage.terms.hasDeclined(handle);
  }

  accept(handle: string): Promise<void> {
    return this.storage.terms.accept(handle);
  }

  async decline(handle: string): Promise<void> {
    await this.clearUserData(handle);
    await this.storage.terms.decline(handle);
  }

  /** Wipe a user's custom data across collections (used on decline). */
  async clearUserData(handle: string): Promise<void> {
    // Resolve the immutable actor id before scrubPii. Inbox payloads may include message text and
    // reply context, so active receipts participate in the same erasure boundary.
    const user = await this.storage.users.findByHandle(handle);
    if (user?.telegramId && this.eraseWork) await this.eraseWork(user.telegramId);
    // Historical usernames are linked only through observed immutable IDs. Fence miners before
    // deleting source rows, including jobs whose model call started before this revocation.
    const aliases =
      user?.telegramId && this.storage.users.listAliasesByTelegramId
        ? await this.storage.users.listAliasesByTelegramId(user.telegramId)
        : [handle];
    if (user?.telegramId && this.storage.eraseMemoryDerivedData)
      await this.storage.eraseMemoryDerivedData(user.telegramId, [
        ...new Set([handle, ...aliases]),
      ]);
    await Promise.all([
      this.storage.messages.deleteByUser(handle),
      this.storage.facts.deleteByUser(handle),
      this.storage.modes.deleteByCreator(handle),
      this.storage.users.scrubPii(handle),
      this.storage.memoryItems.deleteByHandleEverywhere(handle),
      this.storage.socialProfiles.deleteByHandleEverywhere(handle),
      ...(user?.telegramId ? [this.storage.updateInbox.redactByActor(user.telegramId)] : []),
    ]);
    for (const alias of aliases.filter((alias) => alias.toLowerCase() !== handle.toLowerCase())) {
      await Promise.all([
        this.storage.messages.deleteByUser(alias),
        this.storage.facts.deleteByUser(alias),
        this.storage.memoryItems.deleteByHandleEverywhere(alias),
        this.storage.socialProfiles.deleteByHandleEverywhere(alias),
        this.storage.users.scrubPii(alias),
      ]);
    }
  }
}
