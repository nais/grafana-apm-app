import React, { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

export interface ServiceNodeData {
  label: string;
  mainStat?: string;
  secondaryStat?: string;
  errorRate?: number;
  nodeType?: 'service' | 'database' | 'messaging' | 'external';
  isFocused?: boolean;
  [key: string]: unknown;
}

type ServiceNodeType = Node<ServiceNodeData>;

const nodeIcons: Record<string, string> = {
  service: '⚙️',
  database: '🗄️',
  messaging: '📨',
  external: '🌐',
};

export const ServiceNode = memo(({ data, sourcePosition, targetPosition }: NodeProps<ServiceNodeType>) => {
  const styles = useStyles2(getStyles);
  const nodeType = data.nodeType ?? 'service';
  const icon = nodeIcons[nodeType] ?? '⚙️';
  const errorRate = data.errorRate ?? 0;

  const borderClass = errorRate > 0.05 ? styles.borderError : errorRate > 0.01 ? styles.borderWarning : styles.borderOk;

  return (
    <div className={`${styles.node} ${borderClass} ${data.isFocused ? styles.focused : ''}`}>
      <Handle type="target" position={targetPosition ?? Position.Left} className={styles.handle} />
      <div className={styles.header}>
        <span className={styles.icon}>{icon}</span>
        <span className={styles.label} title={data.label}>
          {data.label}
        </span>
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
    border: 2px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.5)} ${theme.spacing(1)};
    min-width: 120px;
    max-width: 200px;
    cursor: pointer;
    font-size: 11px;
    transition:
      border-color 0.15s ease,
      box-shadow 0.15s ease;
    &:hover {
      box-shadow: ${theme.shadows.z2};
    }
  `,
  borderOk: css`
    border-color: ${theme.colors.success.border};
  `,
  borderWarning: css`
    border-color: ${theme.colors.warning.border};
  `,
  borderError: css`
    border-color: ${theme.colors.error.border};
  `,
  focused: css`
    border-width: 3px;
    box-shadow: 0 0 0 2px ${theme.colors.primary.border};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(0.5)};
  `,
  icon: css`
    font-size: 12px;
    flex-shrink: 0;
  `,
  label: css`
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
    color: ${theme.colors.text.primary};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `,
  stats: css`
    display: flex;
    gap: ${theme.spacing(0.5)};
    font-size: 10px;
    margin-top: 1px;
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
