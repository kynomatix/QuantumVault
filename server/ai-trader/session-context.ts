// Agentic Trader Plan §Brick 1, Phase 1A.
// Pure function of a Date — zero external dependencies, no I/O.
// Computes the session label, proximity flags, and a formatted prompt block
// for the AI Trader decision cycle.
//
// DOCUMENTED APPROXIMATIONS (v1):
//   • All boundaries are fixed UTC — no DST handling.
//   • Weekly candle open = Monday 00:00 UTC (crypto-exchange convention; some venues differ).
//   • Asia/London overlap boundary = 09:00 UTC (approximation; varies by venue).
//   • Session boundaries are fixed clock intervals, not measured liquidity flows.
//   • Macro-calendar windows (CPI/FOMC/NFP) are out of scope — separate spec.
//
// Fail behaviour: pure clock math — cannot throw on a valid Date; callers may
// wrap in try/catch per the spec's defensive guidance.

export type SessionLabel =
  | "weekend"         // Fri 21:00 UTC → Sun 21:00 UTC
  | "asia"            // 21:00–07:00 UTC (non-weekend, spans midnight)
  | "asia_london"     // 07:00–09:00 UTC overlap
  | "london"          // 09:00–13:30 UTC
  | "london_new_york" // 13:30–16:00 UTC overlap
  | "new_york";       // 16:00–21:00 UTC

export interface SessionContextResult {
  /** Current session label. */
  label: SessionLabel;
  /**
   * True when now is within the 12h-before / 2h-after window around the
   * weekly candle open (Mon 00:00 UTC).
   */
  nearWeeklyOpen: boolean;
  /**
   * True when now is within 1h before or after the daily candle open (00:00 UTC).
   * Fires on every day, including Mondays (where weekly and daily opens coincide).
   */
  nearDailyOpen: boolean;
  /** Formatted "## Session context (UTC)" block ready for prompt injection. */
  block: string;
}

// ─── internal constants ───────────────────────────────────────────────────────

const DAY_MIN  = 24 * 60;       // minutes per day
const WEEK_MIN = 7 * DAY_MIN;   // minutes per week

// Proximity windows (minutes)
const WEEKLY_OPEN_BEFORE = 12 * 60; // 12h before Mon 00:00
const WEEKLY_OPEN_AFTER  =  2 * 60; //  2h after  Mon 00:00
const DAILY_OPEN_WINDOW  =  1 * 60; //  ±1h around 00:00 UTC each day

const DAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const SESSION_DESC: Record<SessionLabel, string> = {
  weekend:         "weekend (thin liquidity — historically elevated stop-hunt/false-move risk)",
  asia:            "Asia (ranging — setting the range for London break)",
  asia_london:     "Asia/London overlap (increasing liquidity — range-break watch)",
  london:          "London (primary breakout session)",
  london_new_york: "London/New York overlap (peak global liquidity)",
  new_york:        "New York (trend extension or reversal)",
};

// Handoff transitions shown in the "Next handoffs" line.
// Listed in ascending minute-of-day order; `label()` returns null to suppress
// a transition that does not represent a named session change on that day.
const HANDOFF_SCHEDULE: ReadonlyArray<{
  mod: number;    // minute of day (UTC)
  hhmm: string;  // display form
  label(dow: number): string | null;
}> = [
  {
    mod: 0,
    hhmm: "00:00",
    label: (dow) => {
      // Sun 00:00 and Sat 00:00 are mid-weekend — no named handoff
      if (dow === 0 || dow === 6) return null;
      return "Asia"; // daily open within Asia on weekdays
    },
  },
  {
    mod: 7 * 60,
    hhmm: "07:00",
    label: (dow) => {
      if (dow === 0 || dow === 6) return null; // weekend
      return "London";
    },
  },
  {
    mod: 13 * 60 + 30,
    hhmm: "13:30",
    label: (dow) => {
      if (dow === 0 || dow === 6) return null; // weekend
      return "New York";
    },
  },
  {
    mod: 21 * 60,
    hhmm: "21:00",
    label: (dow) => {
      if (dow === 5) return "Weekend";  // Fri 21:00 — weekend begins
      if (dow === 0) return "Asia";     // Sun 21:00 — weekend ends, weekly open
      if (dow === 6) return null;       // Sat 21:00 — mid-weekend, no named change
      return "Asia";                    // Mon–Thu: NY ends, Asia resumes
    },
  },
];

