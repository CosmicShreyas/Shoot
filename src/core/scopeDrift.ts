/**
 * Scope-drift warning — ADVISORY ONLY. Never blocks, in any mode.
 *
 * Honest description of what this is: a file-count heuristic. It asks git how
 * many distinct files changed and how spread out across top-level directories
 * they are, and if that number is unusually large it mentions it in the receipt.
 *
 * What it is NOT: it does not read the task description, does not understand what
 * the change was for, and cannot tell a legitimate wide refactor from genuine
 * drift. A monorepo-wide rename and an agent wandering off look identical to it.
 *
 * Because it is imprecise by construction, it is wired to warn and nothing else.
 * Blocking on a signal this soft would train users to ignore Shoot, which would
 * cost far more than the drift it caught. This is deliberate; see the README.
 */

import { execFileSync } from 'node:child_process';

import type { ShootConfig } from './config.js';

export interface DriftResult {
  /** True when the change looks unexpectedly broad. */
  drifted: boolean;
  /** Distinct changed files git reported. */
  fileCount: number;
  /** Distinct top-level directories touched. */
  areaCount: number;
  /** A few representative paths, for the message. */
  sample: string[];
  /** False when git was unavailable or this isn't a repo — no signal at all. */
  available: boolean;
}

/** Default thresholds. Deliberately generous: false alarms are the bigger risk. */
export const DEFAULT_DRIFT_FILE_THRESHOLD = 12;
export const DEFAULT_DRIFT_AREA_THRESHOLD = 4;

const NOT_AVAILABLE: DriftResult = {
  drifted: false,
  fileCount: 0,
  areaCount: 0,
  sample: [],
  available: false,
};

/** Changed file paths per git, working tree + staged, relative to repo root. */
export function changedFiles(cwd: string): string[] | null {
  try {
    // --porcelain gives a stable, parseable format across git versions.
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const files: string[] = [];
    for (const line of out.split('\n')) {
      if (line.trim() === '') continue;
      // Format: XY <path>, or XY <old> -> <new> for renames.
      const path = line.slice(3).trim();
      const renamed = path.split(' -> ');
      const finalPath = renamed[renamed.length - 1];
      if (finalPath !== undefined && finalPath !== '') files.push(finalPath);
    }
    return files;
  } catch {
    // Not a git repo, git missing, or timed out. No signal — say so.
    return null;
  }
}

function topLevelArea(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const first = normalized.split('/')[0];
  return first ?? normalized;
}

/**
 * Look for an unexpectedly broad change. Returns `available: false` when git
 * can't tell us anything, which callers must treat as "no opinion" rather than
 * as "no drift".
 */
export function detectScopeDrift(
  cwd: string,
  config: Pick<ShootConfig, 'scopeDriftFileThreshold'> & Partial<ShootConfig>,
): DriftResult {
  const files = changedFiles(cwd);
  if (files === null) return NOT_AVAILABLE;

  const fileThreshold = config.scopeDriftFileThreshold ?? DEFAULT_DRIFT_FILE_THRESHOLD;
  const areas = new Set(files.map(topLevelArea));

  const drifted =
    files.length > fileThreshold && areas.size >= DEFAULT_DRIFT_AREA_THRESHOLD;

  return {
    drifted,
    fileCount: files.length,
    areaCount: areas.size,
    sample: files.slice(0, 5),
    available: true,
  };
}

/** Advisory sentence appended to a passing receipt. Deliberately soft wording. */
export function describeDrift(result: DriftResult): string {
  if (!result.available || !result.drifted) return '';
  return (
    `   Heads up (advisory, not a failure): ${result.fileCount} changed files across ` +
    `${result.areaCount} areas — broader than a focused change usually is. ` +
    `Worth a glance if you expected something narrow.`
  );
}
