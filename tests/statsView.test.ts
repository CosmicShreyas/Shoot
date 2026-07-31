import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAR_WIDTH,
  DEFAULT_DAYS,
  OUTCOME_LABELS,
  OUTCOME_ORDER,
  SPARK_CHARS,
  SPARK_EMPTY,
  bucketByDay,
  dayKey,
  formatPercent,
  outcomeSlices,
  rangeLabel,
  recentTimeline,
  sparkChar,
  sparkline,
} from '../src/core/statsView.js';
import type { HistoryEntry, HistoryOutcome } from '../src/core/history.js';

/**
 * The numbers are what matter here. Rendering with colour is exercised by
 * colors.test.ts and by eye; the bucketing, percentages, and character selection
 * are the parts that can be silently wrong.
 */

function entry(at: string, outcome: HistoryOutcome = 'passed', claim?: string): HistoryEntry {
  return {
    at,
    outcome,
    sessionId: 's1',
    checks: ['test'],
    ...(claim !== undefined ? { claim } : {}),
  };
}

const NOW = new Date('2026-08-01T12:00:00Z');

// ---------------------------------------------------------------------------
// Day bucketing
// ---------------------------------------------------------------------------

test('dayKey extracts a UTC calendar day', () => {
  assert.equal(dayKey('2026-08-01T23:59:59Z'), '2026-08-01');
  assert.equal(dayKey('2026-08-01T00:00:00Z'), '2026-08-01');
});

test('dayKey returns empty for an unparseable timestamp', () => {
  assert.equal(dayKey('not a date'), '');
});

test('bucketByDay always returns exactly `days` buckets, including empty ones', () => {
  // A sparkline that omitted quiet days would misrepresent the shape of activity.
  const buckets = bucketByDay([], 7, NOW);
  assert.equal(buckets.length, 7);
  assert.ok(buckets.every((b) => b.count === 0));
});

test('bucketByDay returns buckets in chronological order ending today', () => {
  const buckets = bucketByDay([], 3, NOW);
  assert.deepEqual(
    buckets.map((b) => b.day),
    ['2026-07-30', '2026-07-31', '2026-08-01'],
  );
});

test('bucketByDay counts entries into the right day', () => {
  const buckets = bucketByDay(
    [
      entry('2026-08-01T01:00:00Z'),
      entry('2026-08-01T23:00:00Z'),
      entry('2026-07-31T12:00:00Z'),
    ],
    3,
    NOW,
  );

  assert.equal(buckets[2]?.count, 2, 'two entries today');
  assert.equal(buckets[1]?.count, 1, 'one yesterday');
  assert.equal(buckets[0]?.count, 0, 'none the day before');
});

test('bucketByDay ignores entries outside the window', () => {
  const buckets = bucketByDay([entry('2026-01-01T00:00:00Z')], 7, NOW);
  assert.equal(
    buckets.reduce((n, b) => n + b.count, 0),
    0,
    'an old entry must not be counted into the nearest bucket',
  );
});

test('bucketByDay ignores unparseable timestamps rather than throwing', () => {
  assert.doesNotThrow(() => bucketByDay([entry('garbage')], 7, NOW));
  const buckets = bucketByDay([entry('garbage')], 7, NOW);
  assert.equal(
    buckets.reduce((n, b) => n + b.count, 0),
    0,
  );
});

test('bucketByDay clamps a nonsense window to at least one day', () => {
  assert.equal(bucketByDay([], 0, NOW).length, 1);
  assert.equal(bucketByDay([], -5, NOW).length, 1);
});

test('the default window is 14 days', () => {
  assert.equal(DEFAULT_DAYS, 14);
  assert.equal(bucketByDay([], undefined, NOW).length, 14);
});

// ---------------------------------------------------------------------------
// Sparkline character selection
// ---------------------------------------------------------------------------

test('zero maps to the empty marker, not to the shortest bar', () => {
  // A day with no activity and a day with one verification must look different.
  assert.equal(sparkChar(0, 10), SPARK_EMPTY);
  assert.notEqual(sparkChar(1, 10), SPARK_EMPTY);
});

