/**
 * `shoot stats` — a small dashboard over the local verification history.
 *
 * Reads `.shoot/history.jsonl` only. Nothing is transmitted anywhere; this is your
 * own record of what Shoot did in this project.
 *
 * HUMAN CHANNEL ONLY. An agent never invokes this, so color and Unicode block
 * characters are always appropriate here — subject to the usual NO_COLOR / non-TTY
 * rules. See the two-channel rule in `mascot/colors.ts`.
 */

import { existsSync } from 'node:fs';

import { historyPath, readHistory, summarizeHistory, type HistoryOutcome } from '../core/history.js';
import {
  BAR_CHAR,
  bucketByDay,
  formatPercent,
  outcomeSlices,
  rangeLabel,
  recentTimeline,
  sparkChar,
  type DayBucket,
} from '../core/statsView.js';
import { stdoutPalette, type Palette } from '../mascot/colors.js';
import * as messages from '../mascot/messages.js';

/** Which palette colour an outcome carries, consistently across all three views. */
function tint(palette: Palette, outcome: HistoryOutcome): (text: string) => string {
  switch (outcome) {
    case 'passed':
      return palette.ok;
    case 'blocked':
      return palette.bad;
    case 'warned':
    case 'stoodDown':
    case 'untrusted':
      return palette.warn;
    case 'skipped':
      return palette.faint;
  }
}

/** Colour each sparkline character by how busy that day was. */
function renderSparkline(buckets: readonly DayBucket[], palette: Palette): string {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0);

  return buckets
    .map((b) => {
      const char = sparkChar(b.count, max);
      if (b.count === 0) return palette.faint(char);
      // Busiest quarter of the range gets the accent, so peaks are findable.
      return b.count >= max * 0.75 ? palette.accent(char) : palette.ok(char);
    })
    .join('');
}

export async function stats(_argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const palette = stdoutPalette();
  const write = (s: string): void => void process.stdout.write(s);

  if (!existsSync(historyPath(cwd))) {
    write(`\n${messages.statsEmpty()}\n\n`);
    return 0;
  }

  const entries = readHistory(cwd);
  if (entries.length === 0) {
    write(`\n${messages.statsEmpty()}\n\n`);
    return 0;
  }

  const summary = summarizeHistory(entries);
  const buckets = bucketByDay(entries);
  const slices = outcomeSlices(entries);
  const timeline = recentTimeline(entries, 10);

  // --- Header: the pass-rate summary, now the top line of a richer view --------
  write(`\n${messages.statsHeading()}\n\n`);

  const rate = summary.passRate === null ? '—' : formatPercent(summary.passRate);
  const rateColored =
    summary.passRate === null
      ? palette.faint(rate)
      : summary.passRate >= 0.8
        ? palette.ok(rate)
        : summary.passRate >= 0.5
          ? palette.warn(rate)
          : palette.bad(rate);

  write(`  ${palette.strong('pass rate')}  ${rateColored}`);
  write(palette.faint(` of ${summary.passed + summary.blocked + summary.warned + summary.stoodDown} verified claims\n`));
  write(
    `  ${palette.strong('caught')}     ${palette.bad(String(summary.caught))}` +
      palette.faint(' claims not backed by passing checks\n'),
  );
  write(
    `  ${palette.strong('total')}      ${summary.total}` +
      palette.faint(` across ${summary.sessions} session${summary.sessions === 1 ? '' : 's'}\n`),
  );

  // --- Activity sparkline -----------------------------------------------------
  write(`\n  ${palette.strong('activity')}   ${renderSparkline(buckets, palette)}`);
  write(palette.faint(`  ${rangeLabel(buckets)}\n`));

  const busiest = buckets.reduce((m, b) => Math.max(m, b.count), 0);
  if (busiest > 0) {
    write(palette.faint(`              peak ${busiest}/day\n`));
  }

  // --- Outcome breakdown ------------------------------------------------------
  write(`\n  ${palette.strong('breakdown')}\n`);
  const labelWidth = Math.max(...slices.map((s) => s.label.length), 0);

  for (const slice of slices) {
    const color = tint(palette, slice.outcome);
    const bar = color(BAR_CHAR.repeat(slice.width));
    const label = slice.label.padEnd(labelWidth);
    const count = String(slice.count).padStart(4);
    write(`    ${label} ${bar} ${count}${palette.faint(`  ${formatPercent(slice.share)}`)}\n`);
  }

  // --- Recent timeline --------------------------------------------------------
  write(`\n  ${palette.strong('recent')}\n`);
  for (const item of timeline) {
    const color = tint(palette, item.outcome);
    const when = palette.faint(item.relative.padStart(9));
    const what = color(item.outcome.padEnd(9));
    const claim =
      item.claim === undefined ? '' : palette.faint(`  "${truncate(item.claim, 44)}"`);
    write(`    ${when}  ${what}${claim}\n`);
  }

  write(`\n${messages.statsSummary(summary.caught)}\n\n`);
  return 0;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
