#!/usr/bin/env node
/**
 * Drives the CLI-only demo scenario end to end, in a disposable temp project.
 *
 * WHY THIS EXISTS
 *
 * Recording a terminal GIF programmatically needs asciinema, which needs a POSIX
 * pty. There is no pty on Windows — asciinema's recorder imports `fcntl` and fails
 * outright — and no WSL distro is installed here to borrow one from. So the capture
 * itself stays manual (ScreenToGif; see DEMO.md).
 *
 * What CAN be automated is everything else: this script performs every step of the
 * scenario in the right order, with pauses long enough to read, so recording is
 * "start ScreenToGif, run this one command, stop ScreenToGif". No typing on camera,
 * no missed steps, no half-finished takes.
 *
 * Run it from the repo root:
 *
 *   node scripts/demo-cli.mjs
 *
 * It builds first, works in a fresh temp directory, and cleans up after itself. It
 * never touches this repository's own .shoot state.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const CLI = join(REPO, 'dist', 'cli.js');

/** Beat between steps, so a viewer can read before the next command runs. */
const BEAT = Number(process.env['DEMO_BEAT'] ?? 1800);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Print a prompt line the way a person typing it would look. */
function prompt(command) {
  process.stdout.write(`\x1b[90m$\x1b[0m \x1b[1m${command}\x1b[0m\n`);
}

/** Run a shoot command in the demo project, inheriting stdio so colour survives. */
function shoot(cwd, args, { expectFail = false } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    stdio: 'inherit',
    // Force colour: stdio:'inherit' means the child sees the recorder's terminal,
    // but be explicit so a non-TTY capture still produces a colourful GIF.
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  if (!expectFail && result.status !== 0) {
    throw new Error(`shoot ${args.join(' ')} exited ${result.status}`);
  }
  return result.status ?? 0;
}

async function step(label, fn) {
  process.stdout.write(`\n\x1b[36m# ${label}\x1b[0m\n`);
  await sleep(BEAT / 2);
  await fn();
  await sleep(BEAT);
}

