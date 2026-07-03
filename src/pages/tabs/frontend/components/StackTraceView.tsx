import React, { useMemo, useState } from 'react';
import { Icon } from '@grafana/ui';
import { css, cx } from '@emotion/css';
import { parseStackFrame, StackFrame } from '../frames';

interface StackTraceViewProps {
  stack: string;
  /** True when the exception was captured via Faro's console instrumentation. */
  isConsoleCapture?: boolean;
  /** Styling for the outer <pre> (the drawer passes its themed stacktrace box). */
  className?: string;
}

/** Marker prefix Faro's console instrumentation puts on exception values. */
export function isConsoleCaptureValue(value: string | undefined): boolean {
  return Boolean(value?.startsWith('console.error:'));
}

type Segment = { kind: 'lines'; frames: FrameEntry[] } | { kind: 'collapsed'; frames: FrameEntry[]; leading: boolean };

interface FrameEntry {
  frame: StackFrame;
  /** Index in the original line array (stable React keys). */
  index: number;
  /** True for the first in-app frame of the stack — the best origin guess. */
  isFirstInApp: boolean;
}

/**
 * Stack trace renderer with in-app awareness (#66 Phase 0, retroactive on
 * existing data): runs of 2+ SDK/vendor/native frames collapse into one
 * expandable row, and the first in-app frame — the best origin guess for
 * console-captured exceptions — is highlighted. Faro's console instrumentation
 * creates its synthetic Error inside the SDK, so the top frames of
 * console-captured stacks are always Faro internals, never the error origin.
 */
export function StackTraceView({ stack, isConsoleCapture = false, className }: StackTraceViewProps) {
  const segments = useMemo(() => buildSegments(stack), [stack]);

  return (
    <pre className={cx(styles.pre, className)}>
      <code>
        {segments.map((segment, i) =>
          segment.kind === 'collapsed' ? (
            <CollapsedFrames
              key={`g-${segment.frames[0].index}`}
              frames={segment.frames}
              label={
                segment.leading && isConsoleCapture
                  ? `${segment.frames.length} SDK/vendor frames — Faro console capture, not the error origin`
                  : `${segment.frames.length} SDK/vendor frames`
              }
            />
          ) : (
            segment.frames.map((entry) => <FrameLine key={entry.index} entry={entry} />)
          )
        )}
      </code>
    </pre>
  );
}

/** Group parsed lines into visible runs and collapsible not-in-app runs (2+). */
function buildSegments(stack: string): Segment[] {
  const frames = stack.split('\n').map((line, index) => ({ frame: parseStackFrame(line), index, isFirstInApp: false }));

  const firstInApp = frames.find((f) => f.frame.isFrame && f.frame.inApp);
  if (firstInApp) {
    firstInApp.isFirstInApp = true;
  }

  const segments: Segment[] = [];
  let seenVisible = false;
  let i = 0;
  while (i < frames.length) {
    const entry = frames[i];
    if (entry.frame.isFrame && !entry.frame.inApp) {
      const run: FrameEntry[] = [];
      while (i < frames.length && frames[i].frame.isFrame && !frames[i].frame.inApp) {
        run.push(frames[i]);
        i++;
      }
      if (run.length >= 2) {
        segments.push({ kind: 'collapsed', frames: run, leading: !seenVisible });
      } else {
        appendLines(segments, run);
      }
      continue;
    }
    // Message lines don't count as "visible frames" for the leading-group check.
    if (entry.frame.isFrame) {
      seenVisible = true;
    }
    appendLines(segments, [entry]);
    i++;
  }
  return segments;
}

function appendLines(segments: Segment[], entries: FrameEntry[]) {
  const last = segments[segments.length - 1];
  if (last && last.kind === 'lines') {
    last.frames.push(...entries);
  } else {
    segments.push({ kind: 'lines', frames: [...entries] });
  }
}

function CollapsedFrames({ frames, label }: { frames: FrameEntry[]; label: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        className={styles.collapseToggle}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <Icon name={expanded ? 'angle-down' : 'angle-right'} size="sm" /> {label}
      </button>
      {expanded && frames.map((entry) => <FrameLine key={entry.index} entry={entry} dimmed />)}
    </div>
  );
}

function FrameLine({ entry, dimmed = false }: { entry: FrameEntry; dimmed?: boolean }) {
  const { frame } = entry;
  if (!frame.isFrame) {
    return <div className={styles.message}>{frame.raw}</div>;
  }

  // Parse "at fn (path:line:col)" | "at path:line:col" for colorized display.
  const atMatch = frame.raw.match(/at\s+(.+?)\s*\((.+?)\)/);
  const directMatch = frame.raw.match(/at\s+(\S+)/);
  const funcName = atMatch ? atMatch[1] : '';
  const filePath = atMatch ? atMatch[2] : (directMatch?.[1] ?? '');

  if (!filePath) {
    return <div className={styles.dim}>{frame.raw}</div>;
  }

  const parts = filePath.split(':');
  let lineCol = '';
  let fileClean = filePath;
  if (parts.length >= 3) {
    const col = parts.pop();
    const ln = parts.pop();
    lineCol = `:${ln}:${col}`;
    fileClean = parts.join(':');
  }
  let displayFile = fileClean;
  try {
    if (fileClean.startsWith('http')) {
      displayFile = new URL(fileClean).pathname;
    }
  } catch {
    // keep the raw path
  }

  return (
    <div className={cx(styles.frame, dimmed && styles.dimFrame, entry.isFirstInApp && styles.firstInApp)}>
      <span className={styles.at}>at </span>
      {funcName && <span className={styles.func}>{funcName} </span>}
      <span className={styles.file}>({displayFile}</span>
      <span className={styles.lineCol}>{lineCol}</span>
      <span className={styles.file}>)</span>
      {entry.isFirstInApp && <span className={styles.originHint}> ← first in-app frame</span>}
    </div>
  );
}

// Static styles: the drawer's stack colors are fixed hex values today (theme
// tokens are a tracked follow-up in #70) — keep new code consistent with them.
const styles = {
  pre: css`
    margin: 0;
  `,
  message: css`
    color: #a6acb9;
  `,
  dim: css`
    color: #8c95a5;
  `,
  frame: css`
    margin: 2px 0;
  `,
  dimFrame: css`
    opacity: 0.65;
  `,
  firstInApp: css`
    background: rgba(56, 189, 248, 0.08);
    border-left: 2px solid #38bdf8;
    padding-left: 6px;
    margin-left: -8px;
  `,
  originHint: css`
    color: #38bdf8;
    font-style: italic;
    font-size: 11px;
  `,
  at: css`
    color: #f97316;
    font-weight: 500;
  `,
  func: css`
    color: #38bdf8;
  `,
  file: css`
    color: #8c95a5;
  `,
  lineCol: css`
    color: #f43f5e;
    font-weight: bold;
  `,
  collapseToggle: css`
    background: none;
    border: none;
    padding: 2px 0;
    margin: 2px 0;
    color: #8c95a5;
    font: inherit;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    &:hover {
      color: #a6acb9;
    }
  `,
};
