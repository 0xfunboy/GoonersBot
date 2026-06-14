import type { Storage } from '../storage/index.js';

/**
 * Terms of use state. Ports the accept/decline flow. On decline, the user's custom stored data
 * is cleared (messages, facts, modes they created, PII) while safety bookkeeping (terms + bans)
 * is retained — matching the original behaviour and the documented terms text.
 */
export class TermsService {
  constructor(private readonly storage: Storage) {}

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
    await Promise.all([
      this.storage.messages.deleteByUser(handle),
      this.storage.facts.deleteByUser(handle),
      this.storage.modes.deleteByCreator(handle),
      this.storage.users.scrubPii(handle),
    ]);
  }
}
