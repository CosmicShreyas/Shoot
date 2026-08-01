/**
 * Every user-facing string Shoot produces lives here — one canonical string per
 * situation, defined once, used everywhere that situation occurs.
 *
 * Two rules:
 *
 * 1. PERSONALITY GOES IN THE FRAMING ONLY. Diagnostic data (command output, exit
 *    codes, stack traces) is always plain and unstyled, so it stays greppable and
 *    actually useful. The mascot voice wraps the diagnostics; it never touches them.
 *
 * 2. NO DUPLICATE WORDING. If the same situation is described in two places with
 *    two wordings, that's the bug. The user-facing channel (`systemMessage`, which
 *    Claude Code shows in the terminal) and any local echo must use the SAME
 *    function from this file — never a plain paraphrase alongside a voiced line.
 */

import { plain, terminalPalette, type Palette } from './colors.js';

export const PANDA = '🐼';

/**
 * The project tagline, printed beside the banner art after `init`.
 *
 * Kept here rather than inside ART so the art stays purely pictorial and the tagline
 * can be reworded without redrawing bamboo. Must match the READMEs.
 */
export const TAGLINE = 'No cap, for real.';

/**
 * Which palette the voiced helpers use.
 *
 * Resolved lazily on first use rather than at module load, so a test (or a caller)
 * can set NO_COLOR before anything is rendered. Keyed to stderr, which is where
 * every voiced line goes.
 */
let activePalette: Palette | undefined;

function pal(): Palette {
  activePalette ??= terminalPalette();
  return activePalette;
}

/**
 * Force a palette. Two callers:
 *   - tests, to assert both colored and plain output deterministically
 *   - the hook, which must render PLAIN for anything embedded in stdout JSON,
 *     because an escape code inside the payload would corrupt what the host parses
 */
export function setPalette(palette: Palette): void {
  activePalette = palette;
}

/** Render voiced text with no color at all, regardless of the active palette. */
export function withoutColor<T>(fn: () => T): T {
  const previous = activePalette;
  activePalette = plain;
  try {
    return fn();
  } finally {
    activePalette = previous;
  }
}

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

/**
 * HUMAN CHANNEL ONLY — pure decoration, never reachable from the agent channel.
 * `init` is a CLI command; no hook path prints any of this.
 *
 * CHARACTER DISCIPLINE
 *
 * The wordmark and bamboo use only base ASCII (`_ | / \ = ( )`), which every
 * monospace font renders at exactly one cell. The border uses box-drawing
 * characters, which are near-universally supported at single width. An earlier
 * version used `ǂ` (U+01C2, a click consonant) and fell apart in fonts that
 * substituted it — hence the rule, and the test that enforces it.
 *
 * WIDTH DISCIPLINE
 *
 * The panda emoji occupies TWO terminal cells but is ONE JS code point, so
 * hand-padded borders land a column short on whichever row contains it. Padding is
 * therefore computed from display width via `displayWidth()`, never from `.length`.
 * That bug was caught by rendering, not by reading the source.
 */

/** Display width in terminal cells. Emoji count as two. */
export function displayWidth(text: string): number {
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  return [...text].length + emoji;
}

/** The `shoot` wordmark, standard figlet-style lowercase. */
const WORDMARK: readonly string[] = [
  '     _                 _',
  ' ___| |__   ___   ___ | |_',
  "/ __| '_ \\ / _ \\ / _ \\| __|",
  '\\__ \\ | | | (_) | (_) | |_',
  '|___/_| |_|\\___/ \\___/ \\__|',
];

/** Bamboo fanning from a single base — the brand metaphor, beside the wordmark. */
const BAMBOO: readonly string[] = [
  '|=  |=  |=',
  ' \\  |  /',
  '  \\_|_/',
  '    |',
  ' ___|___',
];

/** Inner width of the full banner box, in cells. */
const BANNER_INNER = 48;

/** Terminals narrower than this get the compact banner instead. */
export const BANNER_MIN_WIDTH = BANNER_INNER + 2;

function padTo(text: string, cells: number): string {
  return text + ' '.repeat(Math.max(0, cells - displayWidth(text)));
}

/** Draw a rounded box around content lines. `'---'` becomes a horizontal rule. */
function drawBox(lines: readonly string[], inner: number): string {
  const out = [`╭${'─'.repeat(inner)}╮`];
  for (const line of lines) {
    out.push(line === '---' ? `├${'─'.repeat(inner)}┤` : `│${padTo(line, inner)}│`);
  }
  out.push(`╰${'─'.repeat(inner)}╯`);
  return out.join('\n');
}

