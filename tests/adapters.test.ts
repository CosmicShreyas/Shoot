import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ADAPTERS, detectPlatforms, getAdapter } from '../src/adapters/index.js';
import { claudeCodeAdapter } from '../src/adapters/claudeCode.js';
import { codexAdapter, CODEX_SHIM_REGISTERED_PATH } from '../src/adapters/codex.js';
import type { HookInput, Verdict } from '../src/adapters/types.js';
import {
  addCodexHooks,
  codexHooksPath,
  countForeignCodexHooks,
  findCodexRegistrations,
  isShootCodexHook,
  readCodexHooks,
  removeCodexHooks,
  writeCodexHooks,
  type CodexHooksFile,
} from '../src/core/codexConfig.js';
import { resolveHookEntry } from '../src/core/shim.js';
import { CODEX_SHIM_RELATIVE_PATH, SHIM_RELATIVE_PATH } from '../src/core/shim.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-adapter-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function input(overrides: Partial<HookInput> = {}): HookInput {
  return {
    sessionId: 's1',
    lastAssistantMessage: 'All tests pass.',
    cwd: process.cwd(),
    hookEventName: 'Stop',
    transcriptPath: '/tmp/t.jsonl',
    stopHookActive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('both adapters are registered with distinct ids', () => {
  const ids = ADAPTERS.map((a) => a.id);
  assert.deepEqual([...ids].sort(), ['claude-code', 'codex']);
  assert.equal(new Set(ids).size, ids.length);
});

test('getAdapter resolves by id', () => {
  assert.equal(getAdapter('claude-code').id, 'claude-code');
  assert.equal(getAdapter('codex').id, 'codex');
});

test('an unknown platform falls back rather than throwing', () => {
  // A hand-edited config must never break the hook.
  const adapter = getAdapter('nonsense' as never);
  assert.equal(adapter.id, 'claude-code', 'falls back to the best-tested path');
});

test('autodetection keys off each platform config directory', () => {
  withTempDir((dir) => {
    assert.deepEqual(detectPlatforms(dir), [], 'nothing present');

    mkdirSync(join(dir, '.claude'), { recursive: true });
    assert.deepEqual(
      detectPlatforms(dir).map((a) => a.id),
      ['claude-code'],
    );

    mkdirSync(join(dir, '.codex'), { recursive: true });
    assert.deepEqual(
      detectPlatforms(dir).map((a) => a.id).sort(),
      ['claude-code', 'codex'],
      'both can be present',
    );
  });
});

// ---------------------------------------------------------------------------
// Claude Code adapter — parsing
// ---------------------------------------------------------------------------

test('claude-code: parses the documented payload', () => {
  const parsed = claudeCodeAdapter.parseInput(
    JSON.stringify({
      session_id: 'abc',
      cwd: '/repo',
      hook_event_name: 'Stop',
      last_assistant_message: 'Tests pass.',
      transcript_path: '/t.jsonl',
      stop_hook_active: true,
    }),
    '/fallback',
  );

  assert.equal(parsed?.sessionId, 'abc');
  assert.equal(parsed?.cwd, '/repo');
  assert.equal(parsed?.lastAssistantMessage, 'Tests pass.');
  assert.equal(parsed?.stopHookActive, true);
});

test('claude-code: rejects malformed and non-object payloads', () => {
  assert.equal(claudeCodeAdapter.parseInput('nope', '/x'), null);
  assert.equal(claudeCodeAdapter.parseInput('[]', '/x'), null);
  assert.equal(claudeCodeAdapter.parseInput('null', '/x'), null);
});

// ---------------------------------------------------------------------------
// Claude Code adapter — formatting
// ---------------------------------------------------------------------------

test('claude-code: allowSilent emits nothing at all', () => {
  const r = claudeCodeAdapter.formatResponse({ kind: 'allowSilent' }, input());
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.equal(r.exitCode, 0);
});

test('claude-code: a notice rides systemMessage, never additionalContext', () => {
  const r = claudeCodeAdapter.formatResponse(
    { kind: 'allowWithNotice', notice: '🐼 Shoot: all good' },
    input(),
  );
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;

  assert.equal(parsed['systemMessage'], '🐼 Shoot: all good');
  assert.equal(parsed['decision'], undefined);
  // The field that caused the live infinite loop must never appear.
  assert.doesNotMatch(r.stdout, /additionalContext/);
  assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
});

test('claude-code: block emits decision + reason, exit 0', () => {
  const reason = '🐼 Shoot: Not yet.\n\n--- test: failed\nreal output here';
  const r = claudeCodeAdapter.formatResponse({ kind: 'block', reason }, input());
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;

  assert.equal(parsed['decision'], 'block');
  assert.equal(parsed['reason'], reason);
  assert.equal(r.exitCode, 0, 'JSON block form uses exit 0, not exit 2');
  // Terminal echo is the framing line only, not the whole dump.
  assert.equal(r.stderr.trim(), '🐼 Shoot: Not yet.');
});

test('claude-code has no install warnings', () => {
  assert.deepEqual(claudeCodeAdapter.warnings(), []);
});

// ---------------------------------------------------------------------------
// Codex adapter — parsing (verified against learn.chatgpt.com/docs/hooks)
// ---------------------------------------------------------------------------

test('codex: parses the documented Stop payload including turn_id siblings', () => {
  const parsed = codexAdapter.parseInput(
    JSON.stringify({
      session_id: 'sess-9',
      turn_id: 'turn-3',
      cwd: '/repo',
      hook_event_name: 'Stop',
      permission_mode: 'default',
      stop_hook_active: false,
      last_assistant_message: 'Fixed, tests pass.',
      transcript_path: '/t.jsonl',
      model: 'gpt-x',
    }),
    '/fallback',
  );

  // sessionId comes from session_id, not turn_id: the breaker needs the
  // longest-lived stable identifier.
  assert.equal(parsed?.sessionId, 'sess-9');
  assert.equal(parsed?.lastAssistantMessage, 'Fixed, tests pass.');
  assert.equal(parsed?.cwd, '/repo');
  assert.equal(parsed?.stopHookActive, false);
});

test('codex: stop_hook_active is honoured (same name, same meaning)', () => {
  const parsed = codexAdapter.parseInput(JSON.stringify({ stop_hook_active: true }), '/x');
  assert.equal(parsed?.stopHookActive, true);
});

test('codex: last_assistant_message may be null per the docs', () => {
  const parsed = codexAdapter.parseInput(
    JSON.stringify({ session_id: 'a', last_assistant_message: null }),
    '/x',
  );
  assert.equal(parsed?.lastAssistantMessage, '', 'null degrades to empty, not a crash');
});

test('codex: malformed stdin fails open — see openai/codex#23784', () => {
  // That open bug can deliver genuinely invalid JSON on Windows when the
  // assistant message contains non-ASCII text.
  assert.equal(codexAdapter.parseInput('{"last_assistant_message": "unterminated', '/x'), null);
  assert.equal(codexAdapter.parseInput('[]', '/x'), null);
});

// ---------------------------------------------------------------------------
// Codex adapter — formatting (differs from Claude Code in real ways)
// ---------------------------------------------------------------------------

test('codex: block emits decision + non-empty reason', () => {
  const r = codexAdapter.formatResponse(
    { kind: 'block', reason: '🐼 Shoot: Not yet.\nreal output' },
    input(),
  );
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;

  assert.equal(parsed['decision'], 'block');
  assert.match(String(parsed['reason']), /Not yet/);
  assert.equal(r.exitCode, 0);
});

test('codex: an empty block reason is replaced, because empty reason fails the hook', () => {
  const r = codexAdapter.formatResponse({ kind: 'block', reason: '   ' }, input());
  const parsed = JSON.parse(r.stdout) as Record<string, unknown>;

  assert.equal(parsed['decision'], 'block');
  assert.notEqual(String(parsed['reason']).trim(), '', 'reason must never be empty');
});

test('codex: a notice goes to stderr only — no systemMessage support on Stop', () => {
  const r = codexAdapter.formatResponse(
    { kind: 'allowWithNotice', notice: '🐼 Shoot: cleared' },
    input(),
  );

  assert.equal(r.stdout, '', 'stdout stays a clean allow');
  assert.match(r.stderr, /cleared/);
  // Emitting systemMessage here would be silently ignored by the host.
  assert.doesNotMatch(r.stdout, /systemMessage/);
});

test('codex: allowSilent emits nothing', () => {
  const r = codexAdapter.formatResponse({ kind: 'allowSilent' }, input());
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('codex warns honestly about its own limitations', () => {
  const warnings = codexAdapter.warnings();
  assert.ok(warnings.length >= 2, 'must not silently degrade');
  assert.ok(
    warnings.some((w) => /systemMessage/.test(w)),
    'must disclose the missing receipt channel',
  );
  assert.ok(
    warnings.some((w) => /less real-session testing|new/i.test(w)),
    'must disclose lower confidence than the Claude Code path',
  );
});

test('codex surfaces the known Windows serialization bug on Windows', () => {
  const warnings = codexAdapter.warnings();
  if (process.platform === 'win32') {
    assert.ok(
      warnings.some((w) => /23784/.test(w)),
      'should cite the open host bug by number',
    );
  } else {
    assert.ok(!warnings.some((w) => /23784/.test(w)), 'not relevant off Windows');
  }
});

// ---------------------------------------------------------------------------
// Both adapters agree on the verdict contract
// ---------------------------------------------------------------------------

test('every adapter handles every verdict kind without throwing', () => {
  const verdicts: Verdict[] = [
    { kind: 'allowSilent' },
    { kind: 'allowWithNotice', notice: 'note' },
    { kind: 'block', reason: 'because' },
  ];

  for (const adapter of ADAPTERS) {
    for (const v of verdicts) {
      const r = adapter.formatResponse(v, input());
      assert.equal(typeof r.stdout, 'string', `${adapter.id} / ${v.kind}`);
      assert.equal(typeof r.stderr, 'string');
      assert.equal(r.exitCode, 0, 'Shoot always exits 0; blocking is via stdout JSON');
    }
  }
});

test('no adapter ever emits a conversation-continuing field on an allow path', () => {
  for (const adapter of ADAPTERS) {
    for (const v of [
      { kind: 'allowSilent' } as Verdict,
      { kind: 'allowWithNotice', notice: 'x' } as Verdict,
    ]) {
      const r = adapter.formatResponse(v, input());
      assert.doesNotMatch(r.stdout, /additionalContext/, adapter.id);
      assert.doesNotMatch(r.stdout, /"decision"/, `${adapter.id} must not block on an allow`);
    }
  }
});

// ---------------------------------------------------------------------------
// Codex config file handling
// ---------------------------------------------------------------------------

function codexFileWithForeignHook(): CodexHooksFile {
  return {
    description: 'my hooks',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['./my-own.js'] }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
    },
  };
}

test('codex config: registers under the documented hooks wrapper', () => {
  const next = addCodexHooks({}, ['Stop'], CODEX_SHIM_REGISTERED_PATH);
  // Per the docs the events sit under "hooks", not at the root.
  assert.ok(next.hooks !== undefined, 'must use the hooks wrapper');
  assert.equal(findCodexRegistrations(next, ['Stop'])[0]?.registered, true);
});

test('codex config: preserves foreign hooks and unrelated keys', () => {
  const before = codexFileWithForeignHook();
  const after = addCodexHooks(before, ['Stop', 'SubagentStop'], CODEX_SHIM_REGISTERED_PATH);

  const stopHandlers = (after.hooks?.['Stop'] ?? []).flatMap((g) => g.hooks ?? []);
  const foreign = stopHandlers.filter((h) => !isShootCodexHook(h));
  assert.equal(foreign.length, 1);
  assert.deepEqual(foreign[0]?.args, ['./my-own.js']);

  assert.equal(after['description'], 'my hooks');
  assert.equal(after.hooks?.['PreToolUse']?.length, 1);
});

test('codex config: install then uninstall is a byte-identical round trip', () => {
  const before = codexFileWithForeignHook();
  const after = removeCodexHooks(
    addCodexHooks(before, ['Stop', 'SubagentStop'], CODEX_SHIM_REGISTERED_PATH),
  );
  assert.deepEqual(after, before);
});

test('codex config: installing twice does not duplicate', () => {
  const once = addCodexHooks({}, ['Stop'], CODEX_SHIM_REGISTERED_PATH);
  const twice = addCodexHooks(once, ['Stop'], CODEX_SHIM_REGISTERED_PATH);
  const shootEntries = (twice.hooks?.['Stop'] ?? [])
    .flatMap((g) => g.hooks ?? [])
    .filter(isShootCodexHook);
  assert.equal(shootEntries.length, 1);
});

test('codex config: round-trips through disk', () => {
  withTempDir((dir) => {
    writeCodexHooks(dir, codexFileWithForeignHook());
    writeCodexHooks(dir, addCodexHooks(readCodexHooks(dir), ['Stop'], CODEX_SHIM_REGISTERED_PATH));

    assert.ok(existsSync(codexHooksPath(dir)));
    assert.match(codexHooksPath(dir), /[\\/]\.codex[\\/]hooks\.json$/);
    assert.equal(findCodexRegistrations(readCodexHooks(dir), ['Stop'])[0]?.registered, true);

    writeCodexHooks(dir, removeCodexHooks(readCodexHooks(dir)));
    assert.deepEqual(readCodexHooks(dir), codexFileWithForeignHook());
  });
});

test('codex config: corrupt file reads as empty rather than throwing', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(codexHooksPath(dir), '{ broken', 'utf8');
    assert.deepEqual(readCodexHooks(dir), {});
  });
});

