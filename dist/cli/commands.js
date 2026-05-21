/**
 * Command handlers — pure async functions, framework-free.
 *
 * Each handler receives a Context and whatever arguments it needs, then writes
 * human-readable output to stdout.  The same functions are called from:
 *   - Commander.js (immediate mode): program.action(() => handler(ctx, ...))
 *   - REPL (interpreter mode): tokenised input dispatched here
 *
 * All file I/O goes through ctx.fileService (nearbytes-files FileService).
 * ctx.skeleton is used only for crypto (key derivation) and the log.
 *
 * Errors are thrown as plain Error objects; callers decide whether to exit the
 * process (immediate mode) or print the message and continue (REPL).
 */
import { readFile, writeFile } from 'fs/promises';
import { basename } from 'path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { green, yellow, red, cyan, dim, bold, formatFileTable } from './output.js';
import { openAndWatch, refreshIfOpen } from './context.js';
// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------
/**
 * Derives the public key for a secret without reading or writing any events.
 */
export async function cmdSetup(ctx, secret) {
    const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
    console.log(green('✓ Channel initialised'));
    console.log(`  Public key: ${bytesToHex(keyPair.publicKey)}`);
}
// ---------------------------------------------------------------------------
// volume open / info / use
// ---------------------------------------------------------------------------
/** Open a volume, materialise its state, and print a summary. */
export async function cmdVolumeOpen(ctx, secret, watch = true) {
    const rv = await openAndWatch(ctx, secret, watch);
    const files = await ctx.fileService.listFiles(secret);
    const keyHex = bytesToHex(rv.volume.publicKey);
    console.log(green('✓ Volume opened'));
    console.log(`  Public key: ${keyHex}`);
    console.log(`  Files     : ${files.length}`);
    if (files.length > 0) {
        console.log('');
        console.log(formatFileTable(files));
    }
}
/** Print info for the currently-active volume. */
export async function cmdVolumeInfo(ctx) {
    if (!ctx.activeVolume) {
        throw new Error('No active volume — use `volume open <secret>` or `use <key>` first');
    }
    const keyHex = bytesToHex(ctx.activeVolume.volume.publicKey);
    const state = ctx.activeVolume.get();
    console.log(`${bold('Public key:')} ${keyHex}`);
    console.log(`${bold('Files:')}      ${state.files.size}`);
}
/** Set the active volume by public-key hex prefix or secret. */
export async function cmdUse(ctx, keyPrefixOrSecret) {
    // First try exact or prefix match against already-open volumes.
    let rv = ctx.volumes.get(keyPrefixOrSecret);
    if (!rv) {
        for (const [key, vol] of ctx.volumes) {
            if (key.startsWith(keyPrefixOrSecret)) {
                rv = vol;
                break;
            }
        }
    }
    // Fall back to treating the argument as a secret and opening the volume.
    if (!rv)
        rv = await openAndWatch(ctx, keyPrefixOrSecret);
    ctx.activeVolume = rv;
    console.log(green(`✓ Active volume: ${bytesToHex(rv.volume.publicKey)}`));
}
// ---------------------------------------------------------------------------
// file add
// ---------------------------------------------------------------------------
export async function cmdFileAdd(ctx, filePath, secret, name) {
    const filename = name ?? basename(filePath);
    if (!filename || filename.trim().length === 0)
        throw new Error('File name cannot be empty');
    const data = Buffer.from(await readFile(filePath));
    const meta = await ctx.fileService.addFile(secret, filename, data);
    console.log(green('✓ File added'));
    console.log(`  Name : ${meta.filename}`);
    console.log(`  Size : ${data.length} bytes`);
    console.log(`  Hash : ${meta.blobHash.slice(0, 32)}…`);
    await refreshIfOpen(ctx, secret);
}
// ---------------------------------------------------------------------------
// file list
// ---------------------------------------------------------------------------
export async function cmdFileList(ctx, secret) {
    const files = await ctx.fileService.listFiles(secret);
    if (files.length === 0) {
        console.log(yellow('  (no files)'));
        return;
    }
    console.log(green(`✓ ${files.length} file(s):`));
    console.log('');
    console.log(formatFileTable(files));
}
// ---------------------------------------------------------------------------
// file get
// ---------------------------------------------------------------------------
export async function cmdFileGet(ctx, filename, secret, outputPath) {
    const files = await ctx.fileService.listFiles(secret);
    const meta = files.find((f) => f.filename === filename);
    if (!meta)
        throw new Error(`File "${filename}" not found in volume`);
    const data = await ctx.fileService.getFile(secret, meta.blobHash);
    await writeFile(outputPath, data);
    console.log(green('✓ File retrieved'));
    console.log(`  Name   : ${filename}`);
    console.log(`  Output : ${outputPath}`);
    console.log(`  Size   : ${data.length} bytes`);
}
// ---------------------------------------------------------------------------
// file remove
// ---------------------------------------------------------------------------
export async function cmdFileRemove(ctx, filename, secret) {
    await ctx.fileService.deleteFile(secret, filename);
    console.log(green('✓ File removed'));
    console.log(`  Name: ${filename}`);
    await refreshIfOpen(ctx, secret);
}
// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------
export async function cmdRefresh(ctx) {
    if (!ctx.activeVolume)
        throw new Error('No active volume');
    await ctx.activeVolume.refresh();
    const state = ctx.activeVolume.get();
    console.log(green(`✓ Refreshed — ${state.files.size} file(s)`));
}
// ---------------------------------------------------------------------------
// volumes (list all open volumes)
// ---------------------------------------------------------------------------
export async function cmdVolumes(ctx) {
    if (ctx.volumes.size === 0) {
        console.log(yellow('  (no open volumes)'));
        return;
    }
    const activeKey = ctx.activeVolume ? bytesToHex(ctx.activeVolume.volume.publicKey) : null;
    for (const [key, rv] of ctx.volumes) {
        const marker = key === activeKey ? cyan('▶ ') : '  ';
        const count = rv.get().files.size;
        console.log(`${marker}${key.slice(0, 16)}…  ${dim(`${count} file(s)`)}`);
    }
}
// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
export function cmdHelp() {
    console.log(`
${bold('Nearbytes REPL')}

${cyan('Volume commands')}
  setup <secret>                  Derive and display public key for a secret
  volume open <secret>            Open a volume and display its file list
  volumes                         List all open volumes in this session
  use <key-prefix|secret>         Set active volume
  info                            Show active volume info
  refresh                         Reload active volume state

${cyan('File commands')}
  file add <path> [name] -s <secret>   Add a file to a volume
  file list -s <secret>                List files in a volume
  file get <name> <out> -s <secret>    Retrieve a file by name
  file rm <name> -s <secret>           Remove a file from a volume

${cyan('REPL meta')}
  help                            Show this message
  exit / quit / ^D                Exit the REPL
`);
}
export { red };
//# sourceMappingURL=commands.js.map