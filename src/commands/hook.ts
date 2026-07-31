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
    const { response } = await evaluate(input, config, {}, outputAdapter);
    emit(response);
    return response.exitCode;
  } catch (err) {
    process.stderr.write(
      `${messages.internalError(err instanceof Error ? err.message : String(err))}\n`,
    );
    return 0;
  }
}
