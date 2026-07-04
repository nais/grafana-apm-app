import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PatternsPanel } from './PatternsPanel';
import * as analytics from '../../../api/analytics';

jest.mock('../../../api/analytics', () => ({
  ...jest.requireActual('../../../api/analytics'),
  getLogPatterns: jest.fn(),
}));

const getLogPatterns = analytics.getLogPatterns as jest.Mock;

function renderPanel(onSelectFilter = jest.fn()) {
  render(
    <PatternsPanel
      namespace="ns"
      service="svc"
      logsUid="nav-logs"
      fromMs={1000}
      toMs={2000}
      onSelectFilter={onSelectFilter}
    />
  );
  return onSelectFilter;
}

const PATTERN = {
  pattern: 'Timeout calling upstream <_>',
  level: 'error',
  count: 42,
  sample: '',
  firstSeenMs: 1500000,
  lastSeenMs: 1700000,
  isNew: true,
  filterLiteral: 'upstream',
};

describe('PatternsPanel', () => {
  beforeEach(() => getLogPatterns.mockReset());

  it('renders patterns with a count, NEW badge, and mode label', async () => {
    getLogPatterns.mockResolvedValue({
      mode: 'serverPatterns',
      patterns: [PATTERN, { ...PATTERN, pattern: 'Failed to load <_>', count: 8, isNew: false, filterLiteral: 'Failed' }],
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('Timeout calling upstream <_>')).toBeInTheDocument());
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('server patterns')).toBeInTheDocument();
  });

  it('applies the pattern filter literal on row click', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: [PATTERN] });
    const onSelectFilter = renderPanel();

    await waitFor(() => expect(screen.getByText('Timeout calling upstream <_>')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Timeout calling upstream <_>'));
    expect(onSelectFilter).toHaveBeenCalledWith('upstream');
  });

  it('shows the sampled-mode label', async () => {
    getLogPatterns.mockResolvedValue({
      mode: 'sampled',
      patterns: [{ ...PATTERN, sample: 'raw error line' }],
      note: 'sampled from newest 1000 error lines',
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('sampled from newest 1000 error lines')).toBeInTheDocument());
  });

  it('renders the empty state', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: [], note: 'no error log patterns in range' });
    renderPanel();

    await waitFor(() => expect(screen.getByText('No error patterns')).toBeInTheDocument());
  });

  it('surfaces unavailability', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'unavailable', patterns: [], note: 'logs datasource not configured' });
    renderPanel();

    await waitFor(() => expect(screen.getByText('logs datasource not configured')).toBeInTheDocument());
  });
});
