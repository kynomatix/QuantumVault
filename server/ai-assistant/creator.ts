// QuantumLab AI Strategy Creator (Task 187) — LLM orchestration.
//
// Turns a plain-English idea into a COMPILABLE Pine v6 strategy: draft → validate
// against the lab's Pine compiler → auto-repair loop (feed the compile error back) →
// escalate to a stronger model as a last resort → independent critic pass. The
// platform's standard backtest defaults and an honesty caveat are server-injected so
// they can never be lost between the server and any UI surface.
//
// compilePine() is tokenize+parse only — it never executes generated JS — so the
// validation loop is safe; generated JS only runs at backtest time (the same exposure
// as a hand-pasted Pine script today).

import { compilePine } from '../lab/pine/index';
import {
  callOpenRouter,
  checkRateLimit,
  CREATOR_MODELS,
  LLM_LIMITS,
  LlmGatewayError,
  type LlmMessage,
} from './router';

// The platform's standard backtest configuration, injected so the generated strategy
// is consistent with how QuantumLab actually runs it.
export const STANDARD_BACKTEST_DEFAULTS = {
  initialCapital: 100,
  commissionPercent: 0.05,
  defaultQtyType: 'cash' as const,
  defaultQtyValue: 100,
  slippageTicks: 1,
};

// Server-injected honesty caveat — included in every Creator response.
export const BACKTEST_CAVEAT =
  'Backtests are historical simulations and do NOT guarantee live results. ' +
  'Real trading involves slippage, fees, latency, and changing market conditions. ' +
  'Treat any backtested edge as a hypothesis to validate cautiously, not a promise.';

const MAX_REPAIRS = 2;

export interface CreatorDraftResult {
  pineScript: string;
  compileOk: boolean;
  compileError: string | null;
  criticNotes: string;
  modelUsed: string;
  attempts: number;
  caveat: string;
  defaults: typeof STANDARD_BACKTEST_DEFAULTS;
}

function systemPrompt(): string {
  const d = STANDARD_BACKTEST_DEFAULTS;
  return [
    'You are an expert Pine Script v6 strategy engineer for QuantumLab, a crypto perpetual-futures backtester/optimizer that runs strategies across many assets and timeframes.',
    "Turn the user's plain-English idea into ONE complete, COMPILABLE Pine v6 strategy that actively protects profit — not a naive indicator-cross that round-trips its gains.",
    '',
    'OUTPUT CONTRACT',
    '- Start with `//@version=6` then a single `strategy(...)` call.',
    `- Put these standard settings in strategy(): initial_capital=${d.initialCapital}, ` +
      `commission_type=strategy.commission.percent, commission_value=${d.commissionPercent}, ` +
      `default_qty_type=strategy.cash, default_qty_value=${d.defaultQtyValue}, slippage=${d.slippageTicks}. ` +
      '(QuantumLab reads sizing/commission out of this call, so it MUST be present — do not omit it.)',
    '- Output ONLY the Pine code inside a single ```pine code block. No prose before or after. Functional comments only.',
    '',
    'HARD RULES (QuantumLab engine constraints — violating these breaks the run)',
    '- OHLCV only. Do NOT use request.security() or any higher-timeframe data request (the engine rejects it). Express higher-timeframe context with long-lookback EMAs / ATR / Donchian on the base series instead.',
    '- No external libraries or imports. alertcondition() / alert_message= are ignored in a backtest — do not emit them.',
    '- Do NOT use `math.sum` (the engine computes it incorrectly); use `ta.sma(x, n) * n` or a manual loop for rolling sums.',
    '- Do NOT add an in-script date-range filter. QuantumLab selects the backtest window at run time; an in-script date gate fights the chosen candle range.',
    '- Expose tunable parameters with input.int / input.float / input.bool. No repainting and no lookahead.',
    '',
    'EXIT ARCHITECTURE (the whole point — stop giving profit back)',
    'Build exits as NATIVE strategy.exit brackets (stop= / limit=). In QuantumLab these fill INTRABAR at the real trigger level, so a protective stop fills where it actually triggers — never rely on bar-close exits, which understate losses.',
    '- A protective ATR stop from entry.',
    '- TP1: a PARTIAL close (qty_percent) at a measured ATR/structure target, to bank part of the move.',
    '- After TP1 fills, move the remaining stop to BREAKEVEN so a winner cannot turn back into a loser.',
    '- Trail the runner with an ATR stop that TIGHTENS after each target, so the trail and the targets cooperate instead of fighting.',
    '- An anti-stuck backstop: a stale-trade timeout (max bars in trade) and/or a no-progress exit.',
    '- The protective stop, the breakeven move, and the trailing / anti-stuck exits are core — do not make them trivially optimizable to "off".',
    '',
    'ENTRY PHILOSOPHY',
    '- The structural logic carries the edge; filtering alone never rescues a bad entry. Trade regime transitions and structure, not a lone indicator cross.',
    '- Prefer ORTHOGONAL signal components across different axes (trend / volatility / momentum / location / time). If two conditions encode the same idea, that is curve-fitting — collapse them or replace one.',
    '- Generalize across assets: no hardcoded ticker names and no absolute price levels.',
    '',
    'OPTIMIZER-AWARE DESIGN (how QuantumLab actually scores and tunes)',
    '- QuantumLab ranks results by a RISK-ADJUSTED score dominated by Sharpe and Calmar (return ÷ drawdown), with an explicit drawdown penalty; win rate and raw net profit are MINOR contributors. So smooth the equity curve: the breakeven + trailing + anti-stuck exits above are exactly what raise Sharpe/Calmar by cutting drawdown and give-backs.',
    '- Control the optimizable-parameter count. Hardcode standard lengths (ADX 14, Bollinger 20 / 2.0, RSI 14). Expose ONLY parameters that genuinely change behavior.',
    '- Set TIGHT, sane minval/maxval (the optimizer random-samples within them). Choose sensible DEFAULTS too — the optimizer also tests the defaults as a baseline and seeds its refinement from the best point found.',
    '',
    'Before you output, re-check the draft against every rule above and fix any violation.',
  ].join('\n');
}

