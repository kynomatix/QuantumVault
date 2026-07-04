// @ts-nocheck
// QuantumVault — "How Borrow Works" in-app tutorial animation (~62s, 1920x1080).
// Ported from the standalone Claude Design bundle into the app as
// <HowBorrowWorksVideo /> (same self-contained timeline-engine pattern as
// LaunchVideo.tsx). Text-only, no audio. Rendered inside a dialog on the
// Wallet tab's Lending section; the player shell below adds play/pause,
// a draggable/touch scrub bar, elapsed/total time and replay-at-end.
import React from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

/* ───────── Engine (same pattern as launch video) ───────── */
const Easing = {
  linear: (t) => t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => (--t) * t * t + 1,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeOutQuart: (t) => 1 - (--t) * t * t * t,
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeOutBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
function interpolate(input, output, ease = Easing.linear) {
  return (t) => {
    if (t <= input[0]) return output[0];
    if (t >= input[input.length - 1]) return output[output.length - 1];
    for (let i = 0; i < input.length - 1; i++) {
      if (t >= input[i] && t <= input[i + 1]) {
        const span = input[i + 1] - input[i];
        const local = span === 0 ? 0 : (t - input[i]) / span;
        const fn = Array.isArray(ease) ? (ease[i] || Easing.linear) : ease;
        return output[i] + (output[i + 1] - output[i]) * fn(local);
      }
    }
    return output[output.length - 1];
  };
}
const TimelineContext = React.createContext({ time: 0, duration: 10, playing: false });
const SpriteContext = React.createContext({ localTime: 0, progress: 0, duration: 0 });
const useSprite = () => React.useContext(SpriteContext);
function Sprite({ start = 0, end = Infinity, children }) {
  const { time } = React.useContext(TimelineContext);
  if (time < start || time > end) return null;
  const duration = end - start;
  const localTime = Math.max(0, time - start);
  const progress = duration > 0 && isFinite(duration) ? clamp(localTime / duration, 0, 1) : 0;
  return <SpriteContext.Provider value={{ localTime, progress, duration }}>{children}</SpriteContext.Provider>;
}

/* ───────── Brand kit — dark navy + teal Lending accent ───────── */
const C = {
  bg: '#07090f',
  text: '#f2f4fa', sub: '#9aa1bd', faint: '#5b6183',
  teal: '#2ee6b7', tealHi: '#5ff0cc', tealDim: 'rgba(46,230,183,0.14)',
  blurple: '#7c6cff', blurpleHi: '#988cff', blue: '#4d7cfe',
  green: '#34d399', red: '#f4566e', amber: '#f5a94b',
};
const FUI = "'Plus Jakarta Sans', system-ui, sans-serif";
const FD = "'Space Grotesk', system-ui, sans-serif";
const FM = "'JetBrains Mono', ui-monospace, monospace";
const panel = {
  background: 'linear-gradient(168deg, rgba(20,23,40,0.97), rgba(10,12,22,0.99))',
  border: '1px solid rgba(140,150,220,0.14)',
  borderRadius: 20,
};
const tealGlow = '0 24px 70px rgba(0,0,0,0.6), 0 0 40px rgba(46,230,183,0.16), 0 0 90px rgba(46,230,183,0.07)';
const blueGlow = '0 24px 70px rgba(0,0,0,0.6), 0 0 40px rgba(124,108,255,0.2)';

/* Lucide icons (inline SVG paths so the 1920x1080 stage scales freely) */
const LUCIDE = {
  landmark: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  vault: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
};
function Icon({ name, size = 22, color = 'currentColor', stroke = 2 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: LUCIDE[name] || '' }} />;
}
const LOGO_SRC = '/images/qv-borrow-logo.webp';
const INF_SRC = '/images/inf-logo.png';
function InfLogo({ size = 44 }) {
  return <img src={INF_SRC} alt="INF" width={size} height={size} style={{ width: size, height: size, borderRadius: '50%', display: 'block', flexShrink: 0 }} />;
}

