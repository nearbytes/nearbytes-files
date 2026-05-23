import { green, dim, bold } from './output.js';
import { matchFriendKey, normalizeFriendPublicKey, persistConfig } from './configStore.js';
export async function cmdFriendList(ctx) {
    if (ctx.config.friends.length === 0) {
        console.log(dim('  (no friends configured)'));
        return;
    }
    for (const pk of ctx.config.friends) {
        console.log(`  ${pk}`);
    }
    console.log(dim(`\n${ctx.config.friends.length} friend(s) — asymmetric follow: you sync their profile topics.`));
}
export async function cmdFriendAdd(ctx, publicKey) {
    const pk = normalizeFriendPublicKey(publicKey);
    if (ctx.config.friends.includes(pk)) {
        console.log(dim(`Already following ${pk}`));
        return;
    }
    const friends = [...ctx.config.friends, pk];
    await persistConfig(ctx, { ...ctx.config, friends });
    console.log(green(`✓ Following ${pk}`));
    console.log(dim('  Sync is active for this session (reloaded).'));
}
export async function cmdFriendRemove(ctx, prefixOrKey) {
    const pk = matchFriendKey(ctx.config.friends, prefixOrKey);
    if (!pk) {
        throw new Error(`No friend matches "${prefixOrKey}"`);
    }
    const friends = ctx.config.friends.filter((f) => f !== pk);
    await persistConfig(ctx, { ...ctx.config, friends });
    console.log(green(`✓ Unfollowed ${pk}`));
}
export async function cmdFriendShow(ctx, prefixOrKey) {
    const pk = matchFriendKey(ctx.config.friends, prefixOrKey) ?? normalizeFriendPublicKey(prefixOrKey);
    console.log(`${bold('Profile key:')} ${pk}`);
    console.log(dim('  Share this hex so others can `friend add` you. They follow your profile topic when you run sync with a profile secret.'));
}
//# sourceMappingURL=friendsCommands.js.map