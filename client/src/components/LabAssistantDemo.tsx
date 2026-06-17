import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Check,
  Loader2,
  ShieldCheck,
  TrendingUp,
  Rocket,
  Wand2,
  FlaskConical,
  Microscope,
} from "lucide-react";

/**
 * No-wallet, auto-looping "canned demo" of the Lab Assistant.
 * Everything is derived from a single clock (`t`, milliseconds into the loop)
 * so the animation loops cleanly and there is no real network / wallet / key.
 * Pauses when off screen, and renders a static finished state for users who
 * prefer reduced motion.
 */

const CYCLE = 13500; // ms per loop

const PROMPT =
  "Build me a mean-reversion bot for SOL that only trades in a range.";

const REPLY =
  "On it. I'll draft it, backtest thousands of variants, then only keep it if it survives data it never saw.";

type Step = {
  icon: typeof Wand2;
  label: string;
  sub: string;
  run: number; // ms the spinner starts
  done: number; // ms the check appears
};

const STEPS: Step[] = [
  { icon: Wand2, label: "Create", sub: "Drafts a Pine strategy from your words", run: 4200, done: 4900 },
  { icon: FlaskConical, label: "Backtest", sub: "Sweeps thousands of parameter combos", run: 4900, done: 5800 },
  { icon: Microscope, label: "Refine", sub: "Cuts what overfits, keeps what holds up", run: 5800, done: 6700 },
  { icon: ShieldCheck, label: "Validate", sub: "Scores it on price it never saw", run: 6700, done: 7700 },
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
      : t > 12500
        ? Math.max(0, (13500 - t) / 1000)
        : 1;

  const userText = typed(PROMPT, t, 500, 34);
  const userTyping = t > 500 && userText.length < PROMPT.length;
  const showThinking = t > 2600 && t < 3500;
  const replyText = typed(REPLY, t, 3500, 48);
  const showReply = t > 3500;

  const cardP = ease((t - 8200) / 700);
  const countP = ease((t - 8400) / 1300);
  const showCard = t > 8100;

  const caret = Math.sin(t / 90) > 0;

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-b from-card/90 to-black/80 shadow-2xl shadow-primary/10"
      data-testid="demo-lab-assistant"
    >
      <div
        className="absolute inset-0 pointer-events-none opacity-60"
        style={{
          background:
            "radial-gradient(600px 240px at 80% -10%, rgba(139,92,246,0.18), transparent 70%)",
        }}
      />

      {/* header */}
      <div className="relative flex items-center gap-3 border-b border-white/10 px-4 sm:px-6 py-3.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white">Lab Assistant</div>
          <div className="text-[11px] text-white/45">QuantumLab</div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Live demo · no wallet needed
        </span>
      </div>

      {/* body */}
      <div
        className="relative px-4 sm:px-6 py-5 space-y-4"
        style={{ opacity: globalOpacity, minHeight: 360 }}
      >
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

                    {/* step pipeline */}
                    {t > 4000 && (
                      <div className="mt-3 space-y-2">
                        {STEPS.map((s, i) => {
                          const isDone = t >= s.done;
                          const isRunning = t >= s.run && t < s.done;
                          const shown = t >= s.run - 150;
                          if (!shown) return null;
                          const Icon = s.icon;
                          return (
                            <div
                              key={s.label}
                              className="flex items-start gap-2.5"
                              style={{
                                opacity: ease((t - (s.run - 150)) / 350),
                                transform: `translateY(${(1 - ease((t - (s.run - 150)) / 350)) * 6}px)`,
                              }}
                              data-testid={`demo-step-${s.label.toLowerCase()}`}
                            >
                              <div
                                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                                  isDone
                                    ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-300"
                                    : "border-primary/40 bg-primary/15 text-primary"
                                }`}
                              >
                                {isDone ? (
                                  <Check className="h-3 w-3" />
                                ) : isRunning ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Icon className="h-3 w-3" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <span className="text-[13px] font-semibold text-white">
                                  {s.label}
                                </span>
                                <span className="text-[12.5px] text-white/45">
                                  {"  "}
                                  {s.sub}
                                </span>
                              </div>
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
                  Robustness {Math.round(87 * countP)} / 100 · holds up out-of-sample
                </span>
              </div>
              <div className="grid grid-cols-3 divide-x divide-white/10">
                {[
                  { k: "Net return", v: `+${Math.round(142 * countP)}%`, c: "text-emerald-300" },
                  { k: "Win rate", v: `${Math.round(61 * countP)}%`, c: "text-white" },
                  { k: "Max drawdown", v: `${Math.round(-14 * countP)}%`, c: "text-white/80" },
                ].map((m) => (
                  <div key={m.k} className="px-3 py-3 text-center">
                    <div className={`font-mono text-lg sm:text-xl font-bold ${m.c}`}>
                      {m.v}
                    </div>
                    <div className="mt-0.5 text-[11px] text-white/45">{m.k}</div>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 px-4 py-3">
                <TrendingUp className="h-3.5 w-3.5 text-emerald-300 shrink-0" />
                <span className="text-[12px] text-white/55">
                  Tested on data it never saw while tuning, so it is far less likely to be curve-fit.
                </span>
                <span
                  className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-primary to-accent px-3 py-1.5 text-[12.5px] font-semibold text-white shadow-lg shadow-primary/30"
                  style={{ opacity: ease((t - 9200) / 600) }}
                >
                  <Rocket className="h-3.5 w-3.5" />
                  Deploy
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="relative border-t border-white/10 px-4 sm:px-6 py-2.5 text-center text-[11px] text-white/35">
        Illustrative demo. Numbers are for illustration only. Trading involves risk of loss.
      </div>
    </div>
  );
}
