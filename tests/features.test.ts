import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnose, MIN_NODE_MAJOR } from '../src/commands/doctor.js';
import {
  HISTORY_FILENAME,
  appendHistory,
  historyPath,
  readHistory,
  summarizeHistory,
  trimHistory,
} from '../src/core/history.js';
import { describeDrift, detectScopeDrift } from '../src/core/scopeDrift.js';
import { DEFAULT_CONFIG, saveConfig, type ShootConfig } from '../src/core/config.js';
import { saveTrustedConfig } from './helpers.js';
import { writeTrust } from '../src/core/trust.js';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { resolveHookEntry, SHIM_RELATIVE_PATH } from '../src/core/shim.js';
import { decide } from '../src/core/decide.js';
import type { HookInput } from '../src/adapters/types.js';
import type { VerificationReport } from '../src/core/verificationRunner.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-feat-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-feat-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function config(overrides: Partial<ShootConfig> = {}): ShootConfig {
  return { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks }, ...overrides };
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    sessionId: 's1',
    lastAssistantMessage: 'All tests pass.',
    cwd: process.cwd(),
    hookEventName: 'Stop',
    transcriptPath: '',
    stopHookActive: false,
    ...overrides,
  };
}

function fakeReport(ok: boolean): VerificationReport {
  return {
    ok,
    results: [
      {
        name: 'test',
        command: 'npm test',
        status: ok ? 'passed' : 'failed',
        exitCode: ok ? 0 : 1,
        output: ok ? 'ok' : 'FAIL something',
        durationMs: 5,
      },
    ],
  };
}

function runCLI(args: string[], cwd: string): { stdout: string; status: number } {
  try {
    return {
      stdout: execFileSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        input: '',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      status: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

// ===========================================================================
// shoot doctor
// ===========================================================================

test('doctor: reports a missing config as a failure with a fix', () => {
  withTempDir((dir) => {
    const results = diagnose(dir);
    const cfg = results.find((r) => r.name === 'Config file');

    assert.equal(cfg?.status, 'fail');
    assert.match(cfg?.fix ?? '', /shoot init/);
  });
});

test('doctor: stops early when there is no config to reason about', () => {
  withTempDir((dir) => {
    const names = diagnose(dir).map((r) => r.name);
    assert.ok(!names.includes('Checks configured'), 'should not check config-dependent things');
  });
});

test('doctor: passes the Node version check on a supported runtime', () => {
  withTempDir((dir) => {
    const node = diagnose(dir).find((r) => r.name === 'Node version');
    // The test suite itself can only run on a supported Node.
    assert.equal(node?.status, 'pass');
    assert.ok(Number.parseInt(process.versions.node, 10) >= MIN_NODE_MAJOR);
  });
});

test('doctor: catches a configured command with no matching package.json script', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
      'utf8',
    );
    saveTrustedConfig(
      dir,
      config({ checks: { test: 'npm test', lint: 'npm run lint', typecheck: '', build: '' } }),
    );

    const results = diagnose(dir);
    const lint = results.find((r) => r.name === 'lint command');
    const testCheck = results.find((r) => r.name === 'test command');

    assert.equal(testCheck?.status, 'pass', 'test script exists');
    assert.equal(lint?.status, 'fail', 'lint script does not');
    assert.match(lint?.detail ?? '', /no "lint" script/);
    assert.match(lint?.fix ?? '', /Add a "lint" script/);
  });
});

test('doctor: does not second-guess free-form shell commands', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');
    saveTrustedConfig(
      dir,
      config({ checks: { test: 'cargo test --all', lint: '', typecheck: '', build: '' } }),
    );

    const results = diagnose(dir);
    assert.equal(
      results.find((r) => r.name === 'test command'),
      undefined,
      'only npm script invocations are validated',
    );
  });
});

test('doctor: catches a registered hook whose script is gone', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));
    claudeCodeAdapter.install(dir, {
      hookEntryPath: resolveHookEntry(),
      verifySubagents: false,
    });

    // Simulate the shim being moved or deleted after install.
    rmSync(join(dir, SHIM_RELATIVE_PATH), { force: true });

    const hook = diagnose(dir).find((r) => r.name.startsWith('Hook:'));
    assert.equal(hook?.status, 'fail');
    assert.match(hook?.detail ?? '', /script is missing/);
    assert.match(hook?.fix ?? '', /shoot init/);
  });
});

test('doctor: reports a healthy install as all-pass', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }), 'utf8');
    saveTrustedConfig(dir, config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }));
    claudeCodeAdapter.install(dir, { hookEntryPath: resolveHookEntry(), verifySubagents: true });

    const results = diagnose(dir);
    assert.equal(results.filter((r) => r.status === 'fail').length, 0);
    assert.ok(results.some((r) => r.name === 'Hook: Stop' && r.status === 'pass'));
  });
});

test('doctor: warns when nothing is configured to verify', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config());
    const checks = diagnose(dir).find((r) => r.name === 'Checks configured');
    assert.equal(checks?.status, 'warn');
    assert.match(checks?.detail ?? '', /nothing to verify/);
  });
});

