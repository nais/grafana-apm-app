import React, { memo } from 'react';
import { useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import type { NodeProps, Node } from '@xyflow/react';

export interface GroupNodeData {
  label: string;
  [key: string]: unknown;
}

type GroupNodeType = Node<GroupNodeData>;

export const GroupNode = memo(({ data }: NodeProps<GroupNodeType>) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.group}>
      <span className={styles.label}>{data.label}</span>
    </div>
  );
});

GroupNode.displayName = 'GroupNode';

const getStyles = (theme: GrafanaTheme2) => ({
  group: css`
    width: 100%;
    height: 100%;
    border: 2px dashed ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
    background: ${theme.colors.background.primary}40;
    padding: ${theme.spacing(1)};
    position: relative;
  `,
  label: css`
    position: absolute;
    top: ${theme.spacing(0.5)};
    left: ${theme.spacing(1)};
    font-size: 11px;
    color: ${theme.colors.text.disabled};
    font-weight: ${theme.typography.fontWeightMedium};
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `,
});
