import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as messages from '../src/mascot/messages.js';
import { plain } from '../src/mascot/colors.js';

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
  // Constants, builders, palette controls, and banner helpers — none of these is
  // "a message", and several would misbehave if called with a dummy argument.
  // (`setPalette('x')` in particular would poison state for every later test.)
  const skip = new Set([
    'PANDA',
    'TAGLINE',
    'BANNER_MIN_WIDTH',
    'prefix',
    'setPalette',
    'withoutColor',
    'banner',
    'compactBanner',
    'bannerFor',
    'displayWidth',
  ]);

  // Render plain so assertions are about wording, not escape codes.
  messages.setPalette(plain);

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
  const unvoiced = [
    messages.initSuggestions(),
    messages.initSkipHint(),
    messages.initNothingConfigured(),
    messages.initWrote('.claude/settings.json'),
    messages.initTryIt(),
    messages.uninstallPreserving(2),
  ];

  for (const line of unvoiced) {
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

test('the banner contains the wordmark, bamboo, panda, and tagline', () => {
  const b = messages.banner();
  assert.match(b, /___\| \|__/, 'the "shoot" wordmark');
  assert.match(b, /\|=/, 'bamboo stalk segments');
  assert.match(b, /🐼/, 'the panda');
  assert.ok(b.includes(messages.TAGLINE), 'the tagline');
});

test('the banner uses only ASCII, box-drawing, and the panda', () => {
  // An earlier version used `ǂ` (U+01C2), which terminal fonts substitute or render
  // at the wrong width, destroying the alignment. Box-drawing characters are the
  // only non-ASCII allowed, because they are near-universally single-width.
  const allowedNonAscii = /[─│╭╮╰╯├┤🐼]/u;
  const offenders = [...messages.banner()].filter(
    (ch) => ch.charCodeAt(0) > 0x7e && !allowedNonAscii.test(ch),
  );
  assert.deepEqual(offenders, [], `unexpected characters: ${offenders.join(' ')}`);
});

test('every banner line is exactly the same display width', () => {
  // THE bug this guards: the panda is two cells wide but one code point, so a
  // hand-padded border lands a column short on whichever row contains it. Caught by
  // rendering, not by reading — hence an assertion rather than a comment.
  for (const b of [messages.banner(), messages.compactBanner()]) {
    const widths = b.split('\n').map(messages.displayWidth);
    const first = widths[0];
    for (const [i, w] of widths.entries()) {
      assert.equal(w, first, `line ${i} is ${w} cells, expected ${first}\n${b}`);
    }
  }
});

test('the compact banner is used when the terminal is too narrow', () => {
  const full = messages.banner();
  const compact = messages.compactBanner();

  assert.equal(messages.bannerFor(100), full, 'wide terminal gets the full banner');
  assert.equal(messages.bannerFor(40), compact, 'narrow terminal gets the compact one');
  // At exactly the threshold the full banner must still fit.
  assert.equal(messages.bannerFor(messages.BANNER_MIN_WIDTH), full);
  assert.equal(messages.bannerFor(messages.BANNER_MIN_WIDTH - 1), compact);
});

test('an unknown terminal width assumes 80 and gets the full banner', () => {
  assert.equal(messages.bannerFor(undefined), messages.banner());
});

test('displayWidth counts the panda as two cells', () => {
  assert.equal(messages.displayWidth('ab'), 2);
  assert.equal(messages.displayWidth('🐼'), 2);
  assert.equal(messages.displayWidth('  🐼  x'), 7);
});

/**
 * Walk up from a starting directory until a directory containing package.json is
 * found. Counting `..` segments is brittle: it silently depends on whether the test
 * is running from source or from `dist-tests/`, and on where that output directory
 * happens to sit.
 */
function repoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repository root from ${from}`);
}

test('the tagline matches the README, so the two cannot drift', () => {
  const readme = readFileSync(join(repoRoot(SRC), 'README.md'), 'utf8');
  assert.match(
    readme,
    new RegExp(`\\*${messages.TAGLINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*`),
    `README tagline does not match messages.TAGLINE ("${messages.TAGLINE}")`,
  );
});

test('the banner fits inside an 80-column terminal', () => {
  const widest = Math.max(...messages.banner().split('\n').map(messages.displayWidth));
  assert.ok(widest <= 72, `widest line is ${widest} columns; must leave room at 80`);
});

test('the compact banner fits a genuinely narrow terminal', () => {
  const widest = Math.max(...messages.compactBanner().split('\n').map(messages.displayWidth));
  assert.ok(widest <= 40, `compact banner is ${widest} columns`);
});
