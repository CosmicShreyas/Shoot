import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHECK_ORDER,
  MAX_OUTPUT_CHARS,
  failureFingerprint,
  failures,
  nothingConfigured,
  passes,
  runCheck,
  runChecks,
  summarize,
  truncateOutput,
  type CommandOutcome,
  type RunCommand,
} from '../src/core/verificationRunner.js';
import type { Checks } from '../src/core/config.js';

const NO_CHECKS: Checks = { test: '', lint: '', typecheck: '', build: '' };

/** A fake runner driven by a per-command lookup table. */
function fakeRunner(table: Record<string, Partial<CommandOutcome>>): RunCommand {
  return async (command) => {
    const hit = table[command] ?? {};
    return {
      exitCode: hit.exitCode ?? 0,
      output: hit.output ?? '',
      timedOut: hit.timedOut ?? false,
    };
  };
}

// ---------------------------------------------------------------------------
// Skipping
// ---------------------------------------------------------------------------

test('an empty command is skipped, not failed', async () => {
  const result = await runCheck('lint', '', { runCommand: fakeRunner({}) });
  assert.equal(result.status, 'skipped');
  assert.equal(result.exitCode, null);
  assert.equal(result.command, '');
});

test('a whitespace-only command is skipped', async () => {
  const result = await runCheck('build', '   ', { runCommand: fakeRunner({}) });
  assert.equal(result.status, 'skipped');
});

test('a report of all-skipped checks is ok, and flagged as nothing configured', async () => {
  const report = await runChecks(NO_CHECKS, { runCommand: fakeRunner({}) });
  assert.equal(report.ok, true);
  assert.equal(nothingConfigured(report), true);
  assert.equal(report.results.length, CHECK_ORDER.length);
  assert.ok(report.results.every((r) => r.status === 'skipped'));
});

test('projects without a lint step are not penalized', async () => {
  const checks: Checks = { test: 'run-tests', lint: '', typecheck: '', build: '' };
  const report = await runChecks(checks, { runCommand: fakeRunner({ 'run-tests': { exitCode: 0 } }) });
  assert.equal(report.ok, true);
  assert.equal(nothingConfigured(report), false);
  assert.equal(passes(report).length, 1);
});

// ---------------------------------------------------------------------------
// Pass / fail
// ---------------------------------------------------------------------------

test('exit code 0 passes; non-zero fails', async () => {
  const run = fakeRunner({ good: { exitCode: 0 }, bad: { exitCode: 1 } });
  assert.equal((await runCheck('test', 'good', { runCommand: run })).status, 'passed');
  assert.equal((await runCheck('test', 'bad', { runCommand: run })).status, 'failed');
});

test('report is not ok when any check fails, and failures are listed', async () => {
  const checks: Checks = { test: 'bad', lint: 'good', typecheck: '', build: '' };
  const report = await runChecks(checks, {
    runCommand: fakeRunner({ bad: { exitCode: 2, output: 'boom' }, good: { exitCode: 0 } }),
  });

  assert.equal(report.ok, false);
  const failed = failures(report);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.name, 'test');
  assert.equal(failed[0]?.exitCode, 2);
  assert.match(failed[0]?.output ?? '', /boom/);
});

test('captured output is preserved for the blocking reason', async () => {
  const result = await runCheck('test', 'x', {
    runCommand: fakeRunner({ x: { exitCode: 1, output: 'FAIL src/a.test.ts > adds numbers' } }),
  });
  assert.match(result.output, /FAIL src\/a\.test\.ts/);
});

test('results follow CHECK_ORDER regardless of config key order', async () => {
  const report = await runChecks(
    { build: 'b', test: 't', typecheck: 'tc', lint: 'l' },
    { runCommand: fakeRunner({}) },
  );
  assert.deepEqual(
    report.results.map((r) => r.name),
    [...CHECK_ORDER],
  );
});

// ---------------------------------------------------------------------------
// Timeout — distinct from plain failure
// ---------------------------------------------------------------------------

test('a timeout is reported as timedOut, not merely failed', async () => {
  const result = await runCheck('test', 'sleep-forever', {
    runCommand: fakeRunner({ 'sleep-forever': { exitCode: null, timedOut: true } }),
  });

  assert.equal(result.status, 'timedOut');
  assert.notEqual(result.status, 'failed');
  assert.match(result.output, /exceeded/i);
});

test('a timeout makes the overall report not ok', async () => {
  const report = await runChecks(
    { test: 'hang', lint: '', typecheck: '', build: '' },
    { runCommand: fakeRunner({ hang: { timedOut: true, exitCode: null } }) },
  );
  assert.equal(report.ok, false);
  assert.equal(failures(report)[0]?.status, 'timedOut');
});

