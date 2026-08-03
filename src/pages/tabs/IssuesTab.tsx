import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { getFrontendMetrics } from '../../api/client';
import { usePluginDatasources } from '../../utils/datasources';
import { useFetch } from '../../utils/useFetch';
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
 * Releases and Sessions sit below as investigation context ("did this start
 * with today's release?" / "ticket in, session out") — but only for services
 * with browser telemetry: both are Faro-based, so backend-only services get
 * pure server-issue triage. Time controls live in the global page header
 * (HeaderTimeControls); this tab just consumes the shared from/to URL params.
 */
export function IssuesTab({ service, namespace, environment }: IssuesTabProps) {
  const styles = useStyles2(getStyles);
  const ds = usePluginDatasources(environment || undefined);
  // Shared with the Frontend tab (#69 P10) — an issueId deep link opens the
  // drawer identically on both tabs.
  const {
    drawerHashes,
    drawerLoading,
    source: drawerSource,
    selectedGroupTitle,
    selectedIssueType,
    selectedIssueId,
    selectedHash,
    selectedSessionId,
    setSelectedSessionId,
    closeDrawer,
  } = useExceptionDrawerState(namespace, service, environment);

  // Single cheap probe (backend-cached) for browser telemetry: the Releases
  // and Sessions panels are Faro-based and pure noise on backend-only
  // services. Hidden until the probe proves browser data — panels appearing
  // after load beats panels flickering away.
  const { data: frontendProbe } = useFetch(
    () => getFrontendMetrics(namespace, service, environment || undefined),
    [namespace, service, environment]
  );
  const hasBrowserData = !!frontendProbe?.available && !!frontendProbe?.hasLoki;

  return (
    <div className={styles.container}>
      <div className={styles.panel}>
        <IssuesTable namespace={namespace} service={service} environment={environment} />
      </div>
      {hasBrowserData && (
        <>
          <div className={styles.panel}>
            <VersionsPanel namespace={namespace} service={service} environment={environment} hideWhenEmpty />
          </div>
          <div className={styles.panel}>
            <SessionsPanel namespace={namespace} service={service} environment={environment} />
          </div>
        </>
      )}
      {(drawerLoading || (drawerHashes && drawerHashes.length > 0) || drawerSource === 'server') && (
        <ExceptionDrawer
          key={selectedIssueId || selectedHash}
          hashes={drawerHashes ?? []}
          source={drawerSource}
          resolving={drawerLoading}
          title={selectedGroupTitle}
          issueType={selectedIssueType}
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
    gap: ${theme.spacing(2)};
  `,
  controls: css`
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: ${theme.spacing(1)};
  `,
  panel: css`
    min-height: 0;
  `,
});
