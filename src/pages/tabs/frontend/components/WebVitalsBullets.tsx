import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

import { BulletGraph } from '../../../../components/BulletGraph';
import { VITAL_DEFS } from '../constants';

interface WebVitalsBulletsProps {
  vitals: Record<string, number>;
}

/** Displays the five CWV bullet charts in a responsive grid. */
export function WebVitalsBullets({ vitals }: WebVitalsBulletsProps) {
  const styles = useStyles2(getBulletStyles);

  return (
    <div className={styles.grid}>
      {VITAL_DEFS.map((def) => (
        <BulletGraph
          key={def.key}
          value={vitals[def.key] ?? null}
          thresholds={def.thresholds}
          label={def.label}
          description={def.description}
          tooltip={def.tooltip}
          unit={def.unit}
          decimals={def.decimals}
        />
      ))}
    </div>
  );
}

const getBulletStyles = (theme: GrafanaTheme2) => ({
  grid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: ${theme.spacing(1)};
  `,
});
