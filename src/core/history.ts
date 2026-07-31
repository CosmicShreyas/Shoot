/**
 * Local verification history: one JSON object per line in `.shoot/history.jsonl`.
 *
 * Append-only, local-only, never transmitted anywhere. The `.shoot/` directory is
 * already gitignored (it holds circuit-breaker state), so history rides along.
 *
 * Failure policy: history is a nice-to-have. Every write is best-effort and
 * swallows errors — losing a log line must never affect a verification decision.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { STATE_DIR_NAME } from './circuitBreaker.js';

export type HistoryOutcome =
  /** Claim verified, checks passed, turn allowed. */
  | 'passed'
  /** Claim verified, checks failed, turn blocked. */
  | 'blocked'
  /** Checks failed but mode was warn, so not blocked. */
  | 'warned'
  /** Breaker limit reached; allowed through despite failing checks. */
  | 'stoodDown'
  /** A claim was made but nothing was configured to verify it. */
  | 'skipped'
  /** Verification was skipped because the config's commands were not trusted. */
  | 'untrusted';

export interface HistoryEntry {
  /** ISO-8601 timestamp. */
  at: string;
  outcome: HistoryOutcome;
  sessionId: string;
  /** Names of checks that actually ran (skipped ones omitted). */
  checks: string[];
  /** Short human summary, e.g. "test passed, lint passed". */
  summary?: string;
  /** The claim phrase that triggered verification. */
  claim?: string;
  /** Number of changed files seen by the scope-drift heuristic, if it ran. */
  driftFiles?: number;
}

export const HISTORY_FILENAME = 'history.jsonl';

/** Cap the file so it can't grow without bound. Oldest lines are dropped. */
export const MAX_HISTORY_ENTRIES = 5000;

export function historyPath(cwd: string): string {
  return join(cwd, STATE_DIR_NAME, HISTORY_FILENAME);
}

/** Append one entry. Best-effort; never throws. */
export function appendHistory(cwd: string, entry: Omit<HistoryEntry, 'at'>): void {
  try {
    const file = historyPath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    const full: HistoryEntry = { at: new Date().toISOString(), ...entry };
    appendFileSync(file, `${JSON.stringify(full)}\n`, 'utf8');
  } catch {
    // History is advisory. Never let it break a decision.
  }
}

/**
 * Read all entries. Malformed lines are skipped rather than throwing — a
 * half-written line from a killed process must not poison the whole file.
 */
export function readHistory(cwd: string): HistoryEntry[] {
  const file = historyPath(cwd);
  if (!existsSync(file)) return [];

  try {
    const out: HistoryEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null) continue;
        const e = parsed as Partial<HistoryEntry>;
        if (typeof e.outcome !== 'string' || typeof e.at !== 'string') continue;
        out.push({
          at: e.at,
          outcome: e.outcome as HistoryOutcome,
          sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
          checks: Array.isArray(e.checks) ? e.checks.filter((c) => typeof c === 'string') : [],
          ...(typeof e.summary === 'string' ? { summary: e.summary } : {}),
          ...(typeof e.claim === 'string' ? { claim: e.claim } : {}),
          ...(typeof e.driftFiles === 'number' ? { driftFiles: e.driftFiles } : {}),
        });
      } catch {
        // Skip this line.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface HistoryStats {
  total: number;
  passed: number;
  blocked: number;
  warned: number;
  stoodDown: number;
  skipped: number;
  /** Claims where verification was skipped because the config was untrusted. */
  untrusted: number;
  /** Claims that were caught and did not survive: blocked + warned + stoodDown. */
  caught: number;
  /** Share of verified claims that passed, 0..1. Null when nothing verified. */
  passRate: number | null;
  firstAt: string | null;
  lastAt: string | null;
  sessions: number;
}

export function summarizeHistory(entries: HistoryEntry[]): HistoryStats {
  const count = (o: HistoryOutcome): number => entries.filter((e) => e.outcome === o).length;

  const passed = count('passed');
  const blocked = count('blocked');
  const warned = count('warned');
  const stoodDown = count('stoodDown');
  const skipped = count('skipped');
  const untrusted = count('untrusted');

  // Pass rate is over claims actually verified. "skipped" had nothing to check
  // and "untrusted" was never run at all, so counting either would misrepresent
  // the number.
  const verified = passed + blocked + warned + stoodDown;

  const sorted = entries.map((e) => e.at).sort();

  return {
    total: entries.length,
    passed,
    blocked,
    warned,
    stoodDown,
    skipped,
    untrusted,
    caught: blocked + warned + stoodDown,
    passRate: verified === 0 ? null : passed / verified,
    firstAt: sorted[0] ?? null,
    lastAt: sorted[sorted.length - 1] ?? null,
    sessions: new Set(entries.map((e) => e.sessionId).filter((s) => s !== '')).size,
  };
}

/** Trim the file to the newest MAX_HISTORY_ENTRIES lines. Best-effort. */
export function trimHistory(cwd: string, max: number = MAX_HISTORY_ENTRIES): number {
  try {
    const entries = readHistory(cwd);
    if (entries.length <= max) return 0;

    const keep = entries.slice(entries.length - max);
    const file = historyPath(cwd);
    rmSync(file, { force: true });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${keep.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
    return entries.length - max;
  } catch {
    return 0;
  }
}
