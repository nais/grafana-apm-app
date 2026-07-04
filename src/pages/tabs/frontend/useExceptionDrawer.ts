import { useSearchParams } from 'react-router-dom';
import { getExceptionGroups } from '../../../api/client';
import { useFetch } from '../../../utils/useFetch';
import { useTimeRange } from '../../../utils/timeRange';
import { useUrlParams } from '../../../utils/useUrlState';

export interface ExceptionDrawerState {
  /** Alloy hashes to pass to <ExceptionDrawer>; null when no drawer should be open. */
  drawerHashes: string[] | null;
  /** Group title (fingerprint groups only) — falls back to the drawer's own parsed value. */
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
 * the Loki hashes the ExceptionDrawer queries by. Shared between the Frontend
 * and Issues tabs (#69 P1/P10) so an `issueId` deep link opens the drawer
 * identically regardless of which tab it lands on.
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

  // Resolve the fingerprint to its member hashes (the drawer queries Loki by
  // hash). The groups response is backend-cached, so this is cheap.
  const { data: groupsData } = useFetch(
    () => getExceptionGroups(namespace, service, fromMs, toMs, environment || undefined),
    [namespace, service, fromMs, toMs, environment],
    { skip: !selectedIssueId }
  );
  const selectedGroup = selectedIssueId ? groupsData?.groups.find((g) => g.fingerprint === selectedIssueId) : undefined;
  const drawerHashes = selectedIssueId ? (selectedGroup?.memberHashes ?? null) : selectedHash ? [selectedHash] : null;

  return {
    drawerHashes,
    selectedGroupTitle: selectedGroup?.title,
    selectedIssueId,
    selectedHash,
    selectedSessionId,
    setSelectedSessionId,
    closeDrawer,
  };
}
