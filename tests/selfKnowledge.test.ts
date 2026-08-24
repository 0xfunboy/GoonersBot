import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/index.js';
import type { Storage } from '../src/storage/index.js';
import type { CapabilityForge } from '../src/capabilities/forge.js';
import { SelfKnowledgeService } from '../src/services/selfKnowledge.js';
import '../src/telegram/handlers/commands/index.js';

function service(lastTurn: unknown = null) {
  const config = {
    llm: { model: 'gemini-3.7-flash', nsfwModel: 'gemini-3.7-flash' },
    brain: {
      replyModel: 'gemini-3.7-flash',
      cortex: { model: 'gemini-3.5-flash-lite' },
      sceneModel: 'gemini-3.5-flash-lite',
      evaluatorModel: 'gemini-3.7-flash',
      plannerModel: 'gemini-3.7-flash',
    },
    env: { BRAIN_DEBUG_ENABLED: true },
  } as unknown as AppConfig;
  const storage = {
    brainDebug: { getLast: vi.fn().mockResolvedValue(lastTurn) },
  } as unknown as Storage;
  const capabilities = {
    list: vi.fn().mockReturnValue([{ command: 'babymetal' }]),
  } as unknown as CapabilityForge;
  return new SelfKnowledgeService(config, storage, capabilities);
}

const context = {
  chatId: -100,
  isGroup: true,
  isBotMentioned: false,
  isGroupAdmin: false,
  isReplyToBot: true,
};

describe('SelfKnowledgeService', () => {
  it('grounds /id implementation facts as raw integer output', async () => {
    const out = await service().buildContext({
      chatId: -100,
      message: 'Per quale motivo /id restituisce questo numero?',
      context,
    });

    expect(out).toContain('/id is a native deterministic command');
    expect(out).toContain('ordinary Telegram integer ID directly');
    expect(out).toContain('not an operating-system log');
    expect(out).toContain('do NOT have arbitrary journalctl/system-log access');
  });

  it('uses the previous persisted brain turn as an audit record without calling it system logs', async () => {
    const out = await service({
      inputMessageId: 77,
      scene: { currentTopic: 'formatted ID' },
      evaluation: { action: 'answer', valueTarget: 'truth' },
      cortex: { intents: ['answer'], toolCalls: [] },
      providerSources: [],
      finalText: 'old reply',
    }).buildContext({
      chatId: -100,
      message: 'perché hai risposto così? hai allucinato?',
      context,
    });

    expect(out).toContain('LAST STORED BRAIN TURN');
    expect(out).toContain('inputMessageId=77');
    expect(out).toContain('previous output="old reply"');
  });

  it('repairs known-false self claims before they can reach Telegram', () => {
    const s = service();
    expect(
      s.repairUnsupportedSelfClaim(
        'Leggo direttamente i log di sistema per sapere gli ID.',
        'come fai a sapere gli ID?',
      ),
    ).toContain('Non leggo journal/log di sistema');
    expect(
      s.repairUnsupportedSelfClaim(
        'Leggo direttamente i log di sistema e le notifiche Telegram.',
        'come fai a saperlo?',
      ),
    ).toContain('Non leggo journal/log di sistema');
    expect(
      s.repairUnsupportedSelfClaim(
        'Quello che ha scritto la boiata prima era fuso. Leggo solo la cronologia della chat.',
        'stai allucinando, prima hai mentito',
      ),
    ).toBe('Prima ho sbagliato. Leggo solo la cronologia della chat.');
  });

  it('does not activate self-diagnostics solely because a secondary replied-media transcript mentions logs', () => {
    const s = service();
    expect(
      s.isRelevant({
        chatId: -100,
        message:
          '[CURRENT VIDEO PRESENT BUT NOT AVAILABLE FOR ANALYSIS]\n[REPLIED MEDIA TRANSCRIPT — SECONDARY CONTEXT]: guardati i log di sistema',
        context,
      }),
    ).toBe(false);
  });
});
