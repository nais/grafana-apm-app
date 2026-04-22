import React, { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { LoadingPlaceholder } from '@grafana/ui';
import { ROUTES } from '../../constants';

const ServiceInventory = React.lazy(() => import('../../pages/ServiceInventory'));
const ServiceOverview = React.lazy(() => import('../../pages/ServiceOverview'));
const NamespaceOverview = React.lazy(() => import('../../pages/NamespaceOverview'));
const Dependencies = React.lazy(() => import('../../pages/Dependencies'));
const DependencyDetail = React.lazy(() => import('../../pages/DependencyDetail'));

function App(props: AppRootProps) {
  return (
    <Suspense fallback={<LoadingPlaceholder text="Loading..." />}>
      <Routes>
        <Route path={ROUTES.ServiceOverview} element={<ServiceOverview />} />
        <Route path={`${ROUTES.ServiceOverview}/*`} element={<ServiceOverview />} />
        <Route path={ROUTES.NamespaceOverview} element={<NamespaceOverview />} />
        <Route path={ROUTES.DependencyDetail} element={<DependencyDetail />} />
        <Route path={ROUTES.Dependencies} element={<Dependencies />} />
        <Route path="*" element={<ServiceInventory />} />
      </Routes>
    </Suspense>
  );
}

export default App;
