import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SHOOT_MARKER,
  addShootHooks,
  countForeignHooks,
  findRegistrations,
  isShootHook,
  readSettings,
  removeShootHooks,
  resolveHookPath,
  settingsCorrupt,
  settingsPath,
  shootHookCommand,
  writeSettings,
  type SettingsShape,
} from '../src/core/settings.js';

const SHIM = '${CLAUDE_PROJECT_DIR}/.claude/shoot-hook.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-settings-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A settings file with a hook the user added themselves. */
function settingsWithForeignHook(): SettingsShape {
  return {
    permissions: { allow: ['Bash(npm test)'] },
    env: { MY_VAR: 'keep-me' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['./scripts/my-own-hook.js'] }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/guard.sh' }] },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

test('recognizes its own hook entries and not others', () => {
  assert.equal(isShootHook(shootHookCommand(SHIM)), true);
  assert.equal(
    isShootHook({ type: 'command', command: 'node', args: ['./scripts/my-own-hook.js'] }),
    false,
  );
  assert.equal(isShootHook({ type: 'command', command: './guard.sh' }), false);
});

test('the marker is specific enough not to claim look-alike paths', () => {
  // A user hook that merely contains the word "shoot" must not be claimed.
  assert.equal(
    isShootHook({ type: 'command', command: 'node', args: ['./scripts/screenshoot.js'] }),
    false,
  );
  assert.match(SHOOT_MARKER, /shoot-hook\.js/);
});

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

test('registers for both events on an empty settings file', () => {
  const next = addShootHooks({}, ['Stop', 'SubagentStop'], SHIM);
  const regs = findRegistrations(next);

  assert.equal(regs.find((r) => r.event === 'Stop')?.registered, true);
  assert.equal(regs.find((r) => r.event === 'SubagentStop')?.registered, true);
});

test('registers Stop only when subagent verification is off', () => {
  const next = addShootHooks({}, ['Stop'], SHIM);
  const regs = findRegistrations(next);

  assert.equal(regs.find((r) => r.event === 'Stop')?.registered, true);
  assert.equal(regs.find((r) => r.event === 'SubagentStop')?.registered, false);
});

test('uses exec form with node and an explicit script path', () => {
  const cmd = shootHookCommand(SHIM);
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.command, 'node');
  assert.deepEqual(cmd.args, [SHIM]);
  // Must NOT rely on the bin name, which breaks on Windows .cmd shims.
  assert.notEqual(cmd.command, 'shoot');
});

test('installing preserves unrelated hooks and unrelated top-level keys', () => {
  const before = settingsWithForeignHook();
  const after = addShootHooks(before, ['Stop', 'SubagentStop'], SHIM);

  // Foreign Stop hook survives.
  const stopHooks = after.hooks?.['Stop'] ?? [];
  const foreign = stopHooks.flatMap((m) => m.hooks ?? []).filter((h) => !isShootHook(h));
  assert.equal(foreign.length, 1);
  assert.deepEqual(foreign[0]?.args, ['./scripts/my-own-hook.js']);

  // Unrelated event untouched.
  assert.equal(after.hooks?.['PreToolUse']?.length, 1);

  // Unrelated top-level keys untouched.
  assert.deepEqual(after['permissions'], { allow: ['Bash(npm test)'] });
  assert.deepEqual(after['env'], { MY_VAR: 'keep-me' });
});

test('installing twice does not duplicate the entry', () => {
  const once = addShootHooks({}, ['Stop'], SHIM);
  const twice = addShootHooks(once, ['Stop'], SHIM);

  const shootEntries = (twice.hooks?.['Stop'] ?? [])
    .flatMap((m) => m.hooks ?? [])
    .filter(isShootHook);
  assert.equal(shootEntries.length, 1, 'init should be idempotent');
});

test('re-installing updates a stale path rather than adding another entry', () => {
  const stale = addShootHooks({}, ['Stop'], '${CLAUDE_PROJECT_DIR}/old/shoot-hook.js');
  const fresh = addShootHooks(stale, ['Stop'], SHIM);

  const paths = findRegistrations(fresh, ['Stop'])[0]?.paths ?? [];
  assert.deepEqual(paths, [SHIM]);
});

// ---------------------------------------------------------------------------
// Uninstall — the case that must not go wrong
// ---------------------------------------------------------------------------

test('uninstalling removes only Shoot entries, keeping the user hook', () => {
  const before = settingsWithForeignHook();
  const installed = addShootHooks(before, ['Stop', 'SubagentStop'], SHIM);
  const removed = removeShootHooks(installed);

  const stopHooks = (removed.hooks?.['Stop'] ?? []).flatMap((m) => m.hooks ?? []);
  assert.equal(stopHooks.length, 1, 'the user hook must survive');
  assert.deepEqual(stopHooks[0]?.args, ['./scripts/my-own-hook.js']);
  assert.equal(stopHooks.filter(isShootHook).length, 0, 'no Shoot entries left');
});

test('install then uninstall is a true round-trip when a foreign hook exists', () => {
  const before = settingsWithForeignHook();
  const after = removeShootHooks(addShootHooks(before, ['Stop', 'SubagentStop'], SHIM));

  assert.deepEqual(after, before, 'settings must be byte-identical after a round trip');
});

test('round-trip is clean for an empty settings file too', () => {
  const after = removeShootHooks(addShootHooks({}, ['Stop', 'SubagentStop'], SHIM));
  assert.deepEqual(after, {}, 'should not leave empty hook containers behind');
});

test('uninstall drops the event key only if nothing of the user survives', () => {
  const installed = addShootHooks({}, ['Stop'], SHIM);
  const removed = removeShootHooks(installed);
  assert.equal(removed.hooks, undefined, 'no orphan empty hooks object');
});

test('uninstalling with no Shoot entries changes nothing', () => {
  const before = settingsWithForeignHook();
  assert.deepEqual(removeShootHooks(before), before);
});

test('counts foreign hooks so uninstall can report what it kept', () => {
  const installed = addShootHooks(settingsWithForeignHook(), ['Stop'], SHIM);
  // One Stop hook of the user's, one PreToolUse hook of the user's.
  assert.equal(countForeignHooks(installed), 2);
});

// ---------------------------------------------------------------------------
// Disk I/O and corruption
// ---------------------------------------------------------------------------

test('round-trips through disk, preserving foreign content', () => {
  withTempDir((dir) => {
    writeSettings(dir, settingsWithForeignHook());
    const installed = addShootHooks(readSettings(dir), ['Stop'], SHIM);
    writeSettings(dir, installed);

    const reread = readSettings(dir);
    assert.deepEqual(reread['env'], { MY_VAR: 'keep-me' });
    assert.equal(findRegistrations(reread, ['Stop'])[0]?.registered, true);

    writeSettings(dir, removeShootHooks(reread));
    assert.deepEqual(readSettings(dir), settingsWithForeignHook());
  });
});

test('creates the .claude directory when absent', () => {
  withTempDir((dir) => {
    writeSettings(dir, addShootHooks({}, ['Stop'], SHIM));
    assert.ok(readFileSync(settingsPath(dir), 'utf8').includes('shoot-hook.js'));
  });
});

test('a corrupt settings file is detected rather than silently overwritten', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath(dir), '{ broken json', 'utf8');

    assert.equal(settingsCorrupt(dir), true);
    assert.deepEqual(readSettings(dir), {}, 'reads as empty rather than throwing');
  });
});

test('an absent settings file is not reported as corrupt', () => {
  withTempDir((dir) => {
    assert.equal(settingsCorrupt(dir), false);
  });
});

test('malformed hook structures do not crash the readers', () => {
  const weird: SettingsShape = {
    hooks: { Stop: 'not an array' as unknown as never },
  };
  assert.doesNotThrow(() => findRegistrations(weird));
  assert.doesNotThrow(() => removeShootHooks(weird));
  assert.doesNotThrow(() => countForeignHooks(weird));
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

test('expands CLAUDE_PROJECT_DIR when checking a registered path', () => {
  const resolved = resolveHookPath('${CLAUDE_PROJECT_DIR}/.claude/shoot-hook.js', '/repo');
  assert.equal(resolved, '/repo/.claude/shoot-hook.js');
});

test('leaves a plain absolute path alone', () => {
  assert.equal(resolveHookPath('/abs/shoot-hook.js', '/repo'), '/abs/shoot-hook.js');
});
