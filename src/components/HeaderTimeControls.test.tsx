import React, { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { HeaderTimeControls } from './HeaderTimeControls';

let currentSearch = '';
function SearchSpy() {
  const { search } = useLocation();
  useEffect(() => {
    currentSearch = search;
  }, [search]);
  return null;
}

function renderControls(route = '/?from=now-1h&to=now') {
  return render(
    <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <HeaderTimeControls />
      <SearchSpy />
    </MemoryRouter>
  );
}

describe('HeaderTimeControls', () => {
  it('renders the time picker with the relative range and the refresh control', () => {
    renderControls();
    // Grafana's TimeRangePicker labels the current range in its toolbar button.
    expect(screen.getByText(/Last 1 hour/i)).toBeInTheDocument();
    expect(screen.getByTestId('refresh-control')).toBeInTheDocument();
  });

  it('keeps a relative range relative in the URL', () => {
    renderControls('/?from=now-6h&to=now');
    expect(currentSearch).toContain('from=now-6h');
    expect(screen.getByText(/Last 6 hours/i)).toBeInTheDocument();
  });

  it('move-backward freezes the window as absolute ISO in ONE history update', async () => {
    renderControls('/?from=2026-07-04T10:00:00.000Z&to=2026-07-04T11:00:00.000Z');
    const back = screen.getByLabelText(/Move time range backwards/i);
    back.click();
    // One atomic write: both params flip to the shifted absolute hour.
    await waitFor(() => expect(currentSearch).toContain(encodeURIComponent('2026-07-04T09:00:00.000Z')));
    expect(currentSearch).toContain(encodeURIComponent('2026-07-04T10:00:00.000Z'));
    expect(currentSearch).not.toContain('now');
  });
});
