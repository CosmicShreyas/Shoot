/**
 * `shoot uninstall` — remove Shoot's hook entries from `.claude/settings.json`,
 * delete the generated shim, and delete `.shoot.config.json`, after confirmation.
 *
 * Must leave any other hooks in the settings file untouched. The settings file is
 * the user's, and may contain hooks Shoot knows nothing about.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { getAdapter } from '../adapters/index.js';
import { CONFIG_FILENAME, configExists, configPath, loadConfig } from '../core/config.js';
import {
  countForeignCodexHooks,
  codexHooksPath,
  readCodexHooks,
  removeCodexHooks,
  writeCodexHooks,
} from '../core/codexConfig.js';
import {
  countForeignHooks,
  readSettings,
  removeShootHooks,
  settingsPath,
  writeSettings,
} from '../core/settings.js';
import { closePrompts, confirm } from '../core/prompt.js';
import { CODEX_SHIM_RELATIVE_PATH, SHIM_RELATIVE_PATH } from '../core/shim.js';
import { STATE_DIR_NAME } from '../core/circuitBreaker.js';
import { stdoutPalette } from '../mascot/colors.js';
import * as messages from '../mascot/messages.js';

export async function uninstall(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const force = argv.includes('--yes') || argv.includes('-y');

  const config = configExists(cwd) ? loadConfig(cwd) : null;
  const adapter = getAdapter(config?.platform ?? 'claude-code');

  const settings = readSettings(cwd);
  const codexHooks = readCodexHooks(cwd);
  const preserved = countForeignHooks(settings) + countForeignCodexHooks(codexHooks);

  const targets: string[] = [];
  if (existsSync(configPath(cwd))) targets.push(CONFIG_FILENAME);
  // Clean up both shims regardless of configured platform — a user who switched
  // platforms shouldn't be left with an orphan.
  for (const shim of [SHIM_RELATIVE_PATH, CODEX_SHIM_RELATIVE_PATH]) {
    if (existsSync(join(cwd, shim))) targets.push(shim);
  }
  if (existsSync(join(cwd, STATE_DIR_NAME))) targets.push(`${STATE_DIR_NAME}/`);

  const hasRegistration =
    JSON.stringify(removeShootHooks(settings)) !== JSON.stringify(settings) ||
    JSON.stringify(removeCodexHooks(codexHooks)) !== JSON.stringify(codexHooks);

  if (targets.length === 0 && !hasRegistration) {
    process.stdout.write(`\n${messages.uninstallNothing()}\n\n`);
    return 0;
  }

  // HUMAN CHANNEL: what's going away is red, what's being kept is green — the
  // distinction that actually matters when someone is about to delete things.
  const palette = stdoutPalette();

  process.stdout.write(`\n${messages.uninstallPlan()}\n\n`);
  for (const t of targets) process.stdout.write(palette.bad(`    - ${t}`) + '\n');
  if (hasRegistration) {
    process.stdout.write(
      palette.bad(`    - Shoot's hook entries in `) + palette.faint(settingsPath(cwd)) + '\n',
    );
  }
  if (preserved > 0) {
    process.stdout.write(`\n  ${palette.ok(messages.uninstallPreserving(preserved))}\n`);
  }
  process.stdout.write('\n');

  if (!force) {
    const ok = await confirm('Go ahead?', false);
    closePrompts();
    if (!ok) {
      process.stdout.write(`\n${messages.uninstallCancelled()}\n\n`);
      return 0;
    }
  }

  // Host config: surgical removal only, on both platforms.
  if (JSON.stringify(removeShootHooks(settings)) !== JSON.stringify(settings)) {
    writeSettings(cwd, removeShootHooks(settings));
  }
  if (JSON.stringify(removeCodexHooks(codexHooks)) !== JSON.stringify(codexHooks)) {
    writeCodexHooks(cwd, removeCodexHooks(codexHooks));
  }

  // Generated files.
  for (const relative of [CONFIG_FILENAME, SHIM_RELATIVE_PATH, CODEX_SHIM_RELATIVE_PATH]) {
    try {
      rmSync(join(cwd, relative), { force: true });
    } catch {
      // Best effort.
    }
  }
  try {
    rmSync(join(cwd, STATE_DIR_NAME), { recursive: true, force: true });
  } catch {
    // Best effort.
  }

  process.stdout.write(`\n${messages.uninstalled()}\n\n`);
  return 0;
}
