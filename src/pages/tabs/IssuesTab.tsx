import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { usePluginDatasources } from '../../utils/datasources';
import { IssuesTable } from './frontend/components/IssuesTable';
import { VersionsPanel } from './frontend/components/VersionsPanel';
import { SessionsPanel } from './frontend/components/SessionsPanel';
import { ExceptionDrawer } from './frontend/components/ExceptionDrawer';
import { useExceptionDrawerState } from './frontend/useExceptionDrawer';

interface IssuesTabProps {
  service: string;
  namespace: string;
  environment?: string;
}

/**
 * Issues tab (#69 P1/P2/P3): the unified, cross-source triage surface —
 * source defaults to "all" (IssuesTable's own default), unresolved first.
 * Versions and Sessions sit below as investigation context ("did this start
 * with today's release?" / "ticket in, session out") — moved off the
 * Frontend tab, which now stays scoped to UX health (#69 P6).
 */
export function IssuesTab({ service, namespace, environment }: IssuesTabProps) {
  const styles = useStyles2(getStyles);
  const ds = usePluginDatasources(environment || undefined);
  // Shared with the Frontend tab (#69 P10) — an issueId deep link opens the
  // drawer identically on both tabs.
  const {
    drawerHashes,
    selectedGroupTitle,
    selectedIssueId,
    selectedHash,
    selectedSessionId,
    setSelectedSessionId,
    closeDrawer,
  } = useExceptionDrawerState(namespace, service, environment);

  return (
    <div className={styles.container}>
      <div className={styles.panel}>
        <IssuesTable namespace={namespace} service={service} environment={environment} />
      </div>
      <div className={styles.panel}>
        <VersionsPanel namespace={namespace} service={service} environment={environment} />
      </div>
      <div className={styles.panel}>
        <SessionsPanel namespace={namespace} service={service} environment={environment} />
      </div>
      {drawerHashes && drawerHashes.length > 0 && (
        <ExceptionDrawer
          key={selectedIssueId || selectedHash}
          hashes={drawerHashes}
          title={selectedGroupTitle}
          service={service}
          namespace={namespace}
          environment={environment}
          logsUid={ds.logsUid}
          selectedSessionId={selectedSessionId}
          onSessionChange={setSelectedSessionId}
          onClose={closeDrawer}
        />
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(3)};
  `,
  panel: css`
    min-height: 260px;
  `,
});
