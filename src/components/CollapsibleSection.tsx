import React, { useState } from 'react';
import { Icon, useStyles2 } from '@grafana/ui';
import { GrafanaTheme2 } from '@grafana/data';
import { css, cx } from '@emotion/css';

interface CollapsibleSectionProps {
  /** Header text/content shown next to the chevron. */
  label: React.ReactNode;
  /** Open on first render? Defaults to collapsed. */
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * A collapse whose container sizes to its content. When collapsed the body is
 * UNMOUNTED (not just CSS-hidden), so there is no empty box; when open it grows
 * to exactly the content height. Replaces `@grafana/ui`'s `ControlledCollapse`,
 * whose panel container stretched in our flex-column tab layouts — leaving a
 * tall empty box when collapsed and wasted space below the content when open.
 */
export function CollapsibleSection({ label, defaultOpen = false, children, className }: CollapsibleSectionProps) {
  const styles = useStyles2(getStyles);
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={cx(styles.container, className)}>
      <button type="button" className={styles.header} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? 'angle-down' : 'angle-right'} />
        <span className={styles.label}>{label}</span>
      </button>
      {open && <div className={styles.body}>{children}</div>}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css`
    background: ${theme.colors.background.secondary};
    border: 1px solid ${theme.colors.border.weak};
    border-radius: ${theme.shape.radius.default};
  `,
  header: css`
    display: flex;
    align-items: center;
    gap: ${theme.spacing(1)};
    width: 100%;
    padding: ${theme.spacing(1, 1.5)};
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    color: ${theme.colors.text.primary};

    &:hover {
      background: ${theme.colors.action.hover};
    }
  `,
  label: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  body: css`
    padding: ${theme.spacing(1, 1.5, 1.5)};
  `,
});
