**English** · [中文](./docs/README.zh-CN.md) · [हिन्दी](./docs/README.hi.md) · [Español](./docs/README.es.md) · [Français](./docs/README.fr.md)

# 🐼 shoot

### *No cap, for real.*

<!-- DEMO_GIF: add after recording via ScreenToGif, see DEMO.md -->

**Stops AI coding agents from saying "done" unless it can actually prove it.**

[![npm version](https://img.shields.io/npm/v/shoot-cc.svg)](https://www.npmjs.com/package/shoot-cc)
[![CI](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml/badge.svg)](https://github.com/CosmicShreyas/Shoot/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/shoot-cc.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/shoot-cc.svg)](https://nodejs.org)

<!-- MASCOT_HERO_IMAGE -->
<!-- Hero image goes here once the art exists — see assets/mascot-placeholder.md
     for the brief. Suggested: <p align="center"><img src="assets/mascot.png"
     alt="A small panda cub hugging a bamboo shoot" width="360"></p> -->

<!-- DEMO_VIDEO_LINK: add after recording, see DEMO.md -->

A bamboo shoot doesn't get to stretch upward until its roots check out. Same idea:
your agent doesn't get to say "fixed" until the tests agree.

---

## The problem

Coding agents claim success they haven't verified. They say "all tests pass" without
running them, report a bug fixed when it isn't, and end the turn while the build is
still broken. You find out later, and the trust cost is worse than the bug.

Shoot closes that loop. It hooks the moment your agent tries to stop, notices
completion-claiming language, runs your project's real test/lint/typecheck/build
commands, and **blocks the stop** if the claims don't hold — handing the agent the
actual error output so it keeps working.

## Before / after

Without Shoot, the turn just ends:

```
Claude: Fixed the bug — all tests pass now.
        [turn ends. the test still fails.]
```

With Shoot, the agent gets stopped and handed the real failure:

```
🐼 Shoot: Not yet. You said "Fixed" — it isn't true yet. Here's what broke:

--- test: failed with exit code 1
--- command: npm test

✖ adds (1.87ms)
ℹ pass 0
ℹ fail 1

  AssertionError [ERR_ASSERTION]: 0 == 4
      at TestContext.<anonymous> (sum.test.js:6:10)
    actual: 0,
    expected: 4,

Fix the underlying problem and re-run the checks. Do not report success until they pass.
```

The agent reads that, fixes the real bug, and tries again. When the checks genuinely pass:

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
```

Both blocks above are verbatim Shoot output, not mock-ups.

## Quickstart

```bash
npx shoot-cc init
```

It asks which commands to run (suggesting them from your `package.json`), writes
`.shoot.config.json`, and registers the hook in `.claude/settings.json`. That's it.

> **Package name:** published as **`shoot-cc`** on npm — the bare `shoot` name belongs
> to an unrelated package. The command you run is still `shoot`.

Check it works right now, without waiting for an agent:

```bash
shoot verify
```

## How it works

On every stop (and subagent-stop) event from your agent, Shoot:

1. Reads the assistant's final message from the hook payload's `last_assistant_message`.
   (Not the transcript file — that's written asynchronously and can lag behind the event.)
2. Runs it through the **claim detector** — 30 phrase patterns, with a negation/hedge
   window so "tests don't pass yet" and "are tests passing?" don't count as claims.
3. **If no claim, exits silently.** Ordinary mid-task turns are never touched, never
   slowed, and leave no trace in the transcript.
4. If a claim was made, runs your configured commands for real — in order:
   `typecheck → lint → test → build`, sequentially, each with its own timeout.
5. All pass → allows the stop with a receipt. Anything fails → returns a `block`
   decision whose reason contains the actual failing output.

Steps 2–4 are platform-neutral. Only the reading of step 1 and the writing of step 5 are
host-specific, and those live in a thin adapter — which is why adding a platform is small.

### The infinite loop we found, and how it's prevented

This is worth stating plainly, because it's the reason to trust the tool: Shoot was
validated against a real Claude Code session, not only against unit tests with
synthesized payloads — and the live run found a bug the unit tests structurally could not.

An early version returned its pass-path receipt via
`hookSpecificOutput.additionalContext`. On `Stop`/`SubagentStop`, that field **continues
the conversation** rather than letting it end. So a *correct* fix produced: pass →
receipt → conversation continues → Claude restates "tests pass" → detector fires again →
receipt → continues. It looped **9 times** before Claude Code's own internal cap
force-ended the turn.

Two fixes, both covered by regression tests:

- **`stop_hook_active` is checked first.** When Claude Code sets this flag, the turn is
  already in a forced continuation, so Shoot exits silently and immediately — no claim
  detection, no verification, no output at all. Re-running the pipeline there is exactly
  what sustains the loop.
- **No `additionalContext` on any allow path.** Receipts use `systemMessage`, which
  reaches you in the terminal without reopening the turn. `additionalContext` is only
  ever correct alongside a genuine `block`, which already carries its own `reason`. The
  type that made the mistake possible was deleted, so it can't quietly return.

A single one-shot hook invocation can never reproduce a continuation state. Only a live
session could surface this.

### The circuit breaker

A genuinely broken test suite must never trap you. Shoot counts consecutive blocks per
session for the same failure, persisted to `.shoot/sessions/` (each hook event is a fresh
process, so in-memory counting would reset every time and never trip). On the third
block for the same failure it stands down and lets the turn end, loudly:

```
🐼 Shoot: I've paused this 3 times now for the same failure (test failed). Something's
genuinely stuck, so I'm letting this through — but the checks still do NOT pass, and a
human should look at it.
```

A *different* failure resets the counter — that's real progress, not a loop. The default
of 3 sits well under Claude Code's own 8-block session cap, and `maxBlocksPerSession` is
capped at 6 so you can't configure your way past it.

## Zero dependencies, by design

```
$ npm ls --omit=dev --all
shoot-cc@0.1.0
`-- (empty)
```

Node built-ins only. **No postinstall or preinstall scripts. No network calls, ever.**
There have been real supply-chain attacks via malicious Claude Code hook packages with
hidden install scripts — so Shoot is built to be read end to end in one sitting. CI
fails the build if a runtime dependency is ever added.

Beyond that, because Shoot runs automatically with your permissions:

- **Config changes require re-approval.** `.shoot.config.json` is committed, and its
  commands run with no prompt — so a pull request editing one line could turn Shoot into
  an arbitrary-command runner on every reviewer's machine, with a diff that doesn't look
  like code. Shoot records a hash of the approved commands in gitignored
  `.shoot/trust.json` (so a PR can't touch it). If the commands change, verification is
  **skipped with a loud warning** until you run `shoot trust` and approve it.
- **Captured output is redacted before it is persisted or sent anywhere.** Test output
  flows into the agent's context, your terminal, and `.shoot/history.jsonl` on disk.
  Recognizable secret shapes are replaced with `[REDACTED]` at the capture point.
- **CI actions are pinned to commit SHAs**, not floating tags a compromised maintainer
  could repoint.
- **Releases use npm Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN` exists to
  steal, and published tarballs carry provenance attestations.

Both of the first two are defense in depth, not guarantees. [SECURITY.md](./SECURITY.md)
is explicit about exactly what they do and don't cover.

## Configuration

`.shoot.config.json`, written by `shoot init`:

```json
{
  "mode": "block",
  "checks": {
    "test": "npm test",
    "lint": "npm run lint",
    "typecheck": "npm run typecheck",
    "build": ""
  },
  "timeoutSeconds": 120,
  "maxBlocksPerSession": 3,
  "verifySubagents": true,
  "platform": "claude-code",
  "scopeDriftWarning": true,
  "scopeDriftFileThreshold": 12
}
```

| Key | Default | What it does |
| --- | --- | --- |
| `mode` | `"block"` | `"block"` stops the agent on failure; `"warn"` reports but never blocks. |
| `checks.test` | `""` | Test command. Empty = skipped, not failed. |
| `checks.lint` | `""` | Lint command. Empty = skipped. |
| `checks.typecheck` | `""` | Typecheck command. Empty = skipped. |
| `checks.build` | `""` | Build command. Empty = skipped. |
| `timeoutSeconds` | `120` | Per-check timeout. A timeout counts as a failure, reported as "timed out". |
| `maxBlocksPerSession` | `3` | Consecutive blocks for the same failure before standing down. Capped at 6. |
| `verifySubagents` | `true` | Also verify subagent stops. Subagents claim completion just as readily. |
| `platform` | `"claude-code"` | Which host's hooks to speak. `"claude-code"` or `"codex"`. |
| `scopeDriftWarning` | `true` | Append an advisory note when a passing change looks unexpectedly broad. Never blocks. |
| `scopeDriftFileThreshold` | `12` | Changed-file count above which that advisory may fire. |

Checks always run in the order `typecheck → lint → test → build` regardless of key order,
so the cheapest signal comes first.

## Commands

| Command | What it does |
| --- | --- |
| `shoot init` | Interactive setup: picks your platform, writes config, installs and registers the hook. |
| `shoot verify` | Run all configured checks once, now. Exits non-zero if any fail. |
| `shoot doctor` | Diagnose setup problems: wrong Node, missing scripts, dead hook registrations, untrusted config. |
| `shoot trust` | Review and approve the configured check commands after they change. |
| `shoot stats` | Summarize your local verification history. |
| `shoot status` | Show config, and whether the hook is registered **and its script still exists**. |
| `shoot uninstall` | Remove Shoot's hook entries, config, and state. Leaves your other hooks alone. |

### `shoot doctor`

Catches the setup failures that otherwise look like success — most importantly a hook
that's registered but whose script is gone, which verifies nothing while appearing
installed:

```
🐼 Shoot: Let's check your setup.

  ok    Node version         v22.14.0
  ok    Working directory    /path/to/project
  ok    Config file          .shoot.config.json
  ok    Platform             Claude Code
  ok    Checks configured    test, lint
  ok    test command         npm test → package.json scripts.test
  FAIL  lint command         npm run lint — no "lint" script in package.json
                             → Add a "lint" script, or change checks.lint in .shoot.config.json.
  FAIL  Hook registration    no Shoot hooks registered for Claude Code
                             → Run `shoot init` to register them.

🐼 Shoot: 2 problems will stop verification from working. The → lines above say how to fix each one.
```

Exits non-zero when something is genuinely broken, so it works in a pre-commit hook or CI.

### `shoot stats`

Every verification outcome is appended to `.shoot/history.jsonl` — local only, never
transmitted anywhere. `shoot stats` reads it back:

```
🐼 Shoot: Your verification history

  pass rate  65% of 17 verified claims
  caught     6 claims not backed by passing checks
  total      19 across 3 sessions

  activity   ▂▄··▂▆··▂▂▄▄▄█  Jul 18 – Jul 31
              peak 4/day

  breakdown
    passed           ████████████████████████   11  58%
    blocked          ███████████    5  26%
    warned only      ██    1  5%
    config untrusted ██    1  5%
    no checks set    ██    1  5%

  recent
       1h ago  blocked    "all tests pass"
       3h ago  passed     "fixed it"
       5h ago  skipped    "fixed it"
       1d ago  passed     "fixed it"

🐼 Shoot: Caught 6 completion claims that weren't backed by passing checks.
```

In a real terminal the sparkline, bars, and timeline are colour-coded by outcome — green
passed, red blocked, yellow for warnings and stand-downs. Bars scale to the largest
outcome rather than the total, so a small category stays visible; the percentage carries
the absolute meaning.

Pass rate is computed over claims actually verified — turns where nothing was configured
to check, or where the config wasn't trusted, are excluded, since counting them either way
would misrepresent the number.

## Supported platforms

| Platform | Status |
| --- | --- |
| **Claude Code** | Fully supported. Verified against a live session. |
| **OpenAI Codex CLI** | Supported. Built to the documented contract; not yet verified against a live Codex session. |
| Cursor | Not yet — a `stop` hook exists, but whether it fires in the CLI is unconfirmed. |
| Kiro | Not yet — hooks exist, but a blocking-capable completion event wasn't confirmed. |
| Antigravity | Not yet — no comparable hook system found. |

`shoot init` detects which platform you're using from `.claude/` or `.codex/` and asks
only if it can't tell. Full detail, including exactly what's blocking each unsupported
platform, is in [docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md).

Two Codex differences worth knowing up front: `decision: "block"` there means *continue
with this reason* rather than *prevent stopping* (both produce what Shoot wants), and
Codex doesn't support `systemMessage` on `Stop`, so the pass receipt reaches your
terminal but not the Codex UI. `shoot init` tells you this before you commit to it.

## Scope-drift warning (advisory)

When a claim passes verification, Shoot can also note whether the change looks
unexpectedly broad — appended to the receipt, never blocking:

```
🐼 Shoot: Nice work — test passed. Cleared to grow.
   Heads up (advisory, not a failure): 34 changed files across 6 areas — broader than a
   focused change usually is. Worth a glance if you expected something narrow.
```

**Be clear about what this is:** a file-count heuristic. It asks git how many files
changed and how spread out they are. It does not read the task description, does not
understand what the change was for, and cannot distinguish a legitimate wide refactor
from an agent wandering off. A monorepo-wide rename and genuine drift look identical
to it.

That's why it never blocks, in any mode. Blocking on a signal this soft would train you
to ignore Shoot, which would cost more than the drift it caught. Disable with
`"scopeDriftWarning": false`, or tune `scopeDriftFileThreshold`.

## Known limitations

Being straight about what this does and doesn't do:

- **Shoot can only run the commands you give it.** It cannot invent tests a project
  doesn't have. Pointed at a project with no test suite, it has nothing to verify and
  says so rather than pretending otherwise. Verification is exactly as good as the
  commands configured — a passing `exit 0` stub proves nothing, and Shoot can't tell.
- **The claim detector misses rhetorical question-then-answer forms.** `"Did I fix it?
  Yes."` is not caught: the question form suppresses the match, and the answer is a
  separate clause with no claim phrase in it. Handling this would weaken genuine
  question suppression (`"Are the tests passing?"` must stay quiet) for a rare pattern,
  so it's a deliberate accepted gap rather than a hidden one.
- **The detector errs quiet.** Hedged claims ("I think it's fixed", "almost done") are
  treated as non-claims. A hedge isn't the thing worth hard-blocking on, but it does
  mean soft claims pass through unverified.
- **Claim detection is heuristic, not semantic.** It matches phrasing. Novel wording
  will slip past — that's what the [claim-detection issue template][claims] is for.
- **Scope-drift detection is a file-count heuristic, not semantic analysis.** See the
  section above — it's advisory by design and cannot tell a wide refactor from real drift.
- **The Codex adapter hasn't been verified against a live Codex session.** It's built to
  the documented contract and unit-tested, but the Claude Code path is the one that has
  been through real end-to-end use. Treat Codex support as newer.
- **Cursor's `stop` hook may not fire in the CLI.** Cursor documents a `stop` hook, but
  its docs don't state whether standard agent hooks run under `cursor-agent` or only in
  the desktop app. Rather than ship an adapter that silently does nothing — the exact
  failure mode Shoot exists to prevent — Cursor is unsupported until that's confirmed.
  This is a platform constraint, not a Shoot bug.
- **A check command that lies still lies.** Shoot verifies exit codes, not test quality.
- **Config tamper detection is a tripwire, not a sandbox.** It makes a change to your
  check commands *visible* and requires approval; it does not judge whether the change is
  safe, and an approved command runs with your full permissions. It also can't help if an
  attacker already has write access to your working tree — they could edit
  `.shoot/trust.json` directly. Read a config change from an unfamiliar contributor the
  same way you'd read any other code change.
- **Secret redaction is best-effort pattern matching, not a guarantee.** No regex list is
  exhaustive. It is calibrated to over-redact — a false positive costs you a moment of
  confusion, a false negative writes a live credential to disk — but it will miss bespoke
  token formats, secrets split across lines, base64-wrapped blobs, and anything that looks
  like ordinary prose. Keep secrets out of test output in the first place.

  <details>
  <summary>Exactly what redaction currently covers</summary>

  | Pattern | Covers |
  | --- | --- |
  | `pem-private-key` | PEM private key blocks (RSA, EC, OPENSSH, PGP, generic) |
  | `pem-private-key-header-only` | An unterminated PEM header, in case output was truncated |
  | `aws-access-key-id` | AWS access key IDs (`AKIA`/`ASIA`/`ABIA`/`ACCA` + 16 chars) |
  | `aws-secret-access-key` | AWS secret keys assigned to a recognizable name |
  | `google-api-key` | Google API keys (`AIza` + 30 or more chars) |
  | `github-token` | `ghp_` `gho_` `ghu_` `ghs_` `ghr_` `github_pat_` |
  | `slack-token` | Slack `xoxb-` / `xoxa-` / `xoxp-` / `xoxr-` / `xoxs-` |
  | `stripe-key` | `sk_live_` `sk_test_` `rk_live_` `rk_test_` |
  | `openai-key` | `sk-…` and `sk-proj-…` |
  | `anthropic-key` | `sk-ant-…` |
  | `npm-token` | `npm_…` |
  | `jwt` | JWT-shaped strings (three base64url segments beginning `eyJ`) |
  | `generic-secret-assignment` | A 16+ char value assigned to a name containing key / token / secret / password / credential / auth |
  | `authorization-header` | `Authorization:` headers using Bearer / Basic / Token |
  | `bearer-token` | A bare `Bearer <token>` |
  | `url-basic-auth` | Credentials in a URL (`scheme://user:pass@host`) — host is preserved |
  | `connection-string-password` | `password=` / `pwd=` in connection strings |

  Where a pattern captures the variable name, the name is preserved so you can still tell
  *what* leaked — only the value is replaced. Defined in
  [`src/core/redact.ts`](./src/core/redact.ts); additions welcome.
  </details>

[claims]: .github/ISSUE_TEMPLATE/claim_detection.md

## FAQ

**Will this slow down my agent?**
Barely. If the final message contains no completion claim, Shoot runs nothing and exits
silently — measured at roughly **0.3s**, essentially all of it Node process startup, with
no transcript entry left behind. You only pay the real cost (your test suite) when the
agent actually claims to be done, which is exactly when you want it run.

**What if I don't have tests?**
Leave `checks.test` blank. Any empty command is skipped, not failed — a project without
a lint step isn't penalized for it. Configure whatever you do have; a typecheck or build
alone is still a real signal. With nothing configured, Shoot tells you rather than
silently passing.

**Why not just ask Claude to verify?**
Because that asks the agent to be both the one doing the work and the one judging it. An
agent that would claim "tests pass" without running them will just as readily claim it
verified them. The check has to live in the harness, outside the agent's control: Shoot
runs the commands itself, reads the real exit codes, and the agent cannot skip it,
reinterpret it, or talk it out of a failing result. It's not that the agent is
untrustworthy — it's that self-reported verification isn't verification.

**Does this work with Cursor or Windsurf?**
Not yet. Claude Code and OpenAI Codex CLI are supported today. Cursor documents a `stop`
hook but it's unclear whether it fires in the CLI, so it's deliberately unsupported
rather than half-working — see [docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md).
The verification engine is independent of the hook layer, so adding a platform is a
small adapter, not a rewrite.

**What if the checks are slow?**
They run only on completion claims, sequentially, each bounded by `timeoutSeconds`
(default 120s). A timeout is treated as a failure and reported as a timeout, so a wedged
runner can never hang your session.

**Can it get stuck blocking forever?**
No. The circuit breaker stands down after `maxBlocksPerSession` consecutive blocks for
the same failure. See [The circuit breaker](#the-circuit-breaker).

**Does it touch my other hooks?**
No. `init` merges into `.claude/settings.json` and `uninstall` removes only Shoot's own
entries — verified by a round-trip test asserting the file is byte-identical afterward.

## Roadmap

**What exists today:** claim detection, real check execution with timeouts, block/warn
modes, circuit breaker, stop + subagent-stop events, Claude Code and Codex adapters,
config tamper detection, secret redaction, local verification history, `doctor`,
advisory scope-drift warning, seven CLI commands.

### Ideas, not commitments

Everything below is **unscheduled and aspirational**. No dates, no promises — these are
things worth building, listed so you can see the direction and tell me if I'm wrong about
the priorities. Several are blocked on someone else's documentation rather than on effort.

- **Cursor adapter** — Cursor documents a `stop` hook with a `followup_message` field,
  which is close to what Shoot needs. The blocker is that their docs don't say whether
  agent hooks fire under `cursor-agent` (CLI) or only in the desktop app. Shipping an
  adapter that silently does nothing would be the exact failure mode this tool exists to
  prevent, so it waits on confirmation. See
  [docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md).
- **Kiro adapter** — Kiro has a hooks system, but research didn't confirm a
  completion-blocking-equivalent event. Hooks that only observe can log a false claim;
  they can't stop one. Needs verification against AWS's current docs first.
- **Live-session verification of the Codex adapter** — built to the documented contract
  and unit-tested, but never run against a real Codex session. The Claude Code path has
  been; that asymmetry should close.
- **Shareable stats summary** (`shoot stats --team` or similar) — for teams who want to
  surface their false-claim-catch rate. Would need a format that's useful without leaking
  claim text or file paths, which is the actual design problem.
- **Non-English claim-detection phrase packs** — the detector is English-only today. A
  completion claim phrased in Spanish, Mandarin, Hindi, or anything else goes completely
  undetected. The pattern table is already data rather than logic, so this is mostly a
  translation-and-testing problem, and it's the gap most likely to matter to real users
  outside English-speaking teams.
- **Optional GitHub Action variant** — run the same verification logic at PR/CI time, not
  only locally via the agent hook. The core is already platform-neutral, so this is
  plausible without restructuring.
- **Mascot artwork** — the brief exists at
  [assets/mascot-placeholder.md](./assets/mascot-placeholder.md); the art does not.
- **Dogfooding demo video** — the script exists at [DEMO.md](./DEMO.md), ready to record.

### Deliberately not planned

- Any dashboard or hosted service. Shoot stays local and offline.
- Semantic scope-drift detection. Today's is a file-count heuristic and is honest about
  it; making it smarter risks making it confidently wrong.
- Per-check timeouts, parallel check execution, git-aware checks. All defensible, none
  urgent.

## Security

Shoot runs automatically with your local permissions, so its threat model is written down
rather than assumed: **[SECURITY.md](./SECURITY.md)**. It covers what the mitigations
above actually do, what they explicitly don't, and how to report a vulnerability privately
(GitHub private advisory — please don't open a public issue for one).

## Contributing

Contributions welcome — especially real-world phrasings the claim detector missed. See
[CONTRIBUTING.md](.github/CONTRIBUTING.md). The one hard rule: **zero runtime
dependencies**, enforced by CI.

Release process, including npm Trusted Publishing setup:
[docs/RELEASING.md](./docs/RELEASING.md).

## License

[MIT](./LICENSE)
