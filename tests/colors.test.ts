import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  colorDisabledByEnv,
  hasAnsi,
  paletteFor,
  plain,
  shouldColor,
  stripAnsi,
} from '../src/mascot/colors.js';
import * as messages from '../src/mascot/messages.js';
import { DEFAULT_CONFIG, type ShootConfig } from '../src/core/config.js';
import { saveTrustedConfig } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const TTY = { isTTY: true };
const NOT_TTY = { isTTY: undefined };

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-color-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function config(overrides: Partial<ShootConfig> = {}): ShootConfig {
  return { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks }, ...overrides };
}

/** Run the CLI with a controlled environment. */
function runCLI(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Zero-dependency guarantee
// ---------------------------------------------------------------------------

test('colors are hand-rolled — no color library is imported anywhere', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const src = fileURLToPath(new URL('../src', import.meta.url));

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(src);

  // The zero-runtime-dependency guarantee is marketed and CI-enforced; a color
  // library would break it for a few dozen bytes of escape codes.
  const banned = /from\s+['"](chalk|colors|picocolors|kleur|ansi-colors|colorette|cli-color)['"]/;
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), banned, `${f} imports a color library`);
  }
});

// ---------------------------------------------------------------------------
// NO_COLOR
// ---------------------------------------------------------------------------

test('NO_COLOR set to any value disables color', () => {
  // Per https://no-color.org, PRESENCE is what counts — not the value.
  for (const value of ['1', '0', 'true', 'false', 'anything']) {
    assert.equal(colorDisabledByEnv({ NO_COLOR: value }), true, `NO_COLOR=${value}`);
  }
});

test('NO_COLOR set to the empty string still disables color', () => {
  // The convention is explicit that an empty value counts as set.
  assert.equal(colorDisabledByEnv({ NO_COLOR: '' }), true);
});

test('an absent NO_COLOR does not disable color', () => {
  assert.equal(colorDisabledByEnv({}), false);
});

test('NO_COLOR beats a TTY', () => {
  assert.equal(shouldColor(TTY, { NO_COLOR: '1' }), false);
  const palette = paletteFor(TTY, { NO_COLOR: '1' });
  assert.equal(palette.enabled, false);
  assert.equal(palette.ok('x'), 'x');
});

// ---------------------------------------------------------------------------
// TTY detection, per stream
// ---------------------------------------------------------------------------

test('a TTY with no NO_COLOR gets color', () => {
  assert.equal(shouldColor(TTY, {}), true);
  assert.equal(paletteFor(TTY, {}).enabled, true);
});

test('a non-TTY stream gets no color', () => {
  assert.equal(shouldColor(NOT_TTY, {}), false);
  assert.equal(shouldColor(undefined, {}), false);
});

test('isTTY must be exactly true, not merely truthy-ish', () => {
  // isTTY is `undefined` on a pipe; treating "unknown" as "yes" would emit escapes
  // into a redirected file.
  assert.equal(shouldColor({ isTTY: undefined }, {}), false);
});

test('each stream is decided independently', () => {
  // The real case this protects: a hook host captures stdout for JSON while stderr
  // stays attached to the user's terminal.
  const stdoutPiped = paletteFor(NOT_TTY, {});
  const stderrTty = paletteFor(TTY, {});

  assert.equal(stdoutPiped.enabled, false);
  assert.equal(stderrTty.enabled, true);
});

// ---------------------------------------------------------------------------
// Palette output
// ---------------------------------------------------------------------------

test('the plain palette is a pure passthrough', () => {
  for (const style of ['ok', 'bad', 'warn', 'strong', 'faint'] as const) {
    assert.equal(plain[style]('text'), 'text', style);
  }
  assert.equal(plain.enabled, false);
});

test('the colored palette wraps text and always resets', () => {
  const p = paletteFor(TTY, {});
  for (const style of ['ok', 'bad', 'warn', 'strong', 'faint'] as const) {
    const out = p[style]('text');
    assert.ok(hasAnsi(out), `${style} should emit an escape`);
    assert.match(out, /text/, `${style} should preserve the text`);
    // A missing reset bleeds color into everything printed afterwards.
    assert.ok(out.endsWith('[0m'), `${style} must reset`);
  }
});

test('stripAnsi recovers the original text exactly', () => {
  const p = paletteFor(TTY, {});
  assert.equal(stripAnsi(p.ok('hello')), 'hello');
  assert.equal(stripAnsi(p.bad(p.strong('nested'))), 'nested');
});