/* ───────── Shared atoms ───────── */
function Background() {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.bg }}>
      <div style={{ position: 'absolute', inset: '-15%', background: 'radial-gradient(1000px 700px at 25% 15%, rgba(60,60,160,0.22), transparent 60%), radial-gradient(1000px 700px at 80% 88%, rgba(20,120,110,0.16), transparent 62%)' }} />
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 300px rgba(0,0,0,0.8)' }} />
    </div>
  );
}
// kinetic headline block (headline + sub + micro-line), fades out before scene end
function Copy({ lt, dur, x, y, headline, sub, micro, align = 'left', maxW = 700, size = 62 }) {
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.45)) / 0.45, 0, 1));
  const hp = Easing.easeOutCubic(clamp((lt - 0.15) / 0.55, 0, 1));
  const sp = Easing.easeOutCubic(clamp((lt - 0.45) / 0.5, 0, 1));
  const mp = Easing.easeOutCubic(clamp((lt - 0.75) / 0.5, 0, 1));
  const tx = align === 'center' ? 'translateX(-50%)' : 'none';
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: maxW, transform: tx, textAlign: align, opacity: 1 - exitP }}>
      <div style={{ overflow: 'hidden' }}>
        <div style={{ transform: `translateY(${(1 - hp) * size * 0.85}px)`, opacity: hp, fontFamily: FD, fontWeight: 600, fontSize: size, lineHeight: 1.06, color: C.text, letterSpacing: '-0.03em' }}>{headline}</div>
      </div>
      {sub && <div style={{ marginTop: 16, transform: `translateY(${(1 - sp) * 14}px)`, opacity: sp, fontFamily: FUI, fontWeight: 500, fontSize: size * 0.34, color: C.sub }}>{sub}</div>}
      {micro && <div style={{ marginTop: 14, transform: `translateY(${(1 - mp) * 10}px)`, opacity: mp * 0.9, fontFamily: FUI, fontSize: size * 0.26, color: C.faint, fontStyle: 'normal' }}>{micro}</div>}
    </div>
  );
}
// animated cursor + tap ring. path: [[t,x,y],...], taps: [t,...]
function Cursor({ lt, path, taps = [] }) {
  const ts = path.map(p => p[0]);
  const x = interpolate(ts, path.map(p => p[1]), Easing.easeInOutCubic)(lt);
  const y = interpolate(ts, path.map(p => p[2]), Easing.easeInOutCubic)(lt);
  const appear = Easing.easeOutCubic(clamp((lt - ts[0] + 0.3) / 0.3, 0, 1));
  let ring = 0, press = 0;
  for (const tt of taps) {
    const rp = (lt - tt) / 0.55;
    if (rp >= 0 && rp <= 1) ring = Math.max(ring, rp);
    const pp = Math.abs(lt - tt);
    if (pp < 0.18) press = Math.max(press, 1 - pp / 0.18);
  }
  return (
    <div style={{ position: 'absolute', left: x, top: y, zIndex: 60, pointerEvents: 'none', opacity: appear }}>
      {ring > 0 && <div style={{ position: 'absolute', left: -6, top: -6, width: 44, height: 44, borderRadius: '50%', border: `2.5px solid ${C.teal}`, transform: `translate(-50%,-50%) scale(${0.3 + ring * 1.5})`, opacity: 1 - ring, marginLeft: 22, marginTop: 22 }} />}
      <svg width="30" height="30" viewBox="0 0 24 24" style={{ transform: `scale(${1 - press * 0.18})`, filter: 'drop-shadow(0 3px 8px rgba(0,0,0,0.7))' }}>
        <path d="M5 3l14 8.5-6.1 1.4L9.5 19 5 3z" fill="#fff" stroke="#111" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
function CalloutArrow({ lt, at, x, y, label, dir = 'down', color = C.teal }) {
  const p = Easing.easeOutBack(clamp((lt - at) / 0.5, 0, 1));
  const op = clamp((lt - at) / 0.3, 0, 1);
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity: op, transform: `translateY(${(1 - clamp(p, 0, 1)) * (dir === 'down' ? -14 : 14)}px)`, display: 'flex', flexDirection: dir === 'down' ? 'column' : 'column-reverse', alignItems: 'flex-start', gap: 8, zIndex: 50 }}>
      <div style={{ fontFamily: FM, fontSize: 17, fontWeight: 700, color, letterSpacing: '0.02em', padding: '8px 14px', borderRadius: 10, background: 'rgba(46,230,183,0.1)', border: `1px solid ${color}55` }}>{label}</div>
      <svg width="40" height="46" viewBox="0 0 40 46" style={{ marginLeft: 22, transform: dir === 'down' ? 'none' : 'scaleY(-1)' }}>
        <path d="M20 2 C20 18 20 28 20 38" stroke={color} strokeWidth="2.5" fill="none" strokeDasharray="1" pathLength="1" strokeDashoffset={1 - p} />
        <path d="M12 32 L20 42 L28 32" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={p > 0.85 ? 1 : 0} />
      </svg>
    </div>
  );
}
const fmtUSD = (v, dec = 0) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/* health bar: teal fill + optional markers */
function HealthBar({ fillPct, w = '100%', h = 10, showMarks = false, fillColor = C.teal }) {
  return (
    <div style={{ position: 'relative', width: w, height: h, borderRadius: h / 2, background: 'rgba(255,255,255,0.07)', overflow: 'visible' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fillPct}%`, borderRadius: h / 2, background: `linear-gradient(90deg, ${fillColor}, ${fillColor}cc)`, boxShadow: `0 0 12px ${fillColor}66`, transition: 'none' }} />
      {showMarks && [[50, C.green], [75, 'rgba(255,255,255,0.45)'], [80, C.red]].map(([m, mc]) => (
        <div key={m} style={{ position: 'absolute', left: `${m}%`, top: -3, bottom: -3, width: 2.5, background: mc, borderRadius: 2 }} />
      ))}
    </div>
  );
}
function SafeShield({ size = 20, pulse = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 12px', borderRadius: 9, background: 'rgba(52,211,153,0.12)', border: `1px solid rgba(52,211,153,${0.35 + pulse * 0.5})`, boxShadow: pulse ? `0 0 ${14 + pulse * 18}px rgba(52,211,153,${pulse * 0.5})` : 'none' }}>
      <Icon name="shield-check" size={size} color={C.green} stroke={2.2} />
      <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: size * 0.85, color: C.green }}>Safe</span>
    </div>
  );
}

/* ───────── Scene 1 — Title card (0–4.2) ───────── */
function S1() {
  const { localTime: lt, duration: dur } = useSprite();
  const logoP = Easing.easeOutCubic(clamp(lt / 0.6, 0, 1));
  const hP = Easing.easeOutCubic(clamp((lt - 0.4) / 0.65, 0, 1));
  const sP = Easing.easeOutCubic(clamp((lt - 1.0) / 0.5, 0, 1));
  const underline = Easing.easeInOutCubic(clamp((lt - 0.9) / 0.8, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 1 - exitP }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: logoP, transform: `scale(${0.9 + logoP * 0.1})`, marginBottom: 46 }}>
        <img src={LOGO_SRC} alt="" width="64" height="64" style={{ width: 64, height: 64, objectFit: 'contain', filter: 'drop-shadow(0 0 14px rgba(124,108,255,0.7))' }} />
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 34, color: C.text, letterSpacing: '-0.02em' }}>QuantumVault</span>
      </div>
      <div style={{ overflow: 'hidden', textAlign: 'center' }}>
        <div style={{ transform: `translateY(${(1 - hP) * 80}px)`, opacity: hP, fontFamily: FD, fontWeight: 600, fontSize: 84, lineHeight: 1.1, color: C.text, letterSpacing: '-0.03em', maxWidth: 1250, textAlign: 'center' }}>
          Borrow USDC without<br />selling your crypto
        </div>
      </div>
      <div style={{ height: 5, width: 380, marginTop: 26, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${underline * 100}%`, background: `linear-gradient(90deg, ${C.teal}, ${C.tealHi})`, boxShadow: `0 0 16px ${C.teal}` }} />
      </div>
      <div style={{ marginTop: 26, opacity: sP, transform: `translateY(${(1 - sP) * 14}px)`, fontFamily: FUI, fontWeight: 500, fontSize: 27, color: C.sub }}>A 60-second tour</div>
    </div>
  );
}

