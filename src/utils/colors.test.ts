import { createTheme } from '@grafana/data';
import { sparklineColors, threadStateColors } from './colors';

describe('sparklineColors', () => {
  const darkTheme = createTheme({ colors: { mode: 'dark' } });
  const lightTheme = createTheme({ colors: { mode: 'light' } });

  it('returns non-empty strings for all keys', () => {
    const sc = sparklineColors(darkTheme);
    expect(sc.rate).toBeTruthy();
    expect(sc.error).toBeTruthy();
    expect(sc.errorDim).toBeTruthy();
    expect(sc.duration).toBeTruthy();
  });

  it('rate and error use distinct colors', () => {
    const sc = sparklineColors(darkTheme);
    expect(sc.rate).not.toBe(sc.error);
  });

  it('resolves different values for dark and light themes', () => {
    const dark = sparklineColors(darkTheme);
    const light = sparklineColors(lightTheme);
    // errorDim should differ since it's theme.colors.text.disabled
    expect(dark.errorDim).not.toBe(light.errorDim);
  });
});

describe('threadStateColors', () => {
  const theme = createTheme({ colors: { mode: 'dark' } });

  it('returns non-empty strings for all keys', () => {
    const tc = threadStateColors(theme);
    expect(tc.runnable).toBeTruthy();
    expect(tc.timedWaiting).toBeTruthy();
    expect(tc.waiting).toBeTruthy();
    expect(tc.blocked).toBeTruthy();
  });

  it('runnable and blocked are distinct', () => {
    const tc = threadStateColors(theme);
    expect(tc.runnable).not.toBe(tc.blocked);
  });
});
