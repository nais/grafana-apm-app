import React, { useCallback, useState } from 'react';
import { ErrorBoundary as GrafanaErrorBoundary, useStyles2, Button, Icon } from '@grafana/ui';
import { getAppEvents } from '@grafana/runtime';
import { AppEvents, GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

interface ErrorBoundaryProps {
  /** Human-readable name of the section being guarded, e.g. "Traces tab". */
  label?: string;
  /**
   * When any value in this array changes the boundary clears its error and
   * re-renders its children. Pass identifiers for the mounted context
   * (namespace/service/tab) so that navigating away from a crashed section
   * recovers automatically.
   */
  resetKeys?: unknown[];
  children: React.ReactNode;
}

/**
 * Catches render errors from a subtree and shows a compact, non-alarming
 * fallback in place of the crashed section instead of white-screening the
 * whole plugin. Errors are logged to the console and published as an
 * AppEvents.alertError so they are observable.
 *
 * Wraps @grafana/ui's render-prop ErrorBoundary (reusing its catch, Faro
 * reporting, and dependency-based recovery) and adds our own fallback UI with
 * a Retry action.
 */
export function ErrorBoundary({ label, resetKeys = [], children }: ErrorBoundaryProps) {
  // Bumping the nonce is threaded through `dependencies` so a user-initiated
  // Retry uses the same recovery path as a resetKeys change.
  const [nonce, setNonce] = useState(0);

  const onError = useCallback(
    (error: Error) => {
      const where = label ? ` [${label}]` : '';
      // eslint-disable-next-line no-console
      console.error(`ErrorBoundary caught an error${where}:`, error);
      getAppEvents().publish({
        type: AppEvents.alertError.name,
        payload: [label ? `${label} failed to load` : 'A section failed to load', error.message],
      });
    },
    [label]
  );

  const onRetry = useCallback(() => setNonce((n) => n + 1), []);

  return (
    <GrafanaErrorBoundary boundaryName={label} dependencies={[...resetKeys, nonce]} onError={onError}>
      {({ error }) => {
        if (!error) {
          return <>{children}</>;
        }
        return <ErrorBoundaryFallback label={label} error={error} onRetry={onRetry} />;
      }}
    </GrafanaErrorBoundary>
  );
}

function ErrorBoundaryFallback({ label, error, onRetry }: { label?: string; error: Error; onRetry: () => void }) {
  const styles = useStyles2(getStyles);
  const isDev = process.env.NODE_ENV !== 'production';
  return (
    <div className={styles.container} role="alert">
      <Icon name="exclamation-triangle" className={styles.icon} />
      <div className={styles.body}>
        <div className={styles.title}>{label ? `${label} failed to load` : 'This section failed to load'}</div>
        <div className={styles.message}>An unexpected error occurred while rendering this section.</div>
        {isDev && (
          <details className={styles.details}>
            <summary>Error detail</summary>
            <pre className={styles.pre}>{error.stack || error.toString()}</pre>
          </details>
        )}
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" icon="sync" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    gap: ${theme.spacing(1.5)};
    align-items: flex-start;
    padding: ${theme.spacing(2)};
    margin: ${theme.spacing(1)} 0;
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.secondary};
  `,
  icon: css`
    color: ${theme.colors.warning.text};
    margin-top: ${theme.spacing(0.25)};
  `,
  body: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    min-width: 0;
    flex: 1;
  `,
  title: css`
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
  `,
  message: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  details: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  pre: css`
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow: auto;
    margin-top: ${theme.spacing(0.5)};
  `,
  actions: css`
    display: flex;
    gap: ${theme.spacing(1)};
  `,
});

export default ErrorBoundary;
