import React from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { BackButton } from './BackButton';

interface PageHeaderProps {
  title: React.ReactNode;
  backLabel: string;
  onBack: () => void;
  /** Optional content placed after the title (e.g. badges). */
  after?: React.ReactNode;
  /** Right-aligned controls (e.g. dropdowns, buttons). */
  controls?: React.ReactNode;
}

export function PageHeader({ title, backLabel, onBack, after, controls }: PageHeaderProps) {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <BackButton label={backLabel} onClick={onBack} />
        <h2 className={styles.title}>{title}</h2>
        {after}
      </div>
      {controls && <div className={styles.controls}>{controls}</div>}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  header: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: ${theme.spacing(2)};
    flex-wrap: wrap;
    gap: ${theme.spacing(1)};
  `,
  titleRow: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1.5)};
    flex-wrap: wrap;
  `,
  title: css`
    margin: 0;
    font-size: ${theme.typography.h2.fontSize};
  `,
  controls: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    flex-wrap: wrap;
  `,
});
