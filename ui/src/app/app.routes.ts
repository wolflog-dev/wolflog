import { Routes } from '@angular/router';
import { adminGuard, authGuard } from './core/state';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage), title: 'Connexion · Vigil' },
  {
    path: '',
    canActivateChild: [authGuard],
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
      { path: 'map', loadComponent: () => import('./pages/service-map').then((m) => m.ServiceMapPage), title: 'Carte des services · Vigil' },
      { path: 'alerts', loadComponent: () => import('./pages/alerts').then((m) => m.AlertsPage), title: 'Alertes · Vigil' },
      { path: 'uptime', loadComponent: () => import('./pages/uptime').then((m) => m.UptimePage), title: 'Disponibilité · Vigil' },
      { path: 'slos', loadComponent: () => import('./pages/slos').then((m) => m.SlosPage), title: 'Objectifs · Vigil' },
      { path: 'slos/:id', loadComponent: () => import('./pages/slos').then((m) => m.SlosPage), title: 'Objectif · Vigil' },
      { path: 'account', loadComponent: () => import('./pages/account').then((m) => m.AccountPage), title: 'Mon compte · Vigil' },
      { path: 'admin/users', canActivate: [adminGuard], loadComponent: () => import('./pages/admin-users').then((m) => m.AdminUsersPage), title: 'Utilisateurs · Vigil' },
      { path: 'admin/keys', canActivate: [adminGuard], loadComponent: () => import('./pages/admin-keys').then((m) => m.AdminKeysPage), title: 'Clés API · Vigil' },
      { path: 'admin/sources', canActivate: [adminGuard], loadComponent: () => import('./pages/admin-sources').then((m) => m.AdminSourcesPage), title: 'Sources · Vigil' },
      { path: 'system', canActivate: [adminGuard], loadComponent: () => import('./pages/system').then((m) => m.SystemPage), title: 'Système · Vigil' },
    ],
  },
  { path: '**', redirectTo: '' },
];
