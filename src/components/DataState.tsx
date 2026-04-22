import React from 'react';
import { Alert, LoadingPlaceholder } from '@grafana/ui';

interface DataStateProps {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  loadingText?: string;
  errorTitle?: string;
  emptyTitle?: string;
  emptyMessage?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Handles the common loading → error → empty → content state machine.
 * Renders the first matching state; `children` is rendered only when
 * not loading, no error, and not empty.
 */
export function DataState({
  loading,
  error,
  empty,
  loadingText = 'Loading…',
  errorTitle = 'Error',
  emptyTitle = 'No data',
  emptyMessage = 'No data found.',
  children,
}: DataStateProps) {
  if (error) {
    return (
      <Alert severity="error" title={errorTitle}>
        {error}
      </Alert>
    );
  }
  if (loading) {
    return <LoadingPlaceholder text={loadingText} />;
  }
  if (empty) {
    return (
      <Alert severity="info" title={emptyTitle}>
        {emptyMessage}
      </Alert>
    );
  }
  return <>{children}</>;
}