test('doctor: warns when config platform disagrees with the filesystem', () => {
  withTempDir((dir) => {
    // Config says codex, but only .claude/ exists.
    mkdirSync(join(dir, '.claude'), { recursive: true });
    saveTrustedConfig(dir, config({ platform: 'codex' }));

    const platform = diagnose(dir).find((r) => r.name === 'Platform');
    assert.equal(platform?.status, 'warn');
    assert.match(platform?.detail ?? '', /Claude Code/);
  });
});

test('CLI: doctor exits 1 on failures, 0 when healthy', () => {
  withTempDir((dir) => {
    assert.equal(runCLI(['doctor'], dir).status, 1, 'no config = failure');

    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }), 'utf8');
    saveTrustedConfig(dir, config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }));
    claudeCodeAdapter.install(dir, { hookEntryPath: resolveHookEntry(), verifySubagents: true });

    const healthy = runCLI(['doctor'], dir);
    assert.equal(healthy.status, 0);
    assert.match(healthy.stdout, /healthy/i);
  });
});

// ===========================================================================
// Verification history + shoot stats
// ===========================================================================

test('history: appends one JSON object per line under .shoot/', () => {
  withTempDir((dir) => {
    appendHistory(dir, { outcome: 'passed', sessionId: 's1', checks: ['test'] });
    appendHistory(dir, { outcome: 'blocked', sessionId: 's1', checks: ['test'] });

    assert.match(historyPath(dir), /[\\/]\.shoot[\\/]history\.jsonl$/);
    const lines = readFileSync(historyPath(dir), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
  });
});

test('history: every entry gets a timestamp', () => {
  withTempDir((dir) => {
    appendHistory(dir, { outcome: 'passed', sessionId: 's1', checks: [] });
    const entry = readHistory(dir)[0];
    assert.ok(entry?.at !== undefined);
    assert.doesNotThrow(() => new Date(entry?.at ?? '').toISOString());
  });
});

test('history: malformed lines are skipped, not fatal', () => {
  withTempDir((dir) => {
    appendHistory(dir, { outcome: 'passed', sessionId: 's1', checks: [] });
    // Simulate a half-written line from a killed process.
    writeFileSync(historyPath(dir), `${readFileSync(historyPath(dir), 'utf8')}{"broken\n`, 'utf8');
    appendHistory(dir, { outcome: 'blocked', sessionId: 's1', checks: [] });

    const entries = readHistory(dir);
    assert.equal(entries.length, 2, 'the two valid lines survive');
  });
});

test('history: reading a nonexistent file returns empty', () => {
  withTempDir((dir) => {
    assert.deepEqual(readHistory(dir), []);
  });
});

test('stats: counts outcomes and computes pass rate over verified claims only', () => {
  const stats = summarizeHistory([
    { at: '2026-01-01T00:00:00Z', outcome: 'passed', sessionId: 'a', checks: ['test'] },
    { at: '2026-01-02T00:00:00Z', outcome: 'blocked', sessionId: 'a', checks: ['test'] },
    { at: '2026-01-03T00:00:00Z', outcome: 'blocked', sessionId: 'b', checks: ['test'] },
    { at: '2026-01-04T00:00:00Z', outcome: 'skipped', sessionId: 'b', checks: [] },
  ]);

  assert.equal(stats.total, 4);
  assert.equal(stats.passed, 1);
  assert.equal(stats.blocked, 2);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.caught, 2);
  assert.equal(stats.sessions, 2);
  // 1 passed of 3 verified — the "skipped" entry had nothing to check, so
  // counting it either way would misrepresent the rate.
  assert.ok(stats.passRate !== null);
  assert.ok(Math.abs((stats.passRate ?? 0) - 1 / 3) < 1e-9);
});

test('stats: pass rate is null when nothing was ever verified', () => {
  const stats = summarizeHistory([
    { at: '2026-01-01T00:00:00Z', outcome: 'skipped', sessionId: 'a', checks: [] },
  ]);
  assert.equal(stats.passRate, null);
});

test('stats: counts warned and stoodDown as caught', () => {
  const stats = summarizeHistory([
    { at: '2026-01-01T00:00:00Z', outcome: 'warned', sessionId: 'a', checks: ['test'] },
    { at: '2026-01-02T00:00:00Z', outcome: 'stoodDown', sessionId: 'a', checks: ['test'] },
  ]);
  assert.equal(stats.caught, 2, 'neither was backed by passing checks');
  assert.equal(stats.passed, 0);
});

test('stats: an empty history summarizes to zeroes without throwing', () => {
  const stats = summarizeHistory([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.passRate, null);
  assert.equal(stats.firstAt, null);
});

test('history: trims to a cap so the file cannot grow without bound', () => {
  withTempDir((dir) => {
    for (let i = 0; i < 20; i++) {
      appendHistory(dir, { outcome: 'passed', sessionId: `s${i}`, checks: [] });
    }
    const removed = trimHistory(dir, 5);
    assert.equal(removed, 15);

    const kept = readHistory(dir);
    assert.equal(kept.length, 5);
    // Newest are kept, not oldest.
    assert.equal(kept[kept.length - 1]?.sessionId, 's19');
  });
});

test('the pipeline records history for each outcome', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } });
    // Approve the commands, or the trust guard skips verification and every
    // outcome is 'untrusted' instead of the pass/block this is checking.
    writeTrust(dir, cfg.checks);

    await decide(input({ cwd: dir }), cfg, { runChecks: async () => fakeReport(true) });
    await decide(input({ cwd: dir, sessionId: 's2' }), cfg, {
      runChecks: async () => fakeReport(false),
    });

    const outcomes = readHistory(dir).map((e) => e.outcome);
    assert.deepEqual(outcomes, ['passed', 'blocked']);
  });
});

