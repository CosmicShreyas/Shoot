/**
 * The platform-neutral decision pipeline.
 *
 * claimDetector -> verificationRunner -> circuitBreaker, producing a `Verdict`.
 * Contains no knowledge of any host's wire format — adapters translate the
 * verdict. Side effects are confined to the circuit-breaker state file, the
 * history log, and the check subprocesses.
 */

import { existsSync } from 'node:fs';

import { detectClaims } from './claimDetector.js';
import { recordBlock, reset } from './circuitBreaker.js';
import type { ShootConfig } from './config.js';
import { appendHistory, type HistoryOutcome } from './history.js';
import { describeDrift, detectScopeDrift } from './scopeDrift.js';
import {
  failureFingerprint,
  failures,
  nothingConfigured,
  runChecksFromConfig,
  summarize,
  type RunOptions,
  type VerificationReport,
} from './verificationRunner.js';
import * as messages from '../mascot/messages.js';
import type { HookInput, Verdict } from '../adapters/types.js';
import type { ClaimResult } from './claimDetector.js';

export interface Decision {
  verdict: Verdict;
  claim: ClaimResult;
  report?: VerificationReport;
}

export interface DecideOptions {
  runOptions?: Partial<RunOptions>;
  /** Injected in tests; defaults to the real runner. */
  runChecks?: (config: ShootConfig, cwd: string) => Promise<VerificationReport>;
  now?: number;
  /** Injected in tests; defaults to fs.existsSync. */
  directoryExists?: (path: string) => boolean;
  /** Injected in tests; skip writing to the history log. */
  recordHistory?: boolean;
}

/**
 * Build the block reason: mascot framing line, then verbatim command output.
 * Personality never touches the diagnostic data.
 */
export function buildBlockReason(claim: ClaimResult, report: VerificationReport): string {
  const quoted = claim.matches[0]?.text;

  const lines: string[] = [
    quoted !== undefined ? messages.blocked(quoted) : messages.blockedNoQuote(),
    '',
  ];

  for (const f of failures(report)) {
    const why =
      f.status === 'timedOut'
        ? 'timed out (exceeded the configured limit)'
        : `failed with exit code ${f.exitCode ?? 'unknown'}`;
    lines.push(`--- ${f.name}: ${why}`);
    lines.push(`--- command: ${f.command}`);
    lines.push(f.output.trim() === '' ? '(no output captured)' : f.output.trimEnd());
    lines.push('');
  }

  lines.push(
    'Fix the underlying problem and re-run the checks. Do not report success until they pass.',
  );
  return lines.join('\n');
}

/** The pass-path receipt. Canonical mascot line — this is what users see. */
export function buildReceipt(report: VerificationReport): string {
  return messages.success(summarize(report));
}

function log(
  input: HookInput,
  options: DecideOptions,
  outcome: HistoryOutcome,
  report?: VerificationReport,
  extra: { claimText?: string; drift?: number } = {},
): void {
  if (options.recordHistory === false) return;
  appendHistory(input.cwd, {
    outcome,
    sessionId: input.sessionId,
    checks: report?.results.filter((r) => r.status !== 'skipped').map((r) => r.name) ?? [],
    ...(report !== undefined ? { summary: summarize(report) } : {}),
    ...(extra.claimText !== undefined ? { claim: extra.claimText } : {}),
    ...(extra.drift !== undefined ? { driftFiles: extra.drift } : {}),
  });
}

/**
 * Decide what should happen for one stop event.
 *
 * Ordering matters and is load-bearing:
 *   0. stopHookActive  — already in a forced continuation; standing down here is
 *      the only thing that prevents an infinite loop.
 *   1. cwd sanity      — without it, config/checks are untrustworthy.
 *   2. claim detection — no claim means stay quiet.
 *   3. run checks, then breaker.
 */
export async function decide(
  input: HookInput,
  config: ShootConfig,
  options: DecideOptions = {},
): Promise<Decision> {
  // 0. Forced continuation. Silent, immediate, unconditional.
  if (input.stopHookActive) {
    return { verdict: { kind: 'allowSilent' }, claim: { claimed: false, matches: [] } };
  }

  const claim = detectClaims(input.lastAssistantMessage);

  // 1. An unresolvable cwd means loadConfig silently fell back to defaults, so
  //    "nothing configured" would read like a pass. Say it was SKIPPED instead.
  if (!(options.directoryExists ?? existsSync)(input.cwd)) {
    return {
      verdict: { kind: 'allowWithNotice', notice: messages.skippedBadCwd(input.cwd) },
      claim,
    };
  }

  // 2. No completion claim: stay quiet. Normal turns must not be noisy.
  if (!claim.claimed) {
    return { verdict: { kind: 'allowSilent' }, claim };
  }

  // 3. A claim was made — actually run the checks.
  const run =
    options.runChecks ??
    ((cfg: ShootConfig, cwd: string) => runChecksFromConfig(cfg, cwd, options.runOptions ?? {}));
  const report = await run(config, input.cwd);

  const claimText = claim.matches[0]?.text;

  if (nothingConfigured(report)) {
    log(input, options, 'skipped', report, { ...(claimText !== undefined ? { claimText } : {}) });
    return {
      verdict: { kind: 'allowWithNotice', notice: messages.noChecksConfigured() },
      claim,
      report,
    };
  }

  if (report.ok) {
    if (input.sessionId !== '') reset(input.cwd, input.sessionId);

    // Scope drift is advisory only — appended to the receipt, never blocking.
    const drift = config.scopeDriftWarning ? detectScopeDrift(input.cwd, config) : null;
    const driftNote = drift !== null && drift.drifted ? `\n${describeDrift(drift)}` : '';

    log(input, options, 'passed', report, {
      ...(claimText !== undefined ? { claimText } : {}),
      ...(drift !== null ? { drift: drift.fileCount } : {}),
    });

    return {
      verdict: { kind: 'allowWithNotice', notice: `${buildReceipt(report)}${driftNote}` },
      claim,
      report,
    };
  }

  // Warn mode never blocks.
  if (config.mode === 'warn') {
    log(input, options, 'warned', report, { ...(claimText !== undefined ? { claimText } : {}) });
    return {
      verdict: { kind: 'allowWithNotice', notice: messages.warnOnly(summarize(report)) },
      claim,
      report,
    };
  }

  // Block mode — consult the circuit breaker first.
  const fingerprint = failureFingerprint(report);
  const breaker =
    input.sessionId === ''
      ? // No session id means no reliable counting; block once rather than risk
        // an uncounted loop.
        { tripped: false, consecutiveBlocks: 1 }
      : recordBlock(
          input.cwd,
          input.sessionId,
          fingerprint,
          config.maxBlocksPerSession,
          options.now ?? Date.now(),
        );

  if (breaker.tripped) {
    log(input, options, 'stoodDown', report, {
      ...(claimText !== undefined ? { claimText } : {}),
    });
    return {
      verdict: {
        kind: 'allowWithNotice',
        notice: messages.breakerTripped(breaker.consecutiveBlocks, summarize(report)),
      },
      claim,
      report,
    };
  }

  log(input, options, 'blocked', report, { ...(claimText !== undefined ? { claimText } : {}) });
  return {
    verdict: { kind: 'block', reason: buildBlockReason(claim, report) },
    claim,
    report,
  };
}
