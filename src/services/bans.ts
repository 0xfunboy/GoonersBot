import type { Storage } from '../storage/index.js';

export class BanService {
  constructor(
    private readonly storage: Storage,
    private readonly defaultBanSeconds: number,
  ) {}

  /**
   * Ban a user. `seconds === undefined` falls back to DEFAULT_BAN_SECONDS (0 => permanent).
   */
  async ban(handle: string, seconds: number | undefined, byHandle: string | null): Promise<number> {
    const duration = seconds ?? this.defaultBanSeconds;
    await this.storage.bans.ban(handle, duration, byHandle);
    return duration;
  }

  unban(handle: string): Promise<void> {
    return this.storage.bans.unban(handle);
  }

  isBanned(handle: string): Promise<boolean> {
    return this.storage.bans.isBanned(handle);
  }
}