test('history records the claim phrase that triggered verification', async () => {
  await withTempDirAsync(async (dir) => {
    await decide(
      input({ cwd: dir, lastAssistantMessage: 'Fixed it, all tests pass.' }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: async () => fakeReport(true) },
    );
    const entry = readHistory(dir)[0];
    assert.ok(entry?.claim !== undefined, 'the quoted claim is worth keeping');
  });
});

test('no history is written for a turn with no claim', async () => {
  await withTempDirAsync(async (dir) => {
    await decide(
      input({ cwd: dir, lastAssistantMessage: 'Still reading the config loader.' }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: async () => fakeReport(true) },
    );
    assert.equal(existsSync(historyPath(dir)), false, 'quiet turns leave no trace');
  });
});

test('CLI: stats says so when there is no history', () => {
  withTempDir((dir) => {
    const r = runCLI(['stats'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No history yet/i);
  });
});

test('CLI: stats reports real counts from a real history file', () => {
  withTempDir((dir) => {
    appendHistory(dir, { outcome: 'passed', sessionId: 'a', checks: ['test'] });
    appendHistory(dir, { outcome: 'blocked', sessionId: 'a', checks: ['test'] });
    appendHistory(dir, { outcome: 'blocked', sessionId: 'b', checks: ['test'] });

    const r = runCLI(['stats'], dir);
    assert.equal(r.status, 0);

    // The dashboard header carries the totals; the breakdown carries per-outcome
    // counts. Both must reflect the real file.
    assert.match(r.stdout, /total\s+3/);
    assert.match(r.stdout, /passed\s+█+\s+1/, 'breakdown row for passed');
    assert.match(r.stdout, /blocked\s+█+\s+2/, 'breakdown row for blocked');
    assert.match(r.stdout, /pass rate\s+33%/, '1 of 3 verified');
    assert.match(r.stdout, /Caught 2 completion claims/);
  });
});

test('history filename is stable', () => {
  assert.equal(HISTORY_FILENAME, 'history.jsonl');
});

// ===========================================================================
// Scope drift — advisory only
// ===========================================================================

test('scope drift reports unavailable outside a git repo', () => {
  withTempDir((dir) => {
    const result = detectScopeDrift(dir, config());
    assert.equal(result.available, false, 'no git = no signal');
    assert.equal(result.drifted, false);
  });
});

test('an unavailable drift result produces no message', () => {
  assert.equal(
    describeDrift({ drifted: false, fileCount: 0, areaCount: 0, sample: [], available: false }),
    '',
  );
});

test('a non-drifted result produces no message', () => {
  assert.equal(
    describeDrift({ drifted: false, fileCount: 3, areaCount: 1, sample: [], available: true }),
    '',
  );
});

test('the drift message is explicitly advisory, never a failure', () => {
  const msg = describeDrift({
    drifted: true,
    fileCount: 40,
    areaCount: 6,
    sample: ['a/x.ts'],
    available: true,
  });
  assert.match(msg, /advisory/i);
  assert.match(msg, /not a failure/i);
  assert.match(msg, /40 changed files/);
  assert.match(msg, /6 areas/);
});

test('scope drift never turns a pass into a block, even in block mode', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await decide(
      input({ cwd: dir }),
      config({
        mode: 'block',
        scopeDriftWarning: true,
        checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
      }),
      { runChecks: async () => fakeReport(true) },
    );

    assert.notEqual(decision.verdict.kind, 'block', 'drift is advisory only');
    assert.equal(decision.verdict.kind, 'allowWithNotice');
  });
});

test('scope drift can be turned off entirely', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await decide(
      input({ cwd: dir }),
      config({
        scopeDriftWarning: false,
        checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
      }),
      { runChecks: async () => fakeReport(true) },
    );

    assert.equal(decision.verdict.kind, 'allowWithNotice');
    if (decision.verdict.kind === 'allowWithNotice') {
      assert.doesNotMatch(decision.verdict.notice, /advisory/i);
    }
  });
});

test('the pass receipt still leads with the mascot line when drift is appended', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await decide(
      input({ cwd: dir }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: async () => fakeReport(true) },
    );

    assert.equal(decision.verdict.kind, 'allowWithNotice');
    if (decision.verdict.kind === 'allowWithNotice') {
      assert.match(decision.verdict.notice, /^🐼 Shoot: /);
    }
  });
});

test('drift thresholds are configurable', () => {
  const cfg = config({ scopeDriftFileThreshold: 999 });
  assert.equal(cfg.scopeDriftFileThreshold, 999);
});
