import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';
import { testIds } from 'components/testIds';

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

  test('renders data source and detection fieldsets', () => {
    const plugin = { meta: { ...props.plugin.meta, enabled: true } };

    // @ts-ignore
    render(<AppConfig plugin={plugin} query={props.query} />);

    expect(screen.queryByRole('group', { name: /data sources/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /detection & overrides/i })).toBeInTheDocument();
    expect(screen.queryByTestId(testIds.appConfig.submit)).toBeInTheDocument();
  });
});
