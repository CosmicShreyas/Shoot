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

export const PANDA = '🐼';

/** Shown once after a successful `shoot init`. */
export const ART = String.raw`
      .--.   .--.
     ( 🐼 )_( 🐼 )      shoot
      '--'   '--'
       \  |ǂ|  /
          |ǂ|            verify before you grow
`;

export const prefix = (body: string): string => `${PANDA} Shoot: ${body}`;

// ---------------------------------------------------------------------------
// Hook decisions — these are what a real user actually sees, via systemMessage
// or via the block `reason`. Every one is canonical: the hook output and any
// terminal echo both call these, so the wording cannot drift apart.
// ---------------------------------------------------------------------------

/** Checks ran and passed. Goes out as the pass-path systemMessage. */
export const success = (checked: string): string =>
  prefix(`Nice work — ${checked}. Cleared to grow.`);

/**
 * Framing line for a block, quoting the claim back. The real command output is
 * appended after this by buildBlockReason — never mixed into it.
 */
export const blocked = (quotedClaim: string): string =>
  prefix(`Not yet. You said "${quotedClaim}" — it isn't true yet. Here's what broke:`);

/** Same, when there's no clean phrase to quote. */
export const blockedNoQuote = (): string =>
  prefix("Not yet. That reads like a completion claim, but the checks disagree. Here's what broke:");

/**
 * Circuit breaker stood down. Goes out as systemMessage — must state plainly
 * that the checks still do NOT pass, so standing down is never mistaken for a pass.
 */
export const breakerTripped = (blocks: number, checked: string): string =>
  prefix(
    `I've paused this ${blocks} times now for the same failure (${checked}). ` +
      "Something's genuinely stuck, so I'm letting this through — but the checks " +
      'still do NOT pass, and a human should look at it.',
  );

/** Warn mode: checks failed, but blocking is disabled. */
export const warnOnly = (checked: string): string =>
  prefix(
    `Heads up — ${checked}. Not blocking (warn mode), but this isn't done.`,
  );

/** The hook's cwd doesn't exist, so nothing could be verified. */
export const skippedBadCwd = (cwd: string): string =>
  prefix(
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
  prefix(
    "⚠️  Your .shoot.config.json commands changed since you last approved them, so I " +
      "skipped verification rather than run something you haven't seen. Nothing was " +
      'verified. Run `shoot trust` to review the change and approve it.',
  );

/** No trust record exists for the configured commands. */
export const configUntrusted = (): string =>
  prefix(
    "⚠️  I don't have a record of you approving these check commands, so I skipped " +
      'verification rather than run them unseen. Nothing was verified. Run ' +
      '`shoot trust` to review and approve them.',
  );

/** A claim was made, but there's nothing configured to check it against. */
export const noChecksConfigured = (): string =>
  prefix('No checks configured yet — nothing to verify. Run `shoot init` to set some up.');

/** The hook itself malfunctioned. Never silent: a broken hook must not look clean. */
export const internalError = (detail: string): string =>
  prefix(`internal error, allowing the stop — ${detail}`);

/** The generated shim could not load Shoot at all. */
export const shimLoadFailed = (detail: string): string =>
  prefix(`hook could not run, allowing the stop — ${detail}`);

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

export const verifyPassed = (): string => prefix('Everything checks out. Cleared to grow.');

export const verifyFailed = (count: number): string =>
  prefix(`${count} ${count === 1 ? 'check' : 'checks'} did not pass. Details above.`);

export const noConfigHere = (): string =>
  prefix('No .shoot.config.json here. Run `shoot init` first.');

export const statusHeading = (): string => prefix('Status');

export const statusHealthy = (): string => prefix("You're all wired up. I'll be watching.");

export const statusNotInstalled = (): string =>
  prefix('Not installed here. Run `shoot init` to set it up.');

export const statusNoHooks = (): string =>
  prefix('Config exists, but no hooks are registered. Run `shoot init` again.');

export const statusBadSettings = (): string => prefix('That settings file is not valid JSON.');

export const brokenRegistration = (): string =>
  prefix(
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
  prefix('Approved. Verification is active again for these commands.');

export const trustDeclined = (): string =>
  prefix('Not approved — nothing changed, and verification stays skipped until you approve.');

export const trustAlreadyTrusted = (): string =>
  prefix('These commands are already approved:');

export const trustNothingToApprove = (): string =>
  prefix('No check commands configured, so there is nothing to approve.');

export const doctorHeading = (): string => prefix("Let's check your setup.");

export const doctorHealthy = (): string => prefix('Everything looks healthy. Nothing to fix.');

export const doctorWarnings = (count: number): string =>
  prefix(
    `No blockers, but ${count} thing${count === 1 ? '' : 's'} worth a look (marked warn above).`,
  );

export const doctorFailed = (count: number): string =>
  prefix(
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
