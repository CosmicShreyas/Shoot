import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHIM_RELATIVE_PATH,
  resolveHookEntry,
  suggestChecks,
  writeHookShim,
} from '../src/commands/init.js';
import { gatherStatus } from '../src/commands/status.js';
import { DEFAULT_CONFIG, configPath, saveConfig, type ShootConfig } from '../src/core/config.js';
import {
  addShootHooks,
  findRegistrations,
  readSettings,
  settingsPath,
  writeSettings,
} from '../src/core/settings.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const SHIM = '${CLAUDE_PROJECT_DIR}/.claude/shoot-hook.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-cmd-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function config(overrides: Partial<ShootConfig> = {}): ShootConfig {
  return { ...DEFAULT_CONFIG, checks: { ...DEFAULT_CONFIG.checks }, ...overrides };
}

function runCLI(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: '',
    });
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', status: e.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// init: shim generation
// ---------------------------------------------------------------------------

test('writes a hook shim that forwards to the real entry point', () => {
  withTempDir((dir) => {
    const shimPath = writeHookShim(dir, resolveHookEntry());

    assert.ok(existsSync(shimPath));
    assert.equal(shimPath, join(dir, SHIM_RELATIVE_PATH));

    const contents = readFileSync(shimPath, 'utf8');
    assert.match(contents, /runHook/);
    assert.match(contents, /hook\.js/);
    // Never let the shim break a session.
    assert.match(contents, /process\.exit\(0\)/);
  });
});

test('the shim imports a file:// URL, not a bare path', () => {
  withTempDir((dir) => {
    const contents = readFileSync(writeHookShim(dir, resolveHookEntry()), 'utf8');

    // On Windows, import('D:/...') throws ERR_UNSUPPORTED_ESM_URL_SCHEME because
    // "d:" parses as a protocol. The shim must use a proper file:// URL.
    assert.match(contents, /import\('file:\/\/\//);
    assert.doesNotMatch(contents, /import\('[A-Za-z]:\//, 'must not embed a bare drive path');
  });
});

test('a shim that cannot load reports the problem instead of failing silently', () => {
  withTempDir((dir) => {
    // Point the shim at a module that does not exist.
    const shimPath = writeHookShim(dir, join(dir, 'missing-entry.js'));

    // The shim exits 0 by design, so execFileSync does not throw — capture
    // stderr from the successful result via spawnSync instead.
    const result = spawnSync(process.execPath, [shimPath], {
      input: '{}',
      encoding: 'utf8',
    });

    // Allowed the stop (exit 0), but said so loudly.
    assert.equal(result.status, 0, 'must never fail the session');
    assert.match(result.stderr, /hook could not run/i);
  });
});

test('the shim path ends in shoot-hook.js so uninstall can identify it', () => {
  assert.match(SHIM_RELATIVE_PATH, /shoot-hook\.js$/);
});

test('the generated shim actually runs and allows a non-claim turn', () => {
  withTempDir((dir) => {
    writeHookShim(dir, resolveHookEntry());
    saveConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const payload = JSON.stringify({
      session_id: 'shim-test',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'Still working on the parser.',
    });

    const stdout = execFileSync(process.execPath, [join(dir, SHIM_RELATIVE_PATH)], {
      input: payload,
      encoding: 'utf8',
    });
    assert.equal(stdout.trim(), '', 'no claim means no output');
  });
});

test('the generated shim blocks a false claim end to end', () => {
  withTempDir((dir) => {
    writeHookShim(dir, resolveHookEntry());
    saveConfig(dir, config({ checks: { test: 'exit 1', lint: '', typecheck: '', build: '' } }));

    const payload = JSON.stringify({
      session_id: 'shim-block',
      cwd: dir,
      hook_event_name: 'Stop',
      last_assistant_message: 'All tests pass now.',
    });

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [join(dir, SHIM_RELATIVE_PATH)], {
        input: payload,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? '';
    }

    const parsed = JSON.parse(stdout) as { decision?: string };
    assert.equal(parsed.decision, 'block');
  });
});

// ---------------------------------------------------------------------------
// init: package.json suggestions
// ---------------------------------------------------------------------------

test('suggests commands based on package.json scripts', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' } }),
      'utf8',
    );

    const suggested = suggestChecks(dir);
    assert.equal(suggested.test, 'npm test');
    assert.equal(suggested.lint, 'npm run lint');
    assert.equal(suggested.build, 'npm run build');
    assert.equal(suggested.typecheck, undefined, 'absent script should not be suggested');
  });
});

