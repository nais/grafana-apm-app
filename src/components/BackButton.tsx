import React from 'react';
import { IconButton } from '@grafana/ui';

interface BackButtonProps {
  label: string;
  onClick: () => void;
}

export function BackButton({ label, onClick }: BackButtonProps) {
  return <IconButton name="arrow-left" size="xl" tooltip={label} onClick={onClick} variant="secondary" />;
}