/* ───────── wallet header (reused S2 / S6) ───────── */
function WalletHeader({ available, netWorth, plusChip = 0, w = 900 }) {
  return (
    <div style={{ ...panel, width: w, padding: '26px 32px', display: 'flex', gap: 20 }}>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Icon name="wallet" size={18} color={C.sub} />
          <span style={{ fontFamily: FUI, fontSize: 16, fontWeight: 600, color: C.sub, letterSpacing: '0.03em' }}>Available</span>
          {plusChip > 0 && (
            <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 16, color: C.green, padding: '3px 10px', borderRadius: 8, background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.35)', opacity: plusChip }}>+$1,000</span>
          )}
        </div>
        <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 44, color: C.text }}>{available}</div>
      </div>
      <div style={{ width: 1, background: 'rgba(140,150,220,0.12)' }} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <Icon name="trending-up" size={18} color={C.sub} />
          <span style={{ fontFamily: FUI, fontSize: 16, fontWeight: 600, color: C.sub, letterSpacing: '0.03em' }}>Net Worth</span>
        </div>
        <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 44, color: C.text }}>{netWorth}</div>
      </div>
    </div>
  );
}
function LendingCard({ totalValue, borrowed, barPct, glow = 0, w = 900, children }) {
  return (
    <div style={{ ...panel, width: w, padding: '26px 32px', boxShadow: glow ? `0 24px 70px rgba(0,0,0,0.6), 0 0 ${28 + glow * 30}px rgba(46,230,183,${0.12 + glow * 0.22})` : '0 24px 70px rgba(0,0,0,0.6)', border: `1px solid rgba(46,230,183,${0.14 + glow * 0.3})` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: C.tealDim, border: '1px solid rgba(46,230,183,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="landmark" size={22} color={C.teal} stroke={1.8} />
        </div>
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 23, color: C.text }}>Lending</span>
      </div>
      <div style={{ display: 'flex', gap: 44, marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint, fontWeight: 600, marginBottom: 6 }}>Total value</div>
          <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 32, color: C.text }}>{totalValue}</div>
        </div>
        <div>
          <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint, fontWeight: 600, marginBottom: 6 }}>Borrowed</div>
          <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 32, color: C.text }}>{borrowed}</div>
        </div>
      </div>
      <HealthBar fillPct={barPct} h={12} />
      {children}
    </div>
  );
}
function TealButton({ label, w, glow = 0 }) {
  return (
    <div style={{ width: w, padding: '15px 26px', borderRadius: 13, textAlign: 'center', fontFamily: FUI, fontWeight: 700, fontSize: 18, color: '#04241a', background: `linear-gradient(100deg, ${C.teal}, ${C.tealHi})`, boxShadow: `0 0 ${12 + glow * 26}px rgba(46,230,183,${0.35 + glow * 0.45})` }}>{label}</div>
  );
}