/** The full banner: wordmark, bamboo, and the tagline below a rule. */
export function banner(): string {
  const rows: string[] = [''];
  for (let i = 0; i < WORDMARK.length; i++) {
    rows.push(padTo(`  ${WORDMARK[i] ?? ''}`, 32) + (BAMBOO[i] ?? ''));
  }
  rows.push('', '---', `  ${PANDA}  ${TAGLINE}`);
  return drawBox(rows, BANNER_INNER);
}

/** A single-box version for terminals too narrow for the full banner. */
export function compactBanner(): string {
  return drawBox(['', `  ${PANDA}  shoot   |=|=|=`, `  ${TAGLINE}`, ''], 30);
}

/**
 * Pick a banner that fits. Falls back to the compact box on narrow terminals,
 * because a wrapped banner looks far worse than a small one.
 */
export function bannerFor(columns: number | undefined = process.stdout.columns): string {
  return (columns ?? 80) >= BANNER_MIN_WIDTH ? banner() : compactBanner();
}


/**
 * The mascot framing line. Bold, because it is the one line that must be findable
 * in a wall of test output — the diagnostics below it stay unstyled.
 */
export const prefix = (body: string): string => pal().strong(`${PANDA} Shoot: ${body}`);

/** Framing line for a good outcome. */
const prefixOk = (body: string): string => pal().ok(pal().strong(`${PANDA} Shoot: ${body}`));

/** Framing line for a failure or block. */
const prefixBad = (body: string): string => pal().bad(pal().strong(`${PANDA} Shoot: ${body}`));

/** Framing line for a warning or advisory. */
const prefixWarn = (body: string): string => pal().warn(pal().strong(`${PANDA} Shoot: ${body}`));

// ---------------------------------------------------------------------------
// Hook decisions — these are what a real user actually sees, via systemMessage
// or via the block `reason`. Every one is canonical: the hook output and any
// terminal echo both call these, so the wording cannot drift apart.
// ---------------------------------------------------------------------------

/** Checks ran and passed. Goes out as the pass-path systemMessage. */
export const success = (checked: string): string =>
  prefixOk(`Nice work — ${checked}. Cleared to grow.`);

/**
 * Framing line for a block, quoting the claim back. The real command output is
 * appended after this by buildBlockReason — never mixed into it.
 */
export const blocked = (quotedClaim: string): string =>
  prefixBad(`Not yet. You said "${quotedClaim}" — it isn't true yet. Here's what broke:`);

/** Same, when there's no clean phrase to quote. */
export const blockedNoQuote = (): string =>
  prefixBad("Not yet. That reads like a completion claim, but the checks disagree. Here's what broke:");

/**
 * Circuit breaker stood down. Goes out as systemMessage — must state plainly
 * that the checks still do NOT pass, so standing down is never mistaken for a pass.
 */
export const breakerTripped = (blocks: number, checked: string): string =>
  prefixWarn(
    `I've paused this ${blocks} times now for the same failure (${checked}). ` +
      "Something's genuinely stuck, so I'm letting this through — but the checks " +
      'still do NOT pass, and a human should look at it.',
  );

/** Warn mode: checks failed, but blocking is disabled. */
export const warnOnly = (checked: string): string =>
  prefixWarn(
    `Heads up — ${checked}. Not blocking (warn mode), but this isn't done.`,
  );

/** The hook's cwd doesn't exist, so nothing could be verified. */
export const skippedBadCwd = (cwd: string): string =>
  prefixWarn(
    `I couldn't find the project directory ("${cwd}"), so I skipped verification — ` +
      'nothing was verified. Letting this through, but treat it as unchecked. ' +
      'Run `shoot verify` to check this project manually.',
  );

/**
 * The configured commands changed since they were last approved, so nothing was
 * run. Deliberately unmistakable: this is the one message where being ignored has
 * a security consequence.
 */
export const configChanged = (): string =>
  prefixWarn(
    "⚠️  Your .shoot.config.json commands changed since you last approved them, so I " +
      "skipped verification rather than run something you haven't seen. Nothing was " +
      'verified. Run `shoot trust` to review the change and approve it.',
  );

/** No trust record exists for the configured commands. */
export const configUntrusted = (): string =>
  prefixWarn(
    "⚠️  I don't have a record of you approving these check commands, so I skipped " +
      'verification rather than run them unseen. Nothing was verified. Run ' +
      '`shoot trust` to review and approve them.',
  );

/** A claim was made, but there's nothing configured to check it against. */
export const noChecksConfigured = (): string =>
  prefix('No checks configured yet — nothing to verify. Run `shoot init` to set some up.');

/** The hook itself malfunctioned. Never silent: a broken hook must not look clean. */
export const internalError = (detail: string): string =>
  prefixWarn(`internal error, allowing the stop — ${detail}`);

/** The generated shim could not load Shoot at all. */
export const shimLoadFailed = (detail: string): string =>
  prefixWarn(`hook could not run, allowing the stop — ${detail}`);

