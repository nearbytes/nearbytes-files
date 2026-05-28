import type { Context } from '../cli/context.js';
import { parseBasicAuth } from './auth.js';
import { profileWebDavPassword } from '../cli/volumeSessionStore.js';

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
      ctx.webdavAuthenticatedGeneration = ctx.webdavAuthGeneration;
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
  };
}

export function invalidateWebDavAuth(ctx: Context): void {
  ctx.webdavAuthGeneration += 1;
  ctx.webdavAuthenticatedGeneration = null;
}
