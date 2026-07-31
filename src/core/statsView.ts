/**
 * Data shaping for the `shoot stats` dashboard.
 *
 * Pure functions only — no rendering, no color, no I/O. The numbers are the part
 * worth testing; how they look is not. `commands/stats.ts` does the drawing.
 *
 * HUMAN CHANNEL ONLY. `shoot stats` is never invoked by an agent, so its output is
 * free to use color and block-drawing characters. See the two-channel rule in
 * `mascot/colors.ts`.
 */

import type { HistoryEntry, HistoryOutcome } from './history.js';

/** Sparkline ramp, ascending. Index 0 is the shortest visible bar. */
export const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Shown for a day with zero activity — deliberately not a spark character. */
export const SPARK_EMPTY = '·';

/** Default window for the activity sparkline. */
export const DEFAULT_DAYS = 14;

/** Character the horizontal outcome bars are built from. */
export const BAR_CHAR = '█';

/** Width of the longest outcome bar, in characters. */
export const BAR_WIDTH = 24;

export interface DayBucket {
  /** `YYYY-MM-DD` in UTC. */
  day: string;
  count: number;
}

export interface OutcomeSlice {
  outcome: HistoryOutcome;
  /** Human-readable label for the row. */
  label: string;
  count: number;
  /** Share of the total, 0..1. */
  share: number;
  /** Bar width in characters, proportional to the largest slice. */
  width: number;
}

export interface TimelineItem {
  at: string;
  outcome: HistoryOutcome;
  /** e.g. "3h ago", "just now", "5d ago". */
  relative: string;
  /** The claim phrase, when one was recorded. */
  claim?: string;
}

/** Row labels. Kept here so the dashboard and its tests agree on wording. */
export const OUTCOME_LABELS: Readonly<Record<HistoryOutcome, string>> = {
  passed: 'passed',
  blocked: 'blocked',
  warned: 'warned only',
  stoodDown: 'stood down',
  skipped: 'no checks set',
  untrusted: 'config untrusted',
};

/** Order rows appear in. Most consequential first. */
export const OUTCOME_ORDER: readonly HistoryOutcome[] = [
  'passed',
  'blocked',
  'warned',
  'stoodDown',
  'untrusted',
  'skipped',
];

/** UTC `YYYY-MM-DD` for a timestamp. */
export function dayKey(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Bucket entries into the last `days` calendar days, inclusive of today.
 *
 * Always returns exactly `days` buckets in chronological order, including empty
 * ones — a sparkline with gaps omitted would misrepresent the shape of activity.
 * Entries older than the window, or with unparseable timestamps, are ignored.
 */
export function bucketByDay(
  entries: readonly HistoryEntry[],
  days: number = DEFAULT_DAYS,
  now: Date = new Date(),
): DayBucket[] {
  const span = Math.max(1, Math.floor(days));

  // Build the window first so empty days are present.
  const buckets: DayBucket[] = [];
  const index = new Map<string, number>();
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = dayKey(d);
    index.set(key, buckets.length);
    buckets.push({ day: key, count: 0 });
  }

  for (const entry of entries) {
    const key = dayKey(entry.at);
    const at = index.get(key);
    if (at !== undefined) {
      const bucket = buckets[at];
      if (bucket !== undefined) bucket.count += 1;
    }
  }

  return buckets;
}

/**
 * Map a count onto a sparkline character.
 *
 * Zero is distinct from "smallest non-zero" on purpose: a day with no activity and
 * a day with one verification should not look the same.
 */
export function sparkChar(count: number, max: number): string {
  if (count <= 0) return SPARK_EMPTY;
  if (max <= 0) return SPARK_EMPTY;

  // Scale into 1..8 so any non-zero count is visible.
  const ratio = Math.min(1, count / max);
  const step = Math.ceil(ratio * SPARK_CHARS.length);
  const clamped = Math.min(SPARK_CHARS.length, Math.max(1, step));
  return SPARK_CHARS[clamped - 1] ?? SPARK_EMPTY;
}

/** Render buckets as a sparkline string (no color — the caller adds that). */
export function sparkline(buckets: readonly DayBucket[]): string {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  return buckets.map((b) => sparkChar(b.count, max)).join('');
}

/**
 * Break entries down by outcome.
 *
 * `share` is over the total number of entries. `width` is scaled to the LARGEST
 * slice rather than to the total, so a dominant outcome doesn't squash the rest into
 * invisibility — the percentage carries the absolute meaning.
 */
export function outcomeSlices(
  entries: readonly HistoryEntry[],
  barWidth: number = BAR_WIDTH,
): OutcomeSlice[] {
  const total = entries.length;
  if (total === 0) return [];

  const counts = new Map<HistoryOutcome, number>();
  for (const e of entries) {
    counts.set(e.outcome, (counts.get(e.outcome) ?? 0) + 1);
  }

  const largest = Math.max(...[...counts.values()], 0);

  const slices: OutcomeSlice[] = [];
  for (const outcome of OUTCOME_ORDER) {
    const count = counts.get(outcome) ?? 0;
    if (count === 0) continue; // Don't show rows for things that never happened.

    slices.push({
      outcome,
      label: OUTCOME_LABELS[outcome],
      count,
      share: count / total,
      width: largest > 0 ? Math.max(1, Math.round((count / largest) * barWidth)) : 0,
    });
  }
  return slices;
}

/** Format a share as a whole-number percentage string. */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share)) return '—';
  return `${Math.round(share * 100)}%`;
}

/**
 * Human-readable age. Deliberately coarse: for scanning a list, "3h ago" is more
 * useful than a precise duration.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'unknown';

  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (seconds < 0) return 'just now'; // Clock skew; don't print a negative age.
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

/** The most recent `limit` entries, newest first. */
export function recentTimeline(
  entries: readonly HistoryEntry[],
  limit = 10,
  now: Date = new Date(),
): TimelineItem[] {
  return [...entries]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(0, limit))
    .map((e) => ({
      at: e.at,
      outcome: e.outcome,
      relative: relativeTime(e.at, now),
      ...(e.claim !== undefined ? { claim: e.claim } : {}),
    }));
}

/** Label for the sparkline's date range, e.g. "Jul 19 – Aug 1". */
export function rangeLabel(buckets: readonly DayBucket[]): string {
  const first = buckets[0]?.day;
  const last = buckets[buckets.length - 1]?.day;
  if (first === undefined || last === undefined) return '';

  const fmt = (day: string): string => {
    const d = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return day;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };

  return first === last ? fmt(first) : `${fmt(first)} – ${fmt(last)}`;
}
