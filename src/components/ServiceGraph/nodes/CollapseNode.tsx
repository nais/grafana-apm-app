import React, { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Icon, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css, cx } from '@emotion/css';

export interface CollapseNodeData {
  label: string;
  count: number;
  side: 'caller' | 'target';
  [key: string]: unknown;
}

type CollapseNodeType = Node<CollapseNodeData>;

export const CollapseNode = memo(({ data, sourcePosition, targetPosition }: NodeProps<CollapseNodeType>) => {
  const styles = useStyles2(getStyles);
  const isCaller = data.side === 'caller';

  return (
    <div className={cx(styles.node)}>
      <Handle type="target" position={targetPosition ?? Position.Left} className={styles.handle} />
      <div className={styles.content}>
        <Icon name={isCaller ? 'angle-double-right' : 'angle-double-left'} size="sm" />
        <span className={styles.label}>{data.label}</span>
      </div>
      <div className={styles.hint}>Click to expand</div>
      <Handle type="source" position={sourcePosition ?? Position.Right} className={styles.handle} />
    </div>
  );
});

CollapseNode.displayName = 'CollapseNode';

const getStyles = (theme: GrafanaTheme2) => ({
  node: css`
    background: ${theme.colors.background.secondary};
    border: 1.5px dashed ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
    padding: ${theme.spacing(0.75)} ${theme.spacing(1.5)};
    min-width: 130px;
    cursor: pointer;
    text-align: center;
    transition:
      border-color 0.15s ease,
      background 0.15s ease;
    &:hover {
      border-color: ${theme.colors.primary.border};
      background: ${theme.colors.action.hover};
    }
  `,
  content: css`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: ${theme.spacing(0.5)};
    color: ${theme.colors.text.secondary};
    font-size: 12px;
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  hint: css`
    font-size: 10px;
    color: ${theme.colors.text.disabled};
    margin-top: 2px;
  `,
  label: css`
    white-space: nowrap;
  `,
  handle: css`
    width: 8px !important;
    height: 8px !important;
    opacity: 0 !important;
    pointer-events: none !important;
  `,
});
