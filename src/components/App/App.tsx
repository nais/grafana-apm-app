import React from 'react';
import { Route, Routes } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { ROUTES } from '../../constants';

const ServiceInventory = React.lazy(() => import('../../pages/ServiceInventory'));
const ServiceOverview = React.lazy(() => import('../../pages/ServiceOverview'));
const ServiceMap = React.lazy(() => import('../../pages/ServiceMap'));

function App(props: AppRootProps) {
  return (
    <Routes>
      <Route path={ROUTES.ServiceOverview} element={<ServiceOverview />} />
      <Route path={`${ROUTES.ServiceOverview}/*`} element={<ServiceOverview />} />
      <Route path={ROUTES.ServiceMap} element={<ServiceMap />} />

      {/* Default page */}
      <Route path="*" element={<ServiceInventory />} />
    </Routes>
  );
}

export default App;
