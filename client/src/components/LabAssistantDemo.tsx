import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Sparkles, ShieldCheck, TrendingUp, Rocket, Wand2, Send, Zap } from "lucide-react";
import {
  QUANT_AGENT_STAGES,
  QuantAgentStepRow,
  type StageState,
} from "@/components/QuantAgentChecklist";

/**
 * No-wallet, auto-looping "canned demo" of the Lab Assistant.
 * Everything is derived from a single clock (`t`, milliseconds into the loop)
 * so the animation loops cleanly and there is no real network / wallet / key.
 * Pauses when off screen, and renders a static finished state for users who
 * prefer reduced motion.
 *
 * The step rows reuse the SAME QuantAgentStepRow + stage list as the live dock,
 * so what the user sees here is exactly what the real "quant agent" checklist
 * looks like. The demo also acts out tapping the "Auto" button, since that is
 * the trigger users would otherwise not discover.
 */

const CYCLE = 17000; // ms per loop (extended to fit the deploy-setup beat)

// Fixed chat viewport height. Like the real dock, the window never lengthens;
// the message list scrolls down to new content instead. The finished checklist
// measures ~380px, so this leaves a little headroom: the checklist always fits
// (the first scroll happens only when the result card lands, never during the
// checklist) and the full deploy card is never cut off, even with small
// per-device font-rendering variance.
const VIEWPORT_H = 392;

// Demo strategy numbers (illustrative). The raw backtest is the honest 1x result; a
// low 4% drawdown is exactly what lets the auto-sizer safely lever up. The live
// max-safe math is floor((100 / drawdown) * 0.8), capped per market (SOL caps at 20x);
// the losing-streak check usually trims it a notch, landing here around 18x (~72%
// post-leverage drawdown, just under the engine's 80% liquidation-warning line).
const NET = 142; // net return % at 1x
const WIN = 61; // win rate %
const DD = 4; // max drawdown % at 1x
const ROBUST = 87; // robustness score (out of 100)
const LEV = 18; // auto-suggested leverage
const DD_LEV = DD * LEV; // ~72% drawdown at the suggested leverage
const NET_LEV = NET * LEV; // ~2,556% return at the suggested leverage (illustrative)
const CAPITAL = 1000; // suggested equity ($)
const BUFFER = Math.round((DD_LEV / 100) * CAPITAL); // ~$720 drawdown buffer

const PROMPT =
  "Build me a mean-reversion bot for SOL that only trades in a range.";

const REPLY =
  "Auto's on. I'll draft it, backtest thousands of variants, then only keep it if it survives data it never saw.";

// Per-stage timings, aligned 1:1 with QUANT_AGENT_STAGES. `final` is the state the
// row settles into: the first three complete, "Improve if needed" is skipped because
// the strategy held up on the first try (honest happy path, matches the live mapping).
const STEP_TIMES: { run: number; settle: number; final: StageState }[] = [
  { run: 4400, settle: 5100, final: "done" },
  { run: 5100, settle: 6000, final: "done" },
  { run: 6000, settle: 6900, final: "done" },
  { run: 6900, settle: 7600, final: "skipped" },
];

function typed(full: string, t: number, start: number, cps: number) {
  if (t < start) return "";
  const n = Math.floor(((t - start) / 1000) * cps);
  return full.slice(0, Math.max(0, Math.min(full.length, n)));
}

function ease(p: number) {
  const c = Math.max(0, Math.min(1, p));
  return 1 - Math.pow(1 - c, 3);
}

