// QuantumLab Lab Assistant: strategy STYLE catalog for the auto-pipeline create gate.
//
// Before the deterministic planner drafts a NEW strategy it asks the user what KIND to
// build (like an agentic IDE offering a few starting points). This module is the single
// source of truth for those options: the canonical style list, a matcher that guesses a
// style from the user's free-text goal, and a helper that folds the chosen style into the
// create prompt. It is pure data + pure functions (no I/O), so it is trivially testable
// and safe to import from both the planner and the route layer.
//
// The orchestrator builds the actual chips (it owns the sentinel prefix), so this module
// stays free of any client/transport types.

export interface StrategyStyle {
  /** Stable id stored in memory and carried by the chip sentinel. */
  id: string;
  /** Short, plain-language chip label. */
  label: string;
  /** One-line description (not currently rendered, kept for future surfaces). */
  blurb: string;
  /** Folded into the create prompt so the draft matches the chosen direction. */
  promptHint: string;
  /** Detects this style in a free-text goal so we can pre-highlight the user's intent. */
  match: RegExp;
}

/** The "let the assistant choose" option. Never auto-detected from a goal unless the user
 *  explicitly asks to be surprised. */
export const SURPRISE_STYLE_ID = "surprise";

// A focused set: the three classic edges (breakout, mean reversion, trend), a range fade,
// one creative option (momentum pullback), plus the surprise escape hatch. Plain language
// so a non-technical user can pick confidently.
export const STRATEGY_STYLES: readonly StrategyStyle[] = [
  {
    id: "breakout",
    label: "Breakout",
    blurb: "Enters when price breaks out of a range or squeeze.",
    promptHint:
      "Build a breakout strategy that enters when price breaks out of a tight range or " +
      "volatility squeeze, with a volume or volatility filter to avoid false breaks.",
    match: /\bbreak\s?outs?\b|\bbreak\s?and\s?retest\b|\bdonchian\b|\bsqueeze\b|\bexpansions?\b/i,
  },
  {
    id: "mean-reversion",
    label: "Mean reversion",
    blurb: "Fades overextended moves back toward the average.",
    promptHint:
      "Build a mean reversion strategy that fades statistically overextended moves back " +
      "toward a moving average, using a z-score or RSI extreme to time entries.",
    match: /\bmean[\s-]?revers\w*\b|\bfade\b|\bz[\s-]?scores?\b|\boversold\b|\boverbought\b|\brsi\b|\bbollinger\b/i,
  },
  {
    id: "trend",
    label: "Trend following",
    blurb: "Rides sustained momentum in the trend direction.",
    promptHint:
      "Build a trend following strategy that rides sustained directional momentum, " +
      "entering with a confirmed trend and standing aside when the market is choppy.",
    match: /\btrend\w*\b|\bmomentum\b|\bmoving average cross\w*\b|\bma cross\b/i,
  },
  {
    id: "range",
    label: "Range fade",
    blurb: "Trades the edges of a sideways, range-bound market.",
    promptHint:
      "Build a range strategy that fades the edges of a sideways, range-bound market and " +
      "stands aside during strong trends, using a regime filter to detect when price is ranging.",
    match: /\branges?\b|\bsideways\b|\bregimes?\b|\bchannels?\b|\bsupport and resistance\b/i,
  },
  {
    id: "pullback",
    label: "Momentum pullback",
    blurb: "Buys dips inside an established uptrend.",
    promptHint:
      "Build a momentum pullback strategy that waits for a shallow pullback inside an " +
      "established trend and enters in the trend direction once momentum resumes.",
    match: /\bpull\s?backs?\b|\bdips?\b|\bretrace\w*\b/i,
  },
  {
    id: SURPRISE_STYLE_ID,
    label: "Surprise me",
    blurb: "Let the assistant pick a distinctive edge.",
    promptHint:
      "Surprise me with a distinctive, creative trading edge of your choosing. Pick an " +
      "approach you think fits the market and explain the idea briefly.",
    match: /\bsurprise\b|\byou (pick|choose|decide)\b|\bnot sure\b|\bdon'?t know\b|\bup to you\b/i,
  },
];

const STYLE_BY_ID = new Map<string, StrategyStyle>(STRATEGY_STYLES.map((s) => [s.id, s]));

/** Look up a style by id (null/unknown id returns undefined). */
export function styleById(id: string | null | undefined): StrategyStyle | undefined {
  return id ? STYLE_BY_ID.get(id) : undefined;
}

/**
 * Guess a style from the user's free-text goal so the gate can pre-highlight their intent
 * (the "if they already named a style, take it but still confirm" path). Returns the first
 * matching style id, or null when nothing obvious is present. The surprise option is only
 * matched on an explicit cue ("surprise me", "you pick"), never as a catch-all.
 */
export function matchStyleInText(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  for (const s of STRATEGY_STYLES) {
    if (s.id === SURPRISE_STYLE_ID) continue; // explicit-cue only; checked last
    if (s.match.test(t)) return s.id;
  }
  const surprise = STYLE_BY_ID.get(SURPRISE_STYLE_ID);
  return surprise && surprise.match.test(t) ? SURPRISE_STYLE_ID : null;
}

/**
 * Fold the chosen style into the create prompt. A known style contributes its promptHint; a
 * free-text style (typed answer) is appended verbatim. With no style the goal is returned
 * unchanged, so the create path is never blocked if the gate is somehow skipped.
 */
export function buildStyledPrompt(goal: string, style: string | null | undefined): string {
  const g = (goal ?? "").trim();
  if (!style) return g;
  const known = styleById(style);
  const hint = known ? known.promptHint : `Use this trading style: ${style}.`;
  if (!g) return hint;
  return `${g}\n\nStrategy style: ${hint}`;
}