test('suggests nothing when package.json is absent or unreadable', () => {
  withTempDir((dir) => {
    assert.deepEqual(suggestChecks(dir), {});
    writeFileSync(join(dir, 'package.json'), 'not json', 'utf8');
    assert.deepEqual(suggestChecks(dir), {});
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status reports not-installed when there is no config', () => {
  withTempDir((dir) => {
    const report = gatherStatus(dir);
    assert.equal(report.configPresent, false);
  });
});

test('status reports healthy when the registered shim exists', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    writeHookShim(dir, resolveHookEntry());
    writeSettings(dir, addShootHooks({}, ['Stop', 'SubagentStop'], SHIM));

    const report = gatherStatus(dir);
    assert.deepEqual(report.healthy, ['Stop', 'SubagentStop']);
    assert.deepEqual(report.brokenPaths, []);
    assert.deepEqual(report.missing, []);
  });
});

test('status catches a registration pointing at a missing file', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    // Register, but never create the shim (simulates a moved/deleted file).
    writeSettings(dir, addShootHooks({}, ['Stop'], SHIM));

    const report = gatherStatus(dir);
    assert.equal(report.brokenPaths.length, 1);
    assert.equal(report.brokenPaths[0]?.event, 'Stop');
    assert.deepEqual(report.healthy, []);
  });
});

test('status reports missing registration when config exists but hooks do not', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    const report = gatherStatus(dir);
    assert.deepEqual(report.missing, ['Stop', 'SubagentStop']);
  });
});

test('status only expects Stop when verifySubagents is false', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ verifySubagents: false }));
    writeHookShim(dir, resolveHookEntry());
    writeSettings(dir, addShootHooks({}, ['Stop'], SHIM));

    const report = gatherStatus(dir);
    assert.deepEqual(report.healthy, ['Stop']);
    assert.deepEqual(report.missing, [], 'SubagentStop should not be expected');
  });
});

test('status flags a corrupt settings file', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), '{ nope', 'utf8');

    assert.equal(gatherStatus(dir).settingsCorrupt, true);
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

test('CLI: verify fails cleanly with no config', () => {
  withTempDir((dir) => {
    const { status, stderr } = runCLI(['verify'], dir);
    assert.equal(status, 1);
    assert.match(stderr, /shoot init/);
  });
});

test('CLI: verify passes and exits 0 when checks pass', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: { test: 'exit 0', lint: '', typecheck: '', build: '' } }));
    const { status, stdout } = runCLI(['verify'], dir);

    assert.equal(status, 0);
    assert.match(stdout, /pass/);
    assert.match(stdout, /Cleared to grow/);
  });
});

test('CLI: verify exits 1 and shows real output when checks fail', () => {
  withTempDir((dir) => {
    const failing = `"${process.execPath}" -e "console.error('SPECIFIC_FAILURE_TEXT');process.exit(1)"`;
    saveConfig(dir, config({ checks: { test: failing, lint: '', typecheck: '', build: '' } }));

    const { status, stdout } = runCLI(['verify'], dir);
    assert.equal(status, 1);
    assert.match(stdout, /FAIL/);
    assert.match(stdout, /SPECIFIC_FAILURE_TEXT/, 'real diagnostics must be shown');
  });
});

test('CLI: verify says so when nothing is configured', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    const { status, stdout } = runCLI(['verify'], dir);
    assert.equal(status, 0);
    assert.match(stdout, /No checks configured/i);
  });
});

test('CLI: status exits 1 when not installed', () => {
  withTempDir((dir) => {
    const { status, stdout } = runCLI(['status'], dir);
    assert.equal(status, 1);
    assert.match(stdout, /not found/);
  });
});

