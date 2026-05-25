import { defaultConfigPath, writeConfig, type NearbytesConfig } from 'nearbytes-skeleton';
import { VOLUME_ID_HEX_REGEX } from 'nearbytes-log';
import type { Context } from './context.js';

export function normalizeFriendPublicKey(raw: string): string {
  const pk = raw.trim().toLowerCase();
  if (!VOLUME_ID_HEX_REGEX.test(pk)) {
    throw new Error('Friend public key must be 130 lowercase hex characters (profile channel key)');
  }
  return pk;
}

export function matchFriendKey(friends: readonly string[], prefixOrKey: string): string | null {
  const needle = prefixOrKey.trim().toLowerCase();
  const exact = friends.find((f) => f === needle);
  if (exact) {
    return exact;
  }
  const matches = friends.filter((f) => f.startsWith(needle));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error('Friend public key prefix is ambiguous');
  }
  return null;
}

export async function persistConfig(ctx: Context, next: NearbytesConfig): Promise<void> {
  const path = defaultConfigPath();
  await writeConfig(next, path);
  ctx.config = next;
  await ctx.skeleton.reloadSync(next.friends, {
    profiles: next.profiles,
    activeProfile: next.activeProfile,
  });
}