test('any non-zero count is visible', () => {
  // Even 1-out-of-1000 should render as the shortest bar rather than vanish.
  assert.equal(sparkChar(1, 1000), SPARK_CHARS[0]);
});

test('the maximum maps to the tallest bar', () => {
  assert.equal(sparkChar(10, 10), SPARK_CHARS[SPARK_CHARS.length - 1]);
});

test('sparkChar scales monotonically', () => {
  const max = 8;
  let previousIndex = -1;
  for (let count = 1; count <= max; count++) {
    const index = SPARK_CHARS.indexOf(sparkChar(count, max) as (typeof SPARK_CHARS)[number]);
    assert.ok(index >= previousIndex, `count ${count} should not go backwards`);
    previousIndex = index;
  }
});

test('sparkChar handles a zero maximum without dividing by zero', () => {
  assert.equal(sparkChar(0, 0), SPARK_EMPTY);
  assert.equal(sparkChar(5, 0), SPARK_EMPTY);
});

test('sparkline renders one character per bucket', () => {
  const buckets = bucketByDay([entry('2026-08-01T00:00:00Z')], 5, NOW);
  const line = sparkline(buckets);
  assert.equal([...line].length, 5);
});

test('sparkline of an empty history is all empty markers', () => {
  const line = sparkline(bucketByDay([], 5, NOW));
  assert.equal(line, SPARK_EMPTY.repeat(5));
});

// ---------------------------------------------------------------------------
// Outcome breakdown
// ---------------------------------------------------------------------------

test('outcomeSlices counts and shares are correct', () => {
  const slices = outcomeSlices([
    entry('2026-08-01T00:00:00Z', 'passed'),
    entry('2026-08-01T00:00:00Z', 'passed'),
    entry('2026-08-01T00:00:00Z', 'blocked'),
    entry('2026-08-01T00:00:00Z', 'skipped'),
  ]);

  const passed = slices.find((s) => s.outcome === 'passed');
  const blocked = slices.find((s) => s.outcome === 'blocked');

  assert.equal(passed?.count, 2);
  assert.ok(Math.abs((passed?.share ?? 0) - 0.5) < 1e-9);
  assert.equal(blocked?.count, 1);
  assert.ok(Math.abs((blocked?.share ?? 0) - 0.25) < 1e-9);
});