test('summarize distinguishes timed out from failed', async () => {
  const report = await runChecks(
    { test: 'hang', lint: 'bad', typecheck: 'good', build: '' },
    {
      runCommand: fakeRunner({
        hang: { timedOut: true, exitCode: null },
        bad: { exitCode: 1 },
        good: { exitCode: 0 },
      }),
    },
  );
  const text = summarize(report);
  assert.match(text, /typecheck passed/);
  assert.match(text, /lint failed/);
  assert.match(text, /test timed out/);
  assert.doesNotMatch(text, /build/); // skipped checks are omitted
});

// ---------------------------------------------------------------------------
// Real subprocess behavior (no mocks) — proves spawn/kill actually work
// ---------------------------------------------------------------------------

test('really executes a command and captures a non-zero exit', async () => {
  const result = await runCheck('test', `"${process.execPath}" -e "process.exit(3)"`, {
    timeoutSeconds: 30,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
});

/**
 * Write a throwaway script and return a command that runs it. Avoids nested
 * shell quoting, which differs between cmd.exe and sh.
 */
function scriptCommand(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, body, 'utf8');
  return `"${process.execPath}" "${file}"`;
}

test('really captures stdout and stderr together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-run-'));
  try {
    const command = scriptCommand(
      dir,
      'both.mjs',
      'console.log("to-stdout"); console.error("to-stderr");',
    );
    const result = await runCheck('test', command, { timeoutSeconds: 30 });

    assert.equal(result.status, 'passed');
    assert.match(result.output, /to-stdout/);
    assert.match(result.output, /to-stderr/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('really kills a hanging command and reports timedOut without hanging', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-run-'));
  try {
    // A process that never exits on its own, under a shell — the exact shape
    // that used to leave a grandchild holding the pipes open forever.
    const command = scriptCommand(dir, 'hang.mjs', 'setInterval(() => {}, 100);');

    const started = Date.now();
    const result = await runCheck('test', command, { timeoutSeconds: 1 });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 'timedOut');
    assert.match(result.output, /exceeded/i);
    assert.ok(elapsed < 15000, `must not hang; took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout still resolves even if output keeps streaming', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-run-'));
  try {
    // Chatty and immortal: guards against the grace-period path regressing.
    const command = scriptCommand(
      dir,
      'chatty.mjs',
      'setInterval(() => console.log("still going"), 20);',
    );

    const started = Date.now();
    const result = await runCheck('test', command, { timeoutSeconds: 1 });
    const elapsed = Date.now() - started;

    assert.equal(result.status, 'timedOut');
    assert.ok(elapsed < 15000, `must not hang; took ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a command that cannot start is a failure, not a crash', async () => {
  const result = await runCheck('test', 'this-command-does-not-exist-shoot-probe', {
    timeoutSeconds: 30,
  });
  assert.notEqual(result.status, 'passed');
  assert.ok(result.output.length > 0, 'should capture some diagnostic output');
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

test('oversized output is truncated but keeps the tail', () => {
  const text = `${'a'.repeat(MAX_OUTPUT_CHARS + 500)}TAIL_MARKER`;
  const out = truncateOutput(text);
  assert.ok(out.length < text.length);
  assert.match(out, /TAIL_MARKER/);
  assert.match(out, /truncated/);
});

test('normal-sized output is left untouched', () => {
  assert.equal(truncateOutput('short output'), 'short output');
});

// ---------------------------------------------------------------------------
// Failure fingerprint (consumed by the circuit breaker)
// ---------------------------------------------------------------------------

test('the same failure yields a stable fingerprint across runs', async () => {
  const checks: Checks = { test: 'bad', lint: '', typecheck: '', build: '' };
  const a = await runChecks(checks, {
    runCommand: fakeRunner({ bad: { exitCode: 1, output: 'run 1 at 10:00' } }),
  });
  const b = await runChecks(checks, {
    runCommand: fakeRunner({ bad: { exitCode: 1, output: 'run 2 at 10:05 different text' } }),
  });

  assert.equal(failureFingerprint(a), failureFingerprint(b));
  assert.notEqual(failureFingerprint(a), '');
});

test('a different failing check yields a different fingerprint', async () => {
  const testFails = await runChecks(
    { test: 'bad', lint: '', typecheck: '', build: '' },
    { runCommand: fakeRunner({ bad: { exitCode: 1 } }) },
  );
  const lintFails = await runChecks(
    { test: '', lint: 'bad', typecheck: '', build: '' },
    { runCommand: fakeRunner({ bad: { exitCode: 1 } }) },
  );
  assert.notEqual(failureFingerprint(testFails), failureFingerprint(lintFails));
});

test('a passing report has an empty fingerprint', async () => {
  const report = await runChecks(
    { test: 'good', lint: '', typecheck: '', build: '' },
    { runCommand: fakeRunner({ good: { exitCode: 0 } }) },
  );
  assert.equal(failureFingerprint(report), '');
});
