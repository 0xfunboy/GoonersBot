import { describe, expect, it } from 'vitest';
import { Cooldown, SlidingWindowCounter } from '../src/utils/rateLimit.js';

describe('Cooldown', () => {
  it('allows first acquire then blocks within interval', () => {
    const cd = new Cooldown(1000);
    expect(cd.tryAcquire('a', 0)).toBe(true);
    expect(cd.tryAcquire('a', 500)).toBe(false);
    expect(cd.tryAcquire('a', 1000)).toBe(true);
  });
  it('isReady checks without consuming', () => {
    const cd = new Cooldown(1000);
    cd.mark('a', 0);
    expect(cd.isReady('a', 500)).toBe(false);
    expect(cd.isReady('a', 1000)).toBe(true);
    // isReady did not consume, so still ready
    expect(cd.isReady('a', 1000)).toBe(true);
  });
  it('interval <= 0 always allows', () => {
    const cd = new Cooldown(0);
    expect(cd.tryAcquire('x', 0)).toBe(true);
    expect(cd.tryAcquire('x', 0)).toBe(true);
  });
});

describe('SlidingWindowCounter', () => {
  it('enforces max within window', () => {
    const w = new SlidingWindowCounter(1000, 2);
    expect(w.isUnderLimit('c', 0)).toBe(true);
    w.record('c', 0);
    w.record('c', 100);
    expect(w.isUnderLimit('c', 200)).toBe(false);
    // after window passes, old hits expire
    expect(w.isUnderLimit('c', 1200)).toBe(true);
  });
  it('counts hits in window', () => {
    const w = new SlidingWindowCounter(1000, 5);
    w.record('c', 0);
    w.record('c', 500);
    expect(w.count('c', 900)).toBe(2);
    expect(w.count('c', 1400)).toBe(1);
  });
});
