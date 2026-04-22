import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({
    get: jest.fn().mockResolvedValue([
      { uid: 'mimir', name: 'Mimir', type: 'prometheus', isDefault: true },
      { uid: 'tempo', name: 'Tempo', type: 'tempo', isDefault: true },
      { uid: 'loki', name: 'Loki', type: 'loki', isDefault: true },
    ]),
    fetch: jest.fn(),
  }),
}));

describe('Components/AppConfig', () => {
  let props: AppConfigProps;

  beforeEach(() => {
    jest.resetAllMocks();

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
});
