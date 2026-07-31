/**
 * `shoot init` — interactive setup: pick a platform, choose check commands, write
 * `.shoot.config.json`, and register the hook with the selected host.
 *
 * Registers both stop and subagent-stop events by default (`verifySubagents:
 * true`), since subagents claim completion just as readily as the main agent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTERS, detectPlatforms, getAdapter } from '../adapters/index.js';
import type { PlatformAdapter, PlatformId } from '../adapters/types.js';
import { DEFAULT_CONFIG, saveConfig, type Mode, type ShootConfig } from '../core/config.js';
import { codexHooksCorrupt, codexHooksPath } from '../core/codexConfig.js';
import { settingsCorrupt, settingsPath } from '../core/settings.js';
import { resolveHookEntry } from '../core/shim.js';
import { writeTrust } from '../core/trust.js';
import { ask, closePrompts, confirm } from '../core/prompt.js';
import * as messages from '../mascot/messages.js';

// Re-exported for tests and for other commands that need shim details.
export {
  SHIM_RELATIVE_PATH,
  SHIM_REGISTERED_PATH,
  CODEX_SHIM_RELATIVE_PATH,
  resolveHookEntry,
  writeHookShim,
} from '../core/shim.js';

/** Suggest check commands by peeking at the project's package.json scripts. */
export function suggestChecks(cwd: string): Partial<Record<keyof ShootConfig['checks'], string>> {
  try {
    const pkgPath = join(cwd, 'package.json');
    if (!existsSync(pkgPath)) return {};

    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const scripts =
      typeof pkg === 'object' && pkg !== null
        ? ((pkg as Record<string, unknown>)['scripts'] as Record<string, unknown> | undefined)
        : undefined;
    if (typeof scripts !== 'object' || scripts === null) return {};

    const has = (name: string): boolean => typeof scripts[name] === 'string';
    return {
      ...(has('test') ? { test: 'npm test' } : {}),
      ...(has('lint') ? { lint: 'npm run lint' } : {}),
      ...(has('typecheck') ? { typecheck: 'npm run typecheck' } : {}),
      ...(has('build') ? { build: 'npm run build' } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Choose a platform. Autodetects by config directory; asks only when detection is
 * ambiguous or finds nothing.
 */
export async function choosePlatform(cwd: string): Promise<PlatformAdapter> {
  const detected = detectPlatforms(cwd);

  if (detected.length === 1) {
    const only = detected[0] as PlatformAdapter;
    process.stdout.write(
      `${messages.initDetectedPlatform(only.displayName, only.detectDirectory)}\n\n`,
    );
    return only;
  }

  if (detected.length === 0) {
    process.stdout.write(`${messages.initNoPlatformDetected()}\n\n`);
  } else {
    process.stdout.write(`${messages.initMultiplePlatforms()}\n\n`);
  }

  for (const [i, a] of ADAPTERS.entries()) {
    process.stdout.write(`    ${i + 1}. ${a.displayName}\n`);
  }
  process.stdout.write('\n');

  const answer = await ask('Which platform? (number)', '1');
  const index = Number.parseInt(answer, 10) - 1;
  return ADAPTERS[index] ?? (ADAPTERS[0] as PlatformAdapter);
}

/** True when the selected platform's config file exists but is unparseable. */
function hostConfigCorrupt(cwd: string, platform: PlatformId): { bad: boolean; path: string } {
  return platform === 'codex'
    ? { bad: codexHooksCorrupt(cwd), path: codexHooksPath(cwd) }
    : { bad: settingsCorrupt(cwd), path: settingsPath(cwd) };
}

export async function init(_argv: string[]): Promise<number> {
  const cwd = process.cwd();

  process.stdout.write(`\n${messages.initIntro()}\n\n`);

  const adapter = await choosePlatform(cwd);

  const corrupt = hostConfigCorrupt(cwd, adapter.id);
  if (corrupt.bad) {
    process.stderr.write(`${messages.initBadSettings(corrupt.path)}\n`);
    closePrompts();
    return 1;
  }

  // Surface platform caveats BEFORE the user commits to anything.
  const warnings = adapter.warnings();
  if (warnings.length > 0) {
    process.stdout.write(`${messages.initPlatformWarnings(adapter.displayName)}\n`);
    for (const w of warnings) process.stdout.write(`    - ${w}\n`);
    process.stdout.write('\n');

    const proceed = await confirm('Continue with this platform?', true);
    if (!proceed) {
      closePrompts();
      process.stdout.write(`\n${messages.initCancelled()}\n\n`);
      return 0;
    }
    process.stdout.write('\n');
  }

  const suggested = suggestChecks(cwd);
  if (Object.keys(suggested).length > 0) {
    process.stdout.write(`${messages.initSuggestions()}\n\n`);
  }
  process.stdout.write(`${messages.initSkipHint()}\n\n`);

  const checks = {
    test: await ask('Test command', suggested.test ?? ''),
    lint: await ask('Lint command', suggested.lint ?? ''),
    typecheck: await ask('Typecheck command', suggested.typecheck ?? ''),
    build: await ask('Build command', suggested.build ?? ''),
  };

  const blockMode = await confirm('\nBlock the agent when checks fail? (no = warn only)', true);
  const verifySubagents = await confirm('Verify subagent completions too?', true);

  closePrompts();

  const mode: Mode = blockMode ? 'block' : 'warn';
  const config: ShootConfig = {
    ...DEFAULT_CONFIG,
    mode,
    checks: {
      test: checks.test.trim(),
      lint: checks.lint.trim(),
      typecheck: checks.typecheck.trim(),
      build: checks.build.trim(),
    },
    verifySubagents,
    platform: adapter.id,
  };

  saveConfig(cwd, config);

  // The user just chose these commands interactively, so they are approved by
  // definition. Recording that now is what makes a LATER change detectable.
  writeTrust(cwd, config.checks);

  const result = adapter.install(cwd, {
    hookEntryPath: resolveHookEntry(),
    verifySubagents,
  });

  // Confirmation.
  const configured = Object.entries(config.checks)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `    ${k.padEnd(10)} ${v}`);

  process.stdout.write(messages.ART);
  process.stdout.write(`\n${messages.initConfigured()}\n\n`);
  process.stdout.write(
    configured.length > 0
      ? `${configured.join('\n')}\n`
      : `    ${messages.initNothingConfigured()}\n`,
  );
  process.stdout.write(`\n    platform   ${adapter.displayName}\n`);
  process.stdout.write(
    `    mode       ${mode}${mode === 'warn' ? ' (warn only, never blocks)' : ''}\n`,
  );
  process.stdout.write(`    hooks      ${result.events.join(', ')}\n`);
  process.stdout.write(`\n${messages.initWrote(result.paths.join(', '))}\n`);
  process.stdout.write(`\n${messages.initTryIt()}\n\n`);

  return 0;
}

/** Exposed so `status` and `doctor` can resolve the adapter for a config. */
export { getAdapter };
