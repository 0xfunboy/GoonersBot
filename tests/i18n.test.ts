import { describe, expect, it } from 'vitest';
import { Localizer } from '../src/config/i18n.js';

describe('Localizer', () => {
  const loc = new Localizer('english');

  it('resolves a key in the default language', () => {
    expect(loc.t('start_done')).toContain('GoonerBot');
  });

  it('interpolates variables', () => {
    expect(loc.t('mode_set', { mode_name: 'Roast' })).toContain('Roast');
    expect(loc.t('user_banned', { user_handle: '@bob', ban_suffix: ' forever' })).toContain('@bob');
  });

  it('falls back to default language for an unknown language', () => {
    expect(loc.t('start_done', {}, 'klingon')).toContain('GoonerBot');
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
});
