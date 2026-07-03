import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ServiceInventory from './ServiceInventory';
import { FavoritesStore, FavoritesStorage } from '../utils/favoritesStorage';

jest.mock('../api/client', () => ({
  getServices: jest.fn().mockImplementation(() =>
    Promise.resolve([
      {
        name: 'my-api',
        namespace: 'team-a',
        environment: 'prod',
        rate: 100,
        errorRate: 0.5,
        p95Duration: 45,
        durationUnit: 'ms',
        framework: 'ktor',
        isSidecar: false,
      },
      {
        name: 'payment',
        namespace: 'team-b',
        environment: 'prod',
        rate: 50,
        errorRate: 2.1,
        p95Duration: 120,
        durationUnit: 'ms',
        framework: 'express',
        isSidecar: false,
      },
      {
        name: 'frontend',
        namespace: 'team-a',
        environment: 'prod',
        rate: 200,
        errorRate: 0.1,
        p95Duration: 30,
        durationUnit: 'ms',
        framework: 'next',
        isSidecar: false,
      },
    ])
  ),
  getCapabilities: jest.fn().mockImplementation(() =>
    Promise.resolve({
      spanMetrics: { detected: true, namespace: 'traces_spanmetrics' },
      serviceGraph: { detected: false },
      tempo: { available: false },
      loki: { available: false },
      services: [
        {
          name: 'my-api',
          namespace: 'team-a',
          environment: 'prod',
          rate: 100,
          errorRate: 0.5,
          p95Duration: 45,
          durationUnit: 'ms',
          framework: 'ktor',
          isSidecar: false,
        },
        {
          name: 'payment',
          namespace: 'team-b',
          environment: 'prod',
          rate: 50,
          errorRate: 2.1,
          p95Duration: 120,
          durationUnit: 'ms',
          framework: 'express',
          isSidecar: false,
        },
        {
          name: 'frontend',
          namespace: 'team-a',
          environment: 'prod',
          rate: 200,
          errorRate: 0.1,
          p95Duration: 30,
          durationUnit: 'ms',
          framework: 'next',
          isSidecar: false,
        },
      ],
    })
  ),
}));

// Use a module-level ref that tests can swap
let activeStore: FavoritesStore;

jest.mock('../utils/useFavorites', () => {
  const actual = jest.requireActual('../utils/useFavorites');
  return {
    ...actual,
    useFavorites: () => actual.useFavorites(activeStore),
  };
});

function renderInventory(route = '/services') {
  return render(
    <MemoryRouter initialEntries={[route]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ServiceInventory />
    </MemoryRouter>
  );
}

function createStore(initial: string[] = []): FavoritesStore {
  const storage: FavoritesStorage = {
    load: jest.fn().mockReturnValue(initial),
    save: jest.fn(),
  };
  return new FavoritesStore(storage);
}

describe('ServiceInventory — Favorites', () => {
  beforeEach(() => {
    localStorage.clear();
    activeStore = createStore();
  });

  afterEach(() => {
    activeStore.destroy();
  });

  it('renders star icons for each service row', async () => {
    renderInventory();
    const buttons = await screen.findAllByRole('button', { name: /to My Apps/i });
    // Should have one star per service
    expect(buttons.length).toBe(3);
  });

  it('toggles favorite on star click without navigating', async () => {
    renderInventory();
    const addButtons = await screen.findAllByRole('button', { name: /Add .+ to My Apps/i });
    // Click the first star (my-api — alphabetically first)
    fireEvent.click(addButtons[0]);

    // Should now show "Remove from My Apps" for that service
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove frontend from My Apps/i })).toBeInTheDocument();
    });
  });

  it('My Apps button shows favorite count', async () => {
    activeStore.toggle('team-a/my-api');
    renderInventory();
    // Wait for data to load by finding a service name
    await screen.findByText('my-api');
    // Find the My Apps toggle button (starts with "My Apps", not "...to My Apps")
    const myAppsBtn = screen.getByRole('button', { name: /^My Apps/i });
    expect(myAppsBtn).toHaveTextContent('My Apps (1)');
  });

  it('My Apps filter shows only favorited services', async () => {
    activeStore.toggle('team-b/payment');
    renderInventory('/services?favorites=true');
    // Only "payment" should be visible
    expect(await screen.findByText('payment')).toBeInTheDocument();
    expect(screen.queryByText('my-api')).not.toBeInTheDocument();
    expect(screen.queryByText('frontend')).not.toBeInTheDocument();
  });

  it('shows empty state when My Apps filter active but no favorites', async () => {
    renderInventory('/services?favorites=true');
    expect(await screen.findByText(/No favorites yet/i)).toBeInTheDocument();
  });

  it('favorites sort to top on default sort', async () => {
    activeStore.toggle('team-b/payment');
    renderInventory();
    const rows = await screen.findAllByRole('row');
    // First data row (after header) should be payment (favorited)
    const firstDataRow = rows[1];
    expect(firstDataRow).toHaveTextContent('payment');
  });
});

