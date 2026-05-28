import type { Context } from './context.js';
import { green, yellow, dim, bold, cyan } from './output.js';
import { bumpWebDavView, invalidateWebDavAuth } from '../webdav/access.js';
import { profileWebDavPassword } from './volumeSessionStore.js';

function formatWhen(ms: number | null): string {
  if (ms === null) return dim('never');
  return new Date(ms).toLocaleString();
}

export function cmdWebDavStatus(ctx: Context): void {
  if (ctx.webdav === null) {
    console.log(yellow('  WebDAV is not running (start nbf repl with the default shell)'));
    return;
  }

  const profileName = ctx.config.activeProfile;
  const profile =
    profileName !== null ? ctx.config.profiles.find((p) => p.name === profileName) : undefined;
  const authenticated =
    ctx.webdavAuthenticatedGeneration === ctx.webdavAuthGeneration &&
    ctx.webdavLastAuthProfile !== null;

  console.log(bold('WebDAV'));
  console.log(`  URL:      ${ctx.webdav.baseUrl}/`);
  console.log('');

  if (profile === undefined) {
    console.log(yellow('  Profile:  none active — Finder will get 503 until you run profile use'));
    console.log(dim('            Example: profile add alice alice:syncpass && profile use alice'));
  } else {
    console.log(`${bold('  Profile:')}  ${cyan(profile.name)} ${dim('(active)')}`);
    console.log(
      dim(
        `            Finder login → username "${profile.name}"  password "${profileWebDavPassword(profile.secret)}"`,
      ),
    );
  }
  console.log('');

  if (authenticated) {
    console.log(
      green(`  Client:   authenticated as "${ctx.webdavLastAuthProfile}"`) +
        dim(` (since ${formatWhen(ctx.webdavLastAuthAt)})`),
    );
    console.log(dim('            Volumes under the mount root should list in Finder.'));
  } else if (profile !== undefined) {
    console.log(yellow('  Client:   not authenticated yet'));
    console.log(
      dim(
        '            Connect in Finder (Go → Connect to Server…); watch this terminal for "Client authenticated" or run with --debug webdav',
      ),
    );
  } else {
    console.log(dim('  Client:   (waiting for profile)'));
  }
  console.log('');

  const volumes = [...ctx.volumeRegistry.keys()].sort();
  if (volumes.length === 0) {
    console.log(yellow('  Volumes:  none registered — run volume add <name:password>'));
  } else {
    console.log(`${bold('  Volumes:')}  ${volumes.join(', ')} ${dim('(at mount root)')}`);
  }

  if (ctx.timelineCursorHash !== null) {
    console.log('');
    console.log(
      yellow('  Timeline: historical cursor — WebDAV is read-only until `timeline live`'),
    );
  }
}

export function cmdWebDavRefresh(ctx: Context): void {
  bumpWebDavView(ctx);
  console.log(green('✓ WebDAV view epoch bumped — clients should refetch on next access'));
  console.log(
    dim(
      '  macOS Finder: click the folder and press ⌘R (or close and reopen the window)\n' +
        '  Windows: F5 in Explorer  ·  Linux (gvfs/Nautilus): F5 or remount',
    ),
  );
}

export function cmdWebDavLogout(ctx: Context): void {
  if (ctx.webdavAuthenticatedGeneration === null) {
    console.log(dim('  WebDAV: no active client session to clear'));
    return;
  }
  invalidateWebDavAuth(ctx);
  console.log(green('✓ WebDAV client session cleared — Finder must log in again'));
}
