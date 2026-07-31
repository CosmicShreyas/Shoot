/**
 * Completion-claim detection.
 *
 * Given the assistant's final message for a turn, decide whether it asserts that
 * work is finished/verified.
 *
 * Design, in order of operations:
 *
 *   1. Split the message into clauses (sentence terminators plus contrastive
 *      conjunctions like "but" / "however", which reset the polarity of what
 *      follows).
 *   2. Drop clauses that are questions — "Are the tests passing?" asks, it does
 *      not claim.
 *   3. Match each remaining clause against CLAIM_PATTERNS (data, below).
 *   4. Veto any match with a negation or hedge word inside a bounded window of
 *      tokens immediately before it — "tests don't pass yet" must not fire.
 *
 * Contributors: to teach Shoot a new phrasing, add one entry to CLAIM_PATTERNS.
 * To teach it a new way of saying "not yet", add one word to NEGATORS. Neither
 * requires touching the control flow below.
 */

export interface ClaimMatch {
  /** Identifier of the pattern that fired, e.g. "tests-pass". */
  id: string;
  /** The literal substring of the message that matched, for quoting back. */
  text: string;
}

export interface ClaimResult {
  claimed: boolean;
  matches: ClaimMatch[];
}

// ---------------------------------------------------------------------------
// Data: claim phrases
// ---------------------------------------------------------------------------

export interface ClaimPattern {
  id: string;
  /**
   * Must be global+case-insensitive. Keep patterns narrow: prefer several
   * specific entries over one clever catch-all, so a false positive can be
   * traced to (and fixed in) exactly one line.
   */
  pattern: RegExp;
}

/**
 * Ordered only for readability — every pattern is tested against every clause.
 */
