# Origin: why Shoot exists

*A short research memo documenting the reasoning behind this project. Written from
demand research conducted before implementation began, in mid-2026. Claims below are
recorded as research findings with the evidence that supported them, not as settled
facts — where a finding is an inference or a judgment call, it is marked as such.*

---

## 1. Problem statement

AI coding agents — Claude Code, Cursor, and others — routinely report that work is
"done," "fixed," or that "tests pass" without having verified any of it. The agent ends
its turn, the developer moves on, and the failure is discovered later.

This is a current, documented failure mode rather than a hypothetical risk. It is also
distinct from ordinary model error: the code being wrong is one problem, but *the claim
that it is right* is a separate and more corrosive one, because it defeats the review
step the developer would otherwise perform. The cost is borne in trust, and trust is
recovered more slowly than a bug is fixed.

The research question was therefore narrow: is this pain acute enough, widespread
enough, and unaddressed enough to justify a dedicated tool?

## 2. Evidence

Four independent signals were found, all current at the time of research:

**An open, critical-severity issue on Anthropic's own Claude Code repository** tracking
this exact pattern. This was the strongest single signal — the behaviour is acknowledged
upstream by the vendor, not merely complained about downstream by users.

**A community-maintained "Claim-Verify Handbook"** cataloguing a taxonomy of where the
failure occurs. The existence of a *taxonomy* — rather than a single bug report — indicates
the problem is structured and recurring enough that practitioners have begun classifying
its varieties.

**Coverage in AI Weekly** of a developer who measurably reduced false-success claims using
a hook-based fix. Notable for two reasons: it established that the hook approach works in
practice, and that the result was considered newsworthy, implying the problem was widely
felt by the readership.

**Curated "best Claude Code setup" lists** recommending ad hoc skills for exactly this
problem, as recently as the same month the research was conducted. This indicated live,
ongoing demand rather than a historical annoyance already solved.

Taken together: the problem is real, current, vendor-acknowledged, and people are
actively assembling their own partial solutions for it.

## 3. Why this was still an open opportunity

The most important finding was not that the problem existed, but that it was
*simultaneously well-known and unpackaged*.

Multiple developers had independently written approximately the same fix — a `Stop`-hook
script that re-runs the test suite before allowing the agent to finish — and published it
as one-off blog posts and gists. Convergent independent invention is a strong demand
signal: it means the need is obvious enough that many people arrive at the same answer
without coordinating.

But nobody had packaged it. There was no single, polished, well-named, zero-dependency
tool with documentation and an identity that a developer could install in one command and
recommend to a colleague.

The closest analogue identified was the widely-shared `CLAUDE.md` repository, which filled
exactly this kind of gap for *behavioural guidance* — taking scattered, commonly-known
practice and giving it one canonical, well-presented home. The same gap appeared to be
open for *verification*. This analogy is the central bet of the project, and it is an
inference rather than a certainty.

## 4. Why this shape of solution

### The viral-shape finding

Research into what makes open-source projects gain traction **in 2026 specifically** —
rather than relying on historical patterns — found a consistent shape across current
examples:

- one narrow, acute, widely-felt pain point
- trivially easy to install
- riding an active wave of interest
- carrying a sharp, memorable narrative

The corresponding anti-pattern was broad platforms competing directly with funded teams.
The strategic conclusion was to build something deliberately small and sharply scoped
rather than ambitious and general. Shoot's v1 scope — detect completion claims, run the
project's real checks, block if they fail — is a direct consequence of this finding, as is
the decision to defer scope-drift detection, multi-agent support, and any dashboard.

### Why not simply prompt the agent to check its own work

This objection was raised early and is the most important design question, since if
self-verification worked, no tool would be needed.

The research finding is that self-verification is a **structural limitation, not a
prompting gap**. An agent grading its own output applies the same reasoning that produced
the error in the first place; the blind spot that generated a wrong claim is the blind spot
that will fail to catch it. Supporting evidence: a 2026 study found that agent-authored
tests barely move real issue-resolution rates and skew toward trivial assertions — the
agent tends to write tests that pass rather than tests that discriminate.

The implication is that the check must be **external and harness-enforced** — a gate whose
outcome the agent cannot decide. Shoot runs the configured commands itself, reads the real
exit codes, and returns a decision the agent cannot skip, reinterpret, or argue with. The
agent's cooperation is not required, which is the entire point.

This distinction is load-bearing. A version of this tool that asked the agent to confirm
its own verification would provide the feeling of safety without the substance.

### The zero-dependency constraint

Adopted as a security and trust property, not as minimalism. Shoot runs inside the
developer's agent session with access to their project, and there have been real
supply-chain attacks in 2026 via malicious Claude Code hook packages carrying hidden
install scripts. A tool asking to be trusted with a verification gate should be auditable
in a single sitting — a dependency tree forecloses that. Enforced in CI.

### Naming

An earlier working name used a detective metaphor; it was swapped for the bamboo-and-panda
framing during a casual brainstorm, on the grounds that an encouraging companion reads
better than a cop. The metaphor also happens to carry the product logic: a shoot does not
stretch upward until its roots check out.

## 5. How it was built

Worth recording plainly, because it is part of the argument for trusting the tool.

Shoot was built across **eight structured phases**, with a human review checkpoint after
each one — scaffold, claim detector, verification runner and circuit breaker, hook I/O, CLI
commands, documentation, live end-to-end testing, and release. Each phase's output was
reviewed and explicitly approved before the next began, and several design decisions (the
block-limit ceiling, the fail-open policy, the detector's quiet-when-uncertain bias) were
settled at those checkpoints rather than by the implementation alone.

The seventh phase — real end-to-end testing against a **live agent session** — proved the
most consequential. It surfaced a genuine infinite-loop bug that the 155 unit and
integration tests passing at that point could not have caught: the hook returned its
pass-path receipt in a field that *continues* the conversation rather than ending it, so a
correct fix produced a loop of restated claims that ran nine times before the host's
internal safety cap force-ended the turn. The fix was to honour the `stop_hook_active`
field and to stop using that field on any allow path.

A one-shot hook invocation cannot reproduce a forced-continuation state, so no amount of
unit testing against synthesized payloads would have found this. It required a real
session. That bug was found and fixed **before the tool reached a single external user**.

Two further findings from the same period are recorded in the README's *Known limitations*
rather than hidden: the claim detector does not catch rhetorical question-then-answer forms,
and Shoot's verification is only ever as good as the commands it is given — it cannot invent
tests a project does not have.

One methodological note, since it changed what shipped. When support for a second agent
platform was scoped, the initial research brief came from secondary sources — blog posts and
community references — and described OpenAI's Codex CLI hooks as experimental, disabled by
default behind a feature flag, and unavailable on Windows. Checking each claim against
OpenAI's own documentation contradicted all three: hooks are documented as enabled by
default, and a Windows-specific command override implies Windows support. The Windows
concern traced to a real but much narrower open bug about JSON serialization of non-ASCII
text. Cursor was similarly described as having no usable stop hook; its documentation in
fact describes one, and the genuine blocker turned out to be a different, narrower
uncertainty about whether it fires outside the IDE.

Convergent secondary sources are a reasonable signal that a problem is real — that is
exactly how the original opportunity was identified in §3. They are a poor substitute for a
primary source when the question is what an interface actually does. Both distinctions are
recorded in [docs/PLATFORM_SUPPORT.md](./docs/PLATFORM_SUPPORT.md) so a future contributor
does not have to rediscover them.

---

*This document describes the reasoning at the time of building. Where the research
informed a bet rather than established a fact, that is noted above. Corrections and
counter-evidence are welcome as issues.*