/* ───────── Scene 2 — Wallet tab (~6s) ───────── */
function S2() {
  const { localTime: lt, duration: dur } = useSprite();
  const inP = Easing.easeOutCubic(clamp((lt - 0.2) / 0.7, 0, 1));
  const pan = interpolate([0.9, 2.2], [0, -190], Easing.easeInOutCubic)(lt);
  const glow = Easing.easeOutCubic(clamp((lt - 2.2) / 0.6, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={430} headline="It starts in your Wallet" maxW={520} size={68} />
      <div style={{ position: 'absolute', left: 760, top: 0, bottom: 0, width: 960, overflow: 'hidden', opacity: (1 - exitP) * inP, transform: `translateX(${(1 - inP) * 90}px)` }}>
        <div style={{ position: 'absolute', left: 30, top: 250, transform: `translateY(${pan}px)`, display: 'flex', flexDirection: 'column', gap: 22 }}>
          <WalletHeader available="$0.00" netWorth="$2,000" />
          <div style={{ position: 'relative' }}>
            <LendingCard totalValue="$0" borrowed="$0" barPct={0} glow={glow}>
              <div style={{ marginTop: 20, display: 'flex' }}>
                <TealButton label="Supply Collateral" w={280} />
              </div>
            </LendingCard>
          </div>
        </div>
        <CalloutArrow lt={lt} at={2.6} x={430} y={485} dir="up" label="The Lending section" />
      </div>
    </div>
  );
}

/* ───────── Scene 3 — Supply Collateral (~7s) ───────── */
function S3() {
  const { localTime: lt, duration: dur } = useSprite();
  // stage: button (leftover context) tapped at 0.8 → dialog springs at 1.0 → INF highlight 2.4 → tap 3.4
  const dlgP = Easing.easeOutBack(clamp((lt - 1.0) / 0.6, 0, 1));
  const infHi = Easing.easeOutCubic(clamp((lt - 2.4) / 0.5, 0, 1));
  const infTap = clamp((lt - 3.5) / 0.25, 0, 1);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const rows = [
    { name: 'INF', note: 'up to 80% LTV', dim: false },
    { name: 'SOL', note: '', dim: true },
    { name: 'BTC', note: '', dim: true },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={360} headline={<span>Step 1 — <span style={{ color: C.teal }}>Supply Collateral</span></span>} sub="Pick an asset you hold. It's pledged — not sold." maxW={620} size={62} />
      {/* button context, gets tapped */}
      <div style={{ position: 'absolute', left: 1050, top: 250, opacity: interpolate([0, 0.3, 1.0, 1.3], [0, 1, 1, 0])(lt) }}>
        <TealButton label="Supply Collateral" w={280} glow={clamp((lt - 0.8) / 0.2, 0, 1)} />
      </div>
      {/* dialog */}
      {lt >= 1.0 && (
        <div style={{ position: 'absolute', left: 1000, top: 285, width: 560, ...panel, padding: 30, boxShadow: tealGlow, opacity: (1 - exitP) * clamp(dlgP, 0, 1), transform: `scale(${0.85 + dlgP * 0.15}) translateY(${(1 - dlgP) * 30}px)`, transformOrigin: 'top center' }}>
          <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 30, color: C.text, marginBottom: 8 }}>Supply Collateral</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: 'rgba(46,230,183,0.07)', border: '1px solid rgba(46,230,183,0.22)', marginBottom: 20 }}>
            <Icon name="lock" size={17} color={C.teal} />
            <span style={{ fontFamily: FUI, fontSize: 15.5, color: C.sub }}>Staked tokens like INF keep earning yield</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {rows.map((r, i) => {
              const isInf = i === 0;
              const hi = isInf ? infHi : 0;
              return (
                <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px', borderRadius: 14, background: isInf ? `rgba(46,230,183,${0.05 + hi * 0.09})` : 'rgba(255,255,255,0.025)', border: isInf ? `1.5px solid rgba(46,230,183,${0.2 + hi * 0.55})` : '1px solid rgba(140,150,220,0.1)', opacity: r.dim ? 0.45 : 1, transform: isInf ? `scale(${1 + hi * 0.02 - infTap * 0.015})` : 'none', boxShadow: isInf && hi ? `0 0 ${hi * 24}px rgba(46,230,183,0.25)` : 'none' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 20, background: isInf ? 'transparent' : 'rgba(140,150,220,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {isInf ? <InfLogo size={40} /> : <Icon name="coins" size={19} color={C.faint} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 20, color: C.text }}>{r.name}</div>
                    {r.note && <div style={{ fontFamily: FM, fontSize: 13.5, color: C.teal, marginTop: 3 }}>{r.note}</div>}
                  </div>
                  {isInf && <Icon name="arrow-right" size={20} color={C.teal} stroke={2.2} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Cursor lt={lt} path={[[0, 1520, 640], [0.7, 1185, 272], [1.9, 1230, 330], [3.3, 1280, 462]]} taps={[0.8, 3.5]} />
    </div>
  );
}

/* ───────── Scene 4 — Loan card appears (~6s) ───────── */
function S4() {
  const { localTime: lt, duration: dur } = useSprite();
  const inP = Easing.easeOutCubic(clamp((lt - 0.2) / 0.6, 0, 1));
  const count = interpolate([0.6, 2.0], [0, 2000], Easing.easeOutExpo)(lt);
  const barP = interpolate([0.8, 2.2], [0, 100], Easing.easeOutCubic)(lt);
  const loanP = Easing.easeOutBack(clamp((lt - 1.6) / 0.6, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={400} headline="Your collateral is in" maxW={520} size={68} />
      <div style={{ position: 'absolute', left: 790, top: 210, opacity: (1 - exitP) * inP, transform: `translateY(${(1 - inP) * 40}px)` }}>
        <LendingCard totalValue={fmtUSD(count)} borrowed="$0" barPct={barP} glow={0.4}>
          <div style={{ marginTop: 22, overflow: 'hidden' }}>
            <div style={{ transform: `translateY(${(1 - clamp(loanP, 0, 1)) * 60}px)`, opacity: clamp(loanP, 0, 1), padding: '18px 22px', borderRadius: 15, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.14)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <InfLogo size={44} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.text }}>INF · $2,000</div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  {['Borrow More', 'Repay', 'Withdraw'].map((b, i) => (
                    <div key={b} style={{ padding: '10px 18px', borderRadius: 11, fontFamily: FUI, fontWeight: 600, fontSize: 15, color: i === 0 ? '#fff' : C.sub, background: i === 0 ? `linear-gradient(100deg, ${C.blue}, ${C.blurple})` : 'rgba(255,255,255,0.05)', border: i === 0 ? 'none' : '1px solid rgba(140,150,220,0.16)' }}>{b}</div>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 18 }}>
                <HealthBar fillPct={0} h={10} showMarks />
              </div>
            </div>
          </div>
        </LendingCard>
        <CalloutArrow lt={lt} at={2.5} x={560} y={345} dir="up" label="Live health bar" />
      </div>
    </div>
  );
}

/* ───────── Scene 5 — Borrow (~8s) ───────── */
function S5() {
  const { localTime: lt, duration: dur } = useSprite();
  const dlgP = Easing.easeOutBack(clamp((lt - 0.3) / 0.6, 0, 1));
  // cursor taps Max at 1.5, field types by 2.4, bar animates 2.2→3.4, stats tick 3.2+
  const typed = interpolate([1.7, 2.5], [0, 1], Easing.easeOutCubic)(lt);
  const amount = Math.round(1000 * typed);
  const barP = interpolate([2.3, 3.5], [0, 50], Easing.easeInOutCubic)(lt);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const stats = [
    ['Projected LTV', '50%', C.text],
    ['Projected health', 'Safe', C.green],
    ['Liquidation price', '$142.50', C.text],
    ['Borrow APR', '5.2%', C.text],
  ];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={340} headline={<span>Step 2 — <span style={{ color: C.blurpleHi }}>Borrow USDC</span></span>} sub="Max targets a safe 50% of your collateral's value" micro="You see health and liquidation price before you confirm" maxW={640} size={62} />
      <div style={{ position: 'absolute', left: 1000, top: 170, width: 600, ...panel, padding: 32, boxShadow: blueGlow, opacity: (1 - exitP) * clamp(dlgP, 0, 1), transform: `scale(${0.87 + dlgP * 0.13}) translateY(${(1 - dlgP) * 26}px)`, transformOrigin: 'top center' }}>
        <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 30, color: C.text, marginBottom: 22 }}>Borrow against INF</div>
        {/* amount field */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 14, background: 'rgba(10,12,24,0.8)', border: `1.5px solid rgba(124,108,255,${0.25 + typed * 0.4})`, marginBottom: 10 }}>
          <span style={{ flex: 1, fontFamily: FM, fontWeight: 700, fontSize: 30, color: amount ? C.text : C.faint }}>
            {amount ? '$' + amount.toLocaleString() : '0.00'}
            <span style={{ opacity: lt % 1 < 0.5 && typed < 1 && lt > 1.5 ? 1 : 0, color: C.blurpleHi }}>|</span>
          </span>
          <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 17, color: C.sub }}>USDC</span>
          <div style={{ padding: '8px 18px', borderRadius: 10, fontFamily: FUI, fontWeight: 700, fontSize: 16, color: '#fff', background: C.blurple, boxShadow: clamp((lt - 1.4) / 0.2, 0, 1) > 0 && lt < 1.9 ? `0 0 22px ${C.blurple}` : 'none' }}>Max</div>
        </div>
        {/* LTV bar */}
        <div style={{ margin: '20px 0 6px' }}>
          <HealthBar fillPct={barP} h={12} showMarks fillColor={barP <= 51 ? C.green : C.amber} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 18 }}>
          <span style={{ fontFamily: FM, fontSize: 13, color: C.faint }}>{Math.round(barP)}%</span>
        </div>
        {/* stat rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {stats.map((s, i) => {
            const p = Easing.easeOutCubic(clamp((lt - (3.3 + i * 0.35)) / 0.45, 0, 1));
            return (
              <div key={s[0]} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 18px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.1)', opacity: p, transform: `translateX(${(1 - p) * 26}px)` }}>
                <span style={{ fontFamily: FUI, fontSize: 17, fontWeight: 600, color: C.sub }}>{s[0]}</span>
                {s[1] === 'Safe' ? <SafeShield size={17} /> : <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 19, color: s[2] }}>{s[1]}</span>}
              </div>
            );
          })}
        </div>
      </div>
      <Cursor lt={lt} path={[[0.6, 1700, 800], [1.4, 1505, 288], [3.0, 1450, 430]]} taps={[1.5]} />
    </div>
  );
}

/* ───────── Scene 6 — The cash lands (~6s) ───────── */
function S6() {
  const { localTime: lt, duration: dur } = useSprite();
  const inP = Easing.easeOutCubic(clamp((lt - 0.2) / 0.6, 0, 1));
  const avail = interpolate([0.6, 2.0], [0, 1000], Easing.easeOutExpo)(lt);
  const chipP = interpolate([0.5, 0.9, 2.4, 2.9], [0, 1, 1, 0])(lt);
  const debtP = Easing.easeOutBack(clamp((lt - 1.6) / 0.55, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={370} headline={<span><span style={{ color: C.green }}>$1,000 USDC</span> — ready to trade</span>} sub="Fund bots with it, or park it in a Vault to earn" micro="Debt is subtracted from your net worth — the numbers stay honest" maxW={620} size={60} />
      <div style={{ position: 'absolute', left: 790, top: 240, opacity: (1 - exitP) * inP, transform: `translateY(${(1 - inP) * 40}px)`, display: 'flex', flexDirection: 'column', gap: 22 }}>
        <WalletHeader available={fmtUSD(avail)} netWorth="$2,000" plusChip={chipP} />
        <div style={{ overflow: 'hidden' }}>
          <div style={{ transform: `translateY(${(1 - clamp(debtP, 0, 1)) * 50}px)`, opacity: clamp(debtP, 0, 1), ...panel, padding: '22px 28px', display: 'flex', alignItems: 'center', gap: 18, width: 900, boxSizing: 'border-box' }}>
            <InfLogo size={44} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 20, color: C.text }}>INF · $2,000</div>
              <div style={{ fontFamily: FM, fontSize: 15, color: C.sub, marginTop: 5 }}>Outstanding debt <span style={{ color: C.text, fontWeight: 700 }}>$1,000</span></div>
            </div>
            <SafeShield />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Scene 6.5 — What it's for (~8s) ───────── */
function S6b() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  // chip: starts center-top (0.5), splits into two at 1.1, lands 1.9
  const split = Easing.easeInOutCubic(clamp((lt - 1.0) / 0.9, 0, 1));
  const chipIn = Easing.easeOutCubic(clamp((lt - 0.4) / 0.5, 0, 1));
  const chipFade = interpolate([1.9, 2.3], [1, 0])(lt);
  const cardL = Easing.easeOutCubic(clamp((lt - 0.6) / 0.6, 0, 1));
  const cardR = Easing.easeOutCubic(clamp((lt - 0.75) / 0.6, 0, 1));
  const pnl = interpolate([2.0, dur - 0.6], [12.4, 68.2], Easing.linear)(lt);
  const microP = Easing.easeOutCubic(clamp((lt - 4.4) / 0.5, 0, 1));
  const edgePulse = interpolate([4.0, 4.4, 5.2], [0, 1, 0], [Easing.easeOutCubic, Easing.easeInOutSine])(lt);
  const chip = (dx) => (
    <div key={dx} style={{ position: 'absolute', left: 960 + dx * split, top: interpolate([0, 1], [180, 285], Easing.easeInOutCubic)(split), transform: 'translateX(-50%)', opacity: chipIn * chipFade, zIndex: 40 }}>
      <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 22, color: C.green, padding: '8px 18px', borderRadius: 12, background: 'rgba(9,14,20,0.9)', border: '1.5px solid rgba(52,211,153,0.5)', boxShadow: '0 0 24px rgba(52,211,153,0.3)' }}>+$1,000</span>
    </div>
  );
  const rows = [
    ['Vault yield', '10%', false],
    ['Borrow cost', '5.2%', false],
    ['Your edge', '+4.8%', true],
  ];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={960} y={70} align="center" headline="What can you do with it?" maxW={900} size={58} />
      {chip(-340)}
      {chip(340)}
      {/* left card — fund bots */}
      <div style={{ position: 'absolute', left: 330, top: 330, width: 560, opacity: cardL * (1 - exitP), transform: `translateY(${(1 - cardL) * 36}px)` }}>
        <div style={{ ...panel, padding: 30, boxShadow: blueGlow }}>
          <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 26, color: C.text, marginBottom: 20 }}>Fund trading bots</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '20px 22px', borderRadius: 15, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.14)' }}>
            <div style={{ width: 48, height: 48, borderRadius: 13, background: 'linear-gradient(150deg, rgba(124,108,255,0.35), rgba(77,124,254,0.25))', border: '1px solid rgba(124,108,255,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="bot" size={24} color={C.blurpleHi} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.text }}>SOL Momentum</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 24, color: C.green }}>+${pnl.toFixed(2)}</div>
            </div>
          </div>
          <div style={{ marginTop: 20, fontFamily: FUI, fontSize: 17.5, color: C.sub, lineHeight: 1.5 }}>Trade with it — fund bots without selling your assets</div>
        </div>
      </div>
      {/* right card — carry trade */}
      <div style={{ position: 'absolute', left: 1030, top: 330, width: 560, opacity: cardR * (1 - exitP), transform: `translateY(${(1 - cardR) * 36}px)` }}>
        <div style={{ ...panel, padding: 30, boxShadow: tealGlow, border: '1px solid rgba(46,230,183,0.22)' }}>
          <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 26, color: C.text, marginBottom: 20 }}>Carry trade in the Vault</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            <div style={{ width: 48, height: 48, borderRadius: 13, background: C.tealDim, border: '1px solid rgba(46,230,183,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="vault" size={24} color={C.teal} />
            </div>
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.text }}>Vault savings</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r, i) => {
              const p = Easing.easeOutCubic(clamp((lt - (2.4 + i * 0.55)) / 0.5, 0, 1));
              const isEdge = r[2];
              return (
                <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: isEdge ? '16px 20px' : '12px 20px', borderRadius: 12, background: isEdge ? `rgba(46,230,183,${0.08 + edgePulse * 0.08})` : 'rgba(255,255,255,0.03)', border: isEdge ? `1.5px solid rgba(46,230,183,${0.35 + edgePulse * 0.45})` : '1px solid rgba(140,150,220,0.1)', opacity: p, transform: `translateX(${(1 - p) * 26}px)`, boxShadow: isEdge && edgePulse ? `0 0 ${edgePulse * 30}px rgba(46,230,183,0.3)` : 'none' }}>
                  <span style={{ fontFamily: FUI, fontSize: isEdge ? 19 : 17, fontWeight: isEdge ? 700 : 600, color: isEdge ? C.teal : C.sub }}>{r[0]}</span>
                  <span style={{ fontFamily: FM, fontWeight: 700, fontSize: isEdge ? 26 : 19, color: isEdge ? C.teal : C.text }}>{r[1]}</span>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 18, fontFamily: FUI, fontSize: 17.5, color: C.sub, lineHeight: 1.5 }}>Or park it — earn more than the loan costs</div>
          {(() => { const p = Easing.easeOutCubic(clamp((lt - 4.6) / 0.5, 0, 1)); return (
          <div style={{ marginTop: 14, opacity: p, transform: `translateY(${(1 - p) * 10}px)`, display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 10, background: 'rgba(46,230,183,0.06)', border: '1px solid rgba(46,230,183,0.18)' }}>
            <Icon name="trending-up" size={16} color={C.teal} />
            <span style={{ fontFamily: FUI, fontSize: 15, color: C.sub }}>Meanwhile, your INF collateral keeps earning staking yield</span>
          </div>
          ); })()}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 960, bottom: 54, transform: 'translateX(-50%)', opacity: microP * 0.85 * (1 - exitP), fontFamily: FUI, fontSize: 17, color: C.faint }}>Rates move and collateral prices can fall — carry isn't risk-free</div>
    </div>
  );
}

