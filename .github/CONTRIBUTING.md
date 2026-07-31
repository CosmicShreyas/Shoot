# Contributing to Shoot

Thanks for helping out. Shoot is small on purpose, and the most valuable contributions
are usually small too.

## The one hard rule: zero runtime dependencies

**Shoot has no runtime dependencies, and it stays that way.** Core code uses Node
built-ins only — `node:fs`, `node:child_process`, `node:path`, `node:crypto`,
`node:readline`, `node:url`, `node:os`. `devDependencies` are limited to TypeScript and
`@types/node`.

This isn't minimalism for its own sake. Shoot is a hook that runs inside your agent
session with access to your project, and there have been real supply-chain attacks via
malicious Claude Code hook packages with hidden install scripts. The whole value
proposition includes being auditable in one sitting — a dependency tree destroys that.

Concretely, a PR will not be merged if it:

- adds anything to `dependencies`, however small or popular
- adds a `postinstall`, `preinstall`, or `prepare` script
- makes a network call from any code path
- pulls in a test framework, CLI parser, or prompt library (we hand-roll these; see
  [`src/cli.ts`](../src/cli.ts) and [`src/core/prompt.ts`](../src/core/prompt.ts))

CI enforces the dependency rule automatically — a separate `zero-deps` job fails the
build if a `dependencies` key appears.

## Getting set up

Requires Node >= 18.

```bash
git clone https://github.com/CosmicShreyas/Shoot.git
cd Shoot
npm ci --ignore-scripts
```

## Running tests

```bash
npm test            # compiles to dist-tests/ then runs node:test
npm run typecheck   # tsc --noEmit
npm run build       # compiles to dist/
```

Tests use the built-in `node:test` runner — no framework. `npm test` has a `pretest` step
that compiles first, so it's a single command from clean.

To run one file while iterating:

```bash
npx tsc -p tsconfig.test.json
node --test dist-tests/tests/claimDetector.test.js
```

> `npm test` runs `cd dist-tests && node --test`, relying on Node's built-in test
> discovery. Avoid glob patterns like `--test "**/*.test.js"` — those need Node 21+,
> and CI runs Node 18.

Some tests spawn real subprocesses and real CLI processes on purpose — timeouts, process
trees, cross-process state, and hook stdin/stdout are not things a mock can prove. Those
are slower (a few seconds total) and that's fine.

## Adding a claim-detection phrase

**This is the most useful contribution.** The detector is only as good as the phrasings
it knows, and real agent output is the best source.

Patterns live in [`src/core/claimDetector.ts`](../src/core/claimDetector.ts) in the
exported `CLAIM_PATTERNS` array. Adding one is a one-line change:

```ts
export const CLAIM_PATTERNS: readonly ClaimPattern[] = [
  // ...
  { id: 'my-new-phrase', pattern: /\byour\s+regex\s+here\b/gi },
];
```

Rules for a new pattern:

1. **Must be global and case-insensitive** (`/gi`). A test enforces this.
2. **Unique `id`.** Also enforced by a test. It's what gets quoted back to the user, so
   make it descriptive (`tests-pass`, not `p7`).
3. **Keep it narrow.** Several specific patterns beat one clever catch-all, so a false
   positive can be traced to exactly one line and fixed without collateral damage.
4. **Add both a positive and a negative test** in
   [`tests/claimDetector.test.ts`](../tests/claimDetector.test.ts) — the phrase itself,
   and its negated form (`"X doesn't pass yet"`) staying quiet.

You usually **don't** need to handle negation yourself. The detector splits clauses,
drops questions, and vetoes any match with a negator or hedge in a 4-token window before
it. To teach it a new way of saying "not yet", add a word to `NEGATORS` or `HEDGES`
instead of writing an exception into your pattern.

Before adding a pattern, check the detector's bias: it deliberately **errs quiet**.
Hedges (`"I think it's fixed"`, `"almost done"`) are treated as non-claims on purpose.
Don't change `HEDGES` without opening an issue first — that's a product decision, not a
detail.

If you hit a miss or a false positive and don't want to write the fix, just open a
[claim-detection issue](./ISSUE_TEMPLATE/claim_detection.md) with the **verbatim** message
text. That's genuinely useful on its own.

## Code style

Match the surrounding code. A few conventions worth naming:

- **All user-facing strings live in [`src/mascot/messages.ts`](../src/mascot/messages.ts)**
  — one canonical string per situation, defined once. Never build a voiced line inline or
  hardcode the panda emoji elsewhere; three tests enforce this.
- **Personality goes in framing only.** Diagnostic data (command output, exit codes,
  stack traces) is always plain and unstyled so it stays greppable and useful.
- **Every failure path allows the stop.** A verification tool that breaks sessions when it
  malfunctions is worse than one that occasionally misses. Fail open — but never silently;
  say what went wrong.
- Strict TypeScript, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  The hook parses untrusted JSON from stdin, so this matters.

## Hook output contract

If you touch [`src/core/hookIO.ts`](../src/core/hookIO.ts), read the comments first.
There is one rule that is easy to get wrong and caused a real infinite loop:

**Never use `hookSpecificOutput.additionalContext` on an allow path.** On
`Stop`/`SubagentStop` that field continues the conversation instead of letting it end. A
claim-detecting hook that continues the turn on a pass will loop until Claude Code's
internal cap kills it. Use `systemMessage` for anything informational. The
`HookSpecificOutput` type was deliberately deleted so this can't be reintroduced by
accident.

Likewise, **`stop_hook_active` must stay the first check in `evaluate()`**. When set, the
turn is already in a forced continuation and Shoot must exit silently and immediately.

## Pull requests

- One logical change per PR.
- `npm run typecheck && npm run build && npm test` must pass.
- Add tests for behavior changes. If you fixed a bug, add the test that would have caught it.
- Describe what you actually verified, not what you expect to work.

## Reporting bugs

Use the [issue templates](./ISSUE_TEMPLATE). For anything hook-related, include your
`.shoot.config.json`, your Node and Claude Code versions, and the raw terminal output —
unedited, formatting warts and all.

## Translations

[`README.md`](../README.md) (English) is the canonical source of truth. The translations
live in [`docs/`](../docs/) — [中文](../docs/README.zh-CN.md),
[हिन्दी](../docs/README.hi.md), [Español](../docs/README.es.md),
[Français](../docs/README.fr.md) — and may lag behind English updates; PRs correcting drift
or adding a new language are welcome.

They sit under `docs/` rather than the repository root for a concrete reason: npm
force-includes every file matching `README*` in the published tarball, regardless of the
`files` allowlist or `.npmignore`. At the root they added ~110 kB of translations to a
package nobody installs for its documentation. Translate prose only: code blocks, commands, config
keys, filenames, CLI flags, and Shoot's own output strings stay in English, since those are
literal rather than language-dependent.

## Code of conduct

By participating you agree to the [Code of Conduct](../CODE_OF_CONDUCT.md).
