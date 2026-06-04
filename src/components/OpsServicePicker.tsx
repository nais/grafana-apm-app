import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, Input, Modal, useStyles2 } from '@grafana/ui';
import { ServiceSummary } from '../api/client';
import { OpsWatchlistEntry, watchlistKey } from '../utils/useOpsWatchlist';

interface OpsServicePickerProps {
  isOpen: boolean;
  services: ServiceSummary[];
  watchlist: OpsWatchlistEntry[];
  onDismiss: () => void;
  onAdd: (namespace: string, service: string) => void;
  onRemove: (namespace: string, service: string) => void;
}

function serviceLabel(service: ServiceSummary): string {
  const env = service.environment ? ` · ${service.environment}` : '';
  return `${service.namespace}/${service.name}${env}`;
}

export function OpsServicePicker({ isOpen, services, watchlist, onDismiss, onAdd, onRemove }: OpsServicePickerProps) {
  const styles = useStyles2(getStyles);
  const [search, setSearch] = useState('');

  const watchlistSet = useMemo(
    () => new Set(watchlist.map((entry) => watchlistKey(entry.namespace, entry.service))),
    [watchlist]
  );

  const filteredServices = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return services;
    }
    return services.filter((service) => serviceLabel(service).toLowerCase().includes(query));
  }, [search, services]);

  return (
    <Modal isOpen={isOpen} onDismiss={onDismiss} title="Configure services">
      <div className={styles.content}>
        <Input
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder="Search namespace or service"
          aria-label="Search services"
          autoFocus
        />

        {services.length === 0 ? (
          <Alert severity="info" title="No services found">
            The selected time range does not contain any discovered services yet.
          </Alert>
        ) : filteredServices.length === 0 ? (
          <Alert severity="info" title="No matches">
            No services match the current search.
          </Alert>
        ) : (
          <div className={styles.list} role="list" aria-label="Available services">
            {filteredServices.map((service) => {
              const key = watchlistKey(service.namespace, service.name);
              const selected = watchlistSet.has(key);
              return (
                <div key={key} className={styles.row} role="listitem">
                  <div className={styles.meta}>
                    <div className={styles.name}>{service.name}</div>
                    <div className={styles.namespace}>{serviceLabel(service)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant={selected ? 'secondary' : 'primary'}
                    onClick={() =>
                      selected ? onRemove(service.namespace, service.name) : onAdd(service.namespace, service.name)
                    }
                  >
                    {selected ? 'Remove' : 'Add'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <Modal.ButtonRow>
          <Button variant="secondary" onClick={onDismiss}>
            Close
          </Button>
        </Modal.ButtonRow>
      </div>
    </Modal>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  content: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1.5)};
    min-width: min(760px, 80vw);
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(1)};
    max-height: 60vh;
    overflow: auto;
    padding-right: ${theme.spacing(0.5)};
  `,
  row: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: ${theme.spacing(2)};
    padding: ${theme.spacing(1.25)} ${theme.spacing(1.5)};
    border: 1px solid ${theme.colors.border.medium};
    border-radius: ${theme.shape.radius.default};
  `,
  meta: css`
    display: flex;
    flex-direction: column;
    gap: ${theme.spacing(0.25)};
    min-width: 0;
  `,
  name: css`
    font-weight: ${theme.typography.fontWeightMedium};
  `,
  namespace: css`
    color: ${theme.colors.text.secondary};
    font-size: ${theme.typography.bodySmall.fontSize};
    word-break: break-word;
  `,
});
