/**
 * Profile management commands.
 *
 * A *profile* is the cryptographic sync keypair: a secp256k1 secret, a
 * derived public key, and a sync topic. A node may serve $K \ge 0$ profiles
 * in parallel (`requirements/sync-protocol-v1.md` SYNC-00). The user names
 * each profile locally (`alice`, `work`, …); one of them is the **active**
 * profile, used to sign `profile publish` and as the follower identity for
 * outbound dials.
 *
 * Identity records (`nb.identity.record.v1`) are a separate, social-layer
 * concept — they bind a display name to a profile. `profile publish` signs
 * one with the active (or `--as`-selected) profile.
 */

import { EventType, createSecret, bytesToHex } from 'nearbytes-crypto';
import type { AppRecordPayload } from 'nearbytes-crypto';
import { createSignedEvent } from 'nearbytes-log';
import type { ProfileConfig } from 'nearbytes-skeleton';
import {
  IDENTITY_RECORD_PROTOCOL,
  createIdentityRecord,
  serializeIdentityRecord,
  verifyIdentityRecord,
} from 'nearbytes-chat';
import { green, dim, bold, cyan, yellow } from './output.js';
import type { Context } from './context.js';
import { persistConfig } from './configStore.js';
import { invalidateWebDavAuth } from '../webdav/access.js';

function findProfileByName(
  ctx: Context,
  name: string,
): ProfileConfig | null {
  return ctx.config.profiles.find((p) => p.name === name) ?? null;
}

function resolveProfile(ctx: Context, explicitName?: string): ProfileConfig {
  if (explicitName !== undefined) {
    const p = findProfileByName(ctx, explicitName);
    if (!p) {
      throw new Error(
        `No profile named "${explicitName}" — run \`profile list\` to see configured profiles`,
      );
    }
    return p;
  }
  if (ctx.config.activeProfile === null) {
    throw new Error(
      'No active profile — run `profile add <name> <secret>` to create one, or `profile use <name>` to switch',
    );
  }
  const active = findProfileByName(ctx, ctx.config.activeProfile);
  if (!active) {
    throw new Error(
      `Active profile "${ctx.config.activeProfile}" missing from profiles[] — config is inconsistent`,
    );
  }
  return active;
}

export async function cmdProfileAdd(
  ctx: Context,
  name: string,
  secret: string,
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Profile name must be non-empty');
  }
  if (findProfileByName(ctx, trimmed)) {
    throw new Error(`Profile "${trimmed}" already exists — choose another name`);
  }
  const wasOffline = ctx.config.profiles.length === 0;
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  const publicKey = bytesToHex(keyPair.publicKey);
  const nextProfiles: ProfileConfig[] = [...ctx.config.profiles, { name: trimmed, secret }];
  const nextActive = ctx.config.activeProfile ?? trimmed;
  await persistConfig(ctx, {
    ...ctx.config,
    profiles: nextProfiles,
    activeProfile: nextActive,
  });
  console.log(green(`✓ Added profile "${trimmed}"`));
  console.log(`${bold('Profile public key:')} ${publicKey}`);
  if (wasOffline) {
    console.log(
      green('✓ Sync activated — discovery + friend carriage are now live for this profile.'),
    );
  }
  if (nextActive === trimmed) {
    console.log(dim(`  "${trimmed}" is the active profile (signs publish/friend ops).`));
  } else {
    console.log(
      dim(
        `  Active profile is still "${nextActive}" — run \`profile use ${trimmed}\` to switch.`,
      ),
    );
  }
  console.log(
    dim(
      '  Share the public key for `friend add`. Run `profile publish -n <name>` to write a display name to the log.',
    ),
  );
}

export async function cmdProfileUse(ctx: Context, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!findProfileByName(ctx, trimmed)) {
    throw new Error(
      `No profile named "${trimmed}" — run \`profile list\` to see configured profiles`,
    );
  }
  if (ctx.config.activeProfile === trimmed) {
    console.log(dim(`Profile "${trimmed}" is already active.`));
    return;
  }
  await persistConfig(ctx, { ...ctx.config, activeProfile: trimmed });
  invalidateWebDavAuth(ctx);
  console.log(green(`✓ Active profile is now "${trimmed}"`));
  console.log(dim('  WebDAV clients must authenticate again (global Basic auth).'));
  console.log(
    dim(
      '  Sync continues to serve every profile in `profiles[]`; only writes and outbound dials use the active one.',
    ),
  );
}

