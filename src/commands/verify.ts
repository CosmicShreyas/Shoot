/**
 * `shoot verify` — run all configured checks once, now, and print the result.
 *
 * No hook context and no claim detection: this just runs whatever is configured
 * and reports honestly. Useful for a pre-commit sanity check, and it is what a
 * demo GIF shows, so the output is kept tidy.
 */

import { configExists, hasAnyCheck, loadConfig } from '../core/config.js';
import { stdoutPalette } from '../mascot/colors.js';
import {
  failures,
  nothingConfigured,
  runChecksFromConfig,
  type CheckResult,
} from '../core/verificationRunner.js';
import * as messages from '../mascot/messages.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusLabel(result: CheckResult): string {
  switch (result.status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'FAIL';
    case 'timedOut':
      return 'TIMEOUT';
    case 'skipped':
      return 'skip';
  }
}

export async function verify(_argv: string[]): Promise<number> {
  const cwd = process.cwd();

  if (!configExists(cwd)) {
    process.stderr.write(`${messages.noConfigHere()}\n`);
    return 1;
  }

  const config = loadConfig(cwd);

  if (!hasAnyCheck(config)) {
    process.stdout.write(`${messages.noChecksConfigured()}\n`);
    return 0;
  }

  const palette = stdoutPalette();
  process.stdout.write(`\n${messages.verifyRunning()}\n\n`);

  const report = await runChecksFromConfig(config, cwd);

  // Per-check summary lines. HUMAN CHANNEL: status coloured, name emphasised,
  // timing dimmed as secondary metadata.
  for (const result of report.results) {
    if (result.status === 'skipped') continue;

    const raw = statusLabel(result);
    const tint =
      result.status === 'passed'
        ? palette.ok
        : result.status === 'timedOut'
          ? palette.warn
          : palette.bad;

    process.stdout.write(
      `  ${tint(raw.padEnd(8))} ${palette.accent(result.name.padEnd(10))} ` +
        `${palette.faint(formatDuration(result.durationMs))}\n`,
    );
  }

  if (nothingConfigured(report)) {
    process.stdout.write(`\n${messages.noChecksConfigured()}\n`);
    return 0;
  }

  // Full diagnostic output for anything that failed.
  //
  // The `---` header lines are Shoot's framing and get colour; the command output
  // below them stays completely unstyled, per the rule in messages.ts — diagnostic
  // data must remain greppable and byte-identical to what the tool emitted.
  const failed = failures(report);
  if (failed.length > 0) {
    for (const result of failed) {
      const why =
        result.status === 'timedOut'
          ? `timed out after ${formatDuration(result.durationMs)}`
          : `exited ${result.exitCode ?? 'unknown'}`;
      const tint = result.status === 'timedOut' ? palette.warn : palette.bad;

      process.stdout.write(`\n${tint(`--- ${result.name}: ${why}`)}\n`);
      process.stdout.write(`${palette.faint(`--- command: ${result.command}`)}\n`);
      const body = result.output.trimEnd();
      process.stdout.write(`${body === '' ? '(no output captured)' : body}\n`);
    }
    process.stdout.write(`\n${messages.verifyFailed(failed.length)}\n\n`);
    return 1;
  }

  process.stdout.write(`\n${messages.verifyPassed()}\n\n`);
  return 0;
}
