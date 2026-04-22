import React from 'react';

interface SparklineProps {
  /** Data points (numeric values). At least 2 needed to draw. */
  data?: number[];
  /** Stroke/fill colour. */
  color: string;
  /** SVG width in px (default 120). */
  width?: number;
  /** SVG height in px (default 28). */
  height?: number;
}

/**
 * Tiny inline area-sparkline rendered as a pure SVG.
 * No dependencies beyond React.
 */
export function Sparkline({ data, color, width = 120, height = 28 }: SparklineProps) {
  if (!data || data.length < 2) {
    return <div style={{ width, height, flexShrink: 1 }} />;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pad = 1;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - 2 * pad);
    const y = pad + (1 - (v - min) / range) * (height - 2 * pad);
    return `${x},${y}`;
  });

  const linePoints = points.join(' ');
  const areaPoints = `${pad},${height} ${linePoints} ${width - pad},${height}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width, height, flexShrink: 1, display: 'block' }}
      preserveAspectRatio="none"
    >
      <polygon fill={color} fillOpacity="0.25" points={areaPoints} />
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={linePoints} />
    </svg>
  );
}