function extractPine(text: string): string {
  const fenced = text.match(/```(?:pine|pinescript)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  return body.trim();
}

function tryCompile(pine: string): { ok: boolean; error: string | null } {
  try {
    compilePine(pine);
    return { ok: true, error: null };
  } catch (e: any) {
    return { ok: false, error: (e?.message ?? 'Unknown compile error').slice(0, 600) };
  }
}

// --- Structural enforcement of the standard backtest defaults --------------------
//
// The prompt asks the model to put the standard settings in strategy(), but a prompt
// is a request, not a guarantee — a draft can omit or deviate from them. parsePineScript
// reads initial_capital / commission_value out of the strategy() declaration into the
// saved strategySettings, so a deviating declaration silently changes how the backtest
// is configured. We therefore rewrite the strategy() call DETERMINISTICALLY after the
// model returns, so the standard defaults are enforced by code, not by hope.
//
// NOTE on date range: there is intentionally NO date-range default to inject. In
// QuantumLab the backtest window is a RUN-TIME selection (the UI's start/end dates drive
// the candle fetch in datafeed.ts and the run-loop filter); it is not part of the Pine
// source. Hard-coding a date range into the script would override the user's chosen
// candle range, so it is deliberately excluded from the enforced defaults.

const STANDARD_DEFAULT_KEYS = new Set([
  'initial_capital',
  'commission_type',
  'commission_value',
  'default_qty_type',
  'default_qty_value',
  'slippage',
]);

// Locate the top-level `strategy(...)` declaration call (NOT strategy.entry / .close /
// .exit), skipping string literals and `//` line comments, and return the paren span.
function locateStrategyCall(src: string): { open: number; close: number } | null {
  let inStr = false;
  let strCh = '';
  let inComment = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inComment) {
      if (c === '\n') inComment = false;
      continue;
    }
    if (inStr) {
      if (c === strCh && src[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      inComment = true;
      i++;
      continue;
    }
    if (c === 's' && src.startsWith('strategy', i)) {
      const prev = i > 0 ? src[i - 1] : '';
      if (/[.\w]/.test(prev)) continue; // member access (strategy.entry) or part of an identifier
      let j = i + 'strategy'.length;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] !== '(') continue;
      const open = j;
      let depth = 0;
      let s2 = false;
      let sc = '';
      for (let k = open; k < src.length; k++) {
        const cc = src[k];
        if (s2) {
          if (cc === sc && src[k - 1] !== '\\') s2 = false;
          continue;
        }
        if (cc === '"' || cc === "'") {
          s2 = true;
          sc = cc;
          continue;
        }
        if (cc === '(') depth++;
        else if (cc === ')') {
          depth--;
          if (depth === 0) return { open, close: k };
        }
      }
      return null; // unbalanced
    }
  }
  return null;
}

