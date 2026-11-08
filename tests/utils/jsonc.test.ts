import { describe, it, expect } from 'vitest';
import { parseJsonc, tryParseJsonc } from '../../src/utils/jsonc';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a": [1, 2], "b": {"c": null}}')).toEqual({ a: [1, 2], b: { c: null } });
  });

  it('strips line and block comments outside strings', () => {
    expect(parseJsonc('{\n  // note\n  "a": 1, /* inline */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('removes trailing commas in objects and arrays, including nested ones', () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(parseJsonc('[1,\n  // last\n]')).toEqual([1]);
  });

  it('never alters string contents', () => {
    const value = { url: 'http://x/*y*/', arg: 'a,]', b: 'c,}', path: '//not-a-comment' };
    expect(parseJsonc(JSON.stringify(value))).toEqual(value);
  });

  it('keeps escaped quotes inside strings', () => {
    expect(parseJsonc('{ "a": "say \\"hi\\", ok", }')).toEqual({ a: 'say "hi", ok' });
  });

  it('accepts a byte-order mark', () => {
    expect(parseJsonc(String.fromCharCode(0xfeff) + '{"a": 1}')).toEqual({ a: 1 });
  });

  it('throws on invalid JSON; tryParseJsonc returns null', () => {
    expect(() => parseJsonc('{ "a": }')).toThrow();
    expect(tryParseJsonc('{ "a": }')).toBeNull();
  });
});
