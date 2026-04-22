import React from 'react';
import { LinkButton } from '@grafana/ui';

interface BackButtonProps {
  label: string;
  onClick: () => void;
}

export function BackButton({ label, onClick }: BackButtonProps) {
  return (
    <LinkButton variant="secondary" size="sm" icon="arrow-left" fill="text" onClick={onClick}>
      {label}
    </LinkButton>
  );
}