// Split a call's argument list on top-level commas, respecting strings and nested
// (), [], {}. Trims and drops empties.
function splitTopLevelArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr = false;
  let strCh = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inStr) {
      if (c === strCh && inner[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.map((a) => a.trim()).filter((a) => a.length > 0);
}

// Rewrite the strategy() declaration so it carries EXACTLY the standard defaults,
// preserving the title and every other (non-default) argument. Returns the input
// unchanged (fail-safe, never throws) if no strategy() call can be located.
export function enforceStandardDefaults(pine: string): string {
  const loc = locateStrategyCall(pine);
  if (!loc) return pine;

  const inner = pine.slice(loc.open + 1, loc.close);
  const args = splitTopLevelArgs(inner);

  // Keep positional args (title etc.) and any named arg that isn't a standard default.
  const kept = args.filter((a) => {
    const eq = a.indexOf('=');
    if (eq === -1) return true; // positional
    const key = a.slice(0, eq).trim();
    return !STANDARD_DEFAULT_KEYS.has(key);
  });

  const d = STANDARD_BACKTEST_DEFAULTS;
  const standardArgs = [
    `initial_capital=${d.initialCapital}`,
    'commission_type=strategy.commission.percent',
    `commission_value=${d.commissionPercent}`,
    'default_qty_type=strategy.cash',
    `default_qty_value=${d.defaultQtyValue}`,
    `slippage=${d.slippageTicks}`,
  ];

  const newInner = [...kept, ...standardArgs].join(', ');
  return pine.slice(0, loc.open + 1) + newInner + pine.slice(loc.close);
}

// Draft on the DRAFT model, then up to MAX_REPAIRS repairs (feeding the compile error
// back), then exactly one escalation to the stronger model as a last resort.
async function generateWithRepair(
  apiKey: string,
  messages: LlmMessage[],
  overrideModel?: string,
): Promise<{ pine: string; compile: { ok: boolean; error: string | null }; modelUsed: string; attempts: number }> {
  let pine = '';
  let compile: { ok: boolean; error: string | null } = { ok: false, error: null };
  let modelUsed: string = overrideModel || CREATOR_MODELS.DRAFT;
  let attempts = 0;

  for (let i = 0; i <= MAX_REPAIRS + 1; i++) {
    // When the user pins a specific model, use it for the draft AND every repair (no
    // cross-model escalation). Otherwise: draft model first, escalate as a last resort.
    const model = overrideModel
      ? overrideModel
      : i <= MAX_REPAIRS
        ? CREATOR_MODELS.DRAFT
        : CREATOR_MODELS.ESCALATE;
    attempts++;
    const raw = await callOpenRouter({
      apiKey,
      model,
      messages,
      maxTokens: LLM_LIMITS.MAX_TOKENS,
      temperature: i === 0 ? 0.2 : 0.1,
    });
    pine = extractPine(raw);
    modelUsed = model;
    compile = tryCompile(pine);
    if (compile.ok) break;
    // Feed the failure back for the next attempt.
    messages.push({ role: 'assistant', content: '```pine\n' + pine + '\n```' });
    messages.push({
      role: 'user',
      content:
        `That script failed to compile in QuantumLab's Pine engine with:\n${compile.error}\n` +
        'Fix it and output the corrected, complete strategy as a single ```pine code block. No prose.',
    });
  }

  // Structurally enforce the standard backtest defaults on the final draft. Adopt the
  // enforced version only if it still compiles, so the rewrite can never turn a working
  // script into a broken one (fail-safe fallback to the model's own output).
  const enforced = enforceStandardDefaults(pine);
  if (enforced !== pine) {
    const enforcedCompile = tryCompile(enforced);
    if (enforcedCompile.ok) {
      pine = enforced;
      compile = enforcedCompile;
    }
  }

  return { pine, compile, modelUsed, attempts };
}

async function critique(apiKey: string, context: string, pine: string): Promise<string> {
  try {
    const messages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You are a skeptical quantitative trading reviewer for QuantumLab. Grade the Pine strategy in <=180 words and call out concrete FAILs:\n' +
          '- ROUND-TRIP PROTECTION: is there a protective stop, a partial take-profit, a move to breakeven after the first target, and a trailing or anti-stuck exit? Flag any strategy that can give back an open profit.\n' +
          '- Exits use native strategy.exit brackets (intrabar fills), not bar-close exits.\n' +
          '- No request.security() / HTF requests, no external libraries, no math.sum; OHLCV only.\n' +
          '- Overfitting: too many optimizable inputs, or redundant / collinear filters encoding the same idea; look-ahead or repainting.\n' +
          '- Entry is structural (not a lone indicator cross) and generalizes across assets (no hardcoded tickers or price levels).\n' +
          '- Does it match the stated intent?\n' +
          'Be concrete and concise. Plain text, no code.',
      },
      { role: 'user', content: `${context}\n\nStrategy:\n\`\`\`pine\n${pine}\n\`\`\`` },
    ];
    const notes = await callOpenRouter({
      apiKey,
      model: CREATOR_MODELS.CRITIC,
      messages,
      maxTokens: 600,
      temperature: 0.3,
    });
    return notes.trim();
  } catch {
    // The critic is best-effort; never fail the whole draft because the review failed.
    return 'Automated review unavailable for this draft.';
  }
}