test('hasAnsi distinguishes plain from colored', () => {
  assert.equal(hasAnsi('plain text'), false);
  assert.equal(hasAnsi(paletteFor(TTY, {}).ok('x')), true);
});

// ---------------------------------------------------------------------------
// messages.ts routing — colors live in ONE place
// ---------------------------------------------------------------------------

test('voiced messages are plain under the plain palette', () => {
  messages.setPalette(plain);
  const lines = [
    messages.success('test passed'),
    messages.blocked('tests pass'),
    messages.breakerTripped(3, 'test failed'),
    messages.warnOnly('test failed'),
    messages.configChanged(),
    messages.verifyPassed(),
    messages.doctorHealthy(),
    messages.trustApproved(),
  ];

  for (const line of lines) {
    assert.equal(hasAnsi(line), false, `should be plain: ${line.slice(0, 40)}`);
    assert.match(line, /^🐼 Shoot: /, 'prefix must survive');
  }
});

test('voiced messages carry color under the colored palette', () => {
  messages.setPalette(paletteFor(TTY, {}));
  try {
    assert.equal(hasAnsi(messages.success('test passed')), true);
    assert.equal(hasAnsi(messages.blocked('tests pass')), true);
    // And the underlying wording is unchanged once stripped.
    assert.equal(
      stripAnsi(messages.success('test passed')),
      '🐼 Shoot: Nice work — test passed. Cleared to grow.',
    );
  } finally {
    messages.setPalette(plain);
  }
});

test('withoutColor forces plain regardless of the active palette', () => {
  messages.setPalette(paletteFor(TTY, {}));
  try {
    const colored = messages.success('test passed');
    const uncolored = messages.withoutColor(() => messages.success('test passed'));

    assert.equal(hasAnsi(colored), true);
    assert.equal(hasAnsi(uncolored), false);
    // The palette is restored afterwards.
    assert.equal(hasAnsi(messages.success('x')), true);
  } finally {
    messages.setPalette(plain);
  }
});

test('the canonical wording is identical colored and plain', () => {
  messages.setPalette(paletteFor(TTY, {}));
  const colored = messages.breakerTripped(3, 'test failed');
  messages.setPalette(plain);
  const uncolored = messages.breakerTripped(3, 'test failed');

  assert.equal(stripAnsi(colored), uncolored, 'color must never change the words');
});

// ---------------------------------------------------------------------------
// End to end: real processes, real pipes
// ---------------------------------------------------------------------------

test('E2E: CLI output is escape-free when piped (non-TTY)', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    // execFileSync pipes both streams, so neither is a TTY.
    const r = runCLI(['verify'], dir);
    assert.equal(hasAnsi(r.stdout), false, 'piped stdout must be plain');
    assert.equal(hasAnsi(r.stderr), false, 'piped stderr must be plain');
    assert.match(r.stdout, /Cleared to grow/, 'and still readable');
  });
});

test('E2E: NO_COLOR=1 produces escape-free output', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    const r = runCLI(['verify'], dir, { NO_COLOR: '1' });
    assert.equal(hasAnsi(r.stdout), false);
    assert.equal(hasAnsi(r.stderr), false);
  });
});

test('E2E: every command stays escape-free when piped', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    for (const cmd of [['status'], ['doctor'], ['stats'], ['trust'], ['verify'], ['--help']]) {
      const r = runCLI(cmd, dir);
      assert.equal(hasAnsi(r.stdout), false, `${cmd.join(' ')} stdout`);
      assert.equal(hasAnsi(r.stderr), false, `${cmd.join(' ')} stderr`);
    }
  });
});

test('E2E: the hook never puts escape codes in its stdout JSON', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const payload = JSON.stringify({
      session_id: 'color-test',
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

    // An escape sequence inside the payload would corrupt what the host parses.
    assert.equal(hasAnsi(stdout), false, 'hook stdout must be pure JSON');
    assert.doesNotThrow(() => JSON.parse(stdout), 'and must still parse');

    const parsed = JSON.parse(stdout) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, 'block');
    assert.equal(hasAnsi(parsed.reason ?? ''), false, 'the reason string too');
  });
});

test('E2E: NO_COLOR is respected by the hook as well', () => {
  withTempDir((dir) => {
    saveTrustedConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));

    const payload = JSON.stringify({
      session_id: 'color-nocolor',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass.',
    });

    const stdout = execFileSync(process.execPath, [CLI, 'hook'], {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });

    assert.equal(hasAnsi(stdout), false);
  });
});
