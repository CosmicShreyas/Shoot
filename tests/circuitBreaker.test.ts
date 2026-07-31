import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_STATE_AGE_MS,
  cleanupStaleState,
  peek,
  recordBlock,
  reset,
  sessionFilePath,
  stateDir,
} from '../src/core/circuitBreaker.js';

/** Fresh temp project dir per test, always cleaned up. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'shoot-breaker-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MAX = 3;

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('counts consecutive blocks for the same failure', () => {
  withTempDir((dir) => {
    assert.equal(recordBlock(dir, 's1', 'test:failed:1', MAX).consecutiveBlocks, 1);
    assert.equal(recordBlock(dir, 's1', 'test:failed:1', MAX).consecutiveBlocks, 2);
    assert.equal(recordBlock(dir, 's1', 'test:failed:1', MAX).consecutiveBlocks, 3);
  });
});

test('sessions are counted independently', () => {
  withTempDir((dir) => {
    recordBlock(dir, 'session-a', 'test:failed:1', MAX);
    recordBlock(dir, 'session-a', 'test:failed:1', MAX);
    const b = recordBlock(dir, 'session-b', 'test:failed:1', MAX);

    assert.equal(b.consecutiveBlocks, 1, 'session-b must start fresh');
    assert.equal(peek(dir, 'session-a')?.consecutiveBlocks, 2);
  });
});

test('a different failure resets the count to 1', () => {
  withTempDir((dir) => {
    recordBlock(dir, 's1', 'test:failed:1', MAX);
    recordBlock(dir, 's1', 'test:failed:1', MAX);

    const moved = recordBlock(dir, 's1', 'lint:failed:1', MAX);
    assert.equal(moved.consecutiveBlocks, 1, 'new failure means real progress');
    assert.equal(moved.tripped, false);
  });
});

// ---------------------------------------------------------------------------
// THE transition: 3rd consecutive block flips to allow-but-warn
// ---------------------------------------------------------------------------

test('the 3rd consecutive block trips: allow, but warn loudly', () => {
  withTempDir((dir) => {
    const first = recordBlock(dir, 's1', 'test:failed:1', 3);
    assert.equal(first.tripped, false, 'block 1 still blocks');

    const second = recordBlock(dir, 's1', 'test:failed:1', 3);
    assert.equal(second.tripped, false, 'block 2 still blocks');

    const third = recordBlock(dir, 's1', 'test:failed:1', 3);
    assert.equal(third.tripped, true, 'block 3 must stand down');
    assert.equal(third.consecutiveBlocks, 3);
  });
});

test('stays tripped after the limit, never resuming blocking', () => {
  withTempDir((dir) => {
    for (let i = 0; i < 3; i++) recordBlock(dir, 's1', 'test:failed:1', 3);
    const fourth = recordBlock(dir, 's1', 'test:failed:1', 3);
    const fifth = recordBlock(dir, 's1', 'test:failed:1', 3);

    assert.equal(fourth.tripped, true);
    assert.equal(fifth.tripped, true);
  });
});

test('the limit is configurable via maxBlocksPerSession', () => {
  withTempDir((dir) => {
    assert.equal(recordBlock(dir, 's1', 'k', 1).tripped, true, 'limit 1 trips immediately');
  });

  withTempDir((dir) => {
    assert.equal(recordBlock(dir, 's2', 'k', 5).tripped, false);
    for (let i = 0; i < 3; i++) recordBlock(dir, 's2', 'k', 5);
    assert.equal(recordBlock(dir, 's2', 'k', 5).tripped, true, 'trips on the 5th');
  });
});

test('a limit of 0 disables blocking entirely', () => {
  withTempDir((dir) => {
    assert.equal(recordBlock(dir, 's1', 'k', 0).tripped, true);
  });
});

// ---------------------------------------------------------------------------
// Persistence across genuinely separate processes
// ---------------------------------------------------------------------------

test('block counts survive across separate processes (real hook conditions)', () => {
  withTempDir((dir) => {
    // Each Stop hook event is a new process, so exercise that for real: spawn
    // three independent node processes that each record one block.
    const modulePath = fileURLToPath(
      new URL('../src/core/circuitBreaker.js', import.meta.url),
    ).replace(/\\/g, '/');

    const script = (d: string): string =>
      `import('file:///${modulePath}').then(m => {` +
      `const r = m.recordBlock(${JSON.stringify(d)}, 'persisted-session', 'test:failed:1', 3);` +
      `process.stdout.write(JSON.stringify(r));})`;

    const runs = [1, 2, 3].map(() => {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script(dir)], {
        encoding: 'utf8',
      });
      return JSON.parse(out) as { tripped: boolean; consecutiveBlocks: number };
    });

    assert.deepEqual(
      runs.map((r) => r.consecutiveBlocks),
      [1, 2, 3],
      'count must accumulate across processes, not restart at 1',
    );
    assert.deepEqual(
      runs.map((r) => r.tripped),
      [false, false, true],
      'third separate process must trip the breaker',
    );
  });
});

test('state is written to a file on disk under .shoot/', () => {
  withTempDir((dir) => {
    recordBlock(dir, 's1', 'test:failed:1', MAX);

    const file = sessionFilePath(dir, 's1');
    assert.ok(existsSync(file), 'expected a persisted state file');
    assert.match(file, /[\\/]\.shoot[\\/]sessions[\\/]/);
  });
});

test('session ids are hashed, so odd ids cannot escape the state dir', () => {
  withTempDir((dir) => {
    const nasty = '../../../etc/passwd';
    recordBlock(dir, nasty, 'k', MAX);

    const file = sessionFilePath(dir, nasty);
    assert.ok(file.startsWith(stateDir(dir)), 'must stay inside the state dir');
    assert.doesNotMatch(file, /\.\./);
    assert.equal(peek(dir, nasty)?.consecutiveBlocks, 1);
  });
});

// ---------------------------------------------------------------------------
// Reset and corruption tolerance
// ---------------------------------------------------------------------------

test('reset clears a session so the next failure starts fresh', () => {
  withTempDir((dir) => {
    recordBlock(dir, 's1', 'k', MAX);
    recordBlock(dir, 's1', 'k', MAX);
    reset(dir, 's1');

    assert.equal(peek(dir, 's1'), null);
    assert.equal(recordBlock(dir, 's1', 'k', MAX).consecutiveBlocks, 1);
  });
});

test('reset on an unknown session is a no-op, not an error', () => {
  withTempDir((dir) => {
    assert.doesNotThrow(() => reset(dir, 'never-seen'));
  });
});

test('corrupt state is treated as a fresh session, never a crash', () => {
  withTempDir((dir) => {
    recordBlock(dir, 's1', 'k', MAX);
    writeFileSync(sessionFilePath(dir, 's1'), '{not valid json', 'utf8');

    assert.equal(peek(dir, 's1'), null);
    const decision = recordBlock(dir, 's1', 'k', MAX);
    assert.equal(decision.consecutiveBlocks, 1);
  });
});

test('peek on an unknown session returns null', () => {
  withTempDir((dir) => {
    assert.equal(peek(dir, 'nobody'), null);
  });
});

// ---------------------------------------------------------------------------
// Cleanup, so .shoot/ does not grow unbounded
// ---------------------------------------------------------------------------

test('state older than the max age is deleted', () => {
  withTempDir((dir) => {
    recordBlock(dir, 'old-session', 'k', MAX);
    const file = sessionFilePath(dir, 'old-session');

    // Backdate the file well past the max age.
    const ancient = (Date.now() - MAX_STATE_AGE_MS - 60_000) / 1000;
    utimesSync(file, ancient, ancient);

    const removed = cleanupStaleState(dir);
    assert.equal(removed, 1);
    assert.equal(existsSync(file), false);
  });
});

test('fresh state is kept by cleanup', () => {
  withTempDir((dir) => {
    recordBlock(dir, 'new-session', 'k', MAX);
    assert.equal(cleanupStaleState(dir), 0);
    assert.ok(existsSync(sessionFilePath(dir, 'new-session')));
  });
});

test('recording a block prunes stale sessions as a side effect', () => {
  withTempDir((dir) => {
    recordBlock(dir, 'stale', 'k', MAX);
    const staleFile = sessionFilePath(dir, 'stale');
    const ancient = (Date.now() - MAX_STATE_AGE_MS - 60_000) / 1000;
    utimesSync(staleFile, ancient, ancient);

    recordBlock(dir, 'current', 'k', MAX);

    assert.equal(existsSync(staleFile), false, 'stale session should be pruned');
    assert.equal(readdirSync(stateDir(dir)).length, 1);
  });
});

test('cleanup on a missing directory is a no-op', () => {
  withTempDir((dir) => {
    assert.equal(cleanupStaleState(join(dir, 'nope')), 0);
  });
});