test('codex config: counts foreign hooks for uninstall reporting', () => {
  const installed = addCodexHooks(
    codexFileWithForeignHook(),
    ['Stop'],
    CODEX_SHIM_REGISTERED_PATH,
  );
  assert.equal(countForeignCodexHooks(installed), 2);
});

// ---------------------------------------------------------------------------
// Install / uninstall through the adapter interface
// ---------------------------------------------------------------------------

test('claude-code adapter installs a shim and registers both events', () => {
  withTempDir((dir) => {
    const result = claudeCodeAdapter.install(dir, {
      hookEntryPath: resolveHookEntry(),
      verifySubagents: true,
    });

    assert.ok(existsSync(join(dir, SHIM_RELATIVE_PATH)));
    assert.deepEqual(result.events, ['Stop', 'SubagentStop']);
    assert.equal(claudeCodeAdapter.registrations(dir).length, 2);
  });
});

test('codex adapter installs its shim under .codex/', () => {
  withTempDir((dir) => {
    const result = codexAdapter.install(dir, {
      hookEntryPath: resolveHookEntry(),
      verifySubagents: true,
    });

    assert.ok(existsSync(join(dir, CODEX_SHIM_RELATIVE_PATH)));
    assert.match(CODEX_SHIM_RELATIVE_PATH, /[\\/]shoot-hook\.js$/);
    assert.deepEqual(result.events, ['Stop', 'SubagentStop']);
    assert.equal(codexAdapter.registrations(dir).length, 2);
  });
});