export const CLAIM_PATTERNS: readonly ClaimPattern[] = [
  // --- test / check status -------------------------------------------------
  { id: 'tests-pass', pattern: /\b(?:all\s+)?(?:the\s+)?tests?\s+(?:are\s+|now\s+)*(?:pass(?:es|ing|ed)?|green)\b/gi },
  { id: 'tests-passing-all', pattern: /\ball\s+(?:\d+\s+)?(?:tests?|specs?|checks?)\s+(?:are\s+)?(?:pass(?:ing|ed|es)?|green)\b/gi },
  { id: 'suite-passes', pattern: /\b(?:test\s+)?suite\s+(?:is\s+|now\s+)*(?:pass(?:es|ing|ed)?|green|clean)\b/gi },
  { id: 'checks-pass', pattern: /\b(?:checks?|lint|linting|typecheck|type\s?check|build)\s+(?:is\s+|are\s+|now\s+)*(?:pass(?:es|ing|ed)?|clean|green|succeed(?:s|ed)?)\b/gi },
  { id: 'lint-clean', pattern: /\b(?:lint|linter|linting|typecheck)\s+(?:is\s+|comes\s+back\s+)?clean\b/gi },
  { id: 'no-errors', pattern: /\b(?:no|zero)\s+(?:more\s+)?(?:errors?|failures?|warnings?|issues?)\s*(?:remain(?:ing)?|left)?\b/gi },
  { id: 'green-across', pattern: /\b(?:everything|all)\s+(?:is\s+)?green\b/gi },

  // --- fixed / resolved ----------------------------------------------------
  { id: 'fixed', pattern: /\b(?:i(?:'ve| have)?\s+)?fix(?:ed|es)\b/gi },
  { id: 'the-fix-works', pattern: /\bfix\s+(?:is\s+)?(?:works?|working|complete|in\s+place)\b/gi },
  { id: 'resolved', pattern: /\b(?:is\s+|has\s+been\s+|now\s+)?resolved\b/gi },
  { id: 'bug-gone', pattern: /\b(?:bug|issue|error|problem)\s+(?:is\s+)?(?:gone|fixed|resolved|sorted)\b/gi },
  { id: 'addressed', pattern: /\b(?:has\s+been\s+|is\s+|now\s+)?addressed\b/gi },

  // --- works now -----------------------------------------------------------
  { id: 'works-now', pattern: /\b(?:it|this|that|everything)?\s*(?:works?|working)\s+(?:now|correctly|as\s+expected|properly)\b/gi },
  { id: 'now-works', pattern: /\bnow\s+(?:it\s+|this\s+)?works?\b/gi },
  { id: 'should-work', pattern: /\bshould\s+(?:now\s+)?(?:work|be\s+working|pass|be\s+fixed|be\s+resolved)\b/gi },
  { id: 'working-as-intended', pattern: /\bworking\s+as\s+(?:intended|expected|designed)\b/gi },
  { id: 'behaves-correctly', pattern: /\bbehav(?:es|ing)\s+(?:correctly|as\s+expected)\b/gi },

  // --- done / complete -----------------------------------------------------
  { id: 'done', pattern: /\b(?:i(?:'m| am)\s+|we(?:'re| are)\s+|(?:it|that|this)(?:'s| is)\s+|all\s+)?done\b/gi },
  { id: 'complete', pattern: /\b(?:is\s+|now\s+)?complete(?:d|ly)?\b/gi },
  { id: 'finished', pattern: /\b(?:i(?:'ve| have)\s+)?finished\b/gi },
  { id: 'implemented', pattern: /\bimplemented\s+(?:successfully|it|this|the)?\b/gi },
  { id: 'successfully', pattern: /\bsuccessfully\s+(?:implemented|added|fixed|created|migrated|completed|updated)\b/gi },
  { id: 'ready-to-go', pattern: /\bready\s+(?:to\s+go|for\s+(?:review|use|production)|now)\b/gi },
  { id: 'all-set', pattern: /\b(?:you(?:'re| are)\s+|we(?:'re| are)\s+)?all\s+set\b/gi },
  { id: 'good-to-go', pattern: /\bgood\s+to\s+go\b/gi },
  { id: 'all-good', pattern: /\b(?:everything\s+(?:looks|is)\s+good|all\s+good|looks\s+good\s+now)\b/gi },
  { id: 'ship-it', pattern: /\bship\s+it\b/gi },
  { id: 'task-complete', pattern: /\b(?:task|work|implementation|feature|refactor(?:ing)?|migration)\s+(?:is\s+)?(?:complete|done|finished)\b/gi },
  { id: 'verified', pattern: /\b(?:i(?:'ve| have)\s+)?verified\s+(?:that\s+)?\b/gi },
  { id: 'confirmed-working', pattern: /\bconfirmed\s+(?:that\s+)?(?:it\s+)?(?:works?|working|passing)\b/gi },
];

// ---------------------------------------------------------------------------
// Data: negation and hedging
// ---------------------------------------------------------------------------

/**
 * A negator within NEGATION_WINDOW tokens before a match vetoes it.
 * Contractions are normalized to "not" before this list is consulted, so
 * "don't" / "doesn't" / "isn't" / "won't" are all covered by "not".
 */
export const NEGATORS: readonly string[] = [
  'not',
  'no',
  'none',
  'nothing',
  'never',
  'neither',
  'nor',
  'without',
  'cannot',
  'cant',
  'fail',
  'fails',
  'failed',
  'failing',
  'broken',
  'breaks',
  'unresolved',
  'unfixed',
  'incomplete',
  'unfinished',
];

/**
 * Words that make a following claim non-assertive — intent, uncertainty, or a
 * future plan rather than a statement of present fact. "I still need to fix the
 * parser" is not a claim that it is fixed.
 */
export const HEDGES: readonly string[] = [
  // Partial-progress qualifiers: "almost done", "nearly finished".
  'almost',
  'nearly',
  'mostly',
  'partially',
  'partly',
  'roughly',
  // Doubt verbs: "I doubt this is fixed", "not sure it works now".
  'doubt',
  'doubtful',
  'unsure',
  'unclear',
  'suspect',
  'guess',
  'assume',
  'think',
  'believe',
  'hope',
  'if',
  'unless',
  'until',
  'whether',
  'hopefully',
  'attempt',
  'attempting',
  'trying',
  'try',
  'need',
  'needs',
  'needed',
  'still',
  'yet',
  'todo',
  'want',
  'wants',
  'plan',
  'planning',
  'will',
  'would',
  'could',
  'might',
  'maybe',
  'perhaps',
  'presumably',
  'once',
  'after',
  'before',
  'when',
  'assuming',
  'supposed',
  'ensure',
  'verify',
  'check',
  'checking',
  'confirm',
  'let',
  'lets',
  'going',
  'about',
  'next',
  'then',
  'canyou',
];

/**
 * How many tokens before a match to scan for a negator/hedge. Four is wide
 * enough for "tests do not currently pass" and "I am not quite done", and
 * narrow enough that it rarely reaches back into an unrelated phrase. Clause
 * splitting bounds it further.
 */
export const NEGATION_WINDOW = 4;

/**
 * "yet" after a claim also negates it, in a way a backward-only window misses:
 * "tests pass yet" never occurs, but "not done yet" and "is it done yet" do, and
 * so does the bare "done yet". A short forward scan catches the trailing form.
 */
export const FORWARD_NEGATORS: readonly string[] = ['yet'];
export const FORWARD_WINDOW = 2;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Expand contractions so NEGATORS only needs the base forms. */
function normalize(text: string): string {
  return text
    .replace(/’/g, "'") // curly apostrophe
    .replace(/\b(?:do|does|did|is|are|was|were|has|have|had|could|would|should|ca|wo|ai)n't\b/gi, (m) =>
      `${m.slice(0, -3)} not`,
    )
    .replace(/\bcan not\b/gi, 'cannot');
}

/**
 * Split into clauses on sentence terminators, newlines, semicolons, and
 * contrastive conjunctions. The contrastive split matters: in "I fixed the
 * parser, but tests still fail", the "fixed" claim is real and must survive,
 * while "still fail" belongs to a separate clause.
 */
function toClauses(text: string): string[] {
  return text
    .split(/(?:[.!?;:]+|\n+|—|\s+-\s+|,?\s+(?:but|however|although|though|except|unfortunately)\b)/gi)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Is this clause phrased as a question? */
function isQuestion(clause: string, original: string): boolean {
  if (/\?/.test(clause)) return true;

  // Clause splitting strips the "?", so also check the original text: find the
  // clause and see whether the next non-space character is a question mark.
  const at = original.indexOf(clause);
  if (at !== -1) {
    const after = original.slice(at + clause.length).match(/^\s*(\S)/);
    if (after?.[1] === '?') return true;
  }

  // Interrogative openers, for messages that omit the mark.
  return /^\s*(?:are|is|do|does|did|can|could|should|would|will|have|has|was|were|any|what|why|how|when|which|who|shall)\b/i.test(
    clause,
  );
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Strip apostrophes so "don't"→"dont" style tokens compare cleanly. */
function bare(token: string): string {
  return token.replace(/'/g, '');
}

const NEGATOR_SET = new Set(NEGATORS);
const HEDGE_SET = new Set(HEDGES);
const FORWARD_SET = new Set(FORWARD_NEGATORS);

/**
 * Is the match at [start, end) within `clause` vetoed by a negator or hedge in
 * the window before it (or a trailing "yet" just after)?
 */
function isVetoed(clause: string, start: number, end: number): boolean {
  const before = tokenize(clause.slice(0, start));
  const window = before.slice(Math.max(0, before.length - NEGATION_WINDOW));

  for (const raw of window) {
    const t = bare(raw);
    if (NEGATOR_SET.has(t) || HEDGE_SET.has(t)) return true;
  }

  const after = tokenize(clause.slice(end)).slice(0, FORWARD_WINDOW);
  for (const raw of after) {
    if (FORWARD_SET.has(bare(raw))) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect completion claims in an assistant message.
 *
 * Returns every surviving match, deduplicated by pattern id, so callers can
 * quote the specific phrase back to the agent ("You said \"tests pass\"...").
 */
export function detectClaims(message: string): ClaimResult {
  const matches: ClaimMatch[] = [];

  if (typeof message !== 'string' || message.trim() === '') {
    return { claimed: false, matches };
  }

  const normalized = normalize(message);
  const seen = new Set<string>();

  for (const clause of toClauses(normalized)) {
    if (isQuestion(clause, normalized)) continue;

    for (const { id, pattern } of CLAIM_PATTERNS) {
      // Patterns are module-level and global; reset lastIndex per clause.
      pattern.lastIndex = 0;

      let m: RegExpExecArray | null;
      while ((m = pattern.exec(clause)) !== null) {
        if (m[0].trim() === '') break; // guard against zero-length loops
        const start = m.index;
        const end = start + m[0].length;

        if (!isVetoed(clause, start, end) && !seen.has(id)) {
          seen.add(id);
          matches.push({ id, text: m[0].trim() });
        }
      }
    }
  }

  return { claimed: matches.length > 0, matches };
}

/** Convenience for callers that only need the boolean. */
export function hasCompletionClaim(message: string): boolean {
  return detectClaims(message).claimed;
}
