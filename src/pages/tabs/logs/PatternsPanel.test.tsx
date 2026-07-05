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

/** Open the collapsed patterns panel via its header toggle. */
function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Top error patterns/ }));
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

/** 8 patterns so top-N (6) capping and the "show all" affordance are exercised. */
const manyPatterns = Array.from({ length: 8 }, (_, i) => ({
  ...PATTERN,
  pattern: `Pattern ${i} <_>`,
  count: 8 - i,
  isNew: false,
  filterLiteral: `pattern-${i}`,
}));

describe('PatternsPanel', () => {
  beforeEach(() => getLogPatterns.mockReset());

  it('is collapsed by default, showing the pattern count in the header', async () => {
    getLogPatterns.mockResolvedValue({
      mode: 'serverPatterns',
      patterns: [
        PATTERN,
        { ...PATTERN, pattern: 'Failed to load <_>', count: 8, isNew: false, filterLiteral: 'Failed' },
      ],
    });
    renderPanel();

    // The signal survives collapse: header text is present immediately...
    await waitFor(() => expect(screen.getByText('Top error patterns (2)')).toBeInTheDocument());
    // ...but the pattern list (the secondary content) is not rendered until expanded.
    expect(screen.queryByText('Timeout calling upstream <_>')).not.toBeInTheDocument();
  });

  it('expands to reveal the pattern list on click', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: [PATTERN] });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns (1)')).toBeInTheDocument());

    openPanel();

    expect(screen.getByText('Timeout calling upstream <_>')).toBeInTheDocument();
  });

  it('renders patterns with a count, NEW badge, and mode label', async () => {
    getLogPatterns.mockResolvedValue({
      mode: 'serverPatterns',
      patterns: [
        PATTERN,
        { ...PATTERN, pattern: 'Failed to load <_>', count: 8, isNew: false, filterLiteral: 'Failed' },
      ],
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns (2)')).toBeInTheDocument());
    openPanel();

    expect(screen.getByText('Timeout calling upstream <_>')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
    expect(screen.getByText('server patterns')).toBeInTheDocument();
    // Header links to the log-patterns how-to.
    const docsLink = screen.getByRole('link', { name: /About log patterns/ });
    expect(docsLink).toHaveAttribute('href', 'https://doc.nais.io/observability/apm/how-to/log-patterns/');
  });

  it('applies the pattern filter literal on row click', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: [PATTERN] });
    const onSelectFilter = renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns (1)')).toBeInTheDocument());
    openPanel();

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
    await waitFor(() => expect(screen.getByText('Top error patterns (1)')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('sampled from newest 1000 error lines')).toBeInTheDocument());
  });

  it('renders the empty state', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: [], note: 'no error log patterns in range' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('No error patterns')).toBeInTheDocument());
  });

  it('surfaces unavailability', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'unavailable', patterns: [], note: 'logs datasource not configured' });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('logs datasource not configured')).toBeInTheDocument());
  });

  it('caps patterns to the top 6 with a "show all" affordance that reveals the rest', async () => {
    getLogPatterns.mockResolvedValue({ mode: 'serverPatterns', patterns: manyPatterns });
    renderPanel();
    await waitFor(() => expect(screen.getByText('Top error patterns (8)')).toBeInTheDocument());
    openPanel();

    await waitFor(() => expect(screen.getByText('Pattern 0 <_>')).toBeInTheDocument());
    for (let i = 0; i < 6; i++) {
      expect(screen.getByText(`Pattern ${i} <_>`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Pattern 6 <_>')).not.toBeInTheDocument();
    expect(screen.queryByText('Pattern 7 <_>')).not.toBeInTheDocument();

    const showAllButton = screen.getByRole('button', { name: 'Show all 8' });
    fireEvent.click(showAllButton);

    expect(screen.getByText('Pattern 6 <_>')).toBeInTheDocument();
    expect(screen.getByText('Pattern 7 <_>')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show top 6' })).toBeInTheDocument();
  });
});
