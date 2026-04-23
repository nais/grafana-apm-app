import React, { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Icon, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2, type IconName } from '@grafana/data';
import { css, cx } from '@emotion/css';

export interface ServiceNodeData {
  label: string;
  subtitle?: string;
  mainStat?: string;
  secondaryStat?: string;
  errorRate?: number;
  nodeType?: 'service' | 'database' | 'messaging' | 'external';
  isFocused?: boolean;
  dimmed?: boolean;
  [key: string]: unknown;
}

type ServiceNodeType = Node<ServiceNodeData>;

const NODE_TYPE_CONFIG: Record<string, { icon: IconName; bg: string }> = {
  service: { icon: 'cube', bg: '#3871DC' },
  database: { icon: 'database', bg: '#336791' },
  messaging: { icon: 'envelope', bg: '#FF6600' },
  external: { icon: 'globe', bg: '#6E6E6E' },
};

export const ServiceNode = memo(({ data, sourcePosition, targetPosition }: NodeProps<ServiceNodeType>) => {
  const styles = useStyles2(getStyles);
  const nodeType = data.nodeType ?? 'service';
  const config = NODE_TYPE_CONFIG[nodeType] ?? NODE_TYPE_CONFIG.service;
  const errorRate = data.errorRate ?? 0;

  const borderClass =
    errorRate > 0.05 ? styles.borderError : errorRate > 0.01 ? styles.borderWarning : styles.borderDefault;

  return (
    <div className={cx(styles.node, borderClass, data.isFocused && styles.focused, data.dimmed && styles.dimmed)}>
      <Handle type="target" position={targetPosition ?? Position.Left} className={styles.handle} />
      <div className={styles.header}>
        <span className={styles.iconBadge} style={{ background: config.bg }}>
          <Icon name={config.icon} size="xs" />
        </span>
        <div className={styles.labelGroup}>
          <span className={styles.label} title={data.label}>
            {data.label}
          </span>
          {data.subtitle && (
            <span className={styles.subtitle} title={data.subtitle}>
              {data.subtitle}
            </span>
          )}
        </div>
      </div>
      {(data.mainStat || data.secondaryStat) && (
        <div className={styles.stats}>
          {data.mainStat && <span className={styles.mainStat}>{data.mainStat}</span>}
          {data.secondaryStat && <span className={styles.secondaryStat}>{data.secondaryStat}</span>}
        </div>
      )}
      <Handle type="source" position={sourcePosition ?? Position.Right} className={styles.handle} />
    </div>
  );
});

ServiceNode.displayName = 'ServiceNode';

const getStyles = (theme: GrafanaTheme2) => ({
  node: css`
    background: ${theme.colors.background.secondary};
    border: 1.5px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    min-width: 110px;
    max-width: 200px;
    cursor: pointer;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease,
      opacity 0.15s ease;
    &:hover {
      box-shadow: ${theme.shadows.z2};
      border-color: ${theme.colors.text.secondary};
    }
  `,
  borderDefault: css`
    border-color: ${theme.colors.border.medium};
  `,
  borderWarning: css`
    border-color: ${theme.colors.warning.border};
    border-width: 2px;
  `,
  borderError: css`
    border-color: ${theme.colors.error.border};
    border-width: 2px;
  `,
  focused: css`
    border-width: 2px;
    border-color: ${theme.colors.primary.border};
    box-shadow: 0 0 0 2px ${theme.colors.primary.transparent};
  `,
  dimmed: css`
    opacity: 0.5;
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  iconBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    color: #fff;
    flex-shrink: 0;
  `,
  labelGroup: css`
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-width: 0;
  `,
  label: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  subtitle: css`
    font-size: 10px;
    color: ${theme.colors.text.secondary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.2;
  `,
  stats: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    font-size: 10px;
    margin-top: 1px;
    padding-left: 22px;
  `,
  mainStat: css`
    color: ${theme.colors.text.secondary};
  `,
  secondaryStat: css`
    color: ${theme.colors.text.disabled};
  `,
  handle: css`
    width: 8px !important;
    height: 8px !important;
    opacity: 0 !important;
    pointer-events: none !important;
  `,
});
