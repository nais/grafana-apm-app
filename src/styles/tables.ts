import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';

/**
 * Shared table styles for consistent alignment across all pages.
 * Usage: const ts = useStyles2(getTableStyles);
 */
export const getTableStyles = (theme: GrafanaTheme2) => ({
  table: css`
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    table-layout: fixed;
    th {
      text-align: left;
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      color: ${theme.colors.text.secondary};
      font-size: ${theme.typography.bodySmall.fontSize};
      font-weight: ${theme.typography.fontWeightMedium};
      border-bottom: 1px solid ${theme.colors.border.medium};
      white-space: nowrap;
      user-select: none;
    }
    td {
      padding: ${theme.spacing(1)} ${theme.spacing(1.5)};
      border-bottom: 1px solid ${theme.colors.border.weak};
      vertical-align: middle;
    }
  `,
  sortableHeader: css`
    cursor: pointer;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  clickableRow: css`
    cursor: pointer;
    &:hover {
      background: ${theme.colors.background.secondary};
    }
  `,
  nameCell: css`
    font-weight: ${theme.typography.fontWeightMedium};
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  secondaryCell: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
  numCell: css`
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  `,
  numHeader: css`
    text-align: right;
    cursor: pointer;
    &:hover {
      color: ${theme.colors.text.primary};
    }
  `,
  errorCell: css`
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: ${theme.colors.error.text};
    font-weight: ${theme.typography.fontWeightMedium};
  `,
});