/* ───────── Scene 7 — Protected (~5s) ───────── */
function S7() {
  const { localTime: lt, duration: dur } = useSprite();
  const inP = Easing.easeOutCubic(clamp((lt - 0.2) / 0.6, 0, 1));
  const pulse = (Math.sin(lt * 3.4) + 1) / 2;
  const toastP = interpolate([1.2, 1.8, 3.6, 4.2], [0, 1, 1, 0], [Easing.easeOutBack, Easing.linear, Easing.easeInCubic])(lt);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={400} headline="Watched 24/7" sub="Telegram alerts warn you before liquidation risk" maxW={560} size={68} />
      <div style={{ position: 'absolute', left: 830, top: 380, opacity: (1 - exitP) * inP, transform: `translateY(${(1 - inP) * 40}px)`, ...panel, padding: '24px 30px', display: 'flex', alignItems: 'center', gap: 18, width: 820, boxSizing: 'border-box' }}>
        <InfLogo size={44} />
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 20, color: C.text }}>INF · $2,000</div>
          <div style={{ fontFamily: FM, fontSize: 15, color: C.sub, marginTop: 5 }}>Outstanding debt <span style={{ color: C.text, fontWeight: 700 }}>$1,000</span></div>
        </div>
        <SafeShield pulse={pulse * 0.8} />
      </div>
      {/* Telegram-style toast */}
      <div style={{ position: 'absolute', right: 80, top: 130, width: 520, opacity: clamp(toastP, 0, 1) * (1 - exitP), transform: `translateY(${(1 - clamp(toastP, 0, 1)) * -30}px)`, ...panel, borderRadius: 16, padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 15, border: '1px solid rgba(245,169,75,0.35)', boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 30px rgba(245,169,75,0.12)' }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(245,169,75,0.14)', border: '1px solid rgba(245,169,75,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="alert-triangle" size={21} color={C.amber} />
        </div>
        <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 18, color: C.text }}>Loan health dropping — consider repaying</span>
      </div>
    </div>
  );
}

