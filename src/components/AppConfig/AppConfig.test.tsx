import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

const mockGet = jest.fn();
const mockFetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({
    get: mockGet,
    fetch: mockFetch,
  }),
}));

// Extract the settings payload the component POSTs on submit.
const submittedPayload = () => {
  const call = mockFetch.mock.calls.find((c) => String(c[0]?.url).endsWith('/settings'));
  if (!call) {
    throw new Error('settings POST was never issued');
  }
  return call[0].data as {
    jsonData: Record<string, unknown>;
    secureJsonData?: Record<string, unknown>;
  };
};

describe('Components/AppConfig', () => {
  let props: AppConfigProps;

  beforeEach(() => {
    jest.resetAllMocks();
    mockGet.mockResolvedValue([
      { uid: 'mimir', name: 'Mimir', type: 'prometheus', isDefault: true },
      { uid: 'tempo', name: 'Tempo', type: 'tempo', isDefault: true },
      { uid: 'loki', name: 'Loki', type: 'loki', isDefault: true },
    ]);
    // fetch returns undefined; lastValueFrom rejects and is swallowed by the
    // component's catch, so window.location.reload is never reached in tests.
    mockFetch.mockReturnValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    props = {
      plugin: {
        meta: {
          id: 'nais-apm-app',
          name: 'Nais APM',
          type: PluginType.app,
          enabled: true,
          jsonData: {
            metricsDataSource: { uid: 'mimir', type: 'prometheus' },
            tracesDataSource: { uid: 'tempo', type: 'tempo' },
            logsDataSource: { uid: 'loki', type: 'loki' },
          },
        },
      },
      query: {},
    } as unknown as AppConfigProps;
  });

  test('renders data source and detection fieldsets', async () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true } };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    expect(screen.queryByRole('group', { name: /data sources/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /detection & overrides/i })).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.submit)).toBeInTheDocument();
  });

  test('updates deployment environment label without synthetic event errors', async () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true } };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    const input = screen.getByPlaceholderText('k8s_cluster_name') as HTMLInputElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'cluster' } });
    });

    expect(input.value).toBe('cluster');
  });

  test('renders the nais API fieldset and round-trips the URL into jsonData on submit', async () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true } };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    expect(screen.queryByRole('group', { name: /nais api/i })).toBeInTheDocument();

    const urlInput = screen.getByPlaceholderText(/graphql/i) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://console.example/graphql' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(testIds.appConfig.submit));
    });

    const payload = submittedPayload();
    expect(payload.jsonData.naisApiUrl).toBe('https://console.example/graphql');
    // No secret was typed, so nothing secure should be sent.
    expect(payload.secureJsonData).toBeUndefined();
  });

  test('sends the nais API token via secureJsonData only when a new value is entered', async () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true } };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    const tokenInput = screen.getByPlaceholderText('nais API token') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(tokenInput, { target: { value: 'secret-token' } });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(testIds.appConfig.submit));
    });

    const payload = submittedPayload();
    expect(payload.secureJsonData?.naisApiToken).toBe('secret-token');
    // The unrelated service-account token must not be sent.
    expect(payload.secureJsonData?.serviceAccountToken).toBeUndefined();
  });

  test('clears a configured service account token via reset + save (sends empty string)', async () => {
    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        secureJsonFields: { serviceAccountToken: true },
      },
    };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    // A configured SecretInput renders a Reset button; clicking it signals intent
    // to clear the secret rather than leaving the stored value untouched.
    const resetButtons = screen.getAllByText('Reset');
    await act(async () => {
      fireEvent.click(resetButtons[0]);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(testIds.appConfig.submit));
    });

    const payload = submittedPayload();
    // Explicit reset must send an empty string so Grafana overwrites/clears it.
    expect(payload.secureJsonData?.serviceAccountToken).toBe('');
    // The untouched nais token must not be sent at all.
    expect(payload.secureJsonData?.naisApiToken).toBeUndefined();
  });

  test('does not send a configured secret that was left untouched', async () => {
    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        secureJsonFields: { serviceAccountToken: true, naisApiToken: true },
      },
    };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId(testIds.appConfig.submit));
    });

    const payload = submittedPayload();
    // Nothing was touched, so no secure payload should be sent (secrets preserved).
    expect(payload.secureJsonData).toBeUndefined();
  });

  test('shows the nais API token as configured and round-trips a provisioned URL', async () => {
    const plugin = {
      meta: {
        ...props.plugin.meta,
        enabled: true,
        jsonData: { ...props.plugin.meta.jsonData, naisApiUrl: 'https://console.provisioned/graphql' },
        secureJsonFields: { naisApiToken: true },
      },
    };

    await act(async () => {
      // @ts-ignore
      render(<AppConfig plugin={plugin} query={props.query} />);
    });

    // SecretInput in its configured state renders a disabled "configured" field.
    expect(screen.getByDisplayValue('configured')).toBeInTheDocument();
    // The provisioned URL is read back from jsonData.
    expect(screen.getByDisplayValue('https://console.provisioned/graphql')).toBeInTheDocument();
  });
});
