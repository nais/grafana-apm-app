import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { StackTraceView, isConsoleCaptureValue } from './StackTraceView';

// The reference console-capture stack from #66.
const CONSOLE_STACK = [
  'Error: console.error: [ERROR] Failed to fetch auth data. [object Object]',
  '  at ? (webpack://_N_E/../../node_modules/.pnpm/@grafana+faro-web-sdk@2.7.1/node_modules/@grafana/faro-web-sdk/dist/esm/instrumentations/console/instrumentation.js:31:0)',
  '  at forEach ([native code]:0:0)',
  '  at ? (webpack://_N_E/../../node_modules/.pnpm/@grafana+faro-core@2.7.1/node_modules/@grafana/faro-core/dist/esm/utils/reactive.js:15:0)',
  '  at ? (webpack://_N_E/../../node_modules/.pnpm/@grafana+faro-web-sdk@2.7.1/node_modules/@grafana/faro-web-sdk/dist/esm/instrumentations/_internal/monitors/consoleMonitor.js:22:0)',
  '  at ? (/personbruker/shared/logger.ts:47:26)',
  '  at ? (/personbruker/decorator-next/src/helpers/auth.ts:74:25)',
].join('\n');

describe('isConsoleCaptureValue', () => {
  it('detects the Faro console.error value prefix', () => {
    expect(isConsoleCaptureValue('console.error: [ERROR] Failed to fetch')).toBe(true);
    expect(isConsoleCaptureValue('TypeError: x is undefined')).toBe(false);
    expect(isConsoleCaptureValue(undefined)).toBe(false);
  });
});

describe('StackTraceView', () => {
  it('collapses consecutive SDK/vendor frames into one labeled toggle', () => {
    render(<StackTraceView stack={CONSOLE_STACK} isConsoleCapture />);

    // 4 consecutive not-in-app frames (faro, native, faro-core, consoleMonitor)
    const toggle = screen.getByRole('button', {
      name: /4 SDK\/vendor frames — Faro console capture, not the error origin/,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // Collapsed frames are hidden; in-app frames are visible.
    expect(screen.queryByText(/instrumentation\.js/)).not.toBeInTheDocument();
    expect(screen.getByText(/logger\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/auth\.ts/)).toBeInTheDocument();
  });

  it('expands collapsed frames on click without losing any line', () => {
    render(<StackTraceView stack={CONSOLE_STACK} isConsoleCapture />);

    fireEvent.click(screen.getByRole('button', { name: /4 SDK\/vendor frames/ }));

    expect(screen.getByRole('button', { name: /4 SDK\/vendor frames/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/instrumentation\.js/)).toBeInTheDocument();
    expect(screen.getByText(/reactive\.js/)).toBeInTheDocument();
    expect(screen.getByText(/consoleMonitor\.js/)).toBeInTheDocument();
  });

  it('highlights the first in-app frame as the origin guess', () => {
    render(<StackTraceView stack={CONSOLE_STACK} isConsoleCapture />);

    const hint = screen.getByText(/first in-app frame/);
    // logger.ts is the first in-app frame in the reference stack
    expect(hint.parentElement?.textContent).toContain('logger.ts');
  });

  it('renders the message line and keeps single vendor frames visible (dimmed, not collapsed)', () => {
    const stack = [
      'TypeError: t.map is not a function',
      '  at render (/app/src/List.tsx:12:3)',
      '  at commitWork (webpack://_N_E/../../node_modules/react-dom/cjs/react-dom.production.min.js:100:1)',
      '  at handle (/app/src/index.tsx:5:1)',
    ].join('\n');
    render(<StackTraceView stack={stack} />);

    expect(screen.getByText('TypeError: t.map is not a function')).toBeInTheDocument();
    // Single not-in-app frame stays inline — no toggle rendered.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/react-dom\.production\.min\.js/)).toBeInTheDocument();
  });

  it('omits the console-capture label when the exception is not a console capture', () => {
    render(<StackTraceView stack={CONSOLE_STACK} />);
    expect(screen.getByRole('button', { name: /^4 SDK\/vendor frames$/ })).toBeInTheDocument();
  });
});