export default function LabAssistantDemo() {
  const [t, setT] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const reducedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const preCardScrollRef = useRef(0);
  const cardScrollRef = useRef(0);

  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
    reducedRef.current = mq?.matches ?? false;

    if (reducedRef.current) {
      // Show the finished conversation, no animation loop.
      setT(CYCLE - 1500);
      return;
    }

    let raf = 0;
    let base: number | null = null;
    let visible = true;

    const tick = (ts: number) => {
      if (base == null) base = ts;
      setT(((ts - base) % CYCLE));
      raf = requestAnimationFrame(tick);
    };

    const start = () => {
      if (raf) return;
      base = null;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    let io: IntersectionObserver | null = null;
    if (wrapRef.current && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        ([e]) => {
          visible = e.isIntersecting;
          if (visible) start();
          else stop();
        },
        { threshold: 0.1 },
      );
      io.observe(wrapRef.current);
    } else {
      start();
    }

    return () => {
      stop();
      io?.disconnect();
    };
  }, []);

  const reduced = reducedRef.current;

  // Global fade so the loop restart is smooth (skipped for reduced motion).
  const globalOpacity = reduced
    ? 1
    : t < 450
      ? t / 450
      : t > 16000
        ? Math.max(0, (17000 - t) / 1000)
        : 1;

  const userText = typed(PROMPT, t, 500, 34);
  const userTyping = t > 500 && userText.length < PROMPT.length;

  // "Auto" button teach beat: after the goal is typed, the pill draws attention,
  // gets tapped, then stays "on" so users learn the trigger before the run starts.
  const autoPulse = !reduced && t > 2300 && t < 2700;
  const autoPressing = !reduced && t >= 2700 && t < 3100;
  const autoPress = autoPressing ? 1 - 0.12 * Math.sin(((t - 2700) / 400) * Math.PI) : 1;
  const autoOn = reduced || t >= 2950;
  const hintOpacity = reduced
    ? 0
    : t < 2300
      ? 0
      : t < 2500
        ? (t - 2300) / 200
        : t < 3100
          ? 1
          : t < 3300
            ? (3300 - t) / 200
            : 0;

  const showThinking = t > 3200 && t < 3900;
  const replyText = typed(REPLY, t, 3900, 48);
  const showReply = t > 3900;

  const cardP = ease((t - 8200) / 700);
  const countP = ease((t - 8400) / 1300);
  const showCard = t > 8100;

  // Deploy beat: the Deploy button gets "tapped", then the card expands into a
  // simplified, honest preview of the real deploy modal (auto-sized leverage,
  // post-leverage return + drawdown, suggested equity). Mirrors the live dock card.
  const deployTap = !reduced && t > 10300 && t < 10800;
  const deployPress = deployTap
    ? 1 - 0.1 * Math.sin(((t - 10300) / 500) * Math.PI)
    : 1;
  const showDeploy = t > 10800;
  const deployP = ease((t - 10800) / 600);
  const levCount = ease((t - 11000) / 1100);

  // Simulate the real dock's chat scroll: the window is a fixed-height viewport
  // and the message list scrolls down to keep the newest content in view. The
  // first scroll lands when the result card appears under the finished checklist,
  // then again when the deploy preview opens. scrollTop is driven straight off
  // the clock so it stays in sync and resets cleanly each loop. Heights are
  // measured live, so the newest content is never cut off.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    // Live-measured so the newest content is never cut off, whatever width the
    // device wraps the text to. maxScroll is 0 while everything fits (normal
    // widths) and grows once content overflows the fixed viewport.
    const maxScroll = Math.max(0, inner.offsetHeight - el.clientHeight);
    if (reduced) {
      el.scrollTop = maxScroll;
      return;
    }
    let target: number;
    if (showDeploy) {
      // Deploy preview opened: glide from the result-card bottom to the new
      // bottom. Fall back to the bottom if the card beat never rendered.
      const start = cardScrollRef.current || maxScroll;
      target = start + (maxScroll - start) * ease((t - 10800) / 1100);
    } else if (showCard) {
      // Result card landed: glide from the checklist bottom to the new bottom.
      cardScrollRef.current = maxScroll;
      const start = preCardScrollRef.current;
      target = start + (maxScroll - start) * ease((t - 8300) / 800);
    } else {
      // Checklist / intro: rest at the bottom. A no-op on normal widths (the
      // content fits, maxScroll = 0, so the first scroll is when the result
      // lands) and on narrow screens it keeps the newest row in view so the
      // checklist is never cut off.
      preCardScrollRef.current = maxScroll;
      target = maxScroll;
    }
    el.scrollTop = target;
  });

  const caret = Math.sin(t / 90) > 0;

  return (
    <div
      ref={wrapRef}
      className="mx-auto w-full max-w-[390px]"
      data-testid="demo-lab-assistant"
    >
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-b from-card/90 to-black/80 shadow-2xl shadow-primary/10">
        <div
          className="absolute inset-0 pointer-events-none opacity-60"
          style={{
            background:
              "radial-gradient(600px 240px at 80% -10%, rgba(139,92,246,0.18), transparent 70%)",
          }}
        />

        {/* header: same compact frame as the real Lab Assistant popup */}
        <div className="relative flex items-center gap-2.5 border-b border-white/10 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
            <Sparkles className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="text-sm font-semibold text-white">Lab Assistant</div>
            <div className="text-[10px] text-white/45">QuantumLab</div>
          </div>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live demo
          </span>
        </div>

      {/* body: fixed-height chat viewport that scrolls down to new messages,
          mirroring the real dock so the window never lengthens. */}
      <div
        ref={scrollRef}
        className="relative overflow-hidden"
        style={{ opacity: globalOpacity, height: VIEWPORT_H }}
        data-testid="demo-chat-viewport"
      >
        <div ref={innerRef} className="px-4 py-4 space-y-3.5">
        {/* user bubble */}
        <div className="flex justify-end">
          <div className="max-w-[88%] rounded-2xl rounded-tr-sm bg-primary/15 border border-primary/25 px-4 py-2.5 text-[13.5px] sm:text-sm text-white/90">
            {userText}
            {userTyping && (
              <span
                className="ml-0.5 inline-block w-[2px] align-middle bg-primary"
                style={{ height: "1em", opacity: caret ? 1 : 0 }}
              />
            )}
          </div>
        </div>

        {/* assistant reply + steps */}
        {(showThinking || showReply) && (
          <div className="flex justify-start">
            <div className="flex max-w-[92%] gap-2.5">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-white/[0.04] px-4 py-3 text-[13.5px] sm:text-sm text-white/85">
                {showThinking && !showReply ? (
                  <span className="inline-flex items-center gap-1 py-1">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 rounded-full bg-white/50"
                        style={{
                          opacity: 0.3 + 0.7 * Math.abs(Math.sin(t / 220 - i * 0.6)),
                        }}
                      />
                    ))}
                  </span>
                ) : (
                  <>
                    <div className="leading-relaxed">{replyText}</div>

                    {/* quant-agent checklist: same rows the live dock renders */}
                    {t > 4200 && (
                      <div className="mt-3 space-y-2" data-testid="demo-quant-agent-steps">
                        {QUANT_AGENT_STAGES.map((stage, i) => {
                          const tm = STEP_TIMES[i];
                          if (t < tm.run - 150) return null;
                          const state: StageState =
                            t >= tm.settle ? tm.final : t >= tm.run ? "running" : "pending";
                          const detail =
                            i === 3
                              ? state === "skipped"
                                ? "Held up first try, no fixes needed"
                                : state === "running"
                                  ? "Checking if it needs a rewrite"
                                  : undefined
                              : undefined;
                          const p = ease((t - (tm.run - 150)) / 350);
                          return (
                            <div
                              key={stage.id}
                              style={{ opacity: p, transform: `translateY(${(1 - p) * 6}px)` }}
                              data-testid={`demo-step-${stage.id}`}
                            >
                              <QuantAgentStepRow stage={stage} step={{ state, detail }} />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* result card */}
        {showCard && (
          <div
            className="flex justify-start"
            style={{
              opacity: cardP,
              transform: `translateY(${(1 - cardP) * 16}px)`,
            }}
          >
            <div className="w-full sm:ml-9 sm:max-w-[92%] overflow-hidden rounded-xl border border-emerald-400/25 bg-gradient-to-br from-emerald-400/[0.07] to-card/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <span className="text-sm font-semibold text-white">
                  SOL · 2h · Mean Reversion
                </span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Robustness {Math.round(ROBUST * countP)} / 100 · holds up out-of-sample
                </span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-white/10">
                {[
                  { k: "Net return", v: `+${Math.round(NET * countP)}%`, c: "text-emerald-300" },
                  { k: "Win rate", v: `${Math.round(WIN * countP)}%`, c: "text-white" },
                  { k: "Max drawdown", v: `${Math.round(-DD * countP)}%`, c: "text-white/80" },
                ].map((m) => (
                  <div key={m.k} className="px-3 py-3 text-center">
                    <div className={`font-mono text-lg sm:text-xl font-bold ${m.c}`}>
                      {m.v}
                    </div>
                    <div className="mt-0.5 text-[11px] text-white/45">{m.k}</div>
                  </div>
                ))}
              </div>
              {!showDeploy ? (
                <div className="flex items-center gap-2 px-4 py-3">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-300 shrink-0" />
                  <span className="text-[12px] text-white/55">
                    Tested on data it never saw while tuning, so it is far less likely to be curve-fit.
                  </span>
                  <span
                    className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-primary to-accent px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-lg shadow-primary/30"
                    style={{ opacity: ease((t - 9200) / 600), transform: `scale(${deployPress})` }}
                    data-testid="demo-deploy-button"
                  >
                    <Rocket className="h-3.5 w-3.5" />
                    Deploy
                  </span>
                </div>
              ) : (
                <div
                  className="border-t border-white/10 px-4 py-3"
                  style={{ opacity: deployP, transform: `translateY(${(1 - deployP) * 8}px)` }}
                  data-testid="demo-deploy-preview"
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-200">
                    <Zap className="h-3.5 w-3.5" />
                    Auto-sized deploy setup
                  </div>

                  {/* hero: the suggested leverage, derived from the low drawdown */}
                  <div className="mt-2.5 flex items-center gap-3 rounded-lg border border-indigo-400/25 bg-indigo-500/[0.08] px-3 py-2.5">
                    <div className="shrink-0 text-center">
                      <div className="font-mono text-2xl font-bold leading-none text-white">
                        {Math.max(1, Math.round(LEV * levCount))}x
                      </div>
                      <div className="mt-1 text-[9px] text-white/45">leverage</div>
                    </div>
                    <p className="text-[11px] leading-relaxed text-white/55">
                      Auto-sized from this strategy's {DD}% drawdown. A low drawdown is what lets it safely lever up.
                    </p>
                  </div>

                  {/* the trade-off, shown honestly: bigger upside, bigger drawdown */}
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                      <div className="font-mono text-sm font-bold text-emerald-300">
                        +{Math.round(NET_LEV * levCount).toLocaleString()}%
                      </div>
                      <div className="mt-0.5 text-[9px] text-white/45">return at {LEV}x</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                      <div className="font-mono text-sm font-bold text-white/80">
                        ~{Math.round(DD_LEV * levCount)}%
                      </div>
                      <div className="mt-0.5 text-[9px] text-white/45">drawdown at {LEV}x</div>
                    </div>
                    <div className="rounded-lg bg-white/[0.03] px-2 py-2 text-center">
                      <div className="font-mono text-sm font-bold text-white">
                        ${CAPITAL.toLocaleString()}
                      </div>
                      <div className="mt-0.5 text-[9px] text-white/45">+${BUFFER} buffer</div>
                    </div>
                  </div>

                  <span className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-primary to-accent px-3 py-2 text-[12.5px] font-semibold text-white shadow-lg shadow-primary/30">
                    <Rocket className="h-3.5 w-3.5" />
                    Deploy at {LEV}x
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        </div>
      </div>

        {/* composer: visual only, this is a no-wallet demo. The "Auto" pill is
            highlighted and tapped so users learn it runs the whole pipeline. */}
        <div className="relative flex items-center gap-2 border-t border-white/10 px-3 py-2.5">
          {/* teach caption pointing at the Auto pill */}
          {hintOpacity > 0 && (
            <div
              className="pointer-events-none absolute -top-8 right-11 z-10"
              style={{ opacity: hintOpacity }}
              data-testid="demo-auto-hint"
            >
              <span className="relative inline-block rounded-lg border border-indigo-400/40 bg-indigo-500/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg shadow-indigo-500/30">
                Tap Auto to run it end to end
                <span className="absolute -bottom-1 right-4 h-2 w-2 rotate-45 border-b border-r border-indigo-400/40 bg-indigo-500/90" />
              </span>
            </div>
          )}

          <div className="flex-1 truncate rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12.5px] text-white/30">
            Ask the Lab Assistant...
          </div>

          {/* Auto pill */}
          <span className="relative shrink-0">
            {autoPulse && (
              <span className="absolute inset-0 rounded-lg border border-indigo-400/60 animate-ping" />
            )}
            <span
              className={`relative inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                autoOn
                  ? "border-transparent bg-gradient-to-r from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/30"
                  : "border-indigo-400/50 bg-indigo-500/10 text-indigo-200"
              }`}
              style={{ transform: `scale(${autoPress})` }}
              data-testid="demo-auto-button"
            >
              <Wand2 className="h-3.5 w-3.5" />
              Auto
            </span>
          </span>

          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent text-white">
            <Send className="h-4 w-4" />
          </span>
        </div>
      </div>

      <p className="mt-3 text-center text-[11px] text-white/35">
        Illustrative demo. Numbers are for illustration only. Trading involves risk of loss.
      </p>
    </div>
  );
}
