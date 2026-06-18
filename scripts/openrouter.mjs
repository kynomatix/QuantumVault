#!/usr/bin/env node
/**
 * OpenRouter CLI for QuantumVault dev tooling — Chinese + frontier models.
 *
 * NOT wired into the production server — used for code reviews, plan audits,
 * architect feedback, and algorithm checks.
 *
 * Auth: requires OPENROUTER_INTERNAL env var (set in Replit secrets).
 *
 * Model IDs are as of June 2026 — if a call returns 404, check openrouter.ai/models.
 * DeepSeek legacy aliases (deepseek-chat, deepseek-reasoner) retire 2026-07-24.
 *
 * Usage:
 *   npm run openrouter -- --task plan-audit --prompt-file docs/SCALABILITY_PLAN.md
 *   npm run openrouter -- --task code-review --prompt-file diff.txt
 *   npm run openrouter -- --task architecture --prompt-file design.md
 *   npm run openrouter -- --task algorithm --prompt "verify this logic: ..."
 *   npm run openrouter -- --task sanity --prompt "is this safe: ..."
 *   npm run openrouter -- --task frontend --prompt-file Component.tsx
 *   npm run openrouter -- --task large-context --prompt-file big-module.txt
 *   npm run openrouter -- --budget --task plan-audit --prompt-file p.md   (cheapest model)
 *   npm run openrouter -- --fallback --task code-review --prompt "..."    (second-opinion model)
 *   npm run openrouter -- --model moonshotai/kimi-k2.7-code --prompt "..." (explicit override)
 *   cat file.ts | npm run openrouter -- --task code-review
 *
 * Tasks:
 *   code-review    — logic, security, performance, maintainability
 *   plan-audit     — completeness, ambiguity, risk, agent failure points
 *   architecture   — structural soundness, data flow, interfaces, failure modes
 *   algorithm      — correctness proof, complexity, trading logic, precision
 *   frontend       — React/TS, state, effects, a11y, perf, security
 *   large-context  — multi-file consistency, cross-file deps, dead code (use for >50K tokens)
 *   batch          — boilerplate/test generation; output-only, no prose
 *   sanity         — quick single-concern check (default)
 *
 * Routing (primary / fallback / budget):
 *   code-review    qwen/qwen3.7-max         / moonshotai/kimi-k2.7-code   / deepseek/deepseek-v4-pro
 *   plan-audit     qwen/qwen3.7-max         / deepseek/deepseek-v4-pro    / deepseek/deepseek-v4-pro
 *   architecture   qwen/qwen3.7-max         / z-ai/glm-5.1                / deepseek/deepseek-v4-pro
 *   algorithm      qwen/qwen3.7-max         / moonshotai/kimi-k2.7-code   / deepseek/deepseek-v4-pro
 *   frontend       z-ai/glm-5.2             / z-ai/glm-5.1                / deepseek/deepseek-v4-pro
 *   large-context  minimax/minimax-m3       / qwen/qwen3.7-max            / deepseek/deepseek-v4-pro
 *   batch          deepseek/deepseek-v4-pro / minimax/minimax-m3          / deepseek/deepseek-v4-flash
 *   sanity         deepseek/deepseek-v4-pro / moonshotai/kimi-k2.7-code   / deepseek/deepseek-v4-flash
 */

import fs from 'node:fs/promises';

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SITE_URL = 'https://myquantumvault.com';
const SITE_NAME = 'QuantumVault';

const MODELS = {
  QWEN_37_MAX:     'qwen/qwen3.7-max',
  DEEPSEEK_V4_PRO: 'deepseek/deepseek-v4-pro',
  DEEPSEEK_FLASH:  'deepseek/deepseek-v4-flash',
  KIMI_K26:        'moonshotai/kimi-k2.6',
  KIMI_K27_CODE:   'moonshotai/kimi-k2.7-code',
  GLM_51:          'z-ai/glm-5.1',
  GLM_52:          'z-ai/glm-5.2',
  MINIMAX_M3:      'minimax/minimax-m3',
};

