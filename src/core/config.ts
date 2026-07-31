/**
 * Loads, validates, and writes `.shoot.config.json`.
 *
 * Validation is forgiving by design: an unreadable or partial config degrades to
 * defaults rather than breaking the agent's session. The hook runs on every stop,
 * so a config typo must never be fatal.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlatformId } from '../adapters/types.js';

export type Mode = 'block' | 'warn';

/** The four check slots. An empty string means "not configured — skip it". */
export interface Checks {
  test: string;
  lint: string;
  typecheck: string;
  build: string;
}

export interface ShootConfig {
  mode: Mode;
  checks: Checks;
  timeoutSeconds: number;
  maxBlocksPerSession: number;
  /**
   * Whether to also verify subagent completions (the `SubagentStop` hook).
   * Defaults to true — subagents claim completion just as readily as the main
   * agent. Set false for stricter opt-in behavior (main-agent stops only).
   */
  verifySubagents: boolean;
  /** Which agent platform's hooks are installed. */
  platform: PlatformId;
  /**
   * Append an advisory note to a passing receipt when the change looks
   * unexpectedly broad. Advisory only — never blocks, in any mode.
   */
  scopeDriftWarning: boolean;
  /** Changed-file count above which the advisory may fire. */
  scopeDriftFileThreshold: number;
}

export const CONFIG_FILENAME = '.shoot.config.json';

export const DEFAULT_CONFIG: ShootConfig = {
  mode: 'block',
  checks: { test: '', lint: '', typecheck: '', build: '' },
  timeoutSeconds: 120,
  maxBlocksPerSession: 3,
  verifySubagents: true,
  platform: 'claude-code',
  scopeDriftWarning: true,
  scopeDriftFileThreshold: 12,
};

/**
 * Upper bound on maxBlocksPerSession. Claude Code force-ends a session after 8
 * consecutive Stop-hook blocks, so Shoot must always stand down first.
 */
export const MAX_BLOCKS_CEILING = 6;

export function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILENAME);
}

function coerceChecks(value: unknown): Checks {
  const out: Checks = { ...DEFAULT_CONFIG.checks };
  if (typeof value !== 'object' || value === null) return out;

  const v = value as Record<string, unknown>;
  for (const key of ['test', 'lint', 'typecheck', 'build'] as const) {
    const raw = v[key];
    if (typeof raw === 'string') out[key] = raw.trim();
  }
  return out;
}

/** Normalize arbitrary parsed JSON into a valid config, filling gaps with defaults. */
export function normalizeConfig(value: unknown): ShootConfig {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_CONFIG };
  const v = value as Record<string, unknown>;

  const timeout = Number(v['timeoutSeconds']);
  const maxBlocks = Number(v['maxBlocksPerSession']);

  return {
    mode: v['mode'] === 'warn' ? 'warn' : 'block',
    checks: coerceChecks(v['checks']),
    timeoutSeconds:
      Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_CONFIG.timeoutSeconds,
    maxBlocksPerSession:
      Number.isFinite(maxBlocks) && maxBlocks >= 0
        ? Math.min(Math.floor(maxBlocks), MAX_BLOCKS_CEILING)
        : DEFAULT_CONFIG.maxBlocksPerSession,
    verifySubagents: v['verifySubagents'] === false ? false : true,
    platform: v['platform'] === 'codex' ? 'codex' : 'claude-code',
    scopeDriftWarning: v['scopeDriftWarning'] === false ? false : true,
    scopeDriftFileThreshold: (() => {
      const n = Number(v['scopeDriftFileThreshold']);
      return Number.isFinite(n) && n > 0
        ? Math.floor(n)
        : DEFAULT_CONFIG.scopeDriftFileThreshold;
    })(),
  };
}

/** True when a config file exists in this directory. */
export function configExists(cwd: string): boolean {
  return existsSync(configPath(cwd));
}

/** Load config, falling back to defaults if absent or malformed. */
export function loadConfig(cwd: string): ShootConfig {
  const file = configPath(cwd);
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };

  try {
    return normalizeConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cwd: string, config: ShootConfig): void {
  writeFileSync(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** True when at least one check command is configured. */
export function hasAnyCheck(config: ShootConfig): boolean {
  return Object.values(config.checks).some((c) => c.trim() !== '');
}
