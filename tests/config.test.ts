import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  MAX_BLOCKS_CEILING,
  configExists,
  configPath,
  hasAnyCheck,
  loadConfig,
  normalizeConfig,
  saveConfig,
} from '../src/core/config.js';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-config-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults match the documented schema', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'block');
  assert.equal(DEFAULT_CONFIG.timeoutSeconds, 120);
  assert.equal(DEFAULT_CONFIG.maxBlocksPerSession, 3);
  assert.equal(DEFAULT_CONFIG.verifySubagents, true);
});

test('the default block limit stays well under Claude Code native 8-block cap', () => {
  assert.ok(
    DEFAULT_CONFIG.maxBlocksPerSession < 8,
    'must stand down before Claude Code force-ends the session',
  );
  assert.ok(MAX_BLOCKS_CEILING < 8, 'the ceiling itself must stay under 8');
});

test('round-trips through disk', () => {
  withTempDir((dir) => {
    const cfg = {
      ...DEFAULT_CONFIG,
      mode: 'warn' as const,
      checks: { test: 'npm test', lint: 'npm run lint', typecheck: '', build: '' },
      timeoutSeconds: 45,
    };
    saveConfig(dir, cfg);

    assert.equal(configExists(dir), true);
    assert.deepEqual(loadConfig(dir), cfg);
    assert.equal(configPath(dir), join(dir, CONFIG_FILENAME));
  });
});

test('a missing config loads defaults rather than throwing', () => {
  withTempDir((dir) => {
    assert.equal(configExists(dir), false);
    assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  });
});

test('a corrupt config loads defaults rather than throwing', () => {
  withTempDir((dir) => {
    writeFileSync(configPath(dir), '{ this is not valid json', 'utf8');
    assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  });
});

test('partial config is filled in with defaults', () => {
  const cfg = normalizeConfig({ checks: { test: 'npm test' } });
  assert.equal(cfg.checks.test, 'npm test');
  assert.equal(cfg.checks.lint, '');
  assert.equal(cfg.timeoutSeconds, 120);
  assert.equal(cfg.mode, 'block');
});

test('invalid values fall back instead of propagating', () => {
  const cfg = normalizeConfig({
    mode: 'nonsense',
    timeoutSeconds: -5,
    maxBlocksPerSession: 'many',
    checks: 'not an object',
  });
  assert.equal(cfg.mode, 'block');
  assert.equal(cfg.timeoutSeconds, 120);
  assert.equal(cfg.maxBlocksPerSession, 3);
  assert.deepEqual(cfg.checks, DEFAULT_CONFIG.checks);
});

test('maxBlocksPerSession is capped at the ceiling', () => {
  assert.equal(normalizeConfig({ maxBlocksPerSession: 99 }).maxBlocksPerSession, MAX_BLOCKS_CEILING);
});

test('mode accepts only block or warn', () => {
  assert.equal(normalizeConfig({ mode: 'warn' }).mode, 'warn');
  assert.equal(normalizeConfig({ mode: 'block' }).mode, 'block');
  assert.equal(normalizeConfig({ mode: 'BLOCK' }).mode, 'block');
});

test('verifySubagents defaults true and only false disables it', () => {
  assert.equal(normalizeConfig({}).verifySubagents, true);
  assert.equal(normalizeConfig({ verifySubagents: false }).verifySubagents, false);
  assert.equal(normalizeConfig({ verifySubagents: 'no' }).verifySubagents, true);
});

test('check commands are trimmed', () => {
  const cfg = normalizeConfig({ checks: { test: '  npm test  ' } });
  assert.equal(cfg.checks.test, 'npm test');
});

test('hasAnyCheck distinguishes configured from empty', () => {
  assert.equal(hasAnyCheck(DEFAULT_CONFIG), false);
  assert.equal(
    hasAnyCheck({ ...DEFAULT_CONFIG, checks: { test: 'npm test', lint: '', typecheck: '', build: '' } }),
    true,
  );
  assert.equal(
    hasAnyCheck({ ...DEFAULT_CONFIG, checks: { test: '   ', lint: '', typecheck: '', build: '' } }),
    false,
  );
});
