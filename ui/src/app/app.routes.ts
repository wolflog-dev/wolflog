import { Routes } from '@angular/router';
import { authGuard } from './core/state';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage), title: 'Connexion · Vigil' },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage), title: "Vue d'ensemble · Vigil" },
      { path: 'dashboards', loadComponent: () => import('./pages/dashboards').then((m) => m.DashboardsPage), title: 'Tableaux de bord · Vigil' },
      { path: 'dashboards/:id', loadComponent: () => import('./pages/dashboard').then((m) => m.DashboardPage), title: 'Tableau de bord · Vigil' },
      { path: 'requests', loadComponent: () => import('./pages/requests').then((m) => m.RequestsPage), title: 'Requêtes HTTP · Vigil' },
      { path: 'logs', loadComponent: () => import('./pages/logs').then((m) => m.LogsPage), title: 'Logs · Vigil' },
      { path: 'traces', loadComponent: () => import('./pages/traces').then((m) => m.TracesPage), title: 'Traces · Vigil' },
      { path: 'traces/:id', loadComponent: () => import('./pages/trace-detail').then((m) => m.TraceDetailPage), title: 'Trace · Vigil' },
      { path: 'errors', loadComponent: () => import('./pages/errors').then((m) => m.ErrorsPage), title: 'Erreurs · Vigil' },
      { path: 'errors/:fingerprint', loadComponent: () => import('./pages/error-detail').then((m) => m.ErrorDetailPage), title: 'Erreur · Vigil' },
      { path: 'metrics', loadComponent: () => import('./pages/metrics').then((m) => m.MetricsPage), title: 'Métriques · Vigil' },
      { path: 'system', loadComponent: () => import('./pages/system').then((m) => m.SystemPage), title: 'Système · Vigil' },
    ],
  },
  { path: '**', redirectTo: '' },
];
