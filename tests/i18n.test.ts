import { describe, expect, it } from 'vitest';
import { Localizer, translations, trustedHtml } from '../src/config/i18n.js';

describe('Localizer', () => {
  const loc = new Localizer('english');

  it('resolves a key in the default language', () => {
    expect(loc.t('start_done')).toContain('GoonersBot');
  });

  it('interpolates variables', () => {
    expect(loc.t('mode_set', { mode_name: 'Roast' })).toContain('Roast');
    expect(loc.t('user_banned', { user_handle: '@bob', ban_suffix: ' forever' })).toContain('@bob');
  });

  it('escapes dynamic values in HTML translations unless explicitly trusted', () => {
    expect(loc.t('vision_result', { description: '<b>owned</b> & broken' })).toContain(
      '&lt;b&gt;owned&lt;/b&gt; &amp; broken',
    );
    expect(
      loc.t('capabilities_list', {
        capabilities: trustedHtml('/<code>papers</code> — Search'),
      }),
    ).toContain('/<code>papers</code>');
  });

  it('can expose a localized template as visible plain text for conversational replies', () => {
    expect(loc.tPlain('music_none', {}, 'italian')).toContain('/play <brano>');
    expect(loc.tPlain('vision_result', { description: '<b>visible</b>' }, 'english')).toContain(
      '<b>visible</b>',
    );
  });

  it('falls back to default language for an unknown language', () => {
    expect(loc.t('start_done', {}, 'klingon')).toContain('GoonersBot');
  });

  it('resolves localized strings for supported languages', () => {
    expect(loc.t('terms_accept_button', {}, 'russian')).toContain('Принять');
    expect(loc.t('terms_accept_button', {}, 'spanish')).toContain('Aceptar');
  });

  it('returns null for an unknown key', () => {
    expect(loc.t('nope_not_a_key')).toBeNull();
  });

  it('lists supported languages', () => {
    const langs = loc.supportedLanguages();
    expect(langs).toContain('english');
    expect(langs).toContain('russian');
    expect(langs).toContain('spanish');
  });

  it('contains no accidental unsupported Telegram HTML tags', () => {
    const allowed = new Set([
      'a',
      'b',
      'blockquote',
      'code',
      'del',
      'em',
      'i',
      'ins',
      'pre',
      's',
      'span',
      'strike',
      'strong',
      'tg-spoiler',
      'u',
    ]);
    const unsupported: string[] = [];

    for (const [key, languages] of Object.entries(translations)) {
      for (const [language, template] of Object.entries(languages)) {
        for (const match of template.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
          const tag = (match[1] ?? '').toLowerCase();
          if (!allowed.has(tag)) unsupported.push(`${key}.${language}: <${tag}>`);
        }
      }
    }

    expect(unsupported).toEqual([]);
  });
});