test('shares sum to 1 across all slices', () => {
  const entries: HistoryEntry[] = [
    ...Array.from({ length: 7 }, () => entry('2026-08-01T00:00:00Z', 'passed')),
    ...Array.from({ length: 3 }, () => entry('2026-08-01T00:00:00Z', 'blocked')),
    entry('2026-08-01T00:00:00Z', 'untrusted'),
  ];
  const total = outcomeSlices(entries).reduce((sum, s) => sum + s.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}`);
});

test('bar width is scaled to the largest slice, not the total', () => {
  // Scaling to the total would squash everything when one outcome dominates.
  const slices = outcomeSlices(
    [
      ...Array.from({ length: 100 }, () => entry('2026-08-01T00:00:00Z', 'passed')),
      entry('2026-08-01T00:00:00Z', 'blocked'),
    ],
    BAR_WIDTH,
  );

  const passed = slices.find((s) => s.outcome === 'passed');
  const blocked = slices.find((s) => s.outcome === 'blocked');

  assert.equal(passed?.width, BAR_WIDTH, 'the largest slice fills the bar');
  assert.ok((blocked?.width ?? 0) >= 1, 'a tiny slice is still visible');
});

test('outcomes that never happened get no row', () => {
  const slices = outcomeSlices([entry('2026-08-01T00:00:00Z', 'passed')]);
  assert.equal(slices.length, 1);
  assert.equal(slices[0]?.outcome, 'passed');
});

test('outcomeSlices on an empty history is empty, not a divide-by-zero', () => {
  assert.deepEqual(outcomeSlices([]), []);
});

test('rows follow OUTCOME_ORDER, not insertion order', () => {
  const slices = outcomeSlices([
    entry('2026-08-01T00:00:00Z', 'skipped'),
    entry('2026-08-01T00:00:00Z', 'blocked'),
    entry('2026-08-01T00:00:00Z', 'passed'),
  ]);

  const order = slices.map((s) => s.outcome);
  const expected = OUTCOME_ORDER.filter((o) => order.includes(o));
  assert.deepEqual(order, expected);
});

test('every outcome has a label', () => {
  for (const outcome of OUTCOME_ORDER) {
    assert.ok(OUTCOME_LABELS[outcome]?.trim() !== '', `${outcome} needs a label`);
  }
});

// ---------------------------------------------------------------------------
// Percentages
// ---------------------------------------------------------------------------

test('formatPercent rounds to whole numbers', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(1), '100%');
  assert.equal(formatPercent(1 / 3), '33%');
  assert.equal(formatPercent(2 / 3), '67%');
  assert.equal(formatPercent(0.005), '1%', 'rounds up at the boundary');
});

test('formatPercent handles a non-finite share', () => {
  assert.equal(formatPercent(Number.NaN), '—');
  assert.equal(formatPercent(Number.POSITIVE_INFINITY), '—');
});

// ---------------------------------------------------------------------------
// Relative time and timeline
// ---------------------------------------------------------------------------

test('relativeTime buckets coarsely and readably', async () => {
  const { relativeTime } = await import('../src/core/statsView.js');

  assert.equal(relativeTime('2026-08-01T11:59:30Z', NOW), 'just now');
  assert.equal(relativeTime('2026-08-01T11:30:00Z', NOW), '30m ago');
  assert.equal(relativeTime('2026-08-01T09:00:00Z', NOW), '3h ago');
  assert.equal(relativeTime('2026-07-29T12:00:00Z', NOW), '3d ago');
  assert.equal(relativeTime('2026-06-01T12:00:00Z', NOW), '2mo ago');
  assert.equal(relativeTime('2024-08-01T12:00:00Z', NOW), '2y ago');
});

test('relativeTime does not print a negative age on clock skew', async () => {
  const { relativeTime } = await import('../src/core/statsView.js');
  assert.equal(relativeTime('2026-08-02T12:00:00Z', NOW), 'just now');
});

test('relativeTime handles an unparseable timestamp', async () => {
  const { relativeTime } = await import('../src/core/statsView.js');
  assert.equal(relativeTime('garbage', NOW), 'unknown');
});

test('recentTimeline returns the newest entries first', () => {
  const items = recentTimeline(
    [
      entry('2026-07-30T00:00:00Z', 'passed'),
      entry('2026-08-01T00:00:00Z', 'blocked'),
      entry('2026-07-31T00:00:00Z', 'passed'),
    ],
    10,
    NOW,
  );

  assert.deepEqual(
    items.map((i) => i.at),
    ['2026-08-01T00:00:00Z', '2026-07-31T00:00:00Z', '2026-07-30T00:00:00Z'],
  );
});

test('recentTimeline respects the limit', () => {
  const entries = Array.from({ length: 25 }, (_, i) =>
    entry(`2026-08-01T00:00:${String(i).padStart(2, '0')}Z`),
  );
  assert.equal(recentTimeline(entries, 10, NOW).length, 10);
  assert.equal(recentTimeline(entries, 0, NOW).length, 0);
});

test('recentTimeline carries the claim phrase when present', () => {
  const items = recentTimeline([entry('2026-08-01T00:00:00Z', 'passed', 'tests pass')], 5, NOW);
  assert.equal(items[0]?.claim, 'tests pass');
});

test('recentTimeline omits claim when absent, rather than emitting undefined', () => {
  const items = recentTimeline([entry('2026-08-01T00:00:00Z')], 5, NOW);
  assert.equal('claim' in (items[0] ?? {}), false);
});

// ---------------------------------------------------------------------------
// Range label
// ---------------------------------------------------------------------------

test('rangeLabel spans first to last bucket', () => {
  const label = rangeLabel(bucketByDay([], 3, NOW));
  assert.match(label, /Jul 30/);
  assert.match(label, /Aug 1/);
});

test('rangeLabel collapses a single-day range', () => {
  const label = rangeLabel(bucketByDay([], 1, NOW));
  assert.equal(label, 'Aug 1');
});

test('rangeLabel on no buckets is empty, not a crash', () => {
  assert.equal(rangeLabel([]), '');
});