/* ───────── Scene 8 — Repay (~7s) ───────── */
function S8() {
  const { localTime: lt, duration: dur } = useSprite();
  const dlgP = Easing.easeOutBack(clamp((lt - 0.3) / 0.6, 0, 1));
  // Max tap 1.4 → fill 1.6-2.2 → Repay tap 3.0 → debt rolls 3.2-4.4 → released 4.8
  const typed = interpolate([1.6, 2.3], [0, 1], Easing.easeOutCubic)(lt);
  const amount = Math.round(1000 * typed);
  const debt = interpolate([3.2, 4.4], [1000, 0], Easing.easeInOutCubic)(lt);
  const repaid = lt >= 4.4;
  const releasedP = Easing.easeOutBack(clamp((lt - 4.8) / 0.6, 0, 1));
  const flourish = interpolate([4.4, 4.8, 5.6], [0, 1, 0], [Easing.easeOutCubic, Easing.easeInOutSine])(lt);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={340} headline={<span>Step 3 — <span style={{ color: C.teal }}>Repay anytime</span></span>} sub="Max clears the exact debt — no dust left over" micro="Fully repaid? Your collateral is released." maxW={620} size={62} />
      <div style={{ position: 'absolute', left: 1000, top: 200, width: 590, ...panel, padding: 32, boxShadow: tealGlow, opacity: (1 - exitP) * clamp(dlgP, 0, 1), transform: `scale(${0.87 + dlgP * 0.13}) translateY(${(1 - dlgP) * 26}px)`, transformOrigin: 'top center' }}>
        <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 30, color: C.text, marginBottom: 8 }}>Repay</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 18px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.12)', marginBottom: 18 }}>
          <span style={{ fontFamily: FUI, fontSize: 17, fontWeight: 600, color: C.sub }}>Outstanding debt</span>
          <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 24, color: repaid ? C.green : C.blurpleHi }}>{fmtUSD(debt)}</span>
        </div>
        {/* mode pills */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
          <div style={{ flex: 1, textAlign: 'center', padding: '12px 10px', borderRadius: 11, fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text, background: 'rgba(124,108,255,0.16)', border: `1.5px solid ${C.blurple}88` }}>Pay with USDC</div>
          <div style={{ flex: 1, textAlign: 'center', padding: '12px 10px', borderRadius: 11, fontFamily: FUI, fontWeight: 600, fontSize: 16, color: C.faint, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.12)' }}>Pay with an asset</div>
        </div>
        {/* amount field */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 14, background: 'rgba(10,12,24,0.8)', border: `1.5px solid rgba(46,230,183,${0.2 + typed * 0.4})`, marginBottom: 18 }}>
          <span style={{ flex: 1, fontFamily: FM, fontWeight: 700, fontSize: 30, color: amount ? C.text : C.faint }}>{amount ? '$' + amount.toLocaleString() : '0.00'}</span>
          <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 17, color: C.sub }}>USDC</span>
          <div style={{ padding: '8px 18px', borderRadius: 10, fontFamily: FUI, fontWeight: 700, fontSize: 16, color: '#04241a', background: C.teal, boxShadow: lt > 1.3 && lt < 1.8 ? `0 0 22px ${C.teal}` : 'none' }}>Max</div>
        </div>
        <div style={{ position: 'relative', padding: '15px', borderRadius: 13, textAlign: 'center', fontFamily: FUI, fontWeight: 700, fontSize: 18, color: '#04241a', background: `linear-gradient(100deg, ${C.teal}, ${C.tealHi})`, boxShadow: lt > 2.9 && lt < 3.4 ? `0 0 30px ${C.teal}` : `0 0 12px rgba(46,230,183,0.3)` }}>Repay</div>
        {/* released state */}
        <div style={{ marginTop: 18, overflow: 'hidden', height: releasedP > 0 ? 'auto' : 0 }}>
          <div style={{ opacity: clamp(releasedP, 0, 1), transform: `translateY(${(1 - clamp(releasedP, 0, 1)) * 20}px)`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '14px', borderRadius: 12, background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.35)', boxShadow: flourish ? `0 0 ${flourish * 34}px rgba(52,211,153,0.35)` : 'none' }}>
            <Icon name="shield-check" size={22} color={C.green} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 18, color: C.green }}>Collateral released</span>
          </div>
        </div>
      </div>
      <Cursor lt={lt} path={[[0.5, 1700, 820], [1.3, 1495, 436], [2.8, 1290, 512], [4.6, 1560, 700]]} taps={[1.4, 3.0]} />
    </div>
  );
}