// ─── helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(Math.abs(n)).padStart(2, "0");
}

/** "Xh YYm" duration string (e.g. "0h46m", "2h05m"). */
function fmtDuration(totalMinutes: number): string {
  const abs = Math.abs(Math.round(totalMinutes));
  return `${Math.floor(abs / 60)}h${pad2(abs % 60)}m`;
}

/** UTC minute-of-day for a Date (0 = 00:00, 1439 = 23:59). */
function modOfDay(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ─── session label ────────────────────────────────────────────────────────────

function resolveLabel(dow: number, mod: number): SessionLabel {
  // Weekend: Fri 21:00 UTC → Sun 21:00 UTC (inclusive start, exclusive end)
  const isWeekend =
    (dow === 5 && mod >= 21 * 60) ||   // Fri from 21:00
    dow === 6 ||                        // all Saturday
    (dow === 0 && mod < 21 * 60);       // Sunday before 21:00

  if (isWeekend) return "weekend";

  // Non-weekend: Sun 21:00+, Mon–Thu (all), Fri before 21:00
  if (mod >= 21 * 60) return "asia";         // 21:00–midnight
  if (mod < 7 * 60)   return "asia";         // midnight–07:00
  if (mod < 9 * 60)   return "asia_london";  // 07:00–09:00
  if (mod < 13 * 60 + 30) return "london";  // 09:00–13:30
  if (mod < 16 * 60)  return "london_new_york"; // 13:30–16:00
  return "new_york";                         // 16:00–21:00
}

// ─── proximity ────────────────────────────────────────────────────────────────

/**
 * Signed minutes from `now` to the weekly candle open (Mon 00:00 UTC).
 * Positive = opens in X min; negative = opened X min ago.
 * Result is wrapped to the nearest occurrence (within ±WEEK_MIN/2).
 */
function minutesToWeeklyOpen(now: Date): number {
  // Phase within the week, measured from Sun 00:00 UTC.
  const nowPhase  = now.getUTCDay() * DAY_MIN + modOfDay(now);
  const openPhase = 1 * DAY_MIN; // Monday = day 1
  let delta = openPhase - nowPhase;
  if (delta >  WEEK_MIN / 2) delta -= WEEK_MIN;
  if (delta < -WEEK_MIN / 2) delta += WEEK_MIN;
  return delta;
}

/**
 * Signed minutes from `now` to the nearest 00:00 UTC.
 * Positive = upcoming; negative = already opened.
 */
function minutesToDailyOpen(now: Date): number {
  const mod = modOfDay(now);
  // First half of day: we are mod minutes past the last 00:00
  // Second half: we are (DAY_MIN - mod) minutes before the next 00:00
  return mod <= DAY_MIN / 2 ? -mod : DAY_MIN - mod;
}

// ─── handoff computation ──────────────────────────────────────────────────────

interface HandoffEntry {
  label: string;
  hhmm: string;
  minutesFromNow: number;
  /** Day abbreviation, included when the handoff is not today (UTC). */
  dayAbbr?: string;
}

function getNextHandoffs(now: Date, count = 3): HandoffEntry[] {
  const results: HandoffEntry[] = [];
  const todayDow = now.getUTCDay();

  // Walk forward day-by-day until we have `count` entries (max 7 days).
  for (let offset = 0; offset <= 7 && results.length < count; offset++) {
    // UTC midnight for the candidate day
    const dayStart = new Date(now);
    dayStart.setUTCDate(dayStart.getUTCDate() + offset);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dow = dayStart.getUTCDay();

    for (const slot of HANDOFF_SCHEDULE) {
      const lbl = slot.label(dow);
      if (!lbl) continue;

      // dayStart is already UTC midnight; offset by slot minutes.
      const ts = new Date(dayStart.getTime() + slot.mod * 60_000);

      const minutesFromNow = (ts.getTime() - now.getTime()) / 60_000;
      if (minutesFromNow <= 0) continue; // past

      results.push({
        label: lbl,
        hhmm: slot.hhmm,
        minutesFromNow,
        dayAbbr: dow !== todayDow ? DAY_ABBR[dow] : undefined,
      });

      if (results.length >= count) break;
    }
  }

  return results;
}

// ─── block assembly ───────────────────────────────────────────────────────────

function buildBlock(
  now: Date,
  label: SessionLabel,
  mWeekly: number,
  mDaily: number,
  nearWeeklyOpen: boolean,
  nearDailyOpen: boolean,
  handoffs: HandoffEntry[],
): string {
  const dow = now.getUTCDay();
  const h   = pad2(now.getUTCHours());
  const m   = pad2(now.getUTCMinutes());
  const dayName = DAY_NAMES[dow];

  const lines: string[] = [
    "## Session context (UTC)",
    `Now: ${dayName} ${h}:${m} UTC.`,
    `Session: ${SESSION_DESC[label]}.`,
  ];

  // Proximity lines — rendered ONLY when near.
  const proximityParts: string[] = [];

  if (nearWeeklyOpen || nearDailyOpen) {
    // Determine what to say about the open countdown.
    // When weekly and daily both near AND they refer to the same event (Mon 00:00),
    // combine into one "Weekly/daily" sentence.
    const bothNear = nearWeeklyOpen && nearDailyOpen;

    if (bothNear) {
      // Mon 00:00 is approaching or just passed — both opens fire together.
      const ref = mWeekly; // weekly and daily nearly identical near Mon 00:00
      const verb = ref > 0 ? `opens in ${fmtDuration(ref)}` : `opened ${fmtDuration(ref)} ago`;
      proximityParts.push(`Weekly/daily candle ${verb}.`);
    } else if (nearWeeklyOpen) {
      const verb =
        mWeekly > 0
          ? `opens in ${fmtDuration(mWeekly)}`
          : `opened ${fmtDuration(mWeekly)} ago`;
      proximityParts.push(`Weekly candle ${verb}.`);
    } else {
      // nearDailyOpen only
      const verb =
        mDaily > 0
          ? `opens in ${fmtDuration(mDaily)}`
          : `opened ${fmtDuration(mDaily)} ago`;
      proximityParts.push(`Daily candle ${verb}.`);
    }

    // Advisory — always included when any proximity fires.
    const subject = nearWeeklyOpen ? "Weekly/daily" : "Daily";
    proximityParts.push(
      `${subject} opens frequently print false moves that fade once London/NY liquidity arrives.`,
    );
  }

  if (proximityParts.length > 0) {
    lines.push(proximityParts.join(" "));
  }

  // Handoff line.
  if (handoffs.length > 0) {
    const parts = handoffs.map((h, i) => {
      const tag = h.dayAbbr ? ` ${h.dayAbbr}` : "";
      const cdown = i === 0 ? ` (${fmtDuration(h.minutesFromNow)})` : "";
      return `${h.label} ${h.hhmm}${tag}${cdown}`;
    });
    lines.push(`Next handoffs: ${parts.join(" · ")}.`);
  }

  return lines.join("\n");
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Pure function of a Date. Returns session label, proximity flags, and a
 * formatted "## Session context (UTC)" prompt block.
 *
 * No I/O, no side-effects, deterministically unit-testable.
 */
export function getSessionContext(now: Date): SessionContextResult {
  const dow = now.getUTCDay();
  const mod = modOfDay(now);

  const label = resolveLabel(dow, mod);

  const mWeekly = minutesToWeeklyOpen(now);
  const mDaily  = minutesToDailyOpen(now);

  const nearWeeklyOpen = mWeekly >= -WEEKLY_OPEN_AFTER && mWeekly <= WEEKLY_OPEN_BEFORE;
  const nearDailyOpen  = Math.abs(mDaily) <= DAILY_OPEN_WINDOW;

  const handoffs = getNextHandoffs(now);

  const block = buildBlock(now, label, mWeekly, mDaily, nearWeeklyOpen, nearDailyOpen, handoffs);

  return { label, nearWeeklyOpen, nearDailyOpen, block };
}
