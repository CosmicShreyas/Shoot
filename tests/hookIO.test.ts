import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildBlockReason,
  emit as emitResponse,
  evaluate as evaluateRaw,
  parseHookInput,
  type HookInput,
} from '../src/core/hookIO.js';
import { DEFAULT_CONFIG, saveConfig, type ShootConfig } from '../src/core/config.js';
import { saveTrustedConfig } from './helpers.js';
import { peek } from '../src/core/circuitBreaker.js';
import type { VerificationReport } from '../src/core/verificationRunner.js';
import type { DecideOptions } from '../src/core/decide.js';
import type { AdapterResponse } from '../src/adapters/types.js';
import * as messages from '../src/mascot/messages.js';

/**
 * Shim over the post-adapter-refactor `evaluate`, which returns
 * `{ decision, response }` instead of a flat object.
 *
 * These assertions all target the Claude Code wire format, which is what the
 * adapter still emits — so the tests stay meaningful. This just re-derives the
 * older shape (parsed stdout JSON + terminal line) so ~40 existing assertions
 * keep testing behavior rather than being rewritten mechanically.
 */
interface LegacyDecision {
  output: { decision?: 'block'; reason?: string; systemMessage?: string };
  terminalMessage: string;
  exitCode: number;
  claim: { claimed: boolean; matches: { id: string; text: string }[] };
  report?: VerificationReport;
}

async function evaluate(
  input: HookInput,
  config: ShootConfig,
  options: DecideOptions = {},
): Promise<LegacyDecision> {
  // These tests predate config-trust and exercise the decision pipeline itself,
  // so default to "trusted" rather than making every one of them write a trust
  // record. The guard has dedicated coverage in trust.test.ts.
  const withTrust: DecideOptions = {
    checkTrust: () => ({
      status: 'trusted',
      currentHash: 'test',
      trustedHash: 'test',
      changes: [],
    }),
    ...options,
  };
  const { decision, response } = await evaluateRaw(input, config, withTrust);
  return {
    output: response.stdout === '' ? {} : JSON.parse(response.stdout),
    terminalMessage: response.stderr.replace(/\n$/, ''),
    exitCode: response.exitCode,
    claim: decision.claim,
    ...(decision.report !== undefined ? { report: decision.report } : {}),
  };
}

/** emit() now takes an AdapterResponse; adapt the old call shape. */
function emit(
  legacy: { output: Record<string, unknown>; terminalMessage: string; [k: string]: unknown },
  stdout: { write(s: string): unknown },
  stderr: { write(s: string): unknown },
): void {
  const hasOutput = Object.keys(legacy.output).length > 0;
  const response: AdapterResponse = {
    stdout: hasOutput ? `${JSON.stringify(legacy.output)}\n` : '',
    stderr: legacy.terminalMessage === '' ? '' : `${legacy.terminalMessage}\n`,
    exitCode: 0,
  };
  emitResponse(response, stdout, stderr);
}

/** Path to the compiled CLI, for true end-to-end runs over stdin. */
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-hook-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Async variant — the sync one would delete the dir before the promise settles. */
async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-hook-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the real CLI hook with a JSON payload on stdin. */
function runHookCLI(
  payload: Record<string, unknown>,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'hook'], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    sessionId: 'sess-1',
    lastAssistantMessage: 'All tests pass.',
    cwd: process.cwd(),
    hookEventName: 'Stop',
    transcriptPath: '/tmp/transcript.jsonl',
    stopHookActive: false,
    ...overrides,
  };
}

function config(overrides: Partial<ShootConfig> = {}): ShootConfig {
  return { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks }, ...overrides };
}

/** A fake report generator, so tests never spawn real check commands. */
function fakeReport(ok: boolean, opts: { timedOut?: boolean; skipped?: boolean } = {}): VerificationReport {
  if (opts.skipped === true) {
    return {
      ok: true,
      results: [
        { name: 'test', command: '', status: 'skipped', exitCode: null, output: '', durationMs: 0 },
      ],
    };
  }
  return {
    ok,
    results: [
      {
        name: 'test',
        command: 'npm test',
        status: ok ? 'passed' : opts.timedOut === true ? 'timedOut' : 'failed',
        exitCode: ok ? 0 : 1,
        output: ok ? 'ok 12 passed' : 'FAIL src/auth.test.ts > rejects bad token',
        durationMs: 10,
      },
    ],
  };
}

