import * as fs from 'fs';
import * as path from 'path';
import { isInAppFrame, parseStackFrame, isLikelyMinifiedFrame, stackLooksMinified, firstScriptUrl } from './frames';

interface FixtureCase {
  path: string;
  inApp: boolean;
  note: string;
}

const fixturePath = path.resolve(__dirname, '../../../../pkg/plugin/fingerprint/testdata/frames.json');
const fixtures: { cases: FixtureCase[] } = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

describe('isInAppFrame (golden fixtures shared with Go)', () => {
  it('has fixture cases', () => {
    expect(fixtures.cases.length).toBeGreaterThan(0);
  });

  for (const tc of fixtures.cases) {
    it(`${tc.inApp ? 'in-app' : 'not-in-app'}: ${tc.note}`, () => {
      expect(isInAppFrame(tc.path)).toBe(tc.inApp);
    });
  }
});

describe('parseStackFrame', () => {
  it('parses the reference console-capture stack correctly', () => {
    // The real-world example from #66: Faro/native frames must classify
    // not-in-app, the logger and auth frames in-app.
    const lines = [
      'Error: console.error: [ERROR] Failed to fetch auth data. [object Object]',
      '  at ? (webpack://_N_E/../../node_modules/.pnpm/@grafana+faro-web-sdk@2.7.1/node_modules/@grafana/faro-web-sdk/dist/esm/instrumentations/console/instrumentation.js:31:0)',
      '  at forEach ([native code]:0:0)',
      '  at ? (webpack://_N_E/../../node_modules/.pnpm/@grafana+faro-core@2.7.1/node_modules/@grafana/faro-core/dist/esm/utils/reactive.js:15:0)',
      '  at ? (/personbruker/shared/logger.ts:47:26)',
      '  at ? (/personbruker/decorator-next/src/helpers/auth.ts:74:25)',
    ];
    const frames = lines.map(parseStackFrame);

    expect(frames[0]).toMatchObject({ isFrame: false, inApp: true }); // message line
    expect(frames[1]).toMatchObject({ isFrame: true, inApp: false });
    expect(frames[2]).toMatchObject({ isFrame: true, inApp: false, path: '[native code]' });
    expect(frames[3]).toMatchObject({ isFrame: true, inApp: false });
    expect(frames[4]).toMatchObject({ isFrame: true, inApp: true, path: '/personbruker/shared/logger.ts' });
    expect(frames[5]).toMatchObject({
      isFrame: true,
      inApp: true,
      path: '/personbruker/decorator-next/src/helpers/auth.ts',
    });
  });

  it('parses frames without a function name', () => {
    const f = parseStackFrame('    at https://cdn.nav.no/team/app/1.2.3/assets/vendor-Cq2ZL9.js:2:48211');
    expect(f.isFrame).toBe(true);
    expect(f.path).toBe('https://cdn.nav.no/team/app/1.2.3/assets/vendor-Cq2ZL9.js');
  });

  it('parses frames with function name but no parens position', () => {
    const f = parseStackFrame('  at processTicksAndRejections (node:internal/process/task_queues:95:5)');
    expect(f.isFrame).toBe(true);
    expect(f.path).toBe('node:internal/process/task_queues');
  });

  it('treats blank and message lines as non-frames', () => {
    expect(parseStackFrame('').isFrame).toBe(false);
    expect(parseStackFrame('TypeError: x is undefined').isFrame).toBe(false);
  });
});

describe('isLikelyMinifiedFrame (#60 heuristic)', () => {
  it('flags a very deep column offset', () => {
    expect(isLikelyMinifiedFrame('    at https://cdn.nav.no/team/app/1.2.3/assets/vendor-Cq2ZL9.js:2:48211')).toBe(
      true
    );
  });

  it('flags a hashed bundle with a mangled 1–2 char function name', () => {
    expect(isLikelyMinifiedFrame('    at Kt (https://cdn.nav.no/team/app/1.2.3/assets/main-Dk3js9aP.js:1:200)')).toBe(
      true
    );
  });

  it('does not flag a clean app frame with real names and a shallow column', () => {
    expect(isLikelyMinifiedFrame('  at handleSubmit (/personbruker/decorator-next/src/helpers/auth.ts:74:25)')).toBe(
      false
    );
  });

  it('does not flag a hashed bundle when the function name is meaningful and the column is shallow', () => {
    expect(
      isLikelyMinifiedFrame('  at renderApp (https://cdn.nav.no/team/app/1.2.3/assets/main-Dk3js9aP.js:1:42)')
    ).toBe(false);
  });

  it('never flags non-frame lines', () => {
    expect(isLikelyMinifiedFrame('TypeError: x is undefined')).toBe(false);
    expect(isLikelyMinifiedFrame('')).toBe(false);
  });
});

describe('stackLooksMinified', () => {
  it('is true when any frame looks minified', () => {
    const stack = [
      'TypeError: undefined is not a function',
      '  at n (https://cdn.nav.no/team/app/1.2.3/assets/index-Bq7Za1.js:1:99213)',
      '  at /personbruker/shared/logger.ts:47:26',
    ].join('\n');
    expect(stackLooksMinified(stack)).toBe(true);
  });

  it('is false for a fully source-mapped stack', () => {
    const stack = [
      'Error: boom',
      '  at handleClick (/personbruker/decorator-next/src/App.tsx:12:8)',
      '  at onClick (/personbruker/shared/Button.tsx:5:3)',
    ].join('\n');
    expect(stackLooksMinified(stack)).toBe(false);
  });
});

describe('firstScriptUrl', () => {
  it('returns the first http(s) bundle URL without the line/column suffix', () => {
    const stack = ['TypeError: boom', '  at n (https://cdn.nav.no/team/app/1.2.3/assets/index-Bq7Za1.js:1:99213)'].join(
      '\n'
    );
    expect(firstScriptUrl(stack)).toBe('https://cdn.nav.no/team/app/1.2.3/assets/index-Bq7Za1.js');
  });

  it('returns undefined for webpack:// or bare-path stacks', () => {
    const stack = ['Error: boom', '  at ? (webpack://_N_E/../src/logger.ts:15:0)'].join('\n');
    expect(firstScriptUrl(stack)).toBeUndefined();
  });
});
