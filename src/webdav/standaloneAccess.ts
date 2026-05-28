import type { NearbytesConfig } from 'nearbytes-skeleton';
import { parseBasicAuth } from './auth.js';
import type { WebDavAccess } from './access.js';
import { profileWebDavPassword } from '../cli/volumeSessionStore.js';

/** WebDAV access for headless `webdav-serve` (no REPL context). */
export function createStandaloneWebDavAccess(
  config: NearbytesConfig,
  volumeRegistry: ReadonlyMap<string, string>,
): WebDavAccess {
  let authGeneration = 0;
  let authenticatedGeneration: number | null = null;

  return {
    get authGeneration() {
      return authGeneration;
    },
    isAuthenticated() {
      return authenticatedGeneration === authGeneration;
    },
    markAuthenticated() {
      authenticatedGeneration = authGeneration;
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
      const name = config.activeProfile;
      if (name === null) return null;
      const profile = config.profiles.find((p) => p.name === name);
      if (profile === undefined) return null;
      return { name: profile.name, secret: profile.secret };
    },
    listVolumeNames() {
      return [...volumeRegistry.keys()].sort((a, b) => a.localeCompare(b));
    },
    resolveVolumeSecret(name) {
      return volumeRegistry.get(name);
    },
    timelineCursorForSecret() {
      return undefined;
    },
    isReadOnlySecret() {
      return false;
    },
    getViewEpoch() {
      return `standalone:live:g0`;
    },
    bumpView() {
      /* headless server has no REPL timeline */
    },
  };
}
