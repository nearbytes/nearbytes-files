#!/usr/bin/env node
import { Command } from 'commander';
import { registerSetupCommand } from './commands/setup.js';
import { registerStoreCommand } from './commands/store.js';
import { registerRetrieveCommand } from './commands/retrieve.js';
import { registerListCommand } from './commands/list.js';
import { registerVolumeOpenCommand } from './commands/volume-open.js';
import { registerFileAddCommand } from './commands/file-add.js';
import { registerFileRemoveCommand } from './commands/file-remove.js';
import { registerFileListCommand } from './commands/file-list.js';
import { registerFileGetCommand } from './commands/file-get.js';
const program = new Command();
program
    .name('nbf')
    .description('Nearbytes files CLI — encrypted file storage on a cryptographic event log')
    .version('0.1.0');
// Low-level channel commands
registerSetupCommand(program);
registerStoreCommand(program);
registerRetrieveCommand(program);
registerListCommand(program);
// Volume commands
const volumeCmd = program.command('volume').description('Volume operations');
registerVolumeOpenCommand(volumeCmd);
// File commands
const fileCmd = program.command('file').description('File operations');
registerFileAddCommand(fileCmd);
registerFileRemoveCommand(fileCmd);
registerFileListCommand(fileCmd);
registerFileGetCommand(fileCmd);
program.parse();
//# sourceMappingURL=index.js.map