const TASKS = {
  'code-review': {
    primary:  MODELS.QWEN_37_MAX,
    fallback: MODELS.KIMI_K27_CODE,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.15,
    maxTokens:   4096,
    system: `You are an expert code reviewer. You receive code WITHOUT access to the broader codebase.

Review for:
1. Correctness — logic errors, off-by-ones, null/undefined paths, race conditions
2. Security — injection vectors, key/secret exposure, unsafe deserialization
3. Performance — N+1s, blocking calls, memory leaks
4. Maintainability — naming, complexity, missing error handling
5. Flag anything that assumes context you haven't been given

Output format:
## Summary
[1-2 sentence overall verdict]

## Issues Found
For each issue:
- **Severity**: CRITICAL | HIGH | MEDIUM | LOW | INFO
- **Location**: [line or function name]
- **Issue**: [what's wrong]
- **Fix**: [concrete suggestion]

## Questions for Codebase Owner
[things you couldn't assess without broader context]

Be direct. If code is clean, say so briefly and stop.`,
  },

  'plan-audit': {
    primary:  MODELS.QWEN_37_MAX,
    fallback: MODELS.DEEPSEEK_V4_PRO,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.1,
    maxTokens:   4096,
    system: `You are an expert technical plan auditor for AI-assisted development. You receive a markdown plan intended to be executed by an AI coding agent. You do NOT have access to the codebase.

Audit across:
1. Completeness — all steps present from start to testable state; clear definition of done per phase
2. Ambiguity — instructions an agent could interpret multiple ways; missing file paths or schema refs
3. Risk & dependency — steps that assume prior state without verifying; destructive operations without safeguards
4. Agent failure points — steps too large for a single action; steps needing human judgment not flagged; missing rollback

Output issues as a numbered list with severity: BLOCKER | MAJOR | MINOR | SUGGESTION
End with: READY TO EXECUTE | NEEDS MINOR FIXES | NEEDS MAJOR REVISION`,
  },

  'architecture': {
    primary:  MODELS.QWEN_37_MAX,
    fallback: MODELS.GLM_51,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.2,
    maxTokens:   4096,
    system: `You are a senior software architect. You receive a system design description WITHOUT access to implementation code.

Review:
1. Structural soundness — component separation, responsibility boundaries, hidden coupling
2. Data flow & state — where state lives, synchronisation risks, normalisation
3. API & interface design — stability, versioning, error propagation
4. Scalability & failure modes — what breaks at 10x load; single points of failure; blast radius
5. Security surface — auth boundaries, data exposure, secrets management

Verdict: APPROVED | APPROVED WITH CONDITIONS | REVISE & RESUBMIT
Top 3 highest-priority changes. Reference specific components by name. No generic advice.`,
  },

  'algorithm': {
    primary:  MODELS.QWEN_37_MAX,
    fallback: MODELS.KIMI_K27_CODE,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.1,
    maxTokens:   4096,
    system: `You are a formal reasoning and algorithm verification expert. You verify correctness, not style.

1. Correctness proof — step-by-step trace, invariant identification, termination, edge cases
2. Complexity — time/space (best/average/worst) with justification; more efficient approach?
3. Numerical precision — floating point hazards, compounding rounding errors, integer overflow
4. Trading logic (if applicable) — entry/exit symmetry, stop reachability, position size division safety

Verdict: CORRECT | CORRECT WITH CAVEATS | INCORRECT
If incorrect: exact counter-example or proof of failure.
Show your working. A verdict without a trace is not useful.`,
  },

  'frontend': {
    primary:  MODELS.GLM_52,
    fallback: MODELS.GLM_51,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.15,
    maxTokens:   4096,
    system: `You are a senior front-end engineer specialising in React, TypeScript, and modern web standards. You receive component code WITHOUT access to the broader application.

Review:
1. Correctness — state update correctness, useEffect deps, event handler stability, conditional rendering edge cases
2. Performance — unnecessary re-renders, missing memo/useCallback/useMemo, unstable list keys
3. Accessibility — missing ARIA, keyboard navigation, screen reader considerations
4. Code quality — component responsibility, prop drilling, magic values, missing error boundaries
5. Security — dangerous innerHTML, unsanitised user input, sensitive data in storage/URL

Output as prioritised issue list: severity, location, issue, fix.`,
  },

  'large-context': {
    primary:  MODELS.MINIMAX_M3,
    fallback: MODELS.QWEN_37_MAX,
    budget:   MODELS.DEEPSEEK_V4_PRO,
    temperature: 0.15,
    maxTokens:   8192,
    system: `You are conducting a holistic review of a large codebase module or multi-file submission. You have been given the full context — use it.

1. Consistency — naming conventions, error handling patterns, logging patterns, config patterns
2. Cross-file dependencies — circular imports, tight coupling, shared mutable state
3. Dead code & redundancy — unused exports, duplicated logic, commented-out blocks
4. Integration points — connections to external systems, mismatched types or contracts
5. Security sweep — hardcoded secrets, input sanitisation gaps, inconsistent auth checks

Summary: dependency graph (text-based), top 5 findings across the submission, files needing immediate attention vs clean.`,
  },

  'batch': {
    primary:  MODELS.DEEPSEEK_V4_PRO,
    fallback: MODELS.MINIMAX_M3,
    budget:   MODELS.DEEPSEEK_FLASH,
    temperature: 0.05,
    maxTokens:   8192,
    system: `You are a code generation engine in batch mode.

Rules:
1. Output ONLY the requested code — no explanations, no prose, no preamble
2. Delimit each item: // ── [ITEM N: description] ──
3. Follow the exact naming convention provided
4. Maintain the pattern from item 1 precisely across all items
5. Ambiguous inputs: insert // AMBIGUOUS: [what was unclear] and continue
6. Do not skip or reorder items

Final line: // ── BATCH COMPLETE: [N] items generated ── Anomalies: [list or "none"]`,
  },

  'sanity': {
    primary:  MODELS.DEEPSEEK_V4_PRO,
    fallback: MODELS.KIMI_K27_CODE,
    budget:   MODELS.DEEPSEEK_FLASH,
    temperature: 0.1,
    maxTokens:   256,
    system: `You are a quick code checker. Be fast and direct.

1. State immediately if there is an obvious bug or not
2. If yes: one sentence describing it, one sentence fix
3. If no: one sentence confirming it looks correct
4. Flag any single security concern if present
5. Stop — do not elaborate unless asked

Format:
STATUS: BUG FOUND | LOOKS CORRECT | NEEDS CONTEXT
BUG: [one sentence, or "none"]
FIX: [one sentence, or "n/a"]
SECURITY: [one sentence, or "none"]

Maximum 6 lines.`,
  },
};

