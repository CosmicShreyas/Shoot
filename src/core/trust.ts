/**
 * Config trust: detect when the commands Shoot runs have changed since the user
 * last approved them.
 *
 * THE THREAT
 *
 * `.shoot.config.json` is committed to the repository, and its `checks` commands
 * are executed automatically on every hook fire with no re-approval. That makes
 * it an attractive target: a pull request that edits one line of config turns
 * Shoot into an arbitrary-command runner on every reviewer's machine that has the
 * hook installed. Nothing about the diff looks like code.
 *
 * THE MITIGATION
 *
 * On `shoot init` (and `shoot trust`), hash the *commands only* and store the
 * hash in `.shoot/trust.json`. That directory is gitignored, so the trust record
 * cannot itself be modified by a PR — an attacker can change the config, but not
 * the record of what you approved. On every hook fire, recompute and compare. A
 * mismatch means "skip verification and say so loudly", never "run the new
 * commands and hope".
 *
 * WHAT THIS IS NOT
 *
 * Defense in depth, not a guarantee. It does not sandbox anything: an approved
 * command still runs with the user's full local permissions. Someone with write
 * access to your working tree can edit `.shoot/trust.json` directly. The point is
 * narrower and still worth having — a *remote* change to a *committed* file can no
 * longer silently execute.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { STATE_DIR_NAME } from './circuitBreaker.js';
import type { Checks, ShootConfig } from './config.js';

export const TRUST_FILENAME = 'trust.json';

/** The check slots, in a fixed order so hashing is stable. */
const CHECK_KEYS: readonly (keyof Checks)[] = ['test', 'lint', 'typecheck', 'build'];

export interface TrustRecord {
  /** Hash of the approved commands. */
  hash: string;
  /** The approved commands themselves, so `shoot trust` can show a real diff. */
  checks: Checks;
  /** ISO-8601 timestamp of approval. */
  approvedAt: string;
}

export type TrustStatus =
  /** Commands match what was approved. */
  | 'trusted'
  /** Commands differ from what was approved. */
  | 'changed'
  /** No trust record exists yet (fresh install, or `.shoot/` was wiped). */
  | 'unknown'
  /** Nothing is configured, so there is nothing to trust. */
  | 'empty';

export interface TrustCheck {
  status: TrustStatus;
  /** Current hash of the config's commands. */
  currentHash: string;
  /** Approved hash, when a record exists. */
  trustedHash: string | null;
  /** Per-slot differences, when status is 'changed'. */
  changes: TrustChange[];
}

export interface TrustChange {
  check: keyof Checks;
  /** The previously approved command; empty string means "was not configured". */
  from: string;
  /** The command now in the config; empty string means "was removed". */
  to: string;
}

export function trustPath(cwd: string): string {
  return join(cwd, STATE_DIR_NAME, TRUST_FILENAME);
}

/**
 * Hash the commands, and only the commands.
 *
 * Deliberately excludes `mode`, `timeoutSeconds`, `verifySubagents`, and every
 * other cosmetic field. Those change behaviour but cannot execute anything, so
 * making them invalidate trust would train users to click through the warning —
 * which is how a real tampering event gets approved by reflex.
 */
export function hashChecks(checks: Checks): string {
  // Canonical form: fixed key order, trimmed values. Whitespace-only differences
  // are not a meaningful change in what gets executed.
  const canonical = CHECK_KEYS.map((k) => `${k}=${(checks[k] ?? '').trim()}`).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeChecks(checks: Checks): Checks {
  return {
    test: (checks.test ?? '').trim(),
    lint: (checks.lint ?? '').trim(),
    typecheck: (checks.typecheck ?? '').trim(),
    build: (checks.build ?? '').trim(),
  };
}

/** Read the trust record, or null if absent/corrupt. */
export function readTrust(cwd: string): TrustRecord | null {
  const file = trustPath(cwd);
  if (!existsSync(file)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const r = parsed as Partial<TrustRecord>;
    if (typeof r.hash !== 'string' || r.hash === '') return null;

    const c = (typeof r.checks === 'object' && r.checks !== null ? r.checks : {}) as Partial<Checks>;
    return {
      hash: r.hash,
      checks: normalizeChecks({
        test: typeof c.test === 'string' ? c.test : '',
        lint: typeof c.lint === 'string' ? c.lint : '',
        typecheck: typeof c.typecheck === 'string' ? c.typecheck : '',
        build: typeof c.build === 'string' ? c.build : '',
      }),
      approvedAt: typeof r.approvedAt === 'string' ? r.approvedAt : '',
    };
  } catch {
    // A corrupt record must read as "unknown", never as "trusted".
    return null;
  }
}

/** Record the current commands as approved. */
export function writeTrust(cwd: string, checks: Checks): TrustRecord {
  const normalized = normalizeChecks(checks);
  const record: TrustRecord = {
    hash: hashChecks(normalized),
    checks: normalized,
    approvedAt: new Date().toISOString(),
  };

  const file = trustPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/** Remove the trust record. Used by `uninstall`. */
export function clearTrust(cwd: string): void {
  try {
    rmSync(trustPath(cwd), { force: true });
  } catch {
    // Absent is the desired end state anyway.
  }
}

/** Which commands differ between an approved set and the current one. */
export function diffChecks(approved: Checks, current: Checks): TrustChange[] {
  const a = normalizeChecks(approved);
  const c = normalizeChecks(current);
  const out: TrustChange[] = [];

  for (const key of CHECK_KEYS) {
    const from = a[key];
    const to = c[key];
    if (from !== to) out.push({ check: key, from, to });
  }
  return out;
}

/**
 * Compare the config's commands against the trust record.
 *
 * Note the 'empty' case: a config with no commands configured has nothing that
 * could execute, so it is not treated as untrusted. Otherwise a fresh `init` with
 * everything left blank would warn about nothing.
 */
export function checkTrust(cwd: string, config: ShootConfig): TrustCheck {
  const current = normalizeChecks(config.checks);
  const currentHash = hashChecks(current);
  const configured = CHECK_KEYS.some((k) => current[k] !== '');

  if (!configured) {
    return { status: 'empty', currentHash, trustedHash: null, changes: [] };
  }

  const record = readTrust(cwd);
  if (record === null) {
    return { status: 'unknown', currentHash, trustedHash: null, changes: [] };
  }

  if (record.hash === currentHash) {
    return { status: 'trusted', currentHash, trustedHash: record.hash, changes: [] };
  }

  return {
    status: 'changed',
    currentHash,
    trustedHash: record.hash,
    changes: diffChecks(record.checks, current),
  };
}

/** True when it is safe to execute the configured commands. */
export function isTrusted(status: TrustStatus): boolean {
  // 'empty' is safe because there is nothing to run. 'unknown' is NOT safe: it
  // means we have no record of approval, which is exactly the state a wiped
  // .shoot/ directory would produce alongside a tampered config.
  return status === 'trusted' || status === 'empty';
}

/** Plain-text diff for `shoot trust` and `shoot doctor`. Unstyled on purpose. */
export function formatChanges(changes: readonly TrustChange[]): string {
  const lines: string[] = [];
  for (const c of changes) {
    if (c.from === '') {
      lines.push(`  + ${c.check.padEnd(10)} ${c.to}`);
    } else if (c.to === '') {
      lines.push(`  - ${c.check.padEnd(10)} ${c.from}   (removed)`);
    } else {
      lines.push(`  - ${c.check.padEnd(10)} ${c.from}`);
      lines.push(`  + ${c.check.padEnd(10)} ${c.to}`);
    }
  }
  return lines.join('\n');
}
