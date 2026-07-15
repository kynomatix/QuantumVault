---
name: qv-workorder-planning
description: >-
  Turn QuantumVault plan docs into anchored, one-per-task Work Orders and run
  the one-at-a-time dispatch loop. Use when any plan doc is being prepared for
  execution, or on any request mentioning "work order", "WO", "dispatch",
  "economy mode", "power mode", or structuring a body of QuantumVault work into
  tasks for Replit Agent.
---

# QV Work Order Planning

The repeatable process for converting a finished QuantumVault plan doc into
anchored Work Orders — dispatched one at a time, each approved individually by
the owner — so Economy mode ships correctly instead of drifting.

---

## 1. The one rule

**Economy mode drifts the moment a Work Order leaves anything to invent.**

The bar for every WO: the executing agent has nothing left to decide. Every file
named, every symbol verified against live code, exact scope, explicit DO NOT
TOUCH, concrete acceptance, no open questions.

A tight spec on Economy beats a vague spec on Power, every time. If a WO seems
to need Power only because it is under-specified, fix the spec, not the mode.

---

## 2. The anchored WO plan format

Embed this template verbatim; fill every section before dispatching.

```
# WO-<id> — <one-line title>

MODE: <Economy · High-Effort | Power · High-Effort> — <one-sentence justification>

GOAL: <one or two sentences; the outcome, not the steps>

Source of truth: <plan doc path, repo root>. Plan wins over this WO; live code wins over the plan.
<Gate preconditions if any.>

## CONTEXT (verified against live code <date> — re-verify symbols before editing; line numbers are hints and WILL drift)
<the real methods/shapes/paths this WO touches, quoted from discovery>

## BUILD
<numbered steps: exact file, exact function/interface, exact behavior — types, params, return shapes.
Pin implementation choices (cache shape, concurrency, timeouts, constants) so they are not invented ad hoc.>

## DO NOT TOUCH
<explicit list: money-path, adapter, signing, schema files that must not change; "no new npm dependencies" when true; og-image always>

## TESTS
<exact tests to add/run; FULL suites, not just the new file; typecheck at baseline>

## ACCEPT
<concrete observable condition> Then ARCHITECT REVIEW (executed, verdict quoted — not implied
by passing tests), then STOP and report the complete verbatim diff + all test output.
Do not continue to any other work.

## Relevant files
<backtick paths with line ranges, verified to exist>
```

**Corrective WOs:** when a report fails verification, the corrective names the
specific deviation, quoted — never "try again." One corrective per miss; the
diff gets re-checked against the same criteria.

**Empirical gates:** for anything calibration-like (detectors, thresholds, cost
models), put a measured gate in the WO with a numeric bar. Tests prove the code
matches the spec — only measurement proves the spec was right.

---

## 3. Discovery before writing (mandatory)

Never write a CONTEXT block from docs or memory alone.

- Grep every symbol the WO names; confirm file paths exist.
- Anchor by SYMBOL NAME with line numbers as parenthetical hints only — they
  drift after every merge.
- Where plan and code disagree, the code is truth and the plan is history.
- Past traps to check for: methods that don't exist; object params vs.
  positional; `side: 'long'|'short'` not buy/sell; `timeInForce: 'ALO'` for
  post-only; `agentPublicKey` parameter actually taking a per-bot wallet pubkey.
- Confirm the file paths the WO names still exist and contain what the WO
  assumes.

---

## 4. Mode formula (owner's rules — encode exactly)

Every WO opens with a `MODE:` line. The MODE line is a recommendation; the
actual mode selector is owner-side UI, set before approving each task.

- **Economy · High-Effort** = the default for ALL named-target work, even in a
  money path, when the spec carries the answer.
- **Power · High-Effort** = two cases only:
  (a) Exploratory money-path work that can't be named in advance (novel
      algorithms, hardening/failure hunts where the problem is unknown).
  (b) Anything that inserts branching into or rewires the live money path's
      callers: executor, monitor, guardrails, adapters, signing paths. Historical
      evidence: Power runs on monitor, executor, guardrails, and hardening each
      caught position-destroying bugs that Economy would have missed.
- **Never Lite, never Turbo.**
- If a WO seems to need Power only because it is under-specified, fix the spec.

---

## 5. The dispatch loop (Replit-native)

