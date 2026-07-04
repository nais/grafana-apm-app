import React, { Suspense, useState, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AppRootProps } from '@grafana/data';
import { initPluginTranslations } from '@grafana/i18n';
import { PLUGIN_BASE_URL, ROUTES } from '../../constants';
import { useFavoritesSync } from '../../utils/useFavoritesSync';
import { ErrorBoundary } from '../ErrorBoundary';

const ServiceInventory = React.lazy(() => import('../../pages/ServiceInventory'));
const JobsInventory = React.lazy(() => import('../../pages/JobsInventory'));
const ServiceOverview = React.lazy(() => import('../../pages/ServiceOverview'));
const NamespaceOverview = React.lazy(() => import('../../pages/NamespaceOverview'));
const StatusBoard = React.lazy(() => import('../../pages/StatusBoard'));
const OpsStatusBoard = React.lazy(() => import('../../pages/OpsStatusBoard'));
const Dependencies = React.lazy(() => import('../../pages/Dependencies'));
const ServiceMap = React.lazy(() => import('../../pages/ServiceMap'));
const DependencyDetail = React.lazy(() => import('../../pages/DependencyDetail'));

function FavoritesRedirect() {
  const { search } = useLocation();
  const navigate = useNavigate();
  React.useEffect(() => {
    const params = new URLSearchParams(search);
    params.set('favorites', 'true');
    navigate(`${PLUGIN_BASE_URL}/${ROUTES.Services}?${params.toString()}`, { replace: true });
  }, [search, navigate]);
  return null;
}

function App(props: AppRootProps) {
  const [initialized, setInitialized] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    let active = true;
    initPluginTranslations('nais-apm-app', [
      (lang: string) => import('@grafana/scenes').then((m) => m.loadResources(lang)),
    ])
      .then(() => {
        if (active) {
          setInitialized(true);
        }
      })
      .catch((err) => {
        console.error('Failed to initialize plugin translations', err);
        if (active) {
          setInitialized(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  // Sync favorites to Grafana's per-user backend storage for cross-device persistence
  useFavoritesSync();

  if (!initialized) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#8c95a5',
          fontFamily: 'sans-serif',
        }}
      >
        Loading Nais APM...
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: '#8c95a5',
            fontFamily: 'sans-serif',
          }}
        >
          Loading Nais APM...
        </div>
      }
    >
      {/* Last-resort boundary: an uncaught render error from any page shows a
          full-section fallback instead of white-screening the plugin, and
          recovers when the route changes. */}
      <ErrorBoundary resetKeys={[pathname]}>
        <Routes>
          <Route
            path={ROUTES.ServiceOverview}
            element={
              <ErrorBoundary label="Service overview">
                <ServiceOverview />
              </ErrorBoundary>
            }
          />
          <Route
            path={`${ROUTES.ServiceOverview}/*`}
            element={
              <ErrorBoundary label="Service overview">
                <ServiceOverview />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.StatusBoard}
            element={
              <ErrorBoundary label="Status board">
                <StatusBoard />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.OpsStatus}
            element={
              <ErrorBoundary label="Ops status board">
                <OpsStatusBoard />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.NamespaceOverview}
            element={
              <ErrorBoundary label="Namespace overview">
                <NamespaceOverview />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.DependencyDetail}
            element={
              <ErrorBoundary label="Dependency detail">
                <DependencyDetail />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.Dependencies}
            element={
              <ErrorBoundary label="Dependencies">
                <Dependencies />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.ServiceMap}
            element={
              <ErrorBoundary label="Service map">
                <ServiceMap />
              </ErrorBoundary>
            }
          />
          <Route path={ROUTES.Favorites} element={<FavoritesRedirect />} />
          <Route
            path={ROUTES.Services}
            element={
              <ErrorBoundary label="Service inventory">
                <ServiceInventory />
              </ErrorBoundary>
            }
          />
          <Route
            path={ROUTES.Jobs}
            element={
              <ErrorBoundary label="Jobs inventory">
                <JobsInventory />
              </ErrorBoundary>
            }
          />
          <Route path="/" element={<Navigate to={ROUTES.Services} replace />} />
          <Route path="*" element={<Navigate to={ROUTES.Services} replace />} />
        </Routes>
      </ErrorBoundary>
    </Suspense>
  );
}

export default App;