/* ───────── Scene 9 — End card (~5s) ───────── */
function S9() {
  const { localTime: lt } = useSprite();
  const words = ['Supply', 'Borrow', 'Trade', 'Repay'];
  const subP = Easing.easeOutCubic(clamp((lt - 2.2) / 0.6, 0, 1));
  const logoP = Easing.easeOutCubic(clamp((lt - 2.6) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 34 }}>
        {words.map((w, i) => {
          const st = 0.3 + i * 0.45;
          const p = Easing.easeOutBack(clamp((lt - st) / 0.45, 0, 1));
          return (
            <React.Fragment key={w}>
              {i > 0 && <div style={{ opacity: clamp(p, 0, 1) * 0.6 }}><Icon name="arrow-right" size={30} color={C.teal} /></div>}
              <span style={{ display: 'inline-block', fontFamily: FD, fontWeight: 600, fontSize: 88, letterSpacing: '-0.03em', color: C.text, opacity: clamp(p, 0, 1), transform: `scale(${0.6 + clamp(p, 0, 1) * 0.4})`, textShadow: `0 0 40px rgba(46,230,183,${clamp(p, 0, 1) * 0.25})` }}>{w}</span>
            </React.Fragment>
          );
        })}
      </div>
      <div style={{ height: 4, width: interpolate([2.0, 2.8], [0, 560], Easing.easeInOutCubic)(lt), marginTop: 34, borderRadius: 2, background: `linear-gradient(90deg, transparent, ${C.teal}, transparent)` }} />
      <div style={{ marginTop: 30, opacity: subP, transform: `translateY(${(1 - subP) * 14}px)`, fontFamily: FUI, fontWeight: 500, fontSize: 30, color: C.sub }}>Keep your crypto. Unlock its buying power.</div>
      <div style={{ marginTop: 46, display: 'flex', alignItems: 'center', gap: 14, opacity: logoP }}>
        <img src={LOGO_SRC} alt="" width="44" height="44" style={{ width: 44, height: 44, objectFit: 'contain', filter: 'drop-shadow(0 0 10px rgba(124,108,255,0.6))' }} />
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 26, color: C.text }}>QuantumVault</span>
      </div>
    </div>
  );
}