const passing = async (): Promise<VerificationReport> => fakeReport(true);
const failing = async (): Promise<VerificationReport> => fakeReport(false);

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

test('parses the documented hook payload fields', () => {
  const parsed = parseHookInput(
    JSON.stringify({
      session_id: 'abc123',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'Stop',
      last_assistant_message: 'Tests pass.',
    }),
  );

  assert.equal(parsed?.sessionId, 'abc123');
  assert.equal(parsed?.lastAssistantMessage, 'Tests pass.');
  assert.equal(parsed?.cwd, '/repo');
  assert.equal(parsed?.hookEventName, 'Stop');
  assert.equal(parsed?.transcriptPath, '/tmp/t.jsonl');
});

test('malformed or non-object stdin returns null (caller allows)', () => {
  assert.equal(parseHookInput('not json'), null);
  assert.equal(parseHookInput(''), null);
  assert.equal(parseHookInput('[]'), null);
  assert.equal(parseHookInput('null'), null);
});

test('missing fields degrade to empty strings, not crashes', () => {
  const parsed = parseHookInput('{}', '/fallback');
  assert.equal(parsed?.sessionId, '');
  assert.equal(parsed?.lastAssistantMessage, '');
  assert.equal(parsed?.cwd, '/fallback');
});

test('wrongly-typed fields are ignored rather than trusted', () => {
  const parsed = parseHookInput(
    JSON.stringify({ session_id: 42, last_assistant_message: { nested: true } }),
    '/fallback',
  );
  assert.equal(parsed?.sessionId, '');
  assert.equal(parsed?.lastAssistantMessage, '');
});

// ---------------------------------------------------------------------------
// Scenario 1: no claim at all
// ---------------------------------------------------------------------------

test('no claim: allows silently with no stdout and no checks run', async () => {
  let ran = false;
  const decision = await evaluate(
    input({ lastAssistantMessage: 'I refactored the parser. Which DB should the test use?' }),
    config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
    {
      runChecks: async () => {
        ran = true;
        return fakeReport(true);
      },
    },
  );

  assert.equal(decision.exitCode, 0);
  assert.equal(decision.output.decision, undefined);
  assert.deepEqual(decision.output, {});
  assert.equal(decision.terminalMessage, '');
  assert.equal(ran, false, 'must not run checks when nothing was claimed');
});

test('no claim emits absolutely nothing on stdout', () => {
  const writes: string[] = [];
  emit(
    { output: {}, terminalMessage: '', exitCode: 0, claim: { claimed: false, matches: [] } },
    { write: (s) => writes.push(s) },
    { write: (s) => writes.push(s) },
  );
  assert.deepEqual(writes, []);
});

// ---------------------------------------------------------------------------
// Mascot voice reaches the user through the REAL channel
//
// systemMessage is the only thing a real user sees. A plain audit string there
// with the panda voice living only in a local echo means the voice never ships.
// These tests assert the exact canonical strings from messages.ts.
// ---------------------------------------------------------------------------

test('the pass receipt IS the canonical mascot line, verbatim', async () => {
  const decision = await evaluate(
    input(),
    // Drift off: this asserts the receipt EXACTLY, and the advisory appends to it.
    // (It fires for real here, because the default cwd is this repo.)
    config({
      scopeDriftWarning: false,
      checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
    }),
    { runChecks: passing },
  );

  const expected = messages.success('test passed');
  assert.equal(decision.output.systemMessage, expected);
  assert.equal(decision.output.systemMessage, '🐼 Shoot: Nice work — test passed. Cleared to grow.');
  // Same string on both channels — no divergent paraphrase.
  assert.equal(decision.terminalMessage, decision.output.systemMessage);
});

test('the stand-down systemMessage is the canonical mascot line', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({
      maxBlocksPerSession: 1,
      checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
    });
    const decision = await evaluate(input({ cwd: dir }), cfg, { runChecks: failing });

    const expected = messages.breakerTripped(1, 'test failed');
    assert.equal(decision.output.systemMessage, expected);
    assert.equal(decision.terminalMessage, expected);
    assert.match(decision.output.systemMessage ?? '', /^🐼 Shoot: /);
    assert.match(decision.output.systemMessage ?? '', /do NOT pass/);
  });
});

