import React from 'react';
import { css } from '@emotion/css';

/**
 * Framework metadata for SDK/framework badges used across pages.
 */
export const FRAMEWORK_BADGES: Record<string, { label: string; bg: string }> = {
  Ktor: { label: 'Ktor', bg: '#7B68EE' },
  'Spring Boot': { label: 'Spring', bg: '#6DB33F' },
  'Node.js': { label: 'Node.js', bg: '#68A063' },
  Go: { label: 'Go', bg: '#00ADD8' },
  Java: { label: 'Java', bg: '#5382A1' },
  Python: { label: 'Python', bg: '#3776AB' },
  '.NET': { label: '.NET', bg: '#512BD4' },
};

/**
 * Compact pill badge for framework/SDK, with a custom background colour.
 */
export function FrameworkBadge({ framework, className }: { framework?: string; className?: string }) {
  if (!framework) {
    return null;
  }
  const info = FRAMEWORK_BADGES[framework];
  if (!info) {
    return <span className={`${badgeStyle('#888')}${className ? ` ${className}` : ''}`}>{framework}</span>;
  }
  return <span className={`${badgeStyle(info.bg)}${className ? ` ${className}` : ''}`}>{info.label}</span>;
}

function badgeStyle(bg: string) {
  return css`
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 400;
    color: white;
    letter-spacing: 0.5px;
    background-color: ${bg};
    vertical-align: middle;
  `;
}
