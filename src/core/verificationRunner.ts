/**
 * Runs the configured check commands for real, with a hard timeout per command.
 * A timeout is a failure, never a hang.
 *
 * Checks run sequentially. That's deliberate for v1: test suites are often the
 * heaviest thing in a repo, and running four of them at once on a dev machine
 * mid-session is worse than waiting. Parallelism can come later if asked for.
 */

import { execFileSync, spawn } from 'node:child_process';

import type { Checks, ShootConfig } from './config.js';

export type CheckName = 'test' | 'lint' | 'typecheck' | 'build';

export type CheckStatus = 'passed' | 'failed' | 'timedOut' | 'skipped';

export interface CheckResult {
  name: CheckName;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  /** Combined stdout+stderr, truncated for hook payloads. */
  output: string;
  durationMs: number;
}

export interface VerificationReport {
  /** True only if every non-skipped check passed. */
  ok: boolean;
  results: CheckResult[];
}

/** Fixed order, so output is stable and cheapest-signal-first. */
export const CHECK_ORDER: readonly CheckName[] = ['typecheck', 'lint', 'test', 'build'];

/**
 * Cap on captured output per check. Blocking reasons get fed back to the agent,
 * and an enormous payload is both useless and expensive. The tail is kept rather
 * than the head — test runners put the failure summary at the end.
 */
export const MAX_OUTPUT_CHARS = 8000;

export interface RunOptions {
  /** Directory to run commands in. Defaults to process.cwd(). */
  cwd?: string;
  /** Per-check timeout. Defaults to 120s. */
  timeoutSeconds?: number;
  /** Injected for tests; defaults to the real spawn-based runner. */
  runCommand?: RunCommand;
}

export interface CommandOutcome {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export type RunCommand = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<CommandOutcome>;

/** Keep the tail of oversized output, with a marker so truncation is visible. */
export function truncateOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - max);
  return `[... output truncated, showing last ${max} characters ...]\n${tail}`;
}

/**
 * Execute one shell command, killing it if it exceeds timeoutMs.
 *
 * Uses `shell: true` because config values are shell strings like
 * "npm test -- --run". This is the user's own configured command from their own
 * config file, so it is trusted input by construction — Shoot never sources a
 * command from the agent or from the network.
 */
/**
 * Kill a spawned shell command and everything it started.
 *
 * `shell: true` means our direct child is a shell (cmd.exe / sh), and the real
 * work is a grandchild. Killing only the shell leaves that grandchild running
 * and holding the stdio pipes open — which is exactly how a "timeout" turns into
 * a permanent hang. So kill the whole tree.
 */
function killTree(child: { pid?: number | undefined; kill: (s?: NodeJS.Signals) => boolean }): void {
  const { pid } = child;

  if (process.platform === 'win32' && pid !== undefined) {
    try {
      // /T kills the tree, /F forces it. Windows has no process groups here.
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // Fall through to the generic kill below.
    }
  }

  if (pid !== undefined) {
    try {
      // Negative pid targets the whole process group (see detached below).
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Fall through.
    }
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

const defaultRunCommand: RunCommand = (command, cwd, timeoutMs) =>
  new Promise<CommandOutcome>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Inherit env, but signal to tools that this is non-interactive CI-ish.
      env: { ...process.env, CI: process.env.CI ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX, become a process group leader so the whole group can be killed
      // together. Not applicable on Windows, which uses taskkill /T instead.
      detached: process.platform !== 'win32',
    });

    const chunks: string[] = [];
    let settled = false;
    let timedOut = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => chunks.push(d));
    child.stderr?.on('data', (d: string) => chunks.push(d));

    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      // Don't let a surviving grandchild keep this process alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ exitCode, output: chunks.join(''), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL rather than SIGTERM: a wedged test runner may ignore TERM, and
      // the whole point of the timeout is that we never hang.
      killTree(child);

      // Critical: do not wait indefinitely for 'close' after killing. If a
      // grandchild survives and holds the pipes open, 'close' may never arrive —
      // so settle on our own after a short grace period. A timeout must always
      // produce a result. This is constraint #3: never hang forever.
      graceTimer = setTimeout(() => finish(null), 250);
      graceTimer.unref?.();
    }, timeoutMs);

    child.on('error', (err: Error) => {
      // Command could not be spawned at all (e.g. shell missing).
      chunks.push(`\n[shoot] failed to start command: ${err.message}\n`);
      finish(null);
    });

    child.on('close', (code) => finish(code));
  });

