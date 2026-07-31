# Platform support

What Shoot supports today, what it doesn't, and — where it doesn't — exactly what is
blocking it. No "coming soon" without a reason attached.

Research was done against each vendor's own primary documentation. Where a claim comes
from somewhere else, or couldn't be confirmed, that's stated.

Last verified: 2026-07-31.

---

## Supported

### Claude Code — fully supported

The original and best-tested target.

| | |
| --- | --- |
| Config | `.claude/settings.json`, under a `hooks` key |
| Events used | `Stop`, `SubagentStop` |
| Block mechanism | `{"decision":"block","reason":"..."}` on stdout, exit 0 |
| User-facing notice | `systemMessage` — shows the user a message without continuing the turn |
| Re-entrancy guard | `stop_hook_active` |
| Validation | Unit + integration tests, plus verified against a **live session** |

Docs: [code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)

The live-session testing is what makes this the trusted path. It caught a bug no
amount of synthetic-payload testing could have — see the README's *How it works*.

### OpenAI Codex CLI — supported, less battle-tested

| | |
| --- | --- |
| Config | `.codex/hooks.json`, under a `hooks` key (Codex also reads `~/.codex/` and `config.toml` variants) |
| Events used | `Stop`, `SubagentStop` |
| Block mechanism | `{"decision":"block","reason":"..."}` on stdout |
| User-facing notice | **None available on `Stop`** — see below |
| Re-entrancy guard | `stop_hook_active` — same name, same meaning |
| Validation | Built to the documented contract; **not yet verified against a live Codex session** |

Docs: [learn.chatgpt.com/docs/hooks](https://learn.chatgpt.com/docs/hooks)
(`developers.openai.com/codex/hooks` redirects there, so that page is canonical.)

Three things worth knowing before you rely on it:

1. **`decision: "block"` means something different than it does on Claude Code.** On
   Codex it tells the agent to *continue*, using `reason` as the next prompt. On Claude
   Code it *prevents* stopping. The wire shape is identical and both produce the
   behavior Shoot wants — the agent keeps working with the real errors in hand — but
   they are not the same underlying operation.

2. **`systemMessage` is not supported on `Stop`.** The docs describe it as parsed but
   supported only for other events. So Shoot's pass receipt prints to your terminal
   (stderr) but will not appear in the Codex UI. Blocking is unaffected.

3. **A known open Codex bug affects Windows.**
   [openai/codex#23784](https://github.com/openai/codex/issues/23784) — non-ASCII text
   in `last_assistant_message` can be serialized as invalid JSON, making stdin
   unparseable *before* any hook runs. Shoot fails open, so the result is a skipped
   verification rather than a crash. It is skipped silently by the host, not by Shoot,
   which is why `shoot init` and `shoot doctor` both say so on Windows.

**A correction worth recording:** secondary sources describe Codex hooks as
experimental, disabled by default behind a `codex_hooks` feature flag, and unavailable
on Windows. None of that matches the primary documentation, which states hooks are
*enabled by default* (disable via `[features] hooks = false`) and documents a
`commandWindows` override implying Windows support. Shoot is built to the documented
contract. If you hit behavior matching the secondary description, please open an issue —
that would mean the docs and the shipped binary disagree.

---

## Not supported yet

### Cursor — plausible, but unverified

Cursor **does** document a `stop` hook that fires "when the agent loop ends," alongside
`sessionStart`/`sessionEnd`, `preToolUse`/`postToolUse`, `subagentStop`, `preCompact`,
and others. It supports a `followup_message` field which, when non-empty, Cursor
"will automatically submit as the next user message" — functionally close to what Shoot
needs for a block.

**What's blocking it:** not the hook's existence, but confidence about where it runs.
Cursor's documentation does not state whether standard agent hooks fire in the Cursor
CLI (`cursor-agent`) or only in the desktop app. It explicitly notes that
`workspaceOpen` runs in "the Cursor desktop app and CLI," which implies the distinction
matters for other events — but doesn't resolve it for `stop`. There are community
reports that the stop hook is IDE-only; those are not something this project has
verified.

Shipping an adapter that silently does nothing in CLI usage would be worse than
shipping none, because a verification tool that appears installed but never fires is
exactly the failure mode Shoot exists to prevent.

**To unblock:** confirm whether `stop` fires under `cursor-agent`, then map
`followup_message` onto Shoot's `block` verdict. That's a small adapter once the
question is answered. Docs: [cursor.com/docs/agent/hooks](https://cursor.com/docs/agent/hooks)

### Kiro (AWS) — hooks exist, blocking equivalent unconfirmed

Kiro has an agent hooks system. What research did **not** confirm is whether it exposes
a completion- or stop-equivalent event that a hook can use to prevent or reverse the end
of an agent turn.

**What's blocking it:** Shoot's entire mechanism depends on being able to intervene at
the moment the agent declares itself finished. Hooks that only observe — fire-and-forget
notifications, or events that can't influence control flow — can log a false claim but
cannot stop one. Without confirming a blocking-capable event, there is nothing to build
against.

**To unblock:** verify against AWS's current Kiro documentation whether any hook event
can (a) fire at agent-turn completion and (b) return a decision that keeps the agent
working. If yes, the adapter is straightforward; the core pipeline is already
platform-neutral.

### Antigravity — no extensibility surface found

Research found no comparable hook or extensibility system for Antigravity as of the
date above.

**What's blocking it:** there is no documented integration point. This is not a case of
"the event is the wrong shape" — nothing was found to attach to at all.

**To unblock:** a documented hook, plugin, or lifecycle-event API. If one exists and
this research missed it, please open an issue with a link; that would be genuinely
useful.

---

## Adding a platform

The verification pipeline is deliberately independent of any host. An adapter only does
two jobs:

1. parse that platform's stdin payload into Shoot's normalized `HookInput`
2. format Shoot's normalized `Verdict` into that platform's expected stdout

See [`src/adapters/types.ts`](../src/adapters/types.ts) for the interface, and
[`claudeCode.ts`](../src/adapters/claudeCode.ts) / [`codex.ts`](../src/adapters/codex.ts)
as worked examples. No verification logic belongs in an adapter — if you find yourself
changing *what* gets checked, it goes in the core.

Two requirements for a new adapter to be merged:

- **A real blocking mechanism.** An observe-only hook cannot enforce anything.
- **Honest `warnings()`.** If the platform has caveats — a field that doesn't work, a
  known host bug, untested paths — say so at install time. Never silently degrade.

Verification against a live session of that platform is strongly preferred before an
adapter is described as supported rather than experimental.