```
1. DISCOVER against the live codebase — confirm current state, real method
   names/shapes, file paths. Never assume from docs or memory.
2. WRITE the anchored Work Order (template above). One component, least scope.
3. PROPOSE all draft tasks up front, dependency-chained in build order.
4. Owner approves exactly ONE task at a time, setting the mode selector first.
   A draft NEVER starts on its own. NEVER batch-approve — batch approval
   auto-advances the chain without the owner reviewing each result.
5. Owner-review gates live BETWEEN approvals (e.g. review audit output, multi-
   day shadow soak). The next task is not approved until its gate clears.
6. Each task runs in an isolated copy. The owner reviews the result before
   merge — that is the verify-the-diff step.
```

**Verification checklist (apply after every returned report):**
- Scope held: only intended files changed; DO NOT TOUCH respected; no drive-by
  refactors.
- Money-safety invariants intact: strict reads, on-chain-is-truth, fail-closed
  money legs, write-ahead ops, reduce-only/post-only where required.
- Architect verdict quoted, not implied ("passed tests" is not an architect
  review).
- Full-suite test output present with counts matching the established baseline.
- Treat completion reports skeptically. Red flags: "was already done," named
  artifacts you can't confirm, reviews "implied" rather than run, baselines that
  drift between reports. Verify claims with concrete artifacts.

**Runtime testing is owner's:** the exact runtime check (which button, which
bot, what to observe) must be spelled out in the ACCEPT block.

---

## 6. QuantumVault conventions (hold on every WO)

These rules apply to every Work Order regardless of feature area.

**Data & state**
- On-chain is truth; DB is cache. Re-read at decision points.
- Money legs fail CLOSED (abort, pause, never guess).
- Context/enrichment fails OPEN (omit the block, stamp null, the decision
  proceeds — never let enrichment block a money path).
- Strict reads in every money path (`getAgentTokenBalanceRawStrict`, not
  fail-open helpers).
- Money legs use write-ahead op discipline: op row + signature before broadcast,
  credit only the on-chain delta, resume by signature status, fail closed.

**Schema & DB**
- Schema changes via idempotent startup DDL in `ensureSchema` (`server/db.ts`),
  one statement per try/catch — never `db:push` (it proposes column drops on
  columns the schema file doesn't know about).
- Additive columns only; always include `IF NOT EXISTS`; rollback statement
  must be in the WO.

**Exchange & adapters**
- Adapter-only exchange access through the `ProtocolAdapter` interface — no
  protocol SDK calls in feature code.
- Bot-scoped ops use `getAdapterForBot(bot)`, not `getDefaultAdapter()`.
- Legacy names are load-bearing (`drift_*`, `driftSubaccountId`) — never
  "correct" them in passing.

**AI Trader executor invariants**
- Executed AI-Trader decisions are never pruned or stripped — they feed
  graduation, net PnL, calibration, and the playbook.
- `executeDecision` does NOT re-read the bot row; it uses the object it is
  passed. Any code that mutates `bot.market` must refresh the in-memory object
  AND recompute `policyHmac` in the same DB update before passing it downstream.

**UI**
- Existing tokens/components only; no new npm dependencies unless the WO
  explicitly justifies and names them.
- `data-testid` on every interactive element and meaningful display element.
- Plain text nodes for AI-authored text (no `dangerouslySetInnerHTML`, no
  markdown rendering).
- Title Case labels. No mockups for incremental UI work.
- Never touch `og-image-v3.jpg` or the `og:image`/`twitter:image` tags in
  `client/index.html`.

**Docs**
- Product docs live in TWO surfaces: `client/src/pages/Docs.tsx` (React, /docs)
  AND `server/docs-markdown.ts` (template literal, /api/docs). Edit both in
  sync.
- Plan docs that must survive merges live at repo root — `docs/` is gitignored
  so files there never merge.

---

## 7. Worked example pointer

`AI_TRADER_SCANNER_PLAN.md` (repo root) and its four Work Orders (WO-0, WO-A,
WO-B, WO-C) are the canonical worked example of this format in practice:

- **WO-0** (Economy · High-Effort): a tiny feed-audit script — named target,
  spec contains the answer, Economy correct.
- **WO-A** (Economy · High-Effort): scanner core in shadow mode — large named
  build, fully pinned constants and cache shapes, no exploration needed.
- **WO-B** (Power · High-Effort): schema + monitor wiring — inserts branching
  into `runAutoCycle` (live money path caller), Power warranted.
- **WO-C** (Economy · High-Effort): UI only — named targets, existing tokens,
  no money-path rewiring.

The plan also demonstrates gate discipline: Gate 1 (WO-0 audit output reviewed),
Gate 2 (3-day shadow soak), Gate 3 (candidate quality review) — each is a hard
STOP between WOs, never auto-advanced.