/* ───────── Player shell — reusable tutorial-video chrome ─────────
   Scales a fixed 1920x1080 stage to fit its container (works down to phone
   widths), and adds: play/pause, a draggable + touch-friendly scrub bar,
   elapsed/total time, and a replay button once the video ends (no loop). */
const W = 1920, H = 1080, DUR = 62;
export function TutorialPlayerShell({ duration = DUR, children }) {
  const [time, setTimeState] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [scale, setScale] = React.useState(1);
  const wrapRef = React.useRef(null);
  const rafRef = React.useRef(null);
  const lastRef = React.useRef(null);
  const timeRef = React.useRef(0);
  const barRef = React.useRef(null);
  const scrubbingRef = React.useRef(false);
  const wasPlayingRef = React.useRef(false);
  const setTime = (t) => { timeRef.current = t; setTimeState(t); };

  // Fit the 1920x1080 stage into whatever box the dialog gives us.
  React.useEffect(() => {
    const measure = () => {
      if (!wrapRef.current) return;
      const s = Math.min(wrapRef.current.clientWidth / W, wrapRef.current.clientHeight / H);
      setScale(Math.max(0.05, s));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // rAF clock — stops at the end (replay button takes over) instead of looping.
  React.useEffect(() => {
    if (!playing) { lastRef.current = null; return; }
    const step = (ts) => {
      if (lastRef.current == null) lastRef.current = ts;
      const dt = (ts - lastRef.current) / 1000;
      lastRef.current = ts;
      const next = Math.min(timeRef.current + dt, duration);
      setTime(next);
      if (next >= duration) { setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); lastRef.current = null; };
  }, [playing, duration]);

  const ended = time >= duration - 0.001;
  const togglePlay = () => {
    if (ended) { setTime(0); setPlaying(true); return; }
    setPlaying((p) => !p);
  };
  const replay = () => { setTime(0); setPlaying(true); };

  // Pointer-based scrub: works for mouse AND touch (pointer events + capture).
  const seekFromClientX = (clientX) => {
    const bar = barRef.current;
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    if (r.width <= 0) return;
    setTime(clamp((clientX - r.left) / r.width, 0, 1) * duration);
  };
  const onScrubDown = (e) => {
    e.preventDefault();
    scrubbingRef.current = true;
    wasPlayingRef.current = playing;
    setPlaying(false);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    seekFromClientX(e.clientX);
  };
  const onScrubMove = (e) => { if (scrubbingRef.current) seekFromClientX(e.clientX); };
  const onScrubUp = () => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (wasPlayingRef.current && timeRef.current < duration - 0.001) setPlaying(true);
  };

  const ctx = React.useMemo(() => ({ time, duration, playing }), [time, duration, playing]);
  const pct = (clamp(time / duration, 0, 1)) * 100;
  const fmt = (t) => { const m = Math.floor(t / 60); const s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };

  return (
    <div className="absolute inset-0 flex flex-col bg-black">
      <div ref={wrapRef} className="relative flex-1 min-h-0 flex items-center justify-center overflow-hidden">
        <div style={{ width: W, height: H, position: 'relative', transform: `scale(${scale})`, transformOrigin: 'center', flexShrink: 0, overflow: 'hidden' }}>
          <TimelineContext.Provider value={ctx}>{children}</TimelineContext.Provider>
        </div>
        {/* big center replay overlay once the video finishes */}
        {ended && (
          <button
            type="button"
            onClick={replay}
            className="absolute inset-0 flex items-center justify-center bg-black/40"
            data-testid="button-tutorial-replay-overlay"
            aria-label="Replay video"
          >
            <span className="flex items-center gap-2.5 rounded-full border border-teal-400/40 bg-black/70 px-5 py-3 text-sm font-semibold text-teal-300">
              <RotateCcw className="w-4 h-4" /> Replay
            </span>
          </button>
        )}
      </div>
      {/* control bar */}
      <div className="flex items-center gap-2 sm:gap-3 px-2.5 sm:px-4 py-2 bg-[#0c0c12] border-t border-teal-400/15 select-none">
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white"
          data-testid="button-tutorial-play-pause"
          aria-label={ended ? 'Replay' : playing ? 'Pause' : 'Play'}
        >
          {ended ? <RotateCcw className="w-3.5 h-3.5" /> : playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
        </button>
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-white" data-testid="text-tutorial-elapsed">{fmt(time)}</span>
        <div
          ref={barRef}
          className="relative flex-1 h-7 flex items-center cursor-pointer touch-none"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
          data-testid="scrub-tutorial-video"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
        >
          <div className="absolute left-0 right-0 h-1 rounded-full bg-white/15" />
          <div className="absolute left-0 h-1 rounded-full" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${C.blurple}, ${C.teal})` }} />
          <div className="absolute h-3.5 w-3.5 rounded-full bg-white shadow-md" style={{ left: `${pct}%`, marginLeft: -7 }} />
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/50" data-testid="text-tutorial-total">{fmt(duration)}</span>
      </div>
    </div>
  );
}

/* ───────── App ───────── */
export default function HowBorrowWorksVideo() {
  return (
    <TutorialPlayerShell duration={DUR}>
      <Background />
      <Sprite start={0.0} end={4.3}><S1 /></Sprite>
      <Sprite start={4.2} end={10.3}><S2 /></Sprite>
      <Sprite start={10.2} end={17.3}><S3 /></Sprite>
      <Sprite start={17.2} end={23.3}><S4 /></Sprite>
      <Sprite start={23.2} end={31.3}><S5 /></Sprite>
      <Sprite start={31.2} end={37.3}><S6 /></Sprite>
      <Sprite start={37.2} end={45.3}><S6b /></Sprite>
      <Sprite start={45.2} end={50.3}><S7 /></Sprite>
      <Sprite start={50.2} end={57.3}><S8 /></Sprite>
      <Sprite start={57.2} end={62.0}><S9 /></Sprite>
    </TutorialPlayerShell>
  );
}
