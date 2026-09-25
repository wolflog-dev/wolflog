/** Comptes, rôles, clés API et session. */
export type Role = 'viewer' | 'editor' | 'admin';

export interface UserAccount {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: Role;
  source: 'local' | 'sso';
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  kind: 'server' | 'browser';
  prefix: string;
  allowedOrigins: string[];
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Me {
  authEnabled: boolean;
  authenticated: boolean;
  user: string | null;
  displayName: string | null;
  role: Role | null;
  source: 'local' | 'sso' | null;
  mustChangePassword: boolean;
  sso: { name: string } | null;
}
