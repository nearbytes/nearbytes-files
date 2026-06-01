import { createSecret, bytesToHex } from 'nearbytes-crypto';
import type { Context } from './context.js';
import { openAndWatch } from './context.js';
import { green, dim, yellow, cyan } from './output.js';
import {
  loadVolumeSession,
  saveVolumeSession,
  secretVolumePrefix,
  type VolumeSessionFile,
} from './volumeSessionStore.js';
import { bumpWebDavView } from '../webdav/access.js';
import { saveWebDavView } from './webdavViewState.js';

function sessionFileFromContext(ctx: Context): VolumeSessionFile {
  return {
    volumes: [...ctx.volumeRegistry.entries()].map(([name, secret]) => ({ name, secret })),
    active: ctx.volumeSessionActive,
  };
}

async function persistVolumeRegistry(ctx: Context): Promise<void> {
  await saveVolumeSession(ctx.config.dataDir, sessionFileFromContext(ctx));
}

export async function resetTimelineCursor(ctx: Context): Promise<void> {
  ctx.timelineCursorHash = null;
  if (ctx.volumeSessionActive !== null) {
    await saveWebDavView(ctx.config.dataDir, {
      volume: ctx.volumeSessionActive,
      cursorHash: null,
    });
  }
  bumpWebDavView(ctx);
}

export async function loadVolumeRegistryFromDisk(ctx: Context): Promise<void> {
  const file = await loadVolumeSession(ctx.config.dataDir);
  ctx.volumeRegistry.clear();
  for (const entry of file.volumes) {
    ctx.volumeRegistry.set(entry.name, entry.secret);
  }
  ctx.volumeSessionActive = file.active;
}

export async function cmdVolumeAdd(ctx: Context, name: string, secret: string): Promise<void> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) throw new Error('Volume name must be non-empty');
  const prefix = secretVolumePrefix(secret);
  const existing = ctx.volumeRegistry.get(trimmedName);
  if (existing !== undefined && existing !== secret) {
    throw new Error(`Volume name "${trimmedName}" is already registered with a different secret`);
  }
  ctx.volumeRegistry.set(trimmedName, secret);
  await openAndWatch(ctx, secret);
  if (ctx.volumeSessionActive === null) {
    ctx.volumeSessionActive = trimmedName;
    const kp = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    ctx.activeVolume = ctx.volumes.get(bytesToHex(kp.publicKey)) ?? null;
  }
  await persistVolumeRegistry(ctx);
  console.log(green(`✓ Registered volume "${trimmedName}"`));
  if (trimmedName !== prefix) {
    console.log(dim(`  Secret prefix is "${prefix}" (WebDAV path uses registered name).`));
  }
}

export async function cmdVolumeUse(ctx: Context, name: string): Promise<void> {
  const trimmed = name.trim();
  const secret = ctx.volumeRegistry.get(trimmed);
  if (secret === undefined) {
    throw new Error(
      `Volume "${trimmed}" is not registered — run \`volume add ${trimmed} ${trimmed}:<password>\` first`,
    );
  }
  const rv = await openAndWatch(ctx, secret);
  const switching = ctx.volumeSessionActive !== trimmed;
  ctx.volumeSessionActive = trimmed;
  ctx.activeVolume = rv;
  if (switching) {
    await resetTimelineCursor(ctx);
    ctx.remoteCwd = '';
  }
  await persistVolumeRegistry(ctx);
  console.log(green(`✓ Active volume: ${trimmed}`));
}

export async function cmdVolumeForget(ctx: Context, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!ctx.volumeRegistry.has(trimmed)) {
    throw new Error(`Volume "${trimmed}" is not registered`);
  }
  const secret = ctx.volumeRegistry.get(trimmed)!;
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const keyHex = bytesToHex(keyPair.publicKey);
  const watcher = ctx.watchers.get(keyHex);
  if (watcher) {
    watcher.close();
    ctx.watchers.delete(keyHex);
  }
  ctx.volumes.delete(keyHex);
  ctx.volumeRegistry.delete(trimmed);
  if (ctx.volumeSessionActive === trimmed) {
    ctx.volumeSessionActive = null;
    ctx.activeVolume = null;
    await resetTimelineCursor(ctx);
    ctx.remoteCwd = '';
  }
  await persistVolumeRegistry(ctx);
  console.log(green(`✓ Forgot volume "${trimmed}"`));
}

export async function cmdVolumeList(ctx: Context): Promise<void> {
  if (ctx.volumeRegistry.size === 0) {
    console.log(yellow('  (no registered volumes)'));
    return;
  }
  for (const [name, secret] of [...ctx.volumeRegistry.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const marker = name === ctx.volumeSessionActive ? cyan('▶ ') : '  ';
    const keyHex = bytesToHex(
      (await ctx.skeleton.crypto.deriveKeys(createSecret(secret))).publicKey,
    );
    const rv = ctx.volumes.get(keyHex);
    const count =
      rv !== undefined ? dim(`${rv.get().files.size} file(s)`) : dim('(registered, not open)');
    console.log(`${marker}${name}  ${count}`);
  }
}

export async function restoreVolumeSession(ctx: Context): Promise<void> {
  await loadVolumeRegistryFromDisk(ctx);
  if (ctx.volumeSessionActive !== null) {
    const secret = ctx.volumeRegistry.get(ctx.volumeSessionActive);
    if (secret !== undefined) {
      await cmdVolumeUse(ctx, ctx.volumeSessionActive);
    } else {
      ctx.volumeSessionActive = null;
    }
  }
}
