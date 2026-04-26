import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import StatusBoard from './StatusBoard';

jest.mock('../api/client', () => ({
  getServices: jest.fn().mockResolvedValue([
    {
      name: 'api-gw',
      namespace: 'myteam',
      environment: 'prod',
      rate: 42.5,
      errorRate: 0.3,
      p95Duration: 120,
      durationUnit: 'ms',
    },
    {
      name: 'payment',
      namespace: 'myteam',
      environment: 'prod',
      rate: 8,
      errorRate: 7.3,
      p95Duration: 3200,
      durationUnit: 'ms',
    },
  ]),
}));

function renderBoard(namespace = 'myteam') {
  return render(
    <MemoryRouter
      initialEntries={[`/a/nais-apm-app/namespaces/${namespace}/status`]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/a/nais-apm-app/namespaces/:namespace/status" element={<StatusBoard />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('StatusBoard', () => {
  it('renders without crashing', () => {
    const { container } = renderBoard();
    expect(container).toBeTruthy();
  });

  it('shows the namespace in the title', async () => {
    renderBoard();
    expect(await screen.findByText(/myteam — Status Board/)).toBeInTheDocument();
  });

  it('renders service cards after loading', async () => {
    renderBoard();
    expect(await screen.findByText('api-gw')).toBeInTheDocument();
    expect(await screen.findByText('payment')).toBeInTheDocument();
  });
});
