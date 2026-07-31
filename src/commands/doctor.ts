/**
 * `shoot doctor` — proactively diagnose common setup problems.
 *
 * Every check is independent and reports pass / fail / warn with a concrete next
 * step. The point is to catch the failure modes that otherwise look like success:
 * a registered hook whose script is gone, a check command that doesn't exist, a
 * config pointing at the wrong platform.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAdapter, detectPlatforms } from '../adapters/index.js';
import {
  CONFIG_FILENAME,
  configExists,
  hasAnyCheck,
  loadConfig,
  type ShootConfig,
} from '../core/config.js';
import { resolveHookPath } from '../core/settings.js';
import { checkTrust } from '../core/trust.js';
import * as messages from '../mascot/messages.js';

export type DiagnosisStatus = 'pass' | 'fail' | 'warn';

export interface Diagnosis {
  name: string;
  status: DiagnosisStatus;
  detail: string;
  /** Concrete next step, when there is one. */
  fix?: string;
}

/** Minimum Node this package supports, from package.json engines. */
export const MIN_NODE_MAJOR = 18;

function checkNodeVersion(): Diagnosis {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= MIN_NODE_MAJOR) {
    return { name: 'Node version', status: 'pass', detail: `v${process.versions.node}` };
  }
  return {
    name: 'Node version',
    status: 'fail',
    detail: `v${process.versions.node} — Shoot needs >= ${MIN_NODE_MAJOR}`,
    fix: `Upgrade Node to ${MIN_NODE_MAJOR} or newer.`,
  };
}

function checkConfigPresent(cwd: string): Diagnosis {
  if (configExists(cwd)) {
    return { name: 'Config file', status: 'pass', detail: CONFIG_FILENAME };
  }
  return {
    name: 'Config file',
    status: 'fail',
    detail: `${CONFIG_FILENAME} not found`,
    fix: 'Run `shoot init`.',
  };
}

function checkCwdResolvable(cwd: string): Diagnosis {
  if (existsSync(cwd)) {
    return { name: 'Working directory', status: 'pass', detail: cwd };
  }
  // Hard to hit locally, but this is exactly the silent-skip case the hook
  // guards against, so it's worth surfacing here too.
  return {
    name: 'Working directory',
    status: 'fail',
    detail: `${cwd} does not exist`,
    fix: 'Run Shoot from inside your project directory.',
  };
}

function checkAnyChecksConfigured(config: ShootConfig): Diagnosis {
  if (hasAnyCheck(config)) {
    const names = Object.entries(config.checks)
      .filter(([, v]) => v.trim() !== '')
      .map(([k]) => k);
    return { name: 'Checks configured', status: 'pass', detail: names.join(', ') };
  }
  return {
    name: 'Checks configured',
    status: 'warn',
    detail: 'nothing configured — Shoot has nothing to verify',
    fix: 'Add at least one command to .shoot.config.json, or re-run `shoot init`.',
  };
}

/**
 * Cross-reference `npm ...` style commands against package.json scripts. A
 * configured `npm run lint` with no `lint` script fails every single time, which
 * would look like a genuinely broken project rather than a config typo.
 */
function checkCommandsExist(cwd: string, config: ShootConfig): Diagnosis[] {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let scripts: Record<string, unknown> = {};
  try {
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg === 'object' && pkg !== null) {
      const s = (pkg as Record<string, unknown>)['scripts'];
      if (typeof s === 'object' && s !== null) scripts = s as Record<string, unknown>;
    }
  } catch {
    return [
      {
        name: 'package.json',
        status: 'warn',
        detail: 'could not be parsed, so command names were not verified',
      },
    ];
  }

  const out: Diagnosis[] = [];

  for (const [checkName, command] of Object.entries(config.checks)) {
    const trimmed = command.trim();
    if (trimmed === '') continue;

    // Only reason about npm script invocations; anything else is a free-form
    // shell command we cannot validate without running it.
    const runMatch = /^npm\s+run\s+([\w:@./-]+)/.exec(trimmed);
    const bareMatch = /^npm\s+(test|start)\b/.exec(trimmed);
    const scriptName = runMatch?.[1] ?? bareMatch?.[1];
    if (scriptName === undefined) continue;

    if (typeof scripts[scriptName] === 'string') {
      out.push({
        name: `${checkName} command`,
        status: 'pass',
        detail: `${trimmed} → package.json scripts.${scriptName}`,
      });
    } else {
      out.push({
        name: `${checkName} command`,
        status: 'fail',
        detail: `${trimmed} — no "${scriptName}" script in package.json`,
        fix: `Add a "${scriptName}" script, or change checks.${checkName} in ${CONFIG_FILENAME}.`,
      });
    }
  }

  return out;
}

