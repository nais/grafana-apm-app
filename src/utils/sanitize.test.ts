import { sanitizeLabelValue, escapeQueryString } from './sanitize';

describe('sanitizeLabelValue', () => {
  it('returns valid label values unchanged', () => {
    expect(sanitizeLabelValue('my-service')).toBe('my-service');
    expect(sanitizeLabelValue('my_namespace')).toBe('my_namespace');
    expect(sanitizeLabelValue('prod-fss')).toBe('prod-fss');
    expect(sanitizeLabelValue('api.example.com')).toBe('api.example.com');
    expect(sanitizeLabelValue('ns/service')).toBe('ns/service');
    expect(sanitizeLabelValue('user@domain')).toBe('user@domain');
    expect(sanitizeLabelValue('with spaces')).toBe('with spaces');
    expect(sanitizeLabelValue('port:8080')).toBe('port:8080');
  });

  it('returns empty for empty input', () => {
    expect(sanitizeLabelValue('')).toBe('');
  });

  it('rejects strings over 256 chars', () => {
    expect(sanitizeLabelValue('a'.repeat(257))).toBe('');
  });

  it('accepts strings up to 256 chars', () => {
    const val = 'a'.repeat(256);
    expect(sanitizeLabelValue(val)).toBe(val);
  });

  it('rejects injection characters', () => {
    expect(sanitizeLabelValue('foo"bar')).toBe('');
    expect(sanitizeLabelValue("foo'bar")).toBe('');
    expect(sanitizeLabelValue('foo`bar')).toBe('');
    expect(sanitizeLabelValue('foo{bar}')).toBe('');
    expect(sanitizeLabelValue('foo\nbar')).toBe('');
    expect(sanitizeLabelValue('foo\\bar')).toBe('');
    expect(sanitizeLabelValue('foo$(cmd)')).toBe('');
    expect(sanitizeLabelValue('foo|bar')).toBe('');
    expect(sanitizeLabelValue('foo;bar')).toBe('');
  });
});

describe('escapeQueryString', () => {
  it('returns safe strings unchanged', () => {
    expect(escapeQueryString('hello world')).toBe('hello world');
  });

  it('escapes backslashes', () => {
    expect(escapeQueryString('foo\\bar')).toBe('foo\\\\bar');
  });

  it('escapes double quotes', () => {
    expect(escapeQueryString('foo"bar')).toBe('foo\\"bar');
  });

  it('escapes both backslashes and quotes', () => {
    expect(escapeQueryString('a\\b"c')).toBe('a\\\\b\\"c');
  });
});
