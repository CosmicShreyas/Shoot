/**
 * Terminal colors, hand-rolled with raw ANSI escapes.
 *
 * NO DEPENDENCY, deliberately. Shoot markets and CI-enforces a zero-runtime-
 * dependency guarantee, and a color library would break it for a few dozen bytes
 * of escape codes. `chalk`, `colors`, `picocolors` — none of them, ever.
 *
 * ---------------------------------------------------------------------------
 * THE TWO-CHANNEL RULE
 * ---------------------------------------------------------------------------
 *
 * Every string Shoot emits belongs to exactly one of two channels. The
 * classification is never ambiguous, and it decides whether decoration is allowed.
 *
 *   HUMAN CHANNEL — anything a person reads in their own terminal: all CLI command
 *   output, and the `systemMessage` a host renders for the user. Full color, full
 *   panda voice, emoji, block-drawing characters, all of it.
 *
 *   AGENT CHANNEL — the `reason` field of a block decision, and anything else
 *   embedded in JSON on stdout for a host to parse. Plain 7-bit ASCII only: no ANSI
 *   escapes, no emoji, no box-drawing or other Unicode decoration.
 *
 * Why strip the agent channel: some hosts and parsers handle multi-byte Unicode
 * poorly inside structured fields, and there is no upside to decorating text a
 * model reads rather than a human sees. The wording is unchanged — only decoration
 * is removed. `toAgentText()` is the single enforcement point, and a structural
 * test asserts the agent channel is pure ASCII.
 *
 * ---------------------------------------------------------------------------
 * WHEN COLOR IS DISABLED (human channel)
 * ---------------------------------------------------------------------------
 *
 *   - `NO_COLOR` is set to any value (https://no-color.org convention)
 *   - the target stream is not a TTY (piped to a file, another program, or captured
 *     by a hook host)
 *
 * The TTY check is PER STREAM. Shoot writes machine-readable JSON to stdout and
 * human-facing lines to stderr, and those can be redirected independently — a host
 * capturing stdout while leaving stderr on the terminal is the normal case.
 */

/** Raw SGR codes. Kept private — callers use the semantic helpers below. */
const CODES = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
} as const;

/** Matches any ANSI escape sequence, for stripping and for tests. */
// eslint-disable-next-line no-control-regex
export const ANSI_PATTERN = /\[[0-9;]*m/g;

export interface Palette {
  /** True when this palette emits escape codes at all. */
  readonly enabled: boolean;
  /** A passing / success result. */
  ok(text: string): string;
  /** A hard failure or block. */
  bad(text: string): string;
  /** A warning or advisory — explicitly not a failure. */
  warn(text: string): string;
  /** A section heading. */
  strong(text: string): string;
  /** Secondary metadata: timings, paths, counts. Never diagnostic data. */
  faint(text: string): string;
  /** Neutral emphasis for names and identifiers. */
  accent(text: string): string;
}

/** Is color disabled by environment? */
export function colorDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  // Per the NO_COLOR convention, presence is what counts — any value, including
  // the empty string, disables color.
  return env['NO_COLOR'] !== undefined;
}

/**
 * Is color force-enabled by environment?
 *
 * `FORCE_COLOR` is the widely-followed counterpart to `NO_COLOR`. It matters for
 * capturing demo output, where the recorder pipes stdout (so `isTTY` is false) but
 * the colour is the whole point of the recording.
 *
 * `NO_COLOR` still wins: a user who has explicitly opted out should not have colour
 * forced back on by a variable some tool set for them.
 */
export function colorForcedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env['FORCE_COLOR'];
  if (value === undefined) return false;
  // `FORCE_COLOR=0` is the documented way to mean "no", matching other tools.
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Should this stream get color?
 *
 * `isTTY` is undefined on a non-TTY stream, so an explicit `=== true` avoids
 * treating "unknown" as "yes".
 */