test('CLI: status exits 0 and reports config when fully installed', () => {
  withTempDir((dir) => {
    saveConfig(dir, config({ checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }));
    writeHookShim(dir, resolveHookEntry());
    writeSettings(dir, addShootHooks({}, ['Stop', 'SubagentStop'], SHIM));

    const { status, stdout } = runCLI(['status'], dir);
    assert.equal(status, 0);
    assert.match(stdout, /npm test/);
    assert.match(stdout, /registered/);
    assert.match(stdout, /wired up/i);
  });
});

test('CLI: status exits 1 and warns when the shim is missing', () => {
  withTempDir((dir) => {
    saveConfig(dir, config());
    writeSettings(dir, addShootHooks({}, ['Stop'], SHIM));

    const { status, stdout } = runCLI(['status'], dir);
    assert.equal(status, 1);
    assert.match(stdout, /BROKEN/);
  });
});

test('CLI: uninstall --yes removes Shoot but keeps a foreign hook', () => {
  withTempDir((dir) => {
    const foreign = {
      env: { KEEP: 'yes' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['./my-hook.js'] }] }],
      },
    };
    writeSettings(dir, addShootHooks(foreign, ['Stop', 'SubagentStop'], SHIM));
    saveConfig(dir, config());
    writeHookShim(dir, resolveHookEntry());

    const { status } = runCLI(['uninstall', '--yes'], dir);
    assert.equal(status, 0);

    // Shoot's files are gone.
    assert.equal(existsSync(configPath(dir)), false);
    assert.equal(existsSync(join(dir, SHIM_RELATIVE_PATH)), false);

    // The user's hook and env survive.
    const after = readSettings(dir);
    assert.deepEqual(after['env'], { KEEP: 'yes' });
    const stopHooks = (after.hooks?.['Stop'] ?? []).flatMap((m) => m.hooks ?? []);
    assert.equal(stopHooks.length, 1);
    assert.deepEqual(stopHooks[0]?.args, ['./my-hook.js']);

    // And Shoot is no longer registered.
    assert.equal(findRegistrations(after, ['Stop'])[0]?.registered, false);
  });
});

test('CLI: uninstall on a clean directory says there is nothing to do', () => {
  withTempDir((dir) => {
    const { status, stdout } = runCLI(['uninstall', '--yes'], dir);
    assert.equal(status, 0);
    assert.match(stdout, /Nothing to remove/i);
  });
});

test('CLI: init is non-interactive-safe and writes a working install', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'exit 0' } }),
      'utf8',
    );

    // stdin is not a TTY here, so prompts take their defaults.
    const { status, stdout } = runCLI(['init'], dir);
    assert.equal(status, 0);
    assert.match(stdout, /All set/);

    // Config written with the suggested test command.
    assert.ok(existsSync(configPath(dir)));
    const cfg = JSON.parse(readFileSync(configPath(dir), 'utf8')) as ShootConfig;
    assert.equal(cfg.checks.test, 'npm test');
    assert.equal(cfg.mode, 'block');
    assert.equal(cfg.verifySubagents, true);

    // Shim written and registered for both events.
    assert.ok(existsSync(join(dir, SHIM_RELATIVE_PATH)));
    const regs = findRegistrations(readSettings(dir));
    assert.equal(regs.find((r) => r.event === 'Stop')?.registered, true);
    assert.equal(regs.find((r) => r.event === 'SubagentStop')?.registered, true);

    // And status agrees it is healthy.
    assert.equal(runCLI(['status'], dir).status, 0);
  });
});

test('CLI: init then uninstall leaves the directory as it started', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8');

    runCLI(['init'], dir);
    runCLI(['uninstall', '--yes'], dir);

    assert.equal(existsSync(configPath(dir)), false);
    assert.equal(existsSync(join(dir, SHIM_RELATIVE_PATH)), false);
    assert.deepEqual(readSettings(dir), {}, 'no leftover hook registration');
  });
});