/** The important one: a registration whose script is gone verifies nothing. */
function checkRegistrations(cwd: string, config: ShootConfig): Diagnosis[] {
  const adapter = getAdapter(config.platform);
  const registrations = adapter.registrations(cwd);

  if (registrations.length === 0) {
    return [
      {
        name: 'Hook registration',
        status: 'fail',
        detail: `no Shoot hooks registered for ${adapter.displayName}`,
        fix: 'Run `shoot init` to register them.',
      },
    ];
  }

  const out: Diagnosis[] = [];
  for (const reg of registrations) {
    const missing = reg.paths.filter((p) => !existsSync(resolveHookPath(p, cwd)));
    if (missing.length === 0) {
      out.push({ name: `Hook: ${reg.event}`, status: 'pass', detail: 'registered, script present' });
    } else {
      out.push({
        name: `Hook: ${reg.event}`,
        status: 'fail',
        detail: `registered, but the script is missing: ${missing.join(', ')}`,
        fix: 'Run `shoot init` to reinstall the shim.',
      });
    }
  }
  return out;
}

/** Config says one platform; the filesystem suggests another. */
function checkPlatformMatch(cwd: string, config: ShootConfig): Diagnosis {
  const adapter = getAdapter(config.platform);
  const detected = detectPlatforms(cwd);

  if (detected.some((d) => d.id === adapter.id)) {
    return { name: 'Platform', status: 'pass', detail: adapter.displayName };
  }

  if (detected.length === 0) {
    return {
      name: 'Platform',
      status: 'warn',
      detail: `config says ${adapter.displayName}, but ${adapter.detectDirectory}/ is not here`,
      fix: 'Run `shoot init` from your project root.',
    };
  }

  return {
    name: 'Platform',
    status: 'warn',
    detail:
      `config says ${adapter.displayName}, but this project looks like ` +
      detected.map((d) => d.displayName).join(' / '),
    fix: 'Re-run `shoot init` to pick the right platform.',
  };
}

/**
 * Are the configured commands the ones the user approved? An untrusted config
 * means verification is currently being skipped entirely, which is a silent
 * degradation and therefore exactly what doctor exists to surface.
 */
function checkConfigTrust(cwd: string, config: ShootConfig): Diagnosis {
  const status = checkTrust(cwd, config);

  switch (status.status) {
    case 'trusted':
      return { name: 'Config trust', status: 'pass', detail: 'commands match what you approved' };

    case 'empty':
      return {
        name: 'Config trust',
        status: 'pass',
        detail: 'no commands configured, nothing to approve',
      };

    case 'changed': {
      const changed = status.changes.map((c) => c.check).join(', ');
      return {
        name: 'Config trust',
        status: 'fail',
        detail: `commands changed since approval (${changed}) — verification is being SKIPPED`,
        fix: 'Run `shoot trust` to review the change and approve it.',
      };
    }

    case 'unknown':
      return {
        name: 'Config trust',
        status: 'fail',
        detail: 'no approval on record — verification is being SKIPPED',
        fix: 'Run `shoot trust` to review and approve the commands.',
      };
  }
}

/** Platform caveats are worth repeating here, not just at install time. */
function platformWarnings(config: ShootConfig): Diagnosis[] {
  const adapter = getAdapter(config.platform);
  return adapter.warnings().map((w) => ({
    name: `${adapter.displayName} caveat`,
    status: 'warn' as const,
    detail: w,
  }));
}

/** Run every diagnosis. Exposed separately so it can be tested without printing. */
export function diagnose(cwd: string): Diagnosis[] {
  const results: Diagnosis[] = [checkNodeVersion(), checkCwdResolvable(cwd)];

  const configCheck = checkConfigPresent(cwd);
  results.push(configCheck);

  // Everything below needs a config to reason about.
  if (configCheck.status === 'fail') return results;

  const config = loadConfig(cwd);
  results.push(checkPlatformMatch(cwd, config));
  results.push(checkConfigTrust(cwd, config));
  results.push(checkAnyChecksConfigured(config));
  results.push(...checkCommandsExist(cwd, config));
  results.push(...checkRegistrations(cwd, config));
  results.push(...platformWarnings(config));

  return results;
}

const MARK: Record<DiagnosisStatus, string> = { pass: 'ok  ', fail: 'FAIL', warn: 'warn' };

export async function doctor(_argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const results = diagnose(cwd);

  process.stdout.write(`\n${messages.doctorHeading()}\n\n`);

  for (const r of results) {
    process.stdout.write(`  ${MARK[r.status]}  ${r.name.padEnd(20)} ${r.detail}\n`);
    if (r.fix !== undefined) process.stdout.write(`        ${' '.repeat(20)} → ${r.fix}\n`);
  }

  const failures = results.filter((r) => r.status === 'fail').length;
  const warnings = results.filter((r) => r.status === 'warn').length;

  process.stdout.write('\n');
  if (failures > 0) {
    process.stderr.write(`${messages.doctorFailed(failures)}\n\n`);
    return 1;
  }
  process.stdout.write(
    `${warnings > 0 ? messages.doctorWarnings(warnings) : messages.doctorHealthy()}\n\n`,
  );
  return 0;
}