async function main() {
  process.stdout.write('\x1b[1mBuilding Shoot first...\x1b[0m\n');
  // Invoke tsc directly rather than through npm: `shell: true` with args triggers a
  // Node deprecation warning that would show up on camera.
  execFileSync(process.execPath, [join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')], {
    cwd: REPO,
    stdio: 'ignore',
  });

  const dir = mkdtempSync(join(tmpdir(), 'shoot-demo-'));

  try {
    // A small real project with a genuinely failing test.
    //
    // Every script `shoot init` might configure exists here and actually runs. If the
    // project declared only `test` but init configured `build` too — which happens the
    // moment someone types an answer at an interactive prompt — `doctor` would
    // correctly report a missing script, and that FAIL would land immediately after
    // "All set". It reads as a broken demo rather than as the tool working, and it
    // spoils the healthy-doctor beat that the deliberate test failure plays against.
    //
    // `lint` is deliberately absent: init leaves it blank, which exercises the
    // "empty command is skipped, not failed" behaviour worth showing.
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'demo',
          version: '1.0.0',
          type: 'module',
          scripts: {
            test: 'node --test',
            // Trivial but real — they exit 0 and cost nothing on camera.
            typecheck: 'node --check sum.js',
            build: 'node -e "console.log(\'built\')"',
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(dir, 'sum.js'),
      'export function add(a, b) {\n  return a - b; // BUG: should be a + b\n}\n',
    );
    writeFileSync(
      join(dir, 'sum.test.js'),
      'import test from "node:test";\n' +
        'import assert from "node:assert";\n' +
        'import { add } from "./sum.js";\n\n' +
        'test("adds two numbers", () => {\n  assert.equal(add(2, 2), 4);\n});\n',
    );
    mkdirSync(join(dir, '.claude'), { recursive: true });

    process.stdout.write(`\n\x1b[1m🐼 shoot — CLI walkthrough\x1b[0m\n`);
    await sleep(BEAT);

    await step('Install into a project', async () => {
      prompt('npx shoot-cc init');
      shoot(dir, ['init']);
    });

    await step('Everything healthy?', async () => {
      prompt('shoot doctor');
      shoot(dir, ['doctor']);
    });

    await step('Run the checks for real — this project has a genuine bug', async () => {
      prompt('shoot verify');
      shoot(dir, ['verify'], { expectFail: true });
    });

    await step('Now someone edits the committed config...', async () => {
      const configPath = join(dir, '.shoot.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      // The same PWNED-style injection used in the earlier manual verification.
      config.checks.test =
        'npm test && node -e "require(\'fs\').writeFileSync(\'PWNED.txt\',\'exfiltrated\')"';
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      prompt('cat .shoot.config.json   # a one-line diff, nothing that looks like code');
      process.stdout.write(`  "test": "${config.checks.test}"\n`);
    });

    await step('Shoot notices, and refuses to run it', async () => {
      prompt('shoot doctor');
      shoot(dir, ['doctor'], { expectFail: true });
    });

    await step('Review the change before approving anything', async () => {
      prompt('shoot trust');
      // Non-interactive stdin declines by default — which is the point.
      shoot(dir, ['trust'], { expectFail: true });
    });

    await step('The injected command never executed', async () => {
      prompt('ls PWNED.txt');
      const exists = spawnSync(process.execPath, ['-e', "process.exit(require('fs').existsSync('PWNED.txt')?0:1)"], {
        cwd: dir,
      }).status === 0;
      process.stdout.write(
        exists
          ? '\x1b[31m  PWNED.txt exists — mitigation failed\x1b[0m\n'
          : '\x1b[32m  ls: PWNED.txt: No such file or directory\x1b[0m\n',
      );
    });

    await step('Fix the real bug, and the checks pass', async () => {
      // Restore the approved command, then fix the code.
      const configPath = join(dir, '.shoot.config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      config.checks.test = 'npm test';
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      shoot(dir, ['trust', '--yes']);

      writeFileSync(join(dir, 'sum.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
      prompt('shoot verify');
      shoot(dir, ['verify']);
    });

    await step('A fortnight of history, for the dashboard', async () => {
      // Seeded, and DEMO.md says so — passing this off as organic usage would be
      // exactly the kind of unverified claim this project exists to stop.
      const now = Date.now();
      const rows = [];
      const plan = [
        [13, 1, 'passed'], [12, 2, 'blocked'], [12, 1, 'passed'], [9, 3, 'passed'],
        [8, 1, 'blocked'], [8, 2, 'blocked'], [8, 4, 'passed'], [5, 1, 'passed'],
        [4, 2, 'untrusted'], [3, 1, 'passed'], [3, 5, 'blocked'], [2, 1, 'passed'],
        [2, 3, 'warned'], [1, 2, 'passed'], [1, 4, 'passed'], [0, 2, 'blocked'],
        [0, 4, 'passed'], [0, 6, 'passed'],
      ];
      for (const [d, h, outcome] of plan) {
        rows.push({
          at: new Date(now - d * 86_400_000 - h * 3_600_000).toISOString(),
          outcome,
          sessionId: `s${d % 3}`,
          checks: ['test'],
          claim: outcome === 'blocked' ? 'all tests pass' : 'fixed it',
        });
      }
      mkdirSync(join(dir, '.shoot'), { recursive: true });

      // Preserve any real history if present. `shoot verify` does not write
      // history — only the hook does — so on a fresh project there is none yet.
      const historyFile = join(dir, '.shoot', 'history.jsonl');
      let existing = '';
      try {
        existing = readFileSync(historyFile, 'utf8');
      } catch {
        existing = '';
      }
      writeFileSync(historyFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n${existing}`);
      prompt('shoot stats');
      shoot(dir, ['stats']);
    });

    process.stdout.write(`\n\x1b[32m\x1b[1m🐼 That's the CLI. Stop the recording here.\x1b[0m\n\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`demo script failed: ${err.message}\n`);
  process.exit(1);
});
