import { escapeRegex } from './debounce';

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('foo.bar')).toBe('foo\\.bar');
    expect(escapeRegex('test(1)')).toBe('test\\(1\\)');
    expect(escapeRegex('a*b+c?')).toBe('a\\*b\\+c\\?');
  });

  it('leaves plain strings unchanged', () => {
    expect(escapeRegex('hello world')).toBe('hello world');
    expect(escapeRegex('simple')).toBe('simple');
  });

  it('escapes pipe and brackets', () => {
    expect(escapeRegex('a|b')).toBe('a\\|b');
    expect(escapeRegex('[foo]')).toBe('\\[foo\\]');
  });
});