export async function cmdProfileList(ctx: Context): Promise<void> {
  if (ctx.config.profiles.length === 0) {
    console.log(dim('  (no profiles configured)'));
    console.log(dim('  Run `profile add <name> <secret>` to create one.'));
    return;
  }
  console.log(bold('Profiles:'));
  for (const p of ctx.config.profiles) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(p.secret));
    const pk = bytesToHex(keyPair.publicKey);
    const marker = p.name === ctx.config.activeProfile ? cyan('▶ ') : '  ';
    console.log(`${marker}${bold(p.name.padEnd(16))} ${dim(pk)}`);
  }
  console.log(
    dim(
      `\n${ctx.config.profiles.length} profile(s); active: ${ctx.config.activeProfile ?? '(none)'}`,
    ),
  );
}

export async function cmdProfileShow(ctx: Context, name?: string): Promise<void> {
  const profile = resolveProfile(ctx, name);
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(profile.secret));
  const publicKey = bytesToHex(keyPair.publicKey);
  const marker =
    profile.name === ctx.config.activeProfile ? cyan(' (active)') : '';
  console.log(`${bold('Profile:')} ${profile.name}${marker}`);
  console.log(`${bold('Public key:')} ${publicKey}`);
  console.log(
    dim(
      '  Sync joins this profile topic so followers can pull your cache. Active profile signs writes.',
    ),
  );
}

export async function cmdProfilePublish(
  ctx: Context,
  displayName: string,
  bio?: string,
  asName?: string,
): Promise<void> {
  const profile = resolveProfile(ctx, asName);
  const trimmed = displayName.trim();
  if (trimmed.length === 0) {
    throw new Error('displayName must be non-empty');
  }
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(profile.secret));
  const publicKey = bytesToHex(keyPair.publicKey);
  const record = await createIdentityRecord(
    ctx.skeleton.crypto,
    keyPair,
    { displayName: trimmed, ...(bio ? { bio } : {}) },
    Date.now(),
  );
  if (!(await verifyIdentityRecord(ctx.skeleton.crypto, record))) {
    throw new Error('Identity record signature check failed');
  }
  const recordJson = serializeIdentityRecord(record);
  const payload: AppRecordPayload = {
    type: EventType.APP_RECORD,
    protocol: IDENTITY_RECORD_PROTOCOL,
    authorPublicKey: publicKey,
    record: recordJson,
    publishedAt: Date.now(),
  };
  const signedEvent = await createSignedEvent(ctx.skeleton.crypto, keyPair, payload, []);
  const eventHash = await ctx.skeleton.log.events.storeEvent(keyPair.publicKey, signedEvent);
  console.log(green(`✓ Published identity record for profile "${profile.name}" as “${trimmed}”`));
  console.log(`  Channel:    ${cyan(publicKey)}`);
  console.log(`  Event hash: ${eventHash}`);
  console.log(
    dim(
      '  Publication is local+log; followers learn your key out-of-band, not from this record alone.',
    ),
  );
}

export async function cmdProfileRemove(ctx: Context, name: string): Promise<void> {
  const trimmed = name.trim();
  const profile = findProfileByName(ctx, trimmed);
  if (!profile) {
    throw new Error(
      `No profile named "${trimmed}" — run \`profile list\` to see configured profiles`,
    );
  }
  const nextProfiles = ctx.config.profiles.filter((p) => p.name !== trimmed);
  const nextActive =
    ctx.config.activeProfile === trimmed
      ? nextProfiles[0]?.name ?? null
      : ctx.config.activeProfile;
  await persistConfig(ctx, {
    ...ctx.config,
    profiles: nextProfiles,
    activeProfile: nextActive,
  });
  console.log(green(`✓ Removed profile "${trimmed}"`));
  if (nextProfiles.length === 0) {
    console.log(
      yellow(
        '  ! No profiles remain — sync is now offline. Run `profile add <name> <secret>` to bring it back.',
      ),
    );
  } else if (ctx.config.activeProfile === trimmed) {
    console.log(dim(`  Active profile is now "${nextActive}".`));
  }
}
