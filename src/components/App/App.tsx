import React, { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import { ROUTES } from '../../constants';

const ServiceInventory = React.lazy(() => import('../../pages/ServiceInventory'));
const ServiceOverview = React.lazy(() => import('../../pages/ServiceOverview'));
const NamespaceOverview = React.lazy(() => import('../../pages/NamespaceOverview'));
const StatusBoard = React.lazy(() => import('../../pages/StatusBoard'));
const Dependencies = React.lazy(() => import('../../pages/Dependencies'));
const DependencyDetail = React.lazy(() => import('../../pages/DependencyDetail'));

function App(props: AppRootProps) {
  return (
    <Suspense fallback={<LoadingPlaceholder text="Loading..." />}>
      <Routes>
        <Route path={ROUTES.ServiceOverview} element={<ServiceOverview />} />
        <Route path={`${ROUTES.ServiceOverview}/*`} element={<ServiceOverview />} />
        <Route path={ROUTES.StatusBoard} element={<StatusBoard />} />
        <Route path={ROUTES.NamespaceOverview} element={<NamespaceOverview />} />
        <Route path={ROUTES.DependencyDetail} element={<DependencyDetail />} />
        <Route path={ROUTES.Dependencies} element={<Dependencies />} />
        <Route path={ROUTES.Services} element={<ServiceInventory />} />
        <Route path="/" element={<Navigate to={ROUTES.Services} replace />} />
        <Route path="*" element={<Navigate to={ROUTES.Services} replace />} />
      </Routes>
    </Suspense>
  );
}

export default App;
