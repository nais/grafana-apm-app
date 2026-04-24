import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';

/** Shared styles for content sections with title + optional subtitle. */
export const getSectionStyles = (theme: GrafanaTheme2) => ({
  section: css`
    margin-top: ${theme.spacing(3)};
  `,
  sectionTitle: css`
    margin-bottom: ${theme.spacing(1)};
    font-size: ${theme.typography.h4.fontSize};
  `,
  sectionSubtitle: css`
    margin: 0 0 ${theme.spacing(1.5)} 0;
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
  `,
});