function parseArgs(argv) {
  const args = { useBudget: false, useFallback: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--task':        args.task = next(); break;
      case '--model':       args.model = next(); break;
      case '--prompt':      args.prompt = next(); break;
      case '--prompt-file': args.promptFile = next(); break;
      case '--out':         args.out = next(); break;
      case '--max-tokens':  args.maxTokens = parseInt(next(), 10); break;
      case '--temperature': args.temperature = parseFloat(next()); break;
      case '--budget':      args.useBudget = true; break;
      case '--fallback':    args.useFallback = true; break;
      case '-h': case '--help': args.help = true; break;
      default: console.error(`Unknown arg: ${a}`); process.exit(2);
    }
  }
  return args;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function callOpenRouter(model, system, userPrompt, maxTokens, temperature, apiKey) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userPrompt });

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': SITE_URL,
      'X-Title': SITE_NAME,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }

  return res.json();
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    const src = await fs.readFile(new URL(import.meta.url), 'utf-8');
    console.log(src.split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \*/gm, ''));
    return;
  }

  const apiKey = process.env.OPENROUTER_INTERNAL;
  if (!apiKey) {
    console.error('Missing OPENROUTER_INTERNAL — set it in Replit secrets.');
    process.exit(1);
  }

  const taskName = args.task || 'sanity';
  const taskCfg = TASKS[taskName];
  if (!taskCfg) {
    console.error(`Unknown task "${taskName}". Valid tasks: ${Object.keys(TASKS).join(', ')}`);
    process.exit(2);
  }

  let prompt = args.prompt || '';
  if (args.promptFile) prompt += (prompt ? '\n\n' : '') + await fs.readFile(args.promptFile, 'utf-8');
  if (!prompt) prompt = await readStdin();
  if (!prompt.trim()) { console.error('No prompt provided (use --prompt, --prompt-file, or pipe stdin)'); process.exit(2); }

  const maxTokens   = args.maxTokens   ?? taskCfg.maxTokens;
  const temperature = args.temperature ?? taskCfg.temperature;

  let model = args.model
    ?? (args.useBudget ? taskCfg.budget : args.useFallback ? taskCfg.fallback : taskCfg.primary);

  const start = Date.now();
  let data;
  let usedFallback = false;

  try {
    data = await callOpenRouter(model, taskCfg.system, prompt, maxTokens, temperature, apiKey);
  } catch (err) {
    if (err.status >= 500 || err.status === 429) {
      const fallbackModel = args.model ? null : taskCfg.fallback;
      if (fallbackModel && fallbackModel !== model) {
        console.error(`[openrouter] ${model} returned ${err.status} — retrying with fallback ${fallbackModel}`);
        model = fallbackModel;
        usedFallback = true;
        data = await callOpenRouter(model, taskCfg.system, prompt, maxTokens, temperature, apiKey);
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  const usage = data.usage ?? {};
  const tokenSummary = `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'} total=${usage.total_tokens ?? '?'}`;

  console.error(`[${elapsed}s] task=${taskName} model=${model}${usedFallback ? ' (fallback)' : ''} ${tokenSummary}`);

  const footer = `\n\n---\n> Reviewed by: ${model} · Task: ${taskName} · Tokens: ${usage.total_tokens ?? '?'}`;
  const output = text + footer;

  if (args.out) {
    await fs.writeFile(args.out, output);
    console.error(`→ ${args.out}`);
  } else {
    console.log(output);
  }
}

main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