/** Run a single named check. An empty command means "skipped". */
export async function runCheck(
  name: CheckName,
  command: string,
  options: RunOptions = {},
): Promise<CheckResult> {
  const trimmed = (command ?? '').trim();

  if (trimmed === '') {
    return {
      name,
      command: '',
      status: 'skipped',
      exitCode: null,
      output: '',
      durationMs: 0,
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = Math.max(1, (options.timeoutSeconds ?? 120) * 1000);
  const run = options.runCommand ?? defaultRunCommand;

  const startedAt = Date.now();
  const outcome = await run(trimmed, cwd, timeoutMs);
  const durationMs = Date.now() - startedAt;

  const status: CheckStatus = outcome.timedOut
    ? 'timedOut'
    : outcome.exitCode === 0
      ? 'passed'
      : 'failed';

  const output = outcome.timedOut
    ? truncateOutput(
        `${outcome.output}\n[shoot] command exceeded ${timeoutMs / 1000}s and was killed.\n`,
      )
    : truncateOutput(outcome.output);

  return { name, command: trimmed, status, exitCode: outcome.exitCode, output, durationMs };
}

/**
 * Run every configured check, in CHECK_ORDER, sequentially.
 *
 * `ok` is true when nothing failed or timed out. A report where everything was
 * skipped is `ok: true` with no non-skipped results — callers decide whether
 * "nothing configured" deserves a message of its own.
 */
export async function runChecks(
  checks: Checks,
  options: RunOptions = {},
): Promise<VerificationReport> {
  const results: CheckResult[] = [];

  for (const name of CHECK_ORDER) {
    results.push(await runCheck(name, checks[name] ?? '', options));
  }

  return { ok: results.every((r) => r.status === 'passed' || r.status === 'skipped'), results };
}

/** Convenience wrapper that pulls cwd/timeout straight from a loaded config. */
export function runChecksFromConfig(
  config: ShootConfig,
  cwd: string,
  overrides: Partial<RunOptions> = {},
): Promise<VerificationReport> {
  const opts: RunOptions = { cwd, timeoutSeconds: config.timeoutSeconds, ...overrides };
  return runChecks(config.checks, opts);
}

/** Checks that actually ran and did not pass — what the agent needs to see. */
export function failures(report: VerificationReport): CheckResult[] {
  return report.results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
}

/** Checks that ran and passed. */
export function passes(report: VerificationReport): CheckResult[] {
  return report.results.filter((r) => r.status === 'passed');
}

/** True when nothing was configured at all. */
export function nothingConfigured(report: VerificationReport): boolean {
  return report.results.every((r) => r.status === 'skipped');
}

/**
 * Stable fingerprint of what failed, for the circuit breaker. Intentionally
 * excludes output text and durations — the same broken test failing three turns
 * in a row must produce the same key even as line numbers or timings shift.
 */
export function failureFingerprint(report: VerificationReport): string {
  return failures(report)
    .map((r) => `${r.name}:${r.status}:${r.exitCode ?? 'null'}`)
    .sort()
    .join('|');
}

/** One-line-per-check summary for terminal output, e.g. "test ✓, lint ✓". */
export function summarize(report: VerificationReport): string {
  const parts = report.results
    .filter((r) => r.status !== 'skipped')
    .map((r) => {
      const mark =
        r.status === 'passed' ? 'passed' : r.status === 'timedOut' ? 'timed out' : 'failed';
      return `${r.name} ${mark}`;
    });
  return parts.length > 0 ? parts.join(', ') : 'nothing configured';
}
