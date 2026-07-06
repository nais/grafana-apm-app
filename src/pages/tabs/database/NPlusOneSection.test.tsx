import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { NPlusOneSection } from './NPlusOneSection';
import * as analytics from '../../../api/analytics';
import { NPlusOneResponse } from '../../../api/analytics';

jest.mock('../../../api/analytics');
const mockScanNPlusOne = analytics.scanNPlusOne as jest.MockedFunction<typeof analytics.scanNPlusOne>;

const baseResponse: NPlusOneResponse = {
  mode: 'traceql',
  scannedTraces: 12,
  truncated: false,
  windowSeconds: 3600,
  threshold: 10,
  findings: [
    {
      statement: 'select * from person where id in (?)',
      dbSystem: 'postgresql',
      table: 'person',
      repeatCount: 40,
      endpoint: 'GET /oppgaveliste.jsf',
      totalDbSpans: 90,
      traceId: 'abc123',
      remediation: 'Replace the per-row queries with a JOIN, a batch fetch, or a single IN (…) clause.',
    },
    {
      statement: 'GET ?',
      dbSystem: 'redis',
      repeatCount: 15,
      endpoint: 'POST /submit',
      totalDbSpans: 20,
      traceId: 'def456',
      remediation: 'Batch the repeated lookups into one round-trip — use MGET (or a pipeline / MULTI).',
    },
  ],
};

const renderSection = () =>
  render(
    <MemoryRouter>
      <NPlusOneSection namespace="myns" service="mysvc" fromMs={1000} toMs={2000} tracesUid="tempo-uid" />
    </MemoryRouter>
  );

describe('NPlusOneSection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not scan until the user clicks the button (on-demand)', () => {
    mockScanNPlusOne.mockResolvedValue(baseResponse);
    renderSection();
    expect(mockScanNPlusOne).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Scan for N\+1/ })).toBeInTheDocument();
  });

  it('renders findings with endpoint, repeat count, trace link and remediation on scan', async () => {
    mockScanNPlusOne.mockResolvedValue(baseResponse);
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Scan for N\+1/ }));

    await waitFor(() => expect(screen.getByText('select * from person where id in (?)')).toBeInTheDocument());
    expect(mockScanNPlusOne).toHaveBeenCalledTimes(1);

    // Endpoint + repeat-count framing.
    expect(screen.getByText('GET /oppgaveliste.jsf')).toBeInTheDocument();
    expect(screen.getByText('POST /submit')).toBeInTheDocument();
    expect(screen.getByText('40× in one request')).toBeInTheDocument();

    // Per-system remediation hints render.
    expect(screen.getByText(/use a JOIN|Replace the per-row queries/i)).toBeInTheDocument();
    expect(screen.getByText(/MGET/)).toBeInTheDocument();

    // Trace links point at the traceId via TraceQL Explore.
    const links = screen.getAllByRole('link', { name: 'View offending trace' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('abc123'));
  });

  it('shows a clean "no N+1" state when the scan finds nothing', async () => {
    mockScanNPlusOne.mockResolvedValue({
      mode: 'traceql',
      findings: [],
      scannedTraces: 5,
      truncated: false,
      windowSeconds: 3600,
      threshold: 10,
    });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Scan for N\+1/ }));
    await waitFor(() => expect(screen.getByText(/No N\+1 patterns found/i)).toBeInTheDocument());
  });

  it('shows a graceful notice when trace search is unavailable', async () => {
    mockScanNPlusOne.mockResolvedValue({
      mode: 'unavailable',
      findings: [],
      scannedTraces: 0,
      truncated: false,
      windowSeconds: 3600,
      threshold: 10,
      note: 'trace search unavailable (Tempo may be busy) — try a narrower range',
    });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Scan for N\+1/ }));
    await waitFor(() => expect(screen.getByText(/trace search unavailable/i)).toBeInTheDocument());
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('reports a bounded sample when the scan was truncated', async () => {
    mockScanNPlusOne.mockResolvedValue({ ...baseResponse, truncated: true });
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: /Scan for N\+1/ }));
    await waitFor(() => expect(screen.getByText(/scan limit was reached/i)).toBeInTheDocument());
  });
});
