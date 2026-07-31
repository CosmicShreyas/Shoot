/**
 * `shoot status` — print the current config and whether the hooks are actually
 * registered in `.claude/settings.json`.
 *
 * Notably, this validates that each registered path still EXISTS. A hook entry
 * pointing at a moved or deleted file looks installed but silently does nothing,
 * which is the worst possible failure mode for a verification tool.
 */

import { existsSync } from 'node:fs';

import { getAdapter } from '../adapters/index.js';
import { CONFIG_FILENAME, configExists, loadConfig } from '../core/config.js';
import { codexHooksCorrupt, codexHooksPath } from '../core/codexConfig.js';
import {
  resolveHookPath,
  settingsCorrupt,
  settingsPath,
  type HookEvent,
} from '../core/settings.js';
import { stdoutPalette } from '../mascot/colors.js';
import * as messages from '../mascot/messages.js';

export interface StatusReport {
  configPresent: boolean;
  settingsCorrupt: boolean;
  /** Events with a Shoot registration whose script path exists. */
  healthy: HookEvent[];
  /** Events registered but pointing at a missing file. */
  brokenPaths: { event: HookEvent; path: string }[];
  /** Events with no Shoot registration at all. */
  missing: HookEvent[];
}

/** Gather status without printing, so it can be tested directly. */
export function gatherStatus(cwd: string): StatusReport {
  const config = configExists(cwd) ? loadConfig(cwd) : null;
  const expected: HookEvent[] =
    config === null || config.verifySubagents ? ['Stop', 'SubagentStop'] : ['Stop'];

  // Route through the configured platform's adapter so status is accurate for
  // Codex installs too, not just Claude Code.
  const adapter = getAdapter(config?.platform ?? 'claude-code');
  const found = adapter.registrations(cwd);
  const registrations = expected.map((event) => {
    const hit = found.find((f) => f.event === event);
    return { event, registered: hit !== undefined, paths: hit?.paths ?? [] };
  });

  const healthy: HookEvent[] = [];
  const brokenPaths: { event: HookEvent; path: string }[] = [];
  const missing: HookEvent[] = [];

  for (const reg of registrations) {
    if (!reg.registered) {
      missing.push(reg.event);
      continue;
    }
    const broken = reg.paths.filter((p) => !existsSync(resolveHookPath(p, cwd)));
    if (broken.length > 0) {
      for (const p of broken) brokenPaths.push({ event: reg.event, path: p });
    } else {
      healthy.push(reg.event);
    }
  }

  return {
    configPresent: config !== null,
    settingsCorrupt:
      adapter.id === 'codex' ? codexHooksCorrupt(cwd) : settingsCorrupt(cwd),
    healthy,
    brokenPaths,
    missing,
  };
}

export async function status(_argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const report = gatherStatus(cwd);
  const palette = stdoutPalette();

  process.stdout.write(`\n${messages.statusHeading()}\n\n`);

  // HUMAN CHANNEL throughout: field names accented, values plain, units and paths
  // dimmed as secondary metadata, states coloured by what they mean.
  const label = (text: string, width = 10): string => palette.accent(text.padEnd(width));

  // Config.
  if (!report.configPresent) {
    process.stdout.write(
      `  ${label('config')} ${palette.bad('not found')}${palette.faint(` (${CONFIG_FILENAME})`)}\n`,
    );
    process.stdout.write(`\n${messages.statusNotInstalled()}\n\n`);
    return 1;
  }

  const config = loadConfig(cwd);
  process.stdout.write(`  ${label('config')} ${CONFIG_FILENAME}\n`);
  process.stdout.write(
    `  ${label('mode')} ${config.mode === 'warn' ? palette.warn(config.mode) : config.mode}\n`,
  );
  process.stdout.write(
    `  ${label('timeout')} ${config.timeoutSeconds}s${palette.faint(' per check')}\n`,
  );
  process.stdout.write(
    `  ${label('max blocks')} ${config.maxBlocksPerSession}${palette.faint(' per session')}\n\n`,
  );

  const configured = Object.entries(config.checks).filter(([, v]) => v.trim() !== '');
  if (configured.length === 0) {
    process.stdout.write(`  ${label('checks')} ${palette.faint('none configured')}\n`);
  } else {
    for (const [name, command] of configured) {
      process.stdout.write(`  ${label(name)} ${command}\n`);
    }
  }

  // Hook registration.
  const statusAdapter = getAdapter(config.platform);
  process.stdout.write(`\n  ${label('platform')} ${statusAdapter.displayName}\n`);
  process.stdout.write(
    palette.faint(
      `  ${statusAdapter.id === 'codex' ? codexHooksPath(cwd) : settingsPath(cwd)}\n`,
    ),
  );

  if (report.settingsCorrupt) {
    process.stderr.write(`\n${messages.statusBadSettings()}\n\n`);
    return 1;
  }

  for (const event of report.healthy) {
    process.stdout.write(`  ${label(event, 14)} ${palette.ok('registered')}\n`);
  }
  for (const { event, path } of report.brokenPaths) {
    // The one status that means "installed but verifying nothing" — the worst
    // failure mode for this tool, so it gets the loudest treatment.
    process.stdout.write(
      `  ${label(event, 14)} ${palette.bad('REGISTERED BUT BROKEN')}` +
        `${palette.faint(` -> ${path}`)}\n`,
    );
  }
  for (const event of report.missing) {
    process.stdout.write(`  ${label(event, 14)} ${palette.warn('not registered')}\n`);
  }

  if (report.brokenPaths.length > 0) {
    process.stderr.write(`\n${messages.brokenRegistration()}\n\n`);
    return 1;
  }
  if (report.healthy.length === 0) {
    process.stderr.write(`\n${messages.statusNoHooks()}\n\n`);
    return 1;
  }

  process.stdout.write(`\n${messages.statusHealthy()}\n\n`);
  return 0;
}
