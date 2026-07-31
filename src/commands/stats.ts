/**
 * `shoot stats` — summarize the local verification history.
 *
 * Reads `.shoot/history.jsonl` only. Nothing is transmitted anywhere; this is
 * your own record of what Shoot did in this project.
 */

import { existsSync } from 'node:fs';

import { historyPath, readHistory, summarizeHistory } from '../core/history.js';
import * as messages from '../mascot/messages.js';

function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  // Date only; the exact minute isn't useful here and keeps the column narrow.
  return iso.slice(0, 10);
}

function formatPercent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

export async function stats(_argv: string[]): Promise<number> {
  const cwd = process.cwd();

  if (!existsSync(historyPath(cwd))) {
    process.stdout.write(`\n${messages.statsEmpty()}\n\n`);
    return 0;
  }

  const entries = readHistory(cwd);
  const s = summarizeHistory(entries);

  if (s.total === 0) {
    process.stdout.write(`\n${messages.statsEmpty()}\n\n`);
    return 0;
  }

  process.stdout.write(`\n${messages.statsHeading()}\n\n`);
  process.stdout.write(`  verifications   ${s.total}\n`);
  process.stdout.write(`  sessions        ${s.sessions}\n`);
  process.stdout.write(`  first / last    ${formatDate(s.firstAt)} .. ${formatDate(s.lastAt)}\n\n`);

  process.stdout.write(`  passed          ${s.passed}\n`);
  process.stdout.write(`  blocked         ${s.blocked}\n`);
  if (s.warned > 0) process.stdout.write(`  warned only     ${s.warned}\n`);
  if (s.stoodDown > 0) process.stdout.write(`  stood down      ${s.stoodDown}\n`);
  if (s.skipped > 0) process.stdout.write(`  nothing to run  ${s.skipped}\n`);

  process.stdout.write(`\n  pass rate       ${formatPercent(s.passRate)}`);
  process.stdout.write(s.passRate === null ? '\n' : ' of verified claims\n');

  process.stdout.write(`\n${messages.statsSummary(s.caught)}\n\n`);
  return 0;
}
