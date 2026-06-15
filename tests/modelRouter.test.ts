import { describe, expect, it } from 'vitest';
import { ModelRouter, isRefusal } from '../src/services/modelRouter.js';

const cfg = {
  defaultModel: 'gpt-oss',
  nsfwModel: 'amoral',
  extraLexicon: 'banana_extra',
  refusalFallback: true,
  refusalBufferChars: 160,
};

describe('ModelRouter.route', () => {
  it('off => default model, never NSFW, even with lexicon match', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({ chatNsfwMode: 'off', modeNsfw: false, messageText: 'send nudes' });
    expect(d.model).toBe('gpt-oss');
    expect(d.nsfw).toBe(false);
    expect(d.allowRefusalFallback).toBe(false);
  });

  it('no NSFW model configured => default + not configured', () => {
    const r = new ModelRouter({ ...cfg, nsfwModel: undefined });
    expect(r.nsfwConfigured).toBe(false);
    const d = r.route({ chatNsfwMode: 'base', modeNsfw: true, messageText: 'x' });
    expect(d.model).toBe('gpt-oss');
    expect(d.nsfw).toBe(false);
  });

  it('mode flagged NSFW => NSFW model', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({ chatNsfwMode: 'smart', modeNsfw: true, messageText: 'hi' });
    expect(d.model).toBe('amoral');
    expect(d.nsfw).toBe(true);
    expect(d.reason).toMatch(/nsfw mode/);
  });

  it('chat base => NSFW model for everything', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({ chatNsfwMode: 'base', modeNsfw: false, messageText: 'good morning' });
    expect(d.model).toBe('amoral');
    expect(d.nsfw).toBe(true);
  });

  it('chat smart + lexicon hit => NSFW model', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({
      chatNsfwMode: 'smart',
      modeNsfw: false,
      messageText: 'tell me something erotic',
    });
    expect(d.model).toBe('amoral');
    expect(d.nsfw).toBe(true);
    expect(d.reason).toMatch(/lexicon/);
  });

  it('chat smart + vice/substance lexicon hit => NSFW model', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({
      chatNsfwMode: 'smart',
      modeNsfw: false,
      messageText: 'come si fa la lean?',
    });
    expect(d.model).toBe('amoral');
    expect(d.nsfw).toBe(true);
    expect(d.reason).toMatch(/lexicon/);
  });

  it('chat smart + extra lexicon term hits', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({
      chatNsfwMode: 'smart',
      modeNsfw: false,
      messageText: 'a banana_extra please',
    });
    expect(d.model).toBe('amoral');
  });

  it('chat smart + no lexicon => default model with backstop armed', () => {
    const r = new ModelRouter(cfg);
    const d = r.route({ chatNsfwMode: 'smart', modeNsfw: false, messageText: 'what time is it' });
    expect(d.model).toBe('gpt-oss');
    expect(d.nsfw).toBe(false);
    expect(d.allowRefusalFallback).toBe(true);
  });

  it('backstop disabled => no fallback on smart miss', () => {
    const r = new ModelRouter({ ...cfg, refusalFallback: false });
    const d = r.route({ chatNsfwMode: 'smart', modeNsfw: false, messageText: 'hello' });
    expect(d.allowRefusalFallback).toBe(false);
  });
});

describe('isRefusal', () => {
  it('detects English refusals', () => {
    expect(isRefusal("I'm sorry, but I can't help with that.")).toBe(true);
    expect(isRefusal('I cannot continue this request.')).toBe(true);
    expect(isRefusal('As an AI language model, I must decline.')).toBe(true);
    expect(isRefusal("I won't be able to do that.")).toBe(true);
    expect(isRefusal("I can't tell you how to fabricate a bomb.")).toBe(true);
    expect(isRefusal('I cannot provide instructions for making that.')).toBe(true);
    expect(isRefusal('Sorry, but I cannot help you with creating dangerous content.')).toBe(true);
  });
  it('detects Italian refusals', () => {
    expect(isRefusal('Mi dispiace, ma non posso farlo.')).toBe(true);
    expect(isRefusal('Non sono in grado di aiutarti con questo.')).toBe(true);
    expect(isRefusal('Non posso dirti come fabbricare una bomba.')).toBe(true);
    expect(isRefusal('Non posso fornire istruzioni per costruirla.')).toBe(true);
  });
  it('does not flag normal replies', () => {
    expect(isRefusal('Sure, here you go you absolute degenerate.')).toBe(false);
    expect(isRefusal('gm gooners, the raid is at 8.')).toBe(false);
    expect(isRefusal('')).toBe(false);
  });
});