test('the bad-cwd systemMessage is the canonical mascot line', async () => {
  const decision = await evaluate(input({ cwd: '/nope' }), config(), {
    directoryExists: () => false,
  });

  assert.equal(decision.output.systemMessage, messages.skippedBadCwd('/nope'));
  assert.equal(decision.terminalMessage, decision.output.systemMessage);
  assert.match(decision.output.systemMessage ?? '', /^🐼 Shoot: /);
});

test('the warn-mode systemMessage is the canonical mascot line', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await evaluate(
      input({ cwd: dir }),
      config({ mode: 'warn', checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: failing },
    );

    assert.equal(decision.output.systemMessage, messages.warnOnly('test failed'));
    assert.equal(decision.terminalMessage, decision.output.systemMessage);
    assert.match(decision.output.systemMessage ?? '', /^🐼 Shoot: /);
  });
});

test('the nothing-configured systemMessage is the canonical mascot line', async () => {
  const decision = await evaluate(input(), config(), {
    runChecks: async () => fakeReport(true, { skipped: true }),
  });

  assert.equal(decision.output.systemMessage, messages.noChecksConfigured());
  assert.equal(decision.terminalMessage, decision.output.systemMessage);
});

test('every non-silent hook decision speaks in the mascot voice', async () => {
  await withTempDirAsync(async (dir) => {
    const withTest = { test: 'npm test', lint: '', typecheck: '', build: '' };
    const cases = [
      await evaluate(input({ cwd: dir }), config({ checks: withTest }), { runChecks: passing }),
      await evaluate(input({ cwd: dir, sessionId: 'a' }), config({ checks: withTest }), {
        runChecks: failing,
      }),
      await evaluate(input({ cwd: '/nope' }), config(), { directoryExists: () => false }),
      await evaluate(input({ cwd: dir }), config({ mode: 'warn', checks: withTest }), {
        runChecks: failing,
      }),
      await evaluate(input({ cwd: dir }), config(), {
        runChecks: async () => fakeReport(true, { skipped: true }),
      }),
    ];

    for (const decision of cases) {
      const shown = decision.output.systemMessage ?? decision.output.reason ?? '';
      assert.ok(shown !== '', 'a non-silent decision must say something');
      assert.match(shown, /^🐼 Shoot: /, `missing mascot voice in: ${shown.slice(0, 60)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The block reason: voiced framing, untouched diagnostics
// ---------------------------------------------------------------------------

test('the block reason opens with the canonical mascot framing line', () => {
  const claim = { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] };
  const reason = buildBlockReason(claim, fakeReport(false));

  const firstLine = reason.split('\n')[0] ?? '';
  assert.equal(firstLine, messages.blocked('tests pass'));
  assert.equal(
    firstLine,
    '🐼 Shoot: Not yet. You said "tests pass" — it isn\'t true yet. Here\'s what broke:',
  );
});

test('the block reason uses the no-quote variant when there is nothing to quote', () => {
  const reason = buildBlockReason({ claimed: true, matches: [] }, fakeReport(false));
  assert.equal(reason.split('\n')[0], messages.blockedNoQuote());
});

test('the block diagnostics stay plain — no personality in the data', () => {
  const claim = { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] };
  const reason = buildBlockReason(claim, fakeReport(false));

  // Exactly one voiced line: the framing. Everything after is raw.
  const voicedLines = reason.split('\n').filter((l) => l.includes('🐼'));
  assert.equal(voicedLines.length, 1, 'personality must not leak into diagnostics');

  const body = reason.split('\n').slice(1).join('\n');
  assert.match(body, /FAIL src\/auth\.test\.ts/, 'real output, verbatim');
  assert.match(body, /npm test/, 'real command');
  assert.match(body, /exit code 1/, 'real exit code');
  assert.doesNotMatch(body, /🐼/);
});

test('the terminal echo of a block matches the reason first line', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await evaluate(
      input({ cwd: dir }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: failing },
    );

    const firstLine = (decision.output.reason ?? '').split('\n')[0];
    assert.equal(decision.terminalMessage, firstLine, 'one canonical wording, both channels');
  });
});

test('E2E: the mascot voice actually reaches stdout as systemMessage', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    const { stdout } = runHookCLI({
      session_id: 'e2e-voice',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    });

    const parsed = JSON.parse(stdout) as { systemMessage?: string };
    assert.equal(parsed.systemMessage, '🐼 Shoot: Nice work — test passed. Cleared to grow.');
  });
});

// ---------------------------------------------------------------------------
// stop_hook_active: the infinite-loop guard
// ---------------------------------------------------------------------------

test('parses stop_hook_active from the payload', () => {
  assert.equal(
    parseHookInput(JSON.stringify({ stop_hook_active: true }))?.stopHookActive,
    true,
  );
  assert.equal(
    parseHookInput(JSON.stringify({ stop_hook_active: false }))?.stopHookActive,
    false,
  );
  // Absent or non-boolean means "not in a continuation".
  assert.equal(parseHookInput('{}')?.stopHookActive, false);
  assert.equal(
    parseHookInput(JSON.stringify({ stop_hook_active: 'yes' }))?.stopHookActive,
    false,
  );
});

test('stop_hook_active: true short-circuits to a silent allow', async () => {
  let ran = false;
  const decision = await evaluate(
    input({ stopHookActive: true, lastAssistantMessage: 'All tests pass, everything is fixed!' }),
    config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
    {
      runChecks: async () => {
        ran = true;
        return fakeReport(false);
      },
    },
  );

  assert.equal(ran, false, 'verification must not run during a forced continuation');
  assert.equal(decision.exitCode, 0);
  assert.deepEqual(decision.output, {}, 'no stdout at all — a true silent exit 0');
  assert.equal(decision.terminalMessage, '');
  assert.equal(decision.claim.claimed, false, 'claim detection is skipped entirely');
});

test('stop_hook_active wins regardless of claim content or config', async () => {
  const turnMessages = [
    'All tests pass.',
    'Fixed it, done.',
    'Just looking at the parser.',
    '',
  ];
  const modes = ['block', 'warn'] as const;

  for (const message of turnMessages) {
    for (const mode of modes) {
      let ran = false;
      const decision = await evaluate(
        input({ stopHookActive: true, lastAssistantMessage: message }),
        config({ mode, checks: { test: 'npm test', lint: 'npm run lint', typecheck: '', build: '' } }),
        {
          runChecks: async () => {
            ran = true;
            return fakeReport(false);
          },
        },
      );

      assert.equal(ran, false, `must not verify (message=${JSON.stringify(message)}, mode=${mode})`);
      assert.deepEqual(decision.output, {}, 'must stay silent');
    }
  }
});

test('stop_hook_active is checked before the cwd guard', async () => {
  // Even a bad cwd must not produce output while in a continuation.
  const decision = await evaluate(
    input({ stopHookActive: true, cwd: '/nope' }),
    config(),
    { directoryExists: () => false },
  );
  assert.deepEqual(decision.output, {}, 'no systemMessage either — fully silent');
});

test('stop_hook_active: true never blocks, even on failing checks', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await evaluate(
      input({ stopHookActive: true, cwd: dir }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: failing },
    );
    assert.equal(decision.output.decision, undefined, 'must not block during continuation');
  });
});

test('E2E: stop_hook_active: true produces literally no stdout', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const { stdout, status } = runHookCLI({
      session_id: 'e2e-active',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
      stop_hook_active: true,
    });

    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'a continuation must produce no output whatsoever');
  });
});

// ---------------------------------------------------------------------------
// The live loop, reproduced: it must terminate
// ---------------------------------------------------------------------------

test('the exact live sequence: pass -> receipt -> no continuation field', async () => {
  const decision = await evaluate(
    input({ lastAssistantMessage: 'Fixed the bug — the test passes now.' }),
    config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
    { runChecks: passing },
  );

  // What went wrong live: a correct fix produced additionalContext, which
  // continued the turn, so Claude restated the claim and the cycle repeated
  // nine times until Claude Code's internal cap force-ended it.
  assert.equal(decision.claim.claimed, true, 'the claim IS detected');
  assert.equal(decision.output.decision, undefined, 'and allowed, because checks pass');
  assert.match(decision.output.systemMessage ?? '', /Cleared to grow/);
  assert.doesNotMatch(
    JSON.stringify(decision.output),
    /additionalContext/,
    'the field that caused the live loop must be absent',
  );
});

test('a loop cannot occur: only the first call in a turn verifies', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } });
    const message = 'All tests pass — the fix works.';

    let verificationRuns = 0;
    const counting = async (): Promise<VerificationReport> => {
      verificationRuns++;
      return fakeReport(true);
    };

    const outputs: string[] = [];

    // Five hook events within one simulated turn: the first is a genuine stop,
    // every subsequent one carries stop_hook_active because a hook continued it.
    for (let i = 0; i < 5; i++) {
      const decision = await evaluate(
        input({ cwd: dir, lastAssistantMessage: message, stopHookActive: i > 0 }),
        cfg,
        { runChecks: counting },
      );
      outputs.push(JSON.stringify(decision.output));
    }

    assert.equal(verificationRuns, 1, 'verification must run exactly once per turn');

    // The first call reports its receipt; the rest are completely silent.
    assert.match(outputs[0] ?? '', /Cleared to grow/);
    for (let i = 1; i < 5; i++) {
      assert.equal(outputs[i], '{}', `call ${i + 1} must be silent`);
    }

    // And nothing in the whole turn ever continues the conversation.
    assert.doesNotMatch(outputs.join(''), /additionalContext/);
  });
});

test('a loop cannot occur across real processes either', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    const payload = {
      session_id: 'e2e-loop',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    };

    const first = runHookCLI({ ...payload, stop_hook_active: false });
    const rest = [1, 2, 3, 4].map(() => runHookCLI({ ...payload, stop_hook_active: true }));

    assert.match(first.stdout, /Cleared to grow/, 'first call reports its receipt');
    assert.doesNotMatch(first.stdout, /additionalContext/);
    for (const r of rest) {
      assert.equal(r.stdout.trim(), '', 'continuations stay silent');
    }
  });
});

// ---------------------------------------------------------------------------
// Unresolvable cwd: allow, but say verification was SKIPPED (not "passed")
// ---------------------------------------------------------------------------

test('an unresolvable cwd allows the stop but warns via systemMessage', async () => {
  let ran = false;
  const decision = await evaluate(
    input({ cwd: '/definitely/not/a/real/directory', lastAssistantMessage: 'All tests pass.' }),
    config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
    {
      directoryExists: () => false,
      runChecks: async () => {
        ran = true;
        return fakeReport(true);
      },
    },
  );

  // Fail-open policy stands.
  assert.equal(decision.exitCode, 0);
  assert.equal(decision.output.decision, undefined, 'must not block');

  // But the user must be told nothing was verified.
  const sys = decision.output.systemMessage ?? '';
  assert.match(sys, /skipped verification/i);
  assert.match(sys, /Nothing was verified/i);
  assert.match(sys, /definitely\/not\/a\/real\/directory/);

  // And it must NOT masquerade as a pass or a "nothing configured" result.
  assert.doesNotMatch(JSON.stringify(decision.output), /additionalContext/);
  assert.doesNotMatch(sys, /No checks configured/i);
  assert.equal(ran, false, 'must not attempt to run checks in a bad directory');
});

test('the bad-cwd warning is also surfaced in the terminal', async () => {
  const decision = await evaluate(input({ cwd: '/nope' }), config(), {
    directoryExists: () => false,
  });
  assert.match(decision.terminalMessage, /couldn't find the project directory/i);
  assert.match(decision.terminalMessage, /unchecked/i);
});

test('a systemMessage-only decision still emits stdout JSON', () => {
  const writes: string[] = [];
  emit(
    {
      output: { systemMessage: 'skipped' },
      terminalMessage: '',
      exitCode: 0,
      claim: { claimed: true, matches: [] },
    },
    { write: (s) => writes.push(s) },
    { write: () => undefined },
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0] ?? '{}'), { systemMessage: 'skipped' });
});

test('E2E: a nonexistent cwd in the payload warns rather than silently passing', () => {
  const { stdout, status } = runHookCLI({
    session_id: 'e2e-badcwd',
    cwd: join(tmpdir(), 'shoot-does-not-exist-at-all-12345'),
    hook_event_name: 'Stop',
    last_assistant_message: 'All tests pass.',
  });

  assert.equal(status, 0);
  const parsed = JSON.parse(stdout) as { systemMessage?: string; decision?: string };
  assert.equal(parsed.decision, undefined);
  assert.match(parsed.systemMessage ?? '', /skipped verification/i);
});

// ---------------------------------------------------------------------------
// Scenario 2: claim + passing checks
// ---------------------------------------------------------------------------

test('claim with passing checks: allows with a systemMessage receipt', async () => {
  const decision = await evaluate(input(), config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }), {
    runChecks: passing,
  });

  assert.equal(decision.exitCode, 0);
  assert.equal(decision.output.decision, undefined, 'must NOT block');
  assert.match(decision.output.systemMessage ?? '', /Cleared to grow/);
  assert.match(decision.output.systemMessage ?? '', /test passed/);
  assert.match(decision.terminalMessage, /Cleared to grow/);
});

test('the pass receipt never uses additionalContext (that field loops the turn)', async () => {
  const decision = await evaluate(input(), config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }), {
    runChecks: passing,
  });

  // This is the exact live failure: additionalContext on Stop continues the
  // conversation, so a passing claim re-triggered the detector forever.
  const raw = JSON.stringify(decision.output);
  assert.doesNotMatch(raw, /additionalContext/, 'must not continue the turn on a pass');
  assert.doesNotMatch(raw, /hookSpecificOutput/);
  assert.ok(decision.output.systemMessage !== undefined, 'but should still report what it checked');
});

test('passing checks clear any accumulated breaker state', async () => {
  await withTempDirAsync(async (dir) => {
    // Accumulate two blocks first.
    const cfg = config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } });
    await evaluate(input({ cwd: dir }), cfg, { runChecks: failing });
    await evaluate(input({ cwd: dir }), cfg, { runChecks: failing });
    assert.equal(peek(dir, 'sess-1')?.consecutiveBlocks, 2);

    // Now pass.
    await evaluate(input({ cwd: dir }), cfg, { runChecks: passing });
    assert.equal(peek(dir, 'sess-1'), null, 'breaker state should be cleared on success');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: claim + failing checks
// ---------------------------------------------------------------------------

test('claim with failing checks: blocks with the real error output in the reason', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await evaluate(
      input({ cwd: dir }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: failing },
    );

    assert.equal(decision.output.decision, 'block');
    assert.equal(decision.exitCode, 0, 'JSON block form uses exit 0');

    const reason = decision.output.reason ?? '';
    assert.match(reason, /FAIL src\/auth\.test\.ts/, 'real output must reach the agent');
    assert.match(reason, /npm test/, 'the command should be named');
    assert.match(reason, /exit code 1/);
    assert.match(reason, /tests pass/i, 'should quote the claim back');
  });
});

test('a timed-out check says so, rather than merely "failed"', () => {
  const reason = buildBlockReason(
    { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] },
    fakeReport(false, { timedOut: true }),
  );
  assert.match(reason, /timed out/i);
});

test('warn mode never blocks, even when checks fail', async () => {
  await withTempDirAsync(async (dir) => {
    const decision = await evaluate(
      input({ cwd: dir }),
      config({ mode: 'warn', checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: failing },
    );

    assert.equal(decision.output.decision, undefined, 'warn mode must not block');
    assert.equal(decision.exitCode, 0);
    assert.match(decision.terminalMessage, /not blocking/i);
  });
});

test('a claim with nothing configured allows, with a note', async () => {
  const decision = await evaluate(input(), config(), {
    runChecks: async () => fakeReport(true, { skipped: true }),
  });
  assert.equal(decision.output.decision, undefined);
  assert.match(decision.terminalMessage, /No checks configured/i);
});

// ---------------------------------------------------------------------------
// Scenario 4: the 3rd-block circuit breaker transition
// ---------------------------------------------------------------------------

test('blocks twice, then stands down on the 3rd with a loud warning', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({
      maxBlocksPerSession: 3,
      checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
    });
    const payload = input({ cwd: dir });

    const first = await evaluate(payload, cfg, { runChecks: failing });
    const second = await evaluate(payload, cfg, { runChecks: failing });
    const third = await evaluate(payload, cfg, { runChecks: failing });

    assert.equal(first.output.decision, 'block', 'block 1');
    assert.equal(second.output.decision, 'block', 'block 2');
    assert.equal(third.output.decision, undefined, 'block 3 must stand down, not block');

    assert.match(third.terminalMessage, /three times|3 times/i);
    assert.match(third.terminalMessage, /human should look/i);
    // The agent must still be told the checks did NOT pass.
    assert.match(third.output.systemMessage ?? '', /do NOT pass/);
    // Standing down must let the turn END, so no continuation field.
    assert.doesNotMatch(JSON.stringify(third.output), /additionalContext/);
  });
});

test('the stand-down uses maxBlocksPerSession, not a hardcoded 3', async () => {
  await withTempDirAsync(async (dir) => {
    const cfg = config({
      maxBlocksPerSession: 2,
      checks: { test: 'npm test', lint: '', typecheck: '', build: '' },
    });
    const payload = input({ cwd: dir, sessionId: 'limit-2' });

    const first = await evaluate(payload, cfg, { runChecks: failing });
    const second = await evaluate(payload, cfg, { runChecks: failing });

    assert.equal(first.output.decision, 'block');
    assert.equal(second.output.decision, undefined, 'should stand down on the 2nd');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the real CLI, over real stdin/stdout
// ---------------------------------------------------------------------------

test('E2E: real CLI allows a non-claim turn with empty stdout', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const { stdout, status } = runHookCLI({
      session_id: 'e2e-noclaim',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'Looking into the failing auth test now.',
    });

    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'no claim means no output at all');
  });
});

test('E2E: real CLI blocks a false claim, running a real failing command', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const { stdout, status } = runHookCLI({
      session_id: 'e2e-block',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass, everything is working now.',
    });

    assert.equal(status, 0);
    const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, 'block');
    assert.match(parsed.reason ?? '', /exit code 1/);
  });
});

test('E2E: real CLI allows a true claim, running a real passing command', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    const { stdout, status } = runHookCLI({
      session_id: 'e2e-pass',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    });

    assert.equal(status, 0);
    const parsed = JSON.parse(stdout) as { decision?: string; systemMessage?: string };
    assert.equal(parsed.decision, undefined, 'must not block when checks pass');
    assert.match(parsed.systemMessage ?? '', /Cleared to grow/);
    assert.doesNotMatch(stdout, /additionalContext/);
  });
});

test('E2E: garbage stdin allows the stop instead of crashing the session', () => {
  const { status, stdout } = (() => {
    try {
      const out = execFileSync(process.execPath, [CLI, 'hook'], {
        input: 'this is not json at all',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 0, stdout: out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      return { status: e.status ?? 1, stdout: e.stdout ?? '' };
    }
  })();

  assert.equal(status, 0, 'must allow, never fail the session');
  assert.equal(stdout.trim(), '');
});

test('E2E: SubagentStop is skipped when verifySubagents is false', () => {
  withTempDir((dir) => {
    saveTrustedConfig(
      dir,
      config({ verifySubagents: false, checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }),
    );

    const { stdout, status } = runHookCLI({
      session_id: 'e2e-subagent-off',
      cwd: dir,
      hook_event_name: 'SubagentStop',
      last_assistant_message: 'All tests pass.',
    });

    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', 'opted out, so no verification');
  });
});

test('E2E: SubagentStop IS verified by default', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const { stdout } = runHookCLI({
      session_id: 'e2e-subagent-on',
      cwd: dir,
      hook_event_name: 'SubagentStop',
      last_assistant_message: 'Fixed it, tests pass.',
    });

    const parsed = JSON.parse(stdout) as { decision?: string };
    assert.equal(parsed.decision, 'block');
  });
});

test('E2E: breaker state persists across separate CLI processes', () => {
  withTempDir((dir) => {
    saveTrustedConfig(
      dir,
      config({
        maxBlocksPerSession: 3,
        checks: { test: 'exit 1', lint: '', typecheck: '', build: '' },
      }),
    );

    const payload = {
      session_id: 'e2e-breaker',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    };

    // Three genuinely separate processes, as real hook invocations would be.
    const decisions = [1, 2, 3].map(() => {
      const { stdout } = runHookCLI(payload);
      return (JSON.parse(stdout) as { decision?: string }).decision;
    });

    assert.deepEqual(
      decisions,
      ['block', 'block', undefined],
      'third separate process must stand down',
    );
  });
});