export function shouldColor(
  stream: { isTTY?: boolean | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // NO_COLOR always wins — an explicit opt-out is not overridable.
  if (colorDisabledByEnv(env)) return false;
  if (colorForcedByEnv(env)) return true;
  return stream?.isTTY === true;
}

/**
 * Wrap text in an SGR code, keeping any trailing newline OUTSIDE the sequence.
 *
 * Without this, `faint('text\n')` emits `ESC[2m text \n ESC[0m` — the reset lands on
 * the next line, so a terminal briefly renders the following line dim and some
 * emulators leave the attribute set. Callers shouldn't have to remember to hoist
 * their own newlines, so the wrapper handles it.
 */
function wrap(code: string): (text: string) => string {
  return (text) => {
    const match = /(\r?\n)+$/.exec(text);
    if (match === null) return `${code}${text}${CODES.reset}`;

    const trailing = match[0];
    const body = text.slice(0, text.length - trailing.length);
    return `${code}${body}${CODES.reset}${trailing}`;
  };
}

const identity = (text: string): string => text;

/** A palette that emits nothing. Used for pipes, NO_COLOR, and the agent channel. */
export const plain: Palette = {
  enabled: false,
  ok: identity,
  bad: identity,
  warn: identity,
  strong: identity,
  faint: identity,
  accent: identity,
};

const colored: Palette = {
  enabled: true,
  ok: wrap(CODES.green),
  bad: wrap(CODES.red),
  warn: wrap(CODES.yellow),
  strong: wrap(CODES.bold),
  faint: wrap(CODES.dim),
  accent: wrap(CODES.cyan),
};

/** Build a palette for a specific stream. */
export function paletteFor(
  stream: { isTTY?: boolean | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Palette {
  return shouldColor(stream, env) ? colored : plain;
}

/**
 * Palette for human-facing terminal output.
 *
 * Keyed to stderr, because that is where Shoot's framing lines go — both from the
 * hook and from the CLI commands.
 */
export function terminalPalette(env: NodeJS.ProcessEnv = process.env): Palette {
  return paletteFor(process.stderr, env);
}

/** Palette for CLI output written to stdout (status tables, dashboards). */
export function stdoutPalette(env: NodeJS.ProcessEnv = process.env): Palette {
  return paletteFor(process.stdout, env);
}

/** Remove every escape sequence from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** True when the string contains an escape sequence. */
export function hasAnsi(text: string): boolean {
  ANSI_PATTERN.lastIndex = 0;
  return ANSI_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Agent channel
// ---------------------------------------------------------------------------

/**
 * Replacements applied when converting human text to agent text.
 *
 * Only characters Shoot itself introduces as decoration are mapped. Anything else
 * non-ASCII — which in practice means text from the user's own command output — is
 * transliterated by the generic pass below rather than guessed at.
 */
const AGENT_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  // Mascot and status glyphs.
  [/\u{1F43C}\s*/gu, ''], // panda
  [/⚠️?\s*/gu, ''], // warning sign (+ optional variation selector)
  [/[✔✓]/gu, 'ok'], // heavy/light check mark
  [/[✖✗✘]/gu, 'x'], // heavy multiplication / ballot x
  [/ℹ️?/gu, 'i'], // information source

  // Punctuation that reads as decoration in a structured field.
  [/[‘’]/gu, "'"], // curly single quotes
  [/[“”]/gu, '"'], // curly double quotes
  [/[–—]/gu, '-'], // en/em dash
  [/…/gu, '...'], // ellipsis
  [/ /gu, ' '], // non-breaking space
  [/→/gu, '->'], // right arrow

  // Block-drawing characters used by the stats dashboard. These should never reach
  // the agent channel, but strip them defensively rather than rely on that.
  [/[▀-▟]/gu, '#'],
  [/[─-╿]/gu, '-'],
];

/**
 * Convert human-channel text into agent-channel text.
 *
 * Strips ANSI escapes, maps Shoot's own decoration to ASCII equivalents, then drops
 * any remaining non-ASCII byte. The result is guaranteed 7-bit ASCII.
 *
 * This is the ONLY place that conversion happens. Everything bound for the `reason`
 * field or any other JSON string passes through here.
 */
export function toAgentText(text: string): string {
  if (typeof text !== 'string' || text === '') return '';

  let out = stripAnsi(text);

  for (const [pattern, replacement] of AGENT_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }

  // Anything still outside printable ASCII (plus tab and newline) is dropped. This
  // catches decoration nobody anticipated, at the cost of mangling non-English
  // command output — an acceptable trade for a field a parser must handle, and the
  // reason non-ASCII test output is better read in the terminal.
  out = out.replace(/[^\t\n\x20-\x7E]/g, '');

  // Collapse any double spaces the removals left behind, per line.
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** True when the text is pure 7-bit ASCII (tab and newline allowed). */
export function isAsciiOnly(text: string): boolean {
  return !/[^\t\n\x20-\x7E]/.test(text);
}
