import type { Context } from '../cli/context.js';
import { parseBasicAuth } from './auth.js';
import { profileWebDavPassword } from '../cli/volumeSessionStore.js';
import { debugEnabled } from '../debug.js';

export interface WebDavAccess {
  readonly authGeneration: number;
  isAuthenticated(): boolean;
  checkAuth(header: string | undefined): boolean;
  markAuthenticated(): void;
  getActiveProfile(): { readonly name: string; readonly secret: string } | null;
  listVolumeNames(): string[];
  resolveVolumeSecret(name: string): string | undefined;
  timelineCursorForSecret(secret: string): string | undefined;
  isReadOnlySecret(secret: string): boolean;
  /** Changes whenever timeline cursor or view generation bumps (invalidates client caches). */
  getViewEpoch(): string;
  bumpView(): void;
}

export function bumpWebDavView(ctx: Context): void {
  ctx.webdavViewGeneration += 1;
}

export function createWebDavAccess(ctx: Context): WebDavAccess {
  return {
    get authGeneration() {
      return ctx.webdavAuthGeneration;
    },
    isAuthenticated() {
      return ctx.webdavAuthenticatedGeneration === ctx.webdavAuthGeneration;
    },
    markAuthenticated() {
      const profile = this.getActiveProfile();
      const wasAuthenticated = this.isAuthenticated();
      ctx.webdavAuthenticatedGeneration = ctx.webdavAuthGeneration;
      if (!wasAuthenticated && profile !== null) {
        ctx.webdavLastAuthAt = Date.now();
        ctx.webdavLastAuthProfile = profile.name;
        console.error(
          `[nearbytes-webdav] Client authenticated (profile "${profile.name}") — mount should work until profile use or webdav logout`,
        );
      }
    },
    checkAuth(header) {
      const basic = parseBasicAuth(header);
      if (basic === null) return false;
      const profile = this.getActiveProfile();
      if (profile === null) return false;
      if (basic.username !== profile.name) return false;
      if (basic.password !== profileWebDavPassword(profile.secret)) return false;
      return true;
    },
    getActiveProfile() {
      const name = ctx.config.activeProfile;
      if (name === null) return null;
      const profile = ctx.config.profiles.find((p) => p.name === name);
      if (profile === undefined) return null;
      return { name: profile.name, secret: profile.secret };
    },
    listVolumeNames() {
      return [...ctx.volumeRegistry.keys()].sort((a, b) => a.localeCompare(b));
    },
    resolveVolumeSecret(name) {
      return ctx.volumeRegistry.get(name);
    },
    timelineCursorForSecret(secret) {
      const activeName = ctx.volumeSessionActive;
      if (activeName === null) return undefined;
      const activeSecret = ctx.volumeRegistry.get(activeName);
      if (activeSecret !== secret) return undefined;
      return ctx.timelineCursorHash ?? undefined;
    },
    isReadOnlySecret(secret) {
      return this.timelineCursorForSecret(secret) !== undefined;
    },
    getViewEpoch() {
      const vol = ctx.volumeSessionActive ?? '_';
      const cursor = ctx.timelineCursorHash ?? 'live';
      return `${vol}@${cursor}:g${ctx.webdavViewGeneration}`;
    },
    bumpView() {
      bumpWebDavView(ctx);
    },
  };
}

export function invalidateWebDavAuth(ctx: Context): void {
  ctx.webdavAuthGeneration += 1;
  ctx.webdavAuthenticatedGeneration = null;
  ctx.webdavLastAuthProfile = null;
  ctx.webdavLastAuthAt = null;
}

/** Human-readable reason for a failed Authorization header (for logs / status). */
export function describeWebDavAuthFailure(
  access: WebDavAccess,
  authHeader: string | undefined,
): string {
  if (access.getActiveProfile() === null) {
    return 'no active sync profile in nbf (run profile add / profile use)';
  }
  const basic = parseBasicAuth(authHeader);
  if (basic === null) {
    return 'missing or invalid Basic Authorization header';
  }
  const profile = access.getActiveProfile()!;
  if (basic.username !== profile.name) {
    return `username "${basic.username}" does not match active profile "${profile.name}"`;
  }
  if (basic.password !== profileWebDavPassword(profile.secret)) {
    return 'password does not match active profile secret (use the part after ":" in the profile secret)';
  }
  return 'unknown';
}

export function logWebDavAuthFailure(access: WebDavAccess, authHeader: string | undefined): void {
  if (!debugEnabled('webdav')) return;
  console.error(`[nearbytes-webdav] auth failed: ${describeWebDavAuthFailure(access, authHeader)}`);
}
