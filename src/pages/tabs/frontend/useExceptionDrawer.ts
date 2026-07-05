import { useSearchParams } from 'react-router-dom';
import { getIssues, IssueSource } from '../../../api/client';
import { useFetch } from '../../../utils/useFetch';
import { useTimeRange } from '../../../utils/timeRange';
import { useUrlParams } from '../../../utils/useUrlState';

export interface ExceptionDrawerState {
  /**
   * Alloy hashes to pass to <ExceptionDrawer> for browser issues; null when no
   * drawer should be open, and [] for server issues (which have no hash — they
   * open on `issueId`/`source` alone, see `source`).
   */
  drawerHashes: string[] | null;
  /**
   * True while a fresh `issueId` deep link is still resolving to its issue (the
   * issues fetch is in flight and no issue has matched yet). Call sites show a
   * loading drawer so the deep link doesn't render nothing until it lands.
   */
  drawerLoading: boolean;
  /**
   * Telemetry source of the open issue: 'browser' (hash→Loki) or 'server'
   * (backend occurrences endpoint). Undefined when no drawer is open. Server
   * issues open on this alone — they carry no member hashes (#84).
   */
  source?: IssueSource;
  /** Group title — falls back to the drawer's own parsed value. */
  selectedGroupTitle?: string;
  selectedIssueId: string;
  selectedHash: string;
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  /** Clears every drawer-related URL param in one transaction. */
  closeDrawer: () => void;
}

/**
 * Resolves the `issueId`/`exceptionHash` URL params (docs/url-contract.md) to
 * the data the ExceptionDrawer needs. Shared between the Frontend and Issues
 * tabs (#69 P1/P10) so an `issueId` deep link opens the drawer identically
 * regardless of which tab it lands on.
 *
 * The unified issues list is the single resolver: it carries each issue's
 * `source` and (for browser issues) its member hashes, so a bare `issueId`
 * deep link opens the correct drawer for either source (#84) — server issues
 * open on `source` alone since they have no Alloy hash.
 */
export function useExceptionDrawerState(
  namespace: string,
  service: string,
  environment?: string
): ExceptionDrawerState {
  const [searchParams] = useSearchParams();
  const updateParams = useUrlParams();
  const { fromMs, toMs } = useTimeRange();

  // issueId (fingerprint, #62) is the primary drawer key; exceptionHash is the
  // legacy deep-link param and keeps resolving (docs/url-contract.md).
  const selectedIssueId = searchParams.get('issueId') ?? '';
  const selectedHash = searchParams.get('exceptionHash') ?? '';
  const selectedSessionId = searchParams.get('exceptionSessionId') ?? '';

  const setSelectedSessionId = (id: string) => {
    updateParams({ exceptionSessionId: id || null });
  };
  const closeDrawer = () => {
    updateParams({ issueId: null, exceptionHash: null, exceptionSessionId: null });
  };

  // Resolve the fingerprint to its issue (source + member hashes + title). The
  // issues response is backend-cached, so this is cheap and shared with the
  // table that linked here.
  const { data: issuesData, loading: issuesLoading } = useFetch(
    () => getIssues(namespace, service, fromMs, toMs, environment || undefined),
    [namespace, service, fromMs, toMs, environment],
    { skip: !selectedIssueId }
  );
  const selectedIssue = selectedIssueId ? issuesData?.issues.find((i) => i.fingerprint === selectedIssueId) : undefined;

  const source: IssueSource | undefined = selectedIssue?.source ?? (selectedHash ? 'browser' : undefined);
  const drawerHashes = selectedIssueId
    ? selectedIssue
      ? selectedIssue.source === 'server'
        ? []
        : selectedIssue.memberHashes
      : null
    : selectedHash
      ? [selectedHash]
      : null;
  // An issueId is set but the issues fetch hasn't resolved it yet: show a
  // loading drawer rather than nothing. A bare exceptionHash resolves
  // synchronously, so it never enters this state.
  const drawerLoading = !!selectedIssueId && !selectedIssue && issuesLoading;

  return {
    drawerHashes,
    drawerLoading,
    source,
    selectedGroupTitle: selectedIssue?.title,
    selectedIssueId,
    selectedHash,
    selectedSessionId,
    setSelectedSessionId,
    closeDrawer,
  };
}
