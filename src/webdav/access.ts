import { readFileSync } from 'node:fs';
import type { Context } from '../cli/context.js';
import { parseBasicAuth } from './auth.js';
import { profileWebDavPassword } from '../cli/volumeSessionStore.js';
import { webDavViewPath, type WebDavViewState } from '../cli/webdavViewState.js';
import { debugEnabled } from '../debug.js';
import { debugLog } from '../debugLog.js';

function cursorEpochToken(cursorHash: string | null): string {
  if (cursorHash === null) return 'live';
  return cursorHash.length <= 16 ? cursorHash : cursorHash.slice(0, 16);
}

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

/** Prefer on-disk view state (written by REPL) so tools can attach without IPC. */
export function resolveTimelineCursor(ctx: Context, volumeName: string): string | undefined {
  try {
    const raw = readFileSync(webDavViewPath(ctx.config.dataDir), 'utf8');
    const file = JSON.parse(raw) as WebDavViewState;
    if (file.volume === volumeName) {
      return file.cursorHash ?? undefined;
    }
  } catch {
    // no file yet
  }
  if (ctx.volumeSessionActive === volumeName) {
    return ctx.timelineCursorHash ?? undefined;
  }
  return undefined;
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
        if (debugEnabled('webdav')) {
          debugLog('webdav', 'auth', `client authenticated as profile "${profile.name}"`);
        }
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
      return resolveTimelineCursor(ctx, activeName);
    },
    isReadOnlySecret(secret) {
      return this.timelineCursorForSecret(secret) !== undefined;
    },
    getViewEpoch() {
      const vol = ctx.volumeSessionActive ?? '_';
      const hash =
        vol === '_' ? (ctx.timelineCursorHash ?? null) : resolveTimelineCursor(ctx, vol) ?? null;
      const cursor = cursorEpochToken(hash);
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
  debugLog('webdav', 'auth', `failed: ${describeWebDavAuthFailure(access, authHeader)}`);
}
