/**
 * `shoot hook` — the stop-event entry point, for every supported platform.
 *
 * Registered in the host's config by `shoot init`. Reads the event JSON on stdin,
 * decides, and emits per that platform's contract.
 *
 * Failure policy: any unexpected error here allows the stop. A verification tool
 * that breaks the user's session when it malfunctions is worse than one that
 * occasionally misses — but it must never fail *silently*, or a broken install
 * looks exactly like a clean pass.
 */

import { getAdapter } from '../adapters/index.js';
import { loadConfig } from '../core/config.js';
import { emit, evaluate, readStdin } from '../core/hookIO.js';
import { paletteFor, plain } from '../mascot/colors.js';
import * as messages from '../mascot/messages.js';

export async function runHook(): Promise<number> {
  let raw = '';
  try {
    raw = await readStdin();
  } catch {
    return 0; // Could not read the event; allow.
  }

  // The platform is recorded in config, but config lives at the payload's cwd,
  // which we haven't parsed yet. Try each adapter's parser until one yields a
  // usable payload — they're all strict about shape, so this is unambiguous in
  // practice, and it keeps the hook working even if `platform` is stale.
  let input = null;
  let adapter = getAdapter('claude-code');
  for (const candidate of [getAdapter('claude-code'), getAdapter('codex')]) {
    const parsed = candidate.parseInput(raw, process.cwd());
    if (parsed !== null) {
      input = parsed;
      adapter = candidate;
      break;
    }
  }
  if (input === null) return 0; // Malformed payload; allow.

  const config = loadConfig(input.cwd);

  // Honour the configured platform for OUTPUT formatting, since that's the host
  // that will read it. Parsing above is shape-driven and platform-agnostic.
  const outputAdapter = getAdapter(config.platform);

  // Subagent verification is opt-out via config.
  if (input.hookEventName === 'SubagentStop' && !config.verifySubagents) return 0;

  try {
    // Build the decision with color OFF. Everything the adapter puts on stdout is
    // JSON the host parses, and an ANSI escape inside that payload would corrupt
    // it — so the strings baked into `systemMessage` / `reason` must stay plain.
    messages.setPalette(plain);
    const { response } = await evaluate(input, config, {}, outputAdapter);

    // stderr is for the human, and may be a TTY even when stdout is captured by
    // the host — so it gets its own palette decision.
    messages.setPalette(paletteFor(process.stderr));
    emit(response, process.stdout, {
      write: (s: string) => process.stderr.write(recolorForTerminal(s)),
    });

    return response.exitCode;
  } catch (err) {
    messages.setPalette(paletteFor(process.stderr));
    process.stderr.write(
      `${messages.internalError(err instanceof Error ? err.message : String(err))}\n`,
    );
    return 0;
  }
}

/**
 * The adapter already rendered the stderr line as plain text (see above), so
 * colorize the mascot framing line on its way out.
 *
 * Only the framing line is touched. Diagnostic output below it stays exactly as
 * the command emitted it — constraint from messages.ts: personality in the framing,
 * never in the data.
 */
function recolorForTerminal(text: string): string {
  const palette = paletteFor(process.stderr);
  if (!palette.enabled) return text;

  return text
    .split('\n')
    .map((line) => (line.startsWith(`${messages.PANDA} Shoot:`) ? palette.strong(line) : line))
    .join('\n');
}
