import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as messages from '../src/mascot/messages.js';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Every .ts file under src/, recursively. */
function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const MESSAGES_FILE = join(SRC, 'mascot', 'messages.ts');

// ---------------------------------------------------------------------------
// Centralization: one canonical string per situation, defined once
// ---------------------------------------------------------------------------

test('the panda marker appears only in messages.ts', () => {
  const offenders = sourceFiles()
    .filter((f) => f !== MESSAGES_FILE)
    .filter((f) => readFileSync(f, 'utf8').includes('🐼'))
    // init.ts embeds a canonical string into generated shim code, sourced from
    // messages.shimLoadFailed() rather than hardcoded — that's allowed.
    .filter((f) => !readFileSync(f, 'utf8').includes('messages.shimLoadFailed'));

  assert.deepEqual(offenders, [], 'mascot voice must be defined only in messages.ts');
});

test('no module builds its own voiced line via prefix()', () => {
  const offenders = sourceFiles()
    .filter((f) => f !== MESSAGES_FILE)
    .filter((f) => /messages\.prefix\(/.test(readFileSync(f, 'utf8')));

  assert.deepEqual(
    offenders,
    [],
    'call a named message function instead of composing one inline',
  );
});

test('every exported message is a non-empty string', () => {
  const skip = new Set(['PANDA', 'ART', 'prefix']);
  for (const [name, value] of Object.entries(messages)) {
    if (skip.has(name)) continue;
    assert.equal(typeof value, 'function', `${name} should be a function`);

    // Call with plausible args; all take 0-2 simple params.
    const fn = value as (...args: unknown[]) => string;
    const produced = fn.length === 0 ? fn() : fn.length === 1 ? fn('x') : fn(1, 'x');
    assert.equal(typeof produced, 'string', `${name} must return a string`);
    assert.ok(produced.trim() !== '', `${name} must not be empty`);
  }
});

// ---------------------------------------------------------------------------
// Voice rules
// ---------------------------------------------------------------------------

test('hook-decision messages carry the mascot prefix', () => {
  const voiced = [
    messages.success('test passed'),
    messages.blocked('tests pass'),
    messages.blockedNoQuote(),
    messages.breakerTripped(3, 'test failed'),
    messages.warnOnly('test failed'),
    messages.skippedBadCwd('/nope'),
    messages.noChecksConfigured(),
    messages.internalError('boom'),
    messages.shimLoadFailed('boom'),
  ];

  for (const line of voiced) {
    assert.match(line, /^🐼 Shoot: /, `missing prefix: ${line.slice(0, 50)}`);
  }
});

test('structural CLI strings stay plain — no voice on data-shaped output', () => {
  // These label or frame columns of data; a panda in front would be noise.
  const plain = [
    messages.initSuggestions(),
    messages.initSkipHint(),
    messages.initNothingConfigured(),
    messages.initWrote('.claude/settings.json'),
    messages.initTryIt(),
    messages.uninstallPreserving(2),
  ];

  for (const line of plain) {
    assert.doesNotMatch(line, /🐼/, `should not be voiced: ${line.slice(0, 50)}`);
  }
});

test('the success line names what was actually checked', () => {
  assert.match(messages.success('test passed, lint passed'), /test passed, lint passed/);
});

test('the block framing quotes the claim back verbatim', () => {
  assert.match(messages.blocked('all tests are passing'), /"all tests are passing"/);
});

test('the stand-down line states plainly that checks still fail', () => {
  const line = messages.breakerTripped(3, 'test failed');
  assert.match(line, /3 times/);
  assert.match(line, /do NOT pass/, 'must never read as a pass');
  assert.match(line, /human/i);
});

test('the bad-cwd line says verification was skipped, not satisfied', () => {
  const line = messages.skippedBadCwd('/gone');
  assert.match(line, /skipped verification/i);
  assert.match(line, /nothing was verified/i);
  assert.match(line, /\/gone/);
});

test('pluralization is handled', () => {
  assert.match(messages.verifyFailed(1), /1 check did not pass/);
  assert.match(messages.verifyFailed(3), /3 checks did not pass/);
  assert.match(messages.uninstallPreserving(1), /1 hook entry /);
  assert.match(messages.uninstallPreserving(2), /2 hook entries /);
});

test('the ASCII art is present for init', () => {
  assert.match(messages.ART, /shoot/);
  assert.match(messages.ART, /verify before you grow/);
});
