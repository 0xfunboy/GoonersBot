import { BUILTIN_MODES } from '../config/modes.js';
import type { ModeView } from '../storage/repositories/modes.js';
import type { Storage } from '../storage/index.js';

export class ModeService {
  constructor(private readonly storage: Storage) {}

  seedDefaults(chatId: number): Promise<void> {
    return this.storage.modes.seedDefaults(chatId, BUILTIN_MODES);
  }

  list(chatId: number): Promise<ModeView[]> {
    return this.storage.modes.list(chatId);
  }

  getActive(chatId: number): Promise<ModeView | null> {
    return this.storage.modes.getActive(chatId);
  }

  getNameById(chatId: number, modeId: string): Promise<string | null> {
    return this.storage.modes.getNameById(chatId, modeId);
  }

  setActive(chatId: number, modeId: string): Promise<boolean> {
    return this.storage.modes.setActive(chatId, modeId);
  }

  delete(chatId: number, modeId: string): Promise<boolean> {
    return this.storage.modes.delete(chatId, modeId);
  }

  /**
   * Add a custom mode. The mode name is derived from the first sentence/line of the description
   * (mirrors the original addmode_handler heuristic). A leading `[nsfw]` token flags the mode so it
   * always routes to the NSFW model (in chats that allow NSFW). Returns the resolved name, or null
   * if the description is empty / the name collides.
   */
  async add(chatId: number, description: string, createdByHandle: string): Promise<string | null> {
    let desc = description.trim();
    if (desc.length === 0) return null;
    let nsfw = false;
    const nsfwTag = /^\[nsfw\]\s*/i;
    if (nsfwTag.test(desc)) {
      nsfw = true;
      desc = desc.replace(nsfwTag, '').trim();
    }
    if (desc.length === 0) return null;
    const firstLine = desc.split('\n')[0] ?? desc;
    const name = (firstLine.split('.')[0] ?? firstLine).trim().slice(0, 64);
    if (name.length === 0) return null;
    const ok = await this.storage.modes.add(chatId, name, desc, createdByHandle, nsfw);
    return ok ? name : null;
  }
}
