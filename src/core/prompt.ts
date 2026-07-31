/**
 * Minimal interactive prompts on `node:readline`. No dependency.
 *
 * Non-interactive safety: if stdin is not a TTY (CI, piped input), prompts
 * resolve immediately to their defaults instead of hanging forever waiting on
 * input that will never arrive.
 */

import { createInterface, type Interface } from 'node:readline';

let rl: Interface | undefined;

function iface(): Interface {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

/** Release stdin so the process can exit. Safe to call more than once. */
export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}

function interactive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Ask a free-text question. Returns `fallback` on empty input, and immediately
 * in non-interactive environments.
 */
export async function ask(question: string, fallback = ''): Promise<string> {
  const hint = fallback === '' ? '' : ` [${fallback}]`;
  if (!interactive()) return fallback;

  const answer = await new Promise<string>((resolve) => {
    iface().question(`  ${question}${hint}: `, resolve);
  });

  const trimmed = answer.trim();
  return trimmed === '' ? fallback : trimmed;
}

/** Ask a yes/no question. Returns `fallback` on empty or non-interactive input. */
export async function confirm(question: string, fallback: boolean): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  if (!interactive()) return fallback;

  const answer = await new Promise<string>((resolve) => {
    iface().question(`  ${question} [${hint}]: `, resolve);
  });

  const normalized = answer.trim().toLowerCase();
  if (normalized === '') return fallback;
  return normalized === 'y' || normalized === 'yes';
}