// ---------------------------------------------------------------------------
// CLI command output
// ---------------------------------------------------------------------------

export const initIntro = (): string =>
  prefix("Let's set up your checks. Press Enter to accept anything in [brackets].");

export const initSuggestions = (): string =>
  'Found these in package.json — press Enter to accept the suggestion, or type your own.';

export const initSkipHint = (): string => 'Leave any check blank to skip it.';

export const initConfigured = (): string => prefix('All set. Here is what I will check:');

export const initNothingConfigured = (): string =>
  '(nothing yet — add commands to .shoot.config.json when you have them)';

export const initWrote = (settingsFile: string): string =>
  `Wrote .shoot.config.json and ${settingsFile}`;

export const initTryIt = (): string => 'Try it now:  shoot verify';

export const initBadSettings = (path: string): string =>
  prefix(`I can't parse ${path} — fix that JSON first, then re-run init.`);

export const initDetectedPlatform = (name: string, dir: string): string =>
  prefix(`Found ${dir}/ — setting up for ${name}.`);

export const initNoPlatformDetected = (): string =>
  prefix("I couldn't tell which agent you're using. Pick one:");

export const initMultiplePlatforms = (): string =>
  prefix('More than one agent looks set up here. Pick which to verify:');

export const initPlatformWarnings = (name: string): string =>
  prefix(`Before you commit to ${name}, a few things worth knowing:`);

export const initCancelled = (): string => prefix('No changes made.');

export const verifyRunning = (): string => prefix('Running your checks...');

export const verifyPassed = (): string => prefixOk('Everything checks out. Cleared to grow.');

export const verifyFailed = (count: number): string =>
  prefixBad(`${count} ${count === 1 ? 'check' : 'checks'} did not pass. Details above.`);

export const noConfigHere = (): string =>
  prefix('No .shoot.config.json here. Run `shoot init` first.');

export const statusHeading = (): string => prefix('Status');

export const statusHealthy = (): string => prefixOk("You're all wired up. I'll be watching.");

export const statusNotInstalled = (): string =>
  prefix('Not installed here. Run `shoot init` to set it up.');

export const statusNoHooks = (): string =>
  prefix('Config exists, but no hooks are registered. Run `shoot init` again.');

export const statusBadSettings = (): string => prefix('That settings file is not valid JSON.');

export const brokenRegistration = (): string =>
  prefixWarn(
    'A hook is registered but its script is missing, so nothing is being verified. ' +
      'Run `shoot init` to repair it.',
  );

export const trustReviewHeading = (): string =>
  prefix('These are the commands I would run. Review them before approving:');

export const trustWarning = (): string =>
  '  These run on your machine with your permissions, every time your agent claims\n' +
  '  to be done. Treat this like reviewing any other code — if a change arrived in a\n' +
  '  pull request you did not write, read it carefully.';

export const trustApproved = (): string =>
  prefixOk('Approved. Verification is active again for these commands.');

export const trustDeclined = (): string =>
  prefixWarn('Not approved — nothing changed, and verification stays skipped until you approve.');

export const trustAlreadyTrusted = (): string =>
  prefix('These commands are already approved:');

export const trustNothingToApprove = (): string =>
  prefix('No check commands configured, so there is nothing to approve.');

export const doctorHeading = (): string => prefix("Let's check your setup.");

export const doctorHealthy = (): string => prefixOk('Everything looks healthy. Nothing to fix.');

export const doctorWarnings = (count: number): string =>
  prefixWarn(
    `No blockers, but ${count} thing${count === 1 ? '' : 's'} worth a look (marked warn above).`,
  );

export const doctorFailed = (count: number): string =>
  prefixBad(
    `${count} problem${count === 1 ? '' : 's'} will stop verification from working. ` +
      'The → lines above say how to fix each one.',
  );

export const statsHeading = (): string => prefix('Your verification history');

export const statsEmpty = (): string =>
  prefix("No history yet — I haven't verified a completion claim in this project so far.");

export const statsSummary = (caught: number): string =>
  caught === 0
    ? prefix('No false completion claims caught yet. Good sign.')
    : prefix(
        `Caught ${caught} completion claim${caught === 1 ? '' : 's'} that ` +
          `${caught === 1 ? "wasn't" : "weren't"} backed by passing checks.`,
      );

export const uninstallPlan = (): string => prefix('This will remove:');

export const uninstallPreserving = (count: number): string =>
  `Your other ${count} hook ${count === 1 ? 'entry' : 'entries'} will be left alone.`;

export const uninstallNothing = (): string =>
  prefix('Nothing to remove — Shoot is not set up here.');

export const uninstallCancelled = (): string => prefix('Left everything as it was.');

export const uninstalled = (): string =>
  prefix('Removed. Thanks for letting me help — re-run `shoot init` any time.');
