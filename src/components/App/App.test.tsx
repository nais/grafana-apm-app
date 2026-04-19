import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRootProps, PluginType } from '@grafana/data';
import { render } from '@testing-library/react';
import App from './App';

// Mock the API client to prevent real HTTP calls
jest.mock('../../api/client', () => ({
  getCapabilities: jest.fn().mockResolvedValue({
    spanMetrics: { detected: false },
    serviceGraph: { detected: false },
    tempo: { available: false },
    loki: { available: false },
    services: [],
  }),
  getServices: jest.fn().mockResolvedValue([]),
}));

describe('Components/App', () => {
  let props: AppRootProps;

  beforeEach(() => {
    jest.resetAllMocks();

    props = {
      basename: 'a/nais-applicationobservability-app',
      meta: {
        id: 'nais-applicationobservability-app',
        name: 'Application Observability',
        type: PluginType.app,
        enabled: true,
        jsonData: {},
      },
      query: {},
      path: '',
      onNavChanged: jest.fn(),
    } as unknown as AppRootProps;
  });

  test('renders without an error', () => {
    const { container } = render(
      <MemoryRouter>
        <App {...props} />
      </MemoryRouter>
    );
    expect(container).toBeTruthy();
  });
});