export async function draftStrategy(args: {
  idea: string;
  apiKey: string;
  walletAddress: string;
  model?: string;
}): Promise<CreatorDraftResult> {
  const idea = (args.idea ?? '').trim();
  if (!idea) throw new LlmGatewayError('Describe the strategy you want first.', 400);
  if (idea.length > LLM_LIMITS.MAX_IDEA_CHARS) {
    throw new LlmGatewayError(`Your description is too long (max ${LLM_LIMITS.MAX_IDEA_CHARS} characters).`, 400);
  }
  checkRateLimit(args.walletAddress);

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: idea },
  ];

  const { pine, compile, modelUsed, attempts } = await generateWithRepair(args.apiKey, messages, args.model);
  const criticNotes = await critique(args.apiKey, `Idea:\n${idea}`, pine);

  return {
    pineScript: pine,
    compileOk: compile.ok,
    compileError: compile.error,
    criticNotes,
    modelUsed,
    attempts,
    caveat: BACKTEST_CAVEAT,
    defaults: STANDARD_BACKTEST_DEFAULTS,
  };
}

export async function improveStrategy(args: {
  currentPine: string;
  insights: string;
  apiKey: string;
  walletAddress: string;
  idea?: string;
  model?: string;
}): Promise<CreatorDraftResult> {
  const currentPine = (args.currentPine ?? '').trim();
  const insights = (args.insights ?? '').trim();
  if (!currentPine) throw new LlmGatewayError('No strategy to improve.', 400);
  if (insights.length > LLM_LIMITS.MAX_IDEA_CHARS) {
    throw new LlmGatewayError(`The insights text is too long (max ${LLM_LIMITS.MAX_IDEA_CHARS} characters).`, 400);
  }
  checkRateLimit(args.walletAddress);

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt() },
    {
      role: 'user',
      content:
        'Here is an existing Pine v6 strategy and a backtest insights report. Improve the strategy to address the ' +
        'weaknesses in the report WITHOUT overfitting to the sample (keep it general and robust). Preserve tunable inputs.\n\n' +
        `Current strategy:\n\`\`\`pine\n${currentPine}\n\`\`\`\n\nInsights report:\n${insights || '(no report provided)'}`,
    },
  ];

  const { pine, compile, modelUsed, attempts } = await generateWithRepair(args.apiKey, messages, args.model);
  const criticNotes = await critique(
    args.apiKey,
    args.idea ? `Idea:\n${args.idea}` : 'Context: improving an existing strategy based on a backtest report.',
    pine,
  );

  return {
    pineScript: pine,
    compileOk: compile.ok,
    compileError: compile.error,
    criticNotes,
    modelUsed,
    attempts,
    caveat: BACKTEST_CAVEAT,
    defaults: STANDARD_BACKTEST_DEFAULTS,
  };
}
