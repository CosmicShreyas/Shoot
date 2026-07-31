import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasAnsi, isAsciiOnly, toAgentText } from '../src/mascot/colors.js';
import { buildBlockReason } from '../src/core/decide.js';
import { decide } from '../src/core/decide.js';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { DEFAULT_CONFIG, type ShootConfig } from '../src/core/config.js';
import { writeTrust } from '../src/core/trust.js';
import { saveTrustedConfig } from './helpers.js';
import type { HookInput } from '../src/adapters/types.js';
import type { VerificationReport } from '../src/core/verificationRunner.js';

/**
 * THE TWO-CHANNEL RULE, enforced.
 *
 * Agent channel = the `reason` field and anything else inside stdout JSON. Must be
 * pure 7-bit ASCII: no ANSI escapes, no emoji, no Unicode decoration.
 *
 * Human channel = CLI output and `systemMessage`. Free to decorate.
 */

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-chan-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-chan-'));
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

function failingReport(output = 'FAIL src/a.test.ts'): VerificationReport {
  return {
    ok: false,
    results: [
      {
        name: 'test',
        command: 'npm test',
        status: 'failed',
        exitCode: 1,
        output,
        durationMs: 5,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// toAgentText — the single enforcement point
// ---------------------------------------------------------------------------

test('toAgentText strips ANSI escapes', () => {
  const out = toAgentText('[32m[1mgreen bold[0m[0m');
  assert.equal(out, 'green bold');
  assert.equal(hasAnsi(out), false);
});

test('toAgentText removes the panda and warning glyphs', () => {
  assert.equal(toAgentText('🐼 Shoot: hello'), 'Shoot: hello');
  assert.equal(toAgentText('⚠️ careful'), 'careful');
  assert.equal(toAgentText('⚠ careful'), 'careful');
});

test('toAgentText maps status glyphs to ASCII', () => {
  assert.match(toAgentText('✔ passed'), /^ok passed$/);
  assert.match(toAgentText('✖ failed'), /^x failed$/);
  assert.match(toAgentText('ℹ tests 3'), /^i tests 3$/);
});

test('toAgentText normalizes typographic punctuation', () => {
  assert.equal(toAgentText('“quoted”'), '"quoted"');
  assert.equal(toAgentText('it’s'), "it's");
  assert.equal(toAgentText('a — b'), 'a - b');
  assert.equal(toAgentText('wait…'), 'wait...');
  assert.equal(toAgentText('a → b'), 'a -> b');
});

test('toAgentText drops block-drawing characters', () => {
  // The stats dashboard uses these; they must never reach a structured field.
  assert.equal(isAsciiOnly(toAgentText('▁▂▃▄▅▆▇█')), true);
  assert.equal(isAsciiOnly(toAgentText('─┼╾')), true);
});

test('toAgentText drops any remaining non-ASCII byte', () => {
  // Catches decoration nobody anticipated, including non-English output.
  const out = toAgentText('café 日本語 Ω');
  assert.equal(isAsciiOnly(out), true);
  assert.match(out, /caf/);
});

test('toAgentText preserves newlines and tabs — structure survives', () => {
  const out = toAgentText('line one\n\tindented\nline three');
  assert.match(out, /line one\n/);
  assert.match(out, /\tindented/);
  assert.equal(isAsciiOnly(out), true);
});

test('toAgentText leaves already-plain ASCII untouched', () => {
  const plain = 'AssertionError [ERR_ASSERTION]: 0 == 4\n  at foo (bar.js:1:2)';
  assert.equal(toAgentText(plain), plain);
});

test('toAgentText handles empty and non-string input', () => {
  assert.equal(toAgentText(''), '');
  assert.equal(toAgentText(undefined as unknown as string), '');
  assert.equal(toAgentText(null as unknown as string), '');
});

// ---------------------------------------------------------------------------
// The block reason IS the agent channel
// ---------------------------------------------------------------------------

test('the block reason is pure ASCII, with no escapes', () => {
  const claim = { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] };
  const reason = buildBlockReason(claim, failingReport());

  assert.equal(hasAnsi(reason), false, 'no ANSI escapes');
  assert.equal(isAsciiOnly(reason), true, 'no non-ASCII bytes');
  assert.doesNotMatch(reason, /🐼/, 'no panda');
});

test('the block reason keeps its wording and structure despite stripping', () => {
  const claim = { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] };
  const reason = buildBlockReason(claim, failingReport());

  // The content requirements from earlier phases still hold.
  assert.match(reason, /Shoot: Not yet/, 'framing survives, minus the panda');
  assert.match(reason, /"tests pass"/, 'the claim is quoted back');
  assert.match(reason, /--- test: failed with exit code 1/);
  assert.match(reason, /--- command: npm test/);
  assert.match(reason, /FAIL src\/a\.test\.ts/, 'real diagnostics survive');
  assert.match(reason, /Do not report success until they pass/);
});

test('non-ASCII command output is sanitized in the reason', () => {
  // A test suite that prints Unicode must not put it into the structured field.
  const claim = { claimed: true, matches: [{ id: 'tests-pass', text: 'tests pass' }] };
  const reason = buildBlockReason(claim, failingReport('✖ 测试失败 — assertion'));

  assert.equal(isAsciiOnly(reason), true);
  assert.match(reason, /x /, 'the cross mark became ASCII');
});

test('a real block decision carries an ASCII reason and a voiced terminal notice', async () => {
  await withTempDirAsync(async (dir) => {
    writeTrust(dir, { test: 'npm test', lint: '', typecheck: '', build: '' });

    const decision = await decide(
      input({ cwd: dir }),
      config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
      { runChecks: async () => failingReport() },
    );

    assert.equal(decision.verdict.kind, 'block');
    if (decision.verdict.kind === 'block') {
      // AGENT CHANNEL.
      assert.equal(isAsciiOnly(decision.verdict.reason), true);
      assert.equal(hasAnsi(decision.verdict.reason), false);

      // HUMAN CHANNEL — the panda belongs here.
      assert.ok(decision.verdict.terminalNotice !== undefined);
      assert.match(decision.verdict.terminalNotice ?? '', /🐼/);
    }
  });
});

// ---------------------------------------------------------------------------
// Adapters must not reintroduce decoration into stdout
// ---------------------------------------------------------------------------

test('every adapter emits ASCII-only stdout for a block', () => {
  const decorated = '🐼 Shoot: Not yet — “tests pass” isn’t true…\n▇▇▇';

  for (const adapter of [claudeCodeAdapter, codexAdapter]) {
    const r = adapter.formatResponse(
      { kind: 'block', reason: toAgentText(decorated), terminalNotice: decorated },
      input(),
    );

    assert.equal(isAsciiOnly(r.stdout), true, `${adapter.id} stdout must be ASCII`);
    assert.equal(hasAnsi(r.stdout), false, `${adapter.id} stdout must have no escapes`);
    // But the human-facing stderr keeps the decoration.
    assert.match(r.stderr, /🐼/, `${adapter.id} stderr is the human channel`);
  }
});

test('adapter stdout stays parseable JSON after sanitization', () => {
  for (const adapter of [claudeCodeAdapter, codexAdapter]) {
    const r = adapter.formatResponse(
      { kind: 'block', reason: toAgentText('🐼 line one\nline two') },
      input(),
    );
    assert.doesNotThrow(() => JSON.parse(r.stdout), adapter.id);
  }
});

// ---------------------------------------------------------------------------
// End to end, through the real CLI
// ---------------------------------------------------------------------------

test('E2E: the hook stdout JSON is ASCII-only even with Unicode test output', () => {
  withTempDir((dir) => {
    // A test that deliberately prints emoji and CJK on failure.
    const script = join(dir, 'unicode.mjs');
    writeFileSync(
      script,
      'console.log("✖ 測試失敗 — café ▇▇▇");\nprocess.exit(1);\n',
      'utf8',
    );
    saveTrustedConfig(
      dir,
      config({
        checks: { test: `"${process.execPath}" "${script}"`, lint: '', typecheck: '', build: '' },
      }),
    );

    const payload = JSON.stringify({
      session_id: 'chan-e2e',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    });

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [CLI, 'hook'], {
        input: payload,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }

    assert.equal(isAsciiOnly(stdout), true, 'the whole payload must be ASCII');
    assert.equal(hasAnsi(stdout), false);

    const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, 'block');
    assert.equal(isAsciiOnly(parsed.reason ?? ''), true, 'the reason field specifically');
  });
});

test('E2E: systemMessage on the pass path is the HUMAN channel and may decorate', () => {
  withTempDir((dir) => {
    saveTrustedConfig(
      dir,
      config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }),
    );

    const stdout = execFileSync(process.execPath, [CLI, 'hook'], {
      input: JSON.stringify({
        session_id: 'chan-pass',
        cwd: dir,
        hook_event_name: 'Stop',
        last_assistant_message: 'All tests pass.',
      }),
      encoding: 'utf8',
    });

    const parsed = JSON.parse(stdout) as { systemMessage?: string };
    // The panda is expected here — a host renders this for a person.
    assert.match(parsed.systemMessage ?? '', /🐼/);
    // But still no escape codes, because stdout is not a TTY.
    assert.equal(hasAnsi(stdout), false);
  });
});
