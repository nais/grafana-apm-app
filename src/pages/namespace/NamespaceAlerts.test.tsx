import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NamespaceAlerts } from './NamespaceAlerts';
import { AlertRuleSummary } from '../../api/client';

const firingRule: AlertRuleSummary = {
  name: 'HighErrorRate',
  state: 'firing',
  severity: 'critical',
  summary: 'Error rate above 5%',
  description: '',
  activeSince: new Date(Date.now() - 3_600_000).toISOString(),
  activeCount: 2,
  groupName: 'myteam',
};

const pendingRule: AlertRuleSummary = {
  name: 'HighLatency',
  state: 'pending',
  severity: 'warning',
  summary: 'P95 latency above 500ms',
  description: '',
  activeSince: new Date(Date.now() - 300_000).toISOString(),
  activeCount: 1,
  groupName: 'myteam',
};

const inactiveRule: AlertRuleSummary = {
  name: 'DiskUsage',
  state: 'inactive',
  severity: 'warning',
  summary: 'Disk above 80%',
  description: '',
  activeSince: '',
  activeCount: 0,
  groupName: 'myteam',
};

describe('NamespaceAlerts', () => {
  it('renders firing and pending rules', () => {
    render(<NamespaceAlerts rules={[firingRule, pendingRule, inactiveRule]} />);

    expect(screen.getByText('HighErrorRate')).toBeInTheDocument();
    expect(screen.getByText('HighLatency')).toBeInTheDocument();
    expect(screen.getByText(/1 firing/)).toBeInTheDocument();
  });

  it('hides inactive rules by default and shows on expand', () => {
    render(<NamespaceAlerts rules={[firingRule, inactiveRule]} />);

    // Inactive rule not visible
    expect(screen.queryByText('DiskUsage')).not.toBeInTheDocument();

    // Toggle button shows count
    const toggle = screen.getByText(/1 inactive rule/);
    expect(toggle).toBeInTheDocument();

    // Click to expand
    fireEvent.click(toggle);
    expect(screen.getByText('DiskUsage')).toBeInTheDocument();
  });

  it('returns null when no rules', () => {
    const { container } = render(<NamespaceAlerts rules={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when unavailable', () => {
    const { container } = render(<NamespaceAlerts rules={[firingRule]} unavailable={true} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows all-good message when only inactive rules', () => {
    render(<NamespaceAlerts rules={[inactiveRule]} />);
    expect(screen.getByText(/All alert rules are inactive/)).toBeInTheDocument();
  });

  it('shows severity badge', () => {
    render(<NamespaceAlerts rules={[firingRule]} />);
    expect(screen.getByText('critical')).toBeInTheDocument();
  });

  it('shows active instance count', () => {
    render(<NamespaceAlerts rules={[firingRule]} />);
    expect(screen.getByText('2 instances')).toBeInTheDocument();
  });

  it('shows summary text', () => {
    render(<NamespaceAlerts rules={[firingRule]} />);
    expect(screen.getByText('Error rate above 5%')).toBeInTheDocument();
  });
});
