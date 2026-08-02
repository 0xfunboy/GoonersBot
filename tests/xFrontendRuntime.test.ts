import { describe, expect, it } from 'vitest';
import { isAuthenticatedXLocation, toDriverCookie } from '../src/frontend/x/runtime.js';

describe('X visual frontend runtime', () => {
  it('classifies only non-login X locations as an authenticated browser destination', () => {
    expect(isAuthenticatedXLocation('https://x.com/home')).toBe(true);
    expect(isAuthenticatedXLocation('https://x.com/notifications')).toBe(true);
    expect(isAuthenticatedXLocation('https://x.com/i/flow/login')).toBe(false);
    expect(isAuthenticatedXLocation('https://x.com/account/access')).toBe(false);
    expect(isAuthenticatedXLocation('https://x.com.evil.example/home')).toBe(false);
    expect(isAuthenticatedXLocation('http://x.com/home')).toBe(false);
  });

  it('maps a parsed cookie without mutating it or inventing an expiry', () => {
    const source = Object.freeze({
      name: 'fixture',
      value: 'fixture-value',
      domain: 'x.com',
      includeSubdomains: true,
      path: '/',
      secure: true,
      httpOnly: true,
      expiresAt: undefined,
    });

    expect(toDriverCookie(source)).toEqual({
      name: 'fixture',
      value: 'fixture-value',
      domain: '.x.com',
      path: '/',
      secure: true,
      httpOnly: true,
    });
    expect(source).toEqual(expect.objectContaining({ value: 'fixture-value' }));
  });
});
