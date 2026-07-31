/**
 * Hook I/O plumbing: read stdin, dispatch to the configured platform adapter,
 * write the adapter's response.
 *
 * All decision logic lives in `decide.ts` (platform-neutral) and all wire-format
 * knowledge lives in `adapters/` (platform-specific). This file only moves bytes.
 *
 * Two invariants worth restating, because getting either wrong caused real bugs:
 *
 *   - `stopHookActive` is checked first in `decide()`. When the host has already
 *     forced a continuation, re-running the pipeline is what creates an infinite
 *     loop.
 *   - No allow path may emit a field that continues the conversation. On Claude
 *     Code that field is `hookSpecificOutput.additionalContext`; it is never
 *     emitted, and the type that made it expressible was deleted.
 */

import { getAdapter } from '../adapters/index.js';
import type { AdapterResponse, HookInput, PlatformAdapter } from '../adapters/types.js';
import type { ShootConfig } from './config.js';
import { decide, type Decision, type DecideOptions } from './decide.js';

export type { HookInput } from '../adapters/types.js';
export { buildBlockReason, buildReceipt } from './decide.js';

/** Parse stdin using the given platform's adapter. */
export function parseHookInput(
  raw: string,
  fallbackCwd: string = process.cwd(),
  adapter: PlatformAdapter = getAdapter('claude-code'),
): HookInput | null {
  return adapter.parseInput(raw, fallbackCwd);
}

export async function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  // If nothing is piped in, don't wait forever for EOF.
  if (stream.isTTY) return '';

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Decide, then render through the adapter. */
export async function evaluate(
  input: HookInput,
  config: ShootConfig,
  options: DecideOptions = {},
  adapter: PlatformAdapter = getAdapter(config.platform),
): Promise<{ decision: Decision; response: AdapterResponse }> {
  const decision = await decide(input, config, options);
  return { decision, response: adapter.formatResponse(decision.verdict, input) };
}

export function emit(
  response: AdapterResponse,
  stdout: { write(s: string): unknown } = process.stdout,
  stderr: { write(s: string): unknown } = process.stderr,
): void {
  if (response.stdout !== '') stdout.write(response.stdout);
  if (response.stderr !== '') stderr.write(response.stderr);
}
