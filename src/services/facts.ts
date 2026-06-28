import type { Storage } from '../storage/index.js';
import { normalizeHandle } from '../utils/handles.js';
import { containsSensitive } from '../utils/secrets.js';

/** Reject facts that contain secrets, credentials, infrastructure or personal data. */
export function isSensitiveFact(fact: string): boolean {
  return containsSensitive(fact);
}

export class FactService {
  constructor(private readonly storage: Storage) {}

  /** Manual /fact. Returns false if rejected (sensitive) - caller shows inappropriate_fact. */
  async addManualFact(
    chatId: number,
    targetHandle: string,
    fact: string,
    byHandle: string,
  ): Promise<boolean> {
    if (isSensitiveFact(fact)) return false;
    await this.storage.facts.add(chatId, normalizeHandle(targetHandle), fact, 'manual', byHandle);
    return true;
  }

  /** Automatic fact from extraction. Skips sensitive/empty silently. */
  async addAutoFact(chatId: number, targetHandle: string, fact: string): Promise<void> {
    const clean = fact.trim();
    if (clean.length === 0 || isSensitiveFact(clean)) return;
    await this.storage.facts.add(chatId, normalizeHandle(targetHandle), clean, 'auto', null);
  }

  /** /introduce. Returns false if rejected. */
  async addIntroduction(chatId: number, handle: string, introduction: string): Promise<boolean> {
    const clean = introduction.trim();
    if (clean.length === 0 || isSensitiveFact(clean)) return false;
    await this.storage.facts.setIntroduction(chatId, handle, clean);
    return true;
  }

  getForUser(chatId: number, handle: string): Promise<string[]> {
    return this.storage.facts.getForUser(chatId, normalizeHandle(handle));
  }

  getChatFacts(chatId: number): Promise<Array<{ handle: string; fact: string }>> {
    return this.storage.facts.getChatFacts(chatId);
  }

  getIntroduction(chatId: number, handle: string): Promise<string | null> {
    return this.storage.facts.getIntroduction(chatId, handle);
  }

  clearForUser(chatId: number, handle: string): Promise<number> {
    return this.storage.facts.clearForUser(chatId, normalizeHandle(handle));
  }
}
