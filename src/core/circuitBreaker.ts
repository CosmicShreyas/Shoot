/**
 * Tracks how many times Shoot has blocked a given session for the same
 * underlying failure. Once the limit is reached, the stop is allowed through
 * with a loud warning — a genuinely broken suite must never trap the user.
 *
 * WHY DISK, NOT MEMORY: every Stop hook event runs as a brand-new process. There
 * is no in-memory state to carry a counter between invocations of the same
 * Claude Code session, so the count is persisted under `.shoot/sessions/` keyed
 * by session id. That directory is gitignored.
 *
 * The session id is accepted as a plain string so this module stays decoupled
 * from the hook payload shape (Phase 4 wires the real id in).
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface BreakerState {
  sessionId: string;
  /** Fingerprint of the failure that caused the most recent blocks. */
  failureKey: string;
  consecutiveBlocks: number;
  /** Epoch ms of the last write, used for max-age cleanup. */
  updatedAt: number;
}

export interface BreakerDecision {
  /** True when the limit is reached and Shoot must stand down. */
  tripped: boolean;
  consecutiveBlocks: number;
}

export const STATE_DIR_NAME = '.shoot';
export const SESSIONS_DIR_NAME = 'sessions';

/** Persisted session state older than this is deleted on next access. */
export const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function stateDir(cwd: string): string {
  return join(cwd, STATE_DIR_NAME, SESSIONS_DIR_NAME);
}

/**
 * Session ids come from an external payload, so they are hashed rather than used
 * as filenames directly — this avoids path traversal and illegal-character
 * issues in one step.
 */
export function sessionFilePath(cwd: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return join(stateDir(cwd), `${digest}.json`);
}

function readState(cwd: string, sessionId: string): BreakerState | null {
  const file = sessionFilePath(cwd, sessionId);
  if (!existsSync(file)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;

    const s = parsed as Partial<BreakerState>;
    if (typeof s.failureKey !== 'string' || typeof s.consecutiveBlocks !== 'number') return null;

    return {
      sessionId,
      failureKey: s.failureKey,
      consecutiveBlocks: s.consecutiveBlocks,
      updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
    };
  } catch {
    // Corrupt state must never break the hook — treat it as a fresh session.
    return null;
  }
}

function writeState(cwd: string, state: BreakerState): void {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    sessionFilePath(cwd, state.sessionId),
    `${JSON.stringify(state, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Delete session files older than maxAgeMs so `.shoot/sessions/` does not grow
 * without bound. Cheap enough to run on every block; failures are swallowed
 * because cleanup must never be the reason a hook errors out.
 */
export function cleanupStaleState(
  cwd: string,
  maxAgeMs: number = MAX_STATE_AGE_MS,
  now: number = Date.now(),
): number {
  const dir = stateDir(cwd);
  if (!existsSync(dir)) return 0;

  let removed = 0;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const file = join(dir, entry);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          rmSync(file, { force: true });
          removed++;
        }
      } catch {
        // Ignore individual file errors.
      }
    }
  } catch {
    // Ignore directory-level errors.
  }
  return removed;
}

/**
 * Record that Shoot is about to block this session for `failureKey`, and decide
 * whether it is still allowed to.
 *
 * Counting rule: consecutive blocks for the SAME failureKey accumulate. A
 * different failureKey means the agent made real progress and moved on to a new
 * problem, so the counter resets to 1 — otherwise unrelated failures across a
 * long session would trip the breaker spuriously.
 *
 * Trip rule: when the recorded count reaches maxBlocks, the decision is
 * `tripped: true`, meaning "allow the stop, but warn loudly". Callers must not
 * block on a tripped decision.
 */
export function recordBlock(
  cwd: string,
  sessionId: string,
  failureKey: string,
  maxBlocks: number,
  now: number = Date.now(),
): BreakerDecision {
  cleanupStaleState(cwd, MAX_STATE_AGE_MS, now);

  const previous = readState(cwd, sessionId);
  const sameFailure = previous !== null && previous.failureKey === failureKey;
  const consecutiveBlocks = sameFailure ? previous.consecutiveBlocks + 1 : 1;

  writeState(cwd, { sessionId, failureKey, consecutiveBlocks, updatedAt: now });

  // A limit of 0 or less disables blocking entirely.
  const limit = Math.max(0, Math.floor(maxBlocks));
  return { tripped: limit <= 0 || consecutiveBlocks >= limit, consecutiveBlocks };
}

/** Read the current count without recording anything. */
export function peek(cwd: string, sessionId: string): BreakerState | null {
  return readState(cwd, sessionId);
}

/**
 * Clear a session's state. Called when checks pass — the agent got there, so the
 * next unrelated failure should start from a clean slate.
 */
export function reset(cwd: string, sessionId: string): void {
  try {
    rmSync(sessionFilePath(cwd, sessionId), { force: true });
  } catch {
    // Nothing to do; absent state is the desired end state anyway.
  }
}
