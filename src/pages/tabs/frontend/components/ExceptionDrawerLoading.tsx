import React from 'react';
import { Drawer, Spinner } from '@grafana/ui';
import { css } from '@emotion/css';

interface ExceptionDrawerLoadingProps {
  onClose: () => void;
}

/**
 * Placeholder drawer shown while a fresh `issueId` deep link is still resolving
 * to its member hashes (see useExceptionDrawerState.drawerLoading). Without it,
 * a deep-linked drawer renders nothing until the groups response lands, so a
 * shared link looks broken for the first render. Matches the real
 * <ExceptionDrawer> chrome (title + lg size) so opening feels continuous.
 */
export function ExceptionDrawerLoading({ onClose }: ExceptionDrawerLoadingProps) {
  return (
    <Drawer title="Exception Details" onClose={onClose} size="lg">
      <div className={styles.center}>
        <Spinner size="lg" />
      </div>
    </Drawer>
  );
}

const styles = {
  center: css`
    display: flex;
    justify-content: center;
    padding: 40px;
  `,
};
