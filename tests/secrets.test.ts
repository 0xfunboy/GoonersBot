import { describe, it, expect } from 'vitest';
import { containsSecret, containsSensitive, redactSecrets } from '../src/utils/secrets.js';

describe('containsSecret', () => {
  it('catches credentials, keys, tokens and infrastructure', () => {
    const cases = [
      'la mia api key è sk-ABCDEFGHIJKLMNOPQRSTUVWX1234',
      'GEMINI_KEY=AQ.Ab8RN6IahVbYr_Q4C7wAxpPRZ2w78cyp',
      'bootstrap 447a37cba2332030816e8de1d292d53bbe959164bb199fe31898b055f07e4e32',
      'connessione mongodb://goonerbot:1dc51438@127.0.0.1:27017/db',
      'AKIAIOSFODNN7EXAMPLE is the access key',
      'token eyJhbGciOiJIUzI1Ni2.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4',
      "c'è un brute-force da 87.251.64.145 sulla porta 4444",
      'Authorization: Bearer abcdef1234567890ABCDEF',
      'export DB_PASSWORD=supersegreto123',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
    ];
    for (const c of cases) expect(containsSecret(c), c).toBe(true);
  });

  it('does not flag ordinary chat', () => {
    for (const c of ['ama i Tool e il doom metal', 'ieri ha vinto la partita 3 a 1', 'che ne pensi del nuovo album?']) {
      expect(containsSecret(c), c).toBe(false);
    }
  });
});

describe('containsSensitive', () => {
  it('also covers personal data', () => {
    expect(containsSensitive('his password is hunter2')).toBe(true);
    expect(containsSensitive('lives at 123 Main Street')).toBe(true);
    expect(containsSensitive('call him at +39 333 1234567')).toBe(true);
    expect(containsSensitive('is the resident doom-metal DJ')).toBe(false);
  });
});

describe('redactSecrets', () => {
  it('masks secrets but keeps the surrounding text', () => {
    expect(redactSecrets('key sk-ABCDEFGHIJKLMNOPQRSTUVWX1234 done')).toContain('[redacted]');
    expect(redactSecrets('mongodb://user:pw123@host/db')).toContain(':[redacted]@');
    expect(redactSecrets('hello world')).toBe('hello world');
  });
});
