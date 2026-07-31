/**
 * `shoot trust` — review and approve the configured check commands.
 *
 * Shows a plain diff of what changed, then asks for explicit confirmation before
 * recording the new commands as approved.
 *
 * HUMAN CHANNEL. The diff follows the familiar git shape — red `-` for what was
 * approved, green `+` for what the config now says — because this is the moment a
 * user decides whether to execute something, and the commands themselves need to be
 * the most legible thing on screen.
 */

import { configExists, hasAnyCheck, loadConfig } from '../core/config.js';
import { checkTrust, formatChanges, readTrust, writeTrust } from '../core/trust.js';
import { closePrompts, confirm } from '../core/prompt.js';
import { stdoutPalette } from '../mascot/colors.js';
import * as messages from '../mascot/messages.js';

export async function trust(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const force = argv.includes('--yes') || argv.includes('-y');
  const palette = stdoutPalette();

  if (!configExists(cwd)) {
    process.stderr.write(`${messages.noConfigHere()}\n`);
    return 1;
  }

  const config = loadConfig(cwd);

  if (!hasAnyCheck(config)) {
    process.stdout.write(`\n${messages.trustNothingToApprove()}\n\n`);
    return 0;
  }

  const status = checkTrust(cwd, config);

  if (status.status === 'trusted') {
    const record = readTrust(cwd);
    process.stdout.write(`\n${messages.trustAlreadyTrusted()}\n\n`);
    for (const [name, command] of Object.entries(config.checks)) {
      if (command.trim() !== '') process.stdout.write(`    ${name.padEnd(10)} ${command}\n`);
    }
    if (record?.approvedAt !== undefined && record.approvedAt !== '') {
      process.stdout.write(`\n    approved   ${record.approvedAt}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  // Show what the user is being asked to approve.
  process.stdout.write(`\n${messages.trustReviewHeading()}\n\n`);

  if (status.status === 'changed') {
    process.stdout.write(`${formatChanges(status.changes, palette)}\n`);
  } else {
    // No prior record — show the full set rather than a diff against nothing.
    for (const [name, command] of Object.entries(config.checks)) {
      if (command.trim() !== '') {
        process.stdout.write(palette.ok(`  + ${name.padEnd(10)} ${command}`) + '\n');
      }
    }
  }

  process.stdout.write(`\n${messages.trustWarning()}\n\n`);

  if (!force) {
    const ok = await confirm('Approve these commands?', false);
    closePrompts();
    if (!ok) {
      process.stdout.write(`\n${messages.trustDeclined()}\n\n`);
      return 1;
    }
  }

  writeTrust(cwd, config.checks);
  process.stdout.write(`\n${messages.trustApproved()}\n\n`);
  return 0;
}