describe('ServiceInventory — Fuzzy search', () => {
  beforeEach(() => {
    localStorage.clear();
    activeStore = createStore();
  });

  afterEach(() => {
    activeStore.destroy();
  });

  it('finds a service from a misspelled query', async () => {
    renderInventory('/services?q=paymnt');
    expect(await screen.findByText('payment')).toBeInTheDocument();
    expect(screen.queryByText('my-api')).not.toBeInTheDocument();
    expect(screen.queryByText('frontend')).not.toBeInTheDocument();
  });

  it('matches on namespace', async () => {
    // 'team-b' is an exact namespace match for 'payment' and should rank first,
    // even though 'team-a' (my-api/frontend) is a close fuzzy neighbor too.
    renderInventory('/services?q=team-b');
    const rows = await screen.findAllByRole('row');
    expect(rows[1]).toHaveTextContent('payment');
  });

  it('shows no rows for a query that matches nothing', async () => {
    renderInventory('/services?q=zzzznonexistentzzzz');
    await waitFor(() => expect(screen.queryByText(/Loading services/i)).not.toBeInTheDocument());
    expect(screen.queryByText('my-api')).not.toBeInTheDocument();
    expect(screen.queryByText('payment')).not.toBeInTheDocument();
    expect(screen.queryByText('frontend')).not.toBeInTheDocument();
  });
});

describe('ServiceInventory — Column sorting', () => {
  beforeEach(() => {
    activeStore = createStore([]);
  });

  it('re-sorts rows when a column header is clicked', async () => {
    renderInventory();
    await waitFor(() => expect(screen.getByText('my-api')).toBeInTheDocument());

    const names = ['my-api', 'payment', 'frontend'];
    const rowNames = () =>
      screen
        .getAllByRole('row')
        .slice(1) // skip header row
        .map((r) => names.find((n) => within(r).queryByText(n, { exact: true }) !== null) ?? '')
        .filter(Boolean);

    // Default: name ascending
    expect(rowNames()).toEqual(['frontend', 'my-api', 'payment']);

    // Click P95 header → numeric columns default to descending
    fireEvent.click(screen.getByText(/P95/i));
    await waitFor(() => expect(rowNames()).toEqual(['payment', 'my-api', 'frontend']));
  });

  it('column sorting still wins while a search query is active', async () => {
    // 'team' fuzzy-matches all three services (both namespaces); relevance is
    // only the default order — an explicit column sort must override it.
    renderInventory('/services?q=team&sort=p95Duration&dir=desc');
    await waitFor(() => expect(screen.getByText('my-api')).toBeInTheDocument());

    const names = ['my-api', 'payment', 'frontend'];
    const rows = screen.getAllByRole('row').slice(1);
    const order = rows
      .map((r) => names.find((n) => within(r).queryByText(n, { exact: true }) !== null) ?? '')
      .filter(Boolean);
    expect(order).toEqual(['payment', 'my-api', 'frontend']);
  });
});
