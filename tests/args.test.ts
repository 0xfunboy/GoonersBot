import { describe, expect, it } from 'vitest';
import { parseArgs, parseCommandName } from '../src/utils/args.js';
import { normalizeHandle, fallbackHandle, isFallbackHandle } from '../src/utils/handles.js';

describe('parseArgs', () => {
  it('strips the command and splits the rest', () => {
    expect(parseArgs('/fact @bob loves memes')).toEqual(['@bob', 'loves', 'memes']);
  });
  it('handles @botname suffix', () => {
    expect(parseArgs('/ban@GoonerBot @bob 60')).toEqual(['@bob', '60']);
  });
  it('returns empty for a bare command', () => {
    expect(parseArgs('/help')).toEqual([]);
    expect(parseArgs('/help   ')).toEqual([]);
  });
  it('collapses extra whitespace', () => {
    expect(parseArgs('/mode   roast')).toEqual(['roast']);
  });
});

describe('parseCommandName', () => {
  it('extracts lowercased command name', () => {
    expect(parseCommandName('/Start hello')).toBe('start');
    expect(parseCommandName('/ban@GoonerBot @x')).toBe('ban');
  });
  it('returns null for non-commands', () => {
    expect(parseCommandName('hello there')).toBeNull();
  });
});

describe('handles', () => {
  it('normalizes handles to @form', () => {
    expect(normalizeHandle('bob')).toBe('@bob');
    expect(normalizeHandle('@bob')).toBe('@bob');
    expect(normalizeHandle('  spaced ')).toBe('@spaced');
  });
  it('builds and detects fallback handles', () => {
    expect(fallbackHandle(42)).toBe('@id42');
    expect(isFallbackHandle('@id42')).toBe(true);
    expect(isFallbackHandle('@bob')).toBe(false);
  });
});