test('codex adapter honours verifySubagents: false', () => {
  withTempDir((dir) => {
    const result = codexAdapter.install(dir, {
      hookEntryPath: resolveHookEntry(),
      verifySubagents: false,
    });
    assert.deepEqual(result.events, ['Stop']);
  });
});

test('each adapter uninstall leaves the other platform alone', () => {
  withTempDir((dir) => {
    claudeCodeAdapter.install(dir, { hookEntryPath: resolveHookEntry(), verifySubagents: true });
    codexAdapter.install(dir, { hookEntryPath: resolveHookEntry(), verifySubagents: true });

    claudeCodeAdapter.uninstall(dir);

    assert.equal(claudeCodeAdapter.registrations(dir).length, 0);
    assert.equal(codexAdapter.registrations(dir).length, 2, 'codex must be untouched');
  });
});

test('the generated codex shim imports a file:// URL', () => {
  withTempDir((dir) => {
    codexAdapter.install(dir, { hookEntryPath: resolveHookEntry(), verifySubagents: false });
    const contents = readFileSync(join(dir, CODEX_SHIM_RELATIVE_PATH), 'utf8');

    // Windows: import('D:/...') throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
    assert.match(contents, /import\('file:\/\/\//);
    assert.doesNotMatch(contents, /import\('[A-Za-z]:\//);
  });
});
