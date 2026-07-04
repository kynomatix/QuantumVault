// @ts-nocheck
// QuantumVault — "How Per-Bot Borrow Works" in-app tutorial animation (~65s).
// Same self-contained timeline-engine pattern as HowBorrowWorksVideo.tsx.
// Text-only, no audio. 10 scenes covering the full per-bot borrow flow.
// Rendered inside a lazy dialog from PerbotBorrowControls.tsx.
import React from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

/* ───────── Engine (verbatim copy from HowBorrowWorksVideo) ───────── */
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

/* Lucide icons (inline SVG paths) */
const LUCIDE = {
  landmark: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  vault: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'graduation-cap': '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
function Icon({ name, size = 22, color = 'currentColor', stroke = 2 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: LUCIDE[name] || '' }} />;
}

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
      {micro && <div style={{ marginTop: 14, transform: `translateY(${(1 - mp) * 10}px)`, opacity: mp * 0.9, fontFamily: FUI, fontSize: size * 0.26, color: C.faint }}>{micro}</div>}
    </div>
  );
}

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

function HealthBar({ fillPct, w = '100%', h = 10, showMarks = false, fillColor = C.teal }) {
  return (
    <div style={{ position: 'relative', width: w, height: h, borderRadius: h / 2, background: 'rgba(255,255,255,0.07)', overflow: 'visible' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${fillPct}%`, borderRadius: h / 2, background: `linear-gradient(90deg, ${fillColor}, ${fillColor}cc)`, boxShadow: `0 0 12px ${fillColor}66` }} />
      {showMarks && [[50, C.green], [75, 'rgba(255,255,255,0.45)'], [80, C.red]].map(([m, mc]) => (
        <div key={m} style={{ position: 'absolute', left: `${m}%`, top: -3, bottom: -3, width: 2.5, background: mc, borderRadius: 2 }} />
      ))}
    </div>
  );
}

const fmtUSD = (v, dec = 0) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/* ───────── Scene 1 — Title card (0–4s) ───────── */
function S1() {
  const { localTime: lt, duration: dur } = useSprite();
  const hP = Easing.easeOutCubic(clamp((lt - 0.3) / 0.65, 0, 1));
  const sP = Easing.easeOutCubic(clamp((lt - 0.85) / 0.5, 0, 1));
  const underline = Easing.easeInOutCubic(clamp((lt - 0.7) / 0.9, 0, 1));
  const tagP = Easing.easeOutCubic(clamp((lt - 1.3) / 0.5, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 1 - exitP }}>
      {/* Flash-only badge */}
      <div style={{ marginBottom: 38, opacity: tagP, transform: `scale(${0.85 + tagP * 0.15})`, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 20px', borderRadius: 40, background: 'rgba(124,108,255,0.13)', border: '1.5px solid rgba(124,108,255,0.45)' }}>
        <Icon name="zap" size={17} color={C.blurpleHi} />
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.blurpleHi, letterSpacing: '0.04em' }}>Flash bots only</span>
      </div>
      <div style={{ overflow: 'hidden', textAlign: 'center' }}>
        <div style={{ transform: `translateY(${(1 - hP) * 80}px)`, opacity: hP, fontFamily: FD, fontWeight: 600, fontSize: 92, lineHeight: 1.05, color: C.text, letterSpacing: '-0.035em', textAlign: 'center' }}>
          Per-Bot Borrowing
        </div>
      </div>
      <div style={{ height: 5, width: 420, marginTop: 26, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${underline * 100}%`, background: `linear-gradient(90deg, ${C.teal}, ${C.tealHi})`, boxShadow: `0 0 16px ${C.teal}` }} />
      </div>
      <div style={{ marginTop: 26, opacity: sP, transform: `translateY(${(1 - sP) * 14}px)`, fontFamily: FUI, fontWeight: 500, fontSize: 28, color: C.sub }}>Each bot gets its own loan — hands-off</div>
    </div>
  );
}

/* ───────── Sidebar (reused S2/S3) ───────── */
const NAV_ITEMS = ['Dashboard', 'My Bots', 'Marketplace', 'Wallet', 'Vaults', 'Portfolio', 'Leaderboard', 'Settings'];
const NAV_ICONS = {
  Dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  'My Bots': '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  Marketplace: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>',
  Wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  Vaults: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
  Portfolio: '<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
  Leaderboard: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  Settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
};
function Sidebar({ activeItem = 'Wallet', width = 260 }) {
  return (
    <div style={{ width, height: '100%', background: 'linear-gradient(180deg, #0d0e1a 0%, #080910 100%)', borderRight: '1px solid rgba(124,108,255,0.12)', display: 'flex', flexDirection: 'column', padding: '32px 16px 24px', flexShrink: 0 }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 36, paddingLeft: 8 }}>
        <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg, #7c6cff, #4d7cfe)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/></svg>
        </div>
        <div>
          <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text }}>QuantumVault</div>
          <div style={{ fontFamily: FUI, fontSize: 12, color: C.faint }}>Solana · Mainnet</div>
        </div>
      </div>
      {/* Nav items */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {NAV_ITEMS.map((item) => {
          const active = item === activeItem;
          return (
            <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 10, background: active ? 'rgba(124,108,255,0.22)' : 'transparent', border: active ? '1px solid rgba(124,108,255,0.3)' : '1px solid transparent' }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={active ? C.blurpleHi : C.faint} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: NAV_ICONS[item] || '' }} />
              <span style={{ fontFamily: FUI, fontWeight: active ? 700 : 500, fontSize: 15, color: active ? C.text : C.faint }}>{item}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ───────── Scene 2 — Start in Wallet (4–10s) ───────── */
function S2() {
  const { localTime: lt, duration: dur } = useSprite();
  const sidebarP = Easing.easeOutCubic(clamp((lt - 0.1) / 0.6, 0, 1));
  const pageP = Easing.easeOutCubic(clamp((lt - 0.3) / 0.65, 0, 1));
  const lendingHighlight = Easing.easeOutCubic(clamp((lt - 1.8) / 0.7, 0, 1));
  const infRowP = Easing.easeOutBack(clamp((lt - 2.6) / 0.6, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={340} headline="First: supply collateral" sub="Open Wallet → Lending section, pick an asset." micro="INF, SOL, or BTC — pledged, not sold. Staked tokens keep earning." maxW={540} size={62} />
      {/* App chrome */}
      <div style={{ position: 'absolute', left: 680, top: 60, right: 50, bottom: 60, display: 'flex', borderRadius: 18, overflow: 'hidden', border: '1px solid rgba(140,150,220,0.12)', opacity: (1 - exitP) }}>
        {/* Sidebar */}
        <div style={{ opacity: sidebarP, transform: `translateX(${(1 - sidebarP) * -40}px)`, flexShrink: 0 }}>
          <Sidebar activeItem="Wallet" width={230} />
        </div>
        {/* Page content */}
        <div style={{ flex: 1, background: '#08090f', padding: '36px 36px 28px', overflow: 'hidden', opacity: pageP, transform: `translateX(${(1 - pageP) * 30}px)` }}>
          <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 26, color: C.text, marginBottom: 4 }}>Wallet Management</div>
          <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginBottom: 28 }}>Your trading funds and lending collateral</div>
          {/* Lending collateral section */}
          <div style={{ borderRadius: 16, background: 'rgba(12,14,26,0.85)', border: `1px solid rgba(46,230,183,${0.14 + lendingHighlight * 0.3})`, padding: '22px 24px', boxShadow: lendingHighlight ? `0 0 ${24 + lendingHighlight * 26}px rgba(46,230,183,${0.08 + lendingHighlight * 0.18})` : 'none' }}>
            {/* Section header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
              <div style={{ width: 36, height: 36, borderRadius: 10, background: C.tealDim, border: '1px solid rgba(46,230,183,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name="landmark" size={18} color={C.teal} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text }}>Lending collateral</div>
                <div style={{ fontFamily: FUI, fontSize: 12, color: C.faint, marginTop: 2 }}>Held as-is · each asset borrows USDC on its own</div>
              </div>
              <div style={{ padding: '8px 16px', borderRadius: 9, fontFamily: FUI, fontWeight: 700, fontSize: 14, color: '#04241a', background: `linear-gradient(100deg, ${C.teal}, ${C.tealHi})` }}>+ Add Collateral</div>
            </div>
            {/* Stats grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Total Collateral', value: '$2,000', sub: '1 asset supplied' },
                { label: 'Available to Borrow', value: '$1,600', sub: 'across all pools', valueColor: C.teal },
                { label: 'Borrowed', value: '$0', sub: 'no liability' },
              ].map((s) => (
                <div key={s.label} style={{ padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.09)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <span style={{ fontFamily: FUI, fontSize: 12, color: C.faint }}>{s.label}</span>
                  </div>
                  <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 22, color: s.valueColor ?? C.text }}>{s.value}</div>
                  <div style={{ fontFamily: FUI, fontSize: 11, color: C.faint, marginTop: 3 }}>{s.sub}</div>
                </div>
              ))}
            </div>
            {/* Health bar */}
            <div style={{ marginBottom: 12 }}>
              <HealthBar fillPct={0} h={8} />
            </div>
            {/* INF row */}
            <div style={{ overflow: 'hidden' }}>
              <div style={{ transform: `translateY(${(1 - clamp(infRowP, 0, 1)) * 40}px)`, opacity: clamp(infRowP, 0, 1), display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderRadius: 12, background: 'rgba(46,230,183,0.05)', border: '1.5px solid rgba(46,230,183,0.28)' }}>
                <InfLogo size={38} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text }}>INF <span style={{ color: C.faint, fontWeight: 500 }}>$2,000</span></div>
                  <div style={{ fontFamily: FM, fontSize: 12, color: C.teal, marginTop: 3 }}>100% · staking yield active</div>
                </div>
                <div style={{ padding: '7px 14px', borderRadius: 8, fontFamily: FUI, fontWeight: 700, fontSize: 13, color: '#04241a', background: `linear-gradient(100deg, ${C.teal}, ${C.tealHi})` }}>Supplied ✓</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <CalloutArrow lt={lt} at={2.0} x={1170} y={530} dir="up" label="Lending collateral section" />
    </div>
  );
}

/* Equity-tab atoms (S3) */
function BalCard({ label, value, icon, accent = false }) {
  return (
    <div style={{ flex: 1, padding: '13px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.09)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontFamily: FUI, fontSize: 12.5, color: C.sub }}>{label}</span>
        <Icon name={icon} size={16} color={accent ? C.teal : C.blurpleHi} />
      </div>
      <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 22, color: accent ? C.green : C.text }}>{value}</div>
    </div>
  );
}
function TransferRow({ icon, title, caption, action, filled = false }) {
  return (
    <div style={{ marginBottom: 12, padding: '13px 16px', borderRadius: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(140,150,220,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <Icon name={icon} size={17} color={C.blurpleHi} stroke={2.4} />
        <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 16, color: C.text }}>{title}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '11px 14px', borderRadius: 11, background: 'rgba(10,12,24,0.7)', border: '1px solid rgba(140,150,220,0.12)' }}>
          <span style={{ flex: 1, fontFamily: FUI, fontSize: 14, color: C.faint }}>Amount (USDC)</span>
          <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 14, color: C.text }}>Max</span>
        </div>
        <div style={{ padding: '11px 22px', borderRadius: 11, fontFamily: FUI, fontWeight: 700, fontSize: 15, ...(filled ? { color: '#fff', background: 'linear-gradient(100deg, #7c6cff, #4d7cfe)' } : { color: C.sub, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(140,150,220,0.15)' }) }}>{action}</div>
      </div>
      <div style={{ fontFamily: FUI, fontSize: 12, color: C.faint, marginTop: 9 }}>{caption}</div>
    </div>
  );
}

/* ───────── Scene 3 — Open the bot (10–17s) ───────── */
function S3() {
  const { localTime: lt, duration: dur } = useSprite();
  const sidebarP = Easing.easeOutCubic(clamp((lt - 0.1) / 0.5, 0, 1));
  const botListP = Easing.easeOutCubic(clamp((lt - 0.3) / 0.6, 0, 1));
  const drawerP = Easing.easeOutBack(clamp((lt - 1.2) / 0.7, 0, 1));
  const equityTabActive = lt >= 2.2;
  const cardP = Easing.easeOutBack(clamp((lt - 3.0) / 0.6, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={360} headline={<span>Open the bot <span style={{ color: C.teal }}>Equity tab</span></span>} sub="My Bots → tap a bot → Equity → Borrow card." maxW={540} size={62} />
      {/* App chrome */}
      <div style={{ position: 'absolute', left: 680, top: 60, right: 50, bottom: 60, display: 'flex', borderRadius: 18, overflow: 'hidden', border: '1px solid rgba(140,150,220,0.12)', opacity: (1 - exitP) }}>
        {/* Sidebar */}
        <div style={{ opacity: sidebarP, transform: `translateX(${(1 - sidebarP) * -30}px)`, flexShrink: 0 }}>
          <Sidebar activeItem="My Bots" width={210} />
        </div>
        {/* Main content */}
        <div style={{ flex: 1, background: '#08090f', display: 'flex', overflow: 'hidden', opacity: botListP, transform: `translateX(${(1 - botListP) * 20}px)` }}>
          {/* Bot list panel */}
          <div style={{ width: 340, padding: '28px 20px', borderRight: '1px solid rgba(140,150,220,0.1)', flexShrink: 0 }}>
            <div style={{ fontFamily: FD, fontWeight: 700, fontSize: 20, color: C.text, marginBottom: 18 }}>My Bots</div>
            {/* Bot card (highlighted) */}
            <div style={{ padding: '16px 18px', borderRadius: 14, background: 'rgba(124,108,255,0.1)', border: '1.5px solid rgba(124,108,255,0.35)', cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                <div style={{ width: 40, height: 40, borderRadius: 11, background: 'linear-gradient(150deg, rgba(124,108,255,0.35), rgba(77,124,254,0.22))', border: '1px solid rgba(124,108,255,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Icon name="bot" size={20} color={C.blurpleHi} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 15, color: C.text }}>SOL Momentum</div>
                  <div style={{ fontFamily: FM, fontSize: 12, color: C.sub, marginTop: 2 }}>Flash · 3× · Active</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div><div style={{ fontFamily: FUI, fontSize: 11, color: C.faint }}>PnL today</div><div style={{ fontFamily: FM, fontWeight: 700, fontSize: 18, color: C.green }}>+$124.80</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontFamily: FUI, fontSize: 11, color: C.faint }}>Deposited</div><div style={{ fontFamily: FM, fontWeight: 700, fontSize: 18, color: C.text }}>$500</div></div>
              </div>
            </div>
          </div>
          {/* Bot drawer sliding in */}
          {lt >= 1.2 && (
            <div style={{ flex: 1, opacity: clamp(drawerP, 0, 1), transform: `translateX(${(1 - clamp(drawerP, 0, 1)) * 60}px)`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Drawer header */}
              <div style={{ padding: '20px 24px 0', borderBottom: '1px solid rgba(140,150,220,0.10)' }}>
                <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text, marginBottom: 14 }}>SOL Momentum</div>
                {/* Tabs */}
                <div style={{ display: 'flex' }}>
                  {['Stats', 'Positions', 'Equity', 'Settings'].map((t, i) => {
                    const isEquity = i === 2;
                    const active = equityTabActive ? isEquity : i === 0;
                    return (
                      <div key={t} style={{ padding: '10px 20px', fontFamily: FUI, fontWeight: active ? 700 : 500, fontSize: 15, color: active ? (isEquity ? C.teal : C.text) : C.faint, borderBottom: active ? `2.5px solid ${isEquity ? C.teal : C.blurple}` : '2.5px solid transparent' }}>{t}</div>
                    );
                  })}
                </div>
              </div>
              {/* Equity tab content */}
              <div style={{ flex: 1, padding: '18px 22px', overflow: 'hidden', opacity: equityTabActive ? 1 : 0.25 }}>
                {/* Balance cards */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                  <BalCard label="Agent Wallet" value="$8.20" icon="wallet" />
                  <BalCard label="Bot Balance" value="$480.00" icon="trending-up" accent />
                </div>
                {/* Add to Bot */}
                <TransferRow icon="arrow-up" title="Add to Bot" caption="Transfer USDC from your wallet to the bot for trading" action="Add" filled />
                {/* Remove from Bot */}
                <TransferRow icon="arrow-down" title="Remove from Bot" caption="Withdraw USDC from the bot back to your wallet" action="Remove" />
                {/* Borrow Against Collateral (highlighted) */}
                {lt >= 3.0 && (
                  <div style={{ marginTop: 2, transform: `translateY(${(1 - clamp(cardP, 0, 1)) * 26}px)`, opacity: clamp(cardP, 0, 1), padding: '15px 18px', borderRadius: 14, background: 'rgba(46,230,183,0.05)', border: '1.5px solid rgba(46,230,183,0.3)', boxShadow: `0 0 ${18 + cardP * 16}px rgba(46,230,183,${0.08 + cardP * 0.08})` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <InfLogo size={32} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text }}>Borrow Against Collateral</div>
                        <div style={{ fontFamily: FUI, fontSize: 12.5, color: C.sub, marginTop: 2 }}>Backed by your INF collateral</div>
                      </div>
                      <Icon name="graduation-cap" size={19} color={C.teal} />
                    </div>
                    <div style={{ fontFamily: FUI, fontSize: 12.5, color: C.sub, marginTop: 11, lineHeight: 1.45 }}>Borrow extra USDC against your INF collateral and add it to this bot's balance.</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <Cursor lt={lt} path={[[0, 1520, 720], [0.9, 1070, 149], [1.55, 1070, 149], [2.15, 1466, 127], [3.6, 1500, 590], [5.5, 1500, 590]]} taps={[0.9, 2.15]} />
    </div>
  );
}

/* ───────── Scene 4 — Open Loan dialog (17–23s) ───────── */
function S4() {
  const { localTime: lt, duration: dur } = useSprite();
  const dlgP = Easing.easeOutBack(clamp((lt - 0.3) / 0.65, 0, 1));
  const typed = interpolate([1.4, 2.3], [0, 1], Easing.easeOutCubic)(lt);
  const amount = Math.round(800 * typed);
  const barP = interpolate([1.8, 2.8], [0, 50], Easing.easeInOutCubic)(lt);
  const confirmGlow = clamp((lt - 3.6) / 0.3, 0, 1);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={360} headline="Choose how much to borrow" sub="Max pre-fills a safe 50% loan-to-value." micro="Your remaining account collateral stays untouched." maxW={580} size={62} />
      {/* Dialog */}
      <div style={{ position: 'absolute', left: 990, top: 160, width: 600, ...panel, padding: 34, boxShadow: tealGlow, opacity: (1 - exitP) * clamp(dlgP, 0, 1), transform: `scale(${0.87 + dlgP * 0.13}) translateY(${(1 - dlgP) * 28}px)`, transformOrigin: 'top center' }}>
        <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 30, color: C.text, marginBottom: 20 }}>Borrow Against INF</div>
        {/* Collateral asset chip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '14px 18px', borderRadius: 13, background: 'rgba(46,230,183,0.06)', border: '1.5px solid rgba(46,230,183,0.3)', marginBottom: 22 }}>
          <InfLogo size={36} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 18, color: C.text }}>INF · $2,000 collateral</div>
            <div style={{ fontFamily: FM, fontSize: 13, color: C.teal, marginTop: 3 }}>80% LTV · staking yield active</div>
          </div>
          <div style={{ padding: '6px 14px', borderRadius: 9, fontFamily: FM, fontWeight: 700, fontSize: 14, color: C.green, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)' }}>Selected ✓</div>
        </div>
        {/* Amount field */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 14, background: 'rgba(10,12,24,0.8)', border: `1.5px solid rgba(46,230,183,${0.2 + typed * 0.4})`, marginBottom: 10 }}>
          <span style={{ flex: 1, fontFamily: FM, fontWeight: 700, fontSize: 30, color: amount ? C.text : C.faint }}>{amount ? fmtUSD(amount) : '0.00'}</span>
          <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 17, color: C.sub }}>USDC</span>
          <div style={{ padding: '8px 18px', borderRadius: 10, fontFamily: FUI, fontWeight: 700, fontSize: 16, color: '#04241a', background: C.teal, boxShadow: lt > 1.3 && lt < 1.7 ? `0 0 22px ${C.teal}` : 'none' }}>Max</div>
        </div>
        {/* LTV bar */}
        <div style={{ margin: '16px 0 8px' }}>
          <HealthBar fillPct={barP} h={12} showMarks fillColor={barP <= 51 ? C.green : C.amber} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 18 }}>
          <span style={{ fontFamily: FM, fontSize: 13, color: C.faint }}>{Math.round(barP)}% LTV</span>
        </div>
        {/* Confirm button */}
        <div style={{ padding: '15px', borderRadius: 13, textAlign: 'center', fontFamily: FUI, fontWeight: 700, fontSize: 18, color: '#04241a', background: `linear-gradient(100deg, ${C.teal}, ${C.tealHi})`, boxShadow: confirmGlow ? `0 0 ${12 + confirmGlow * 28}px rgba(46,230,183,${0.35 + confirmGlow * 0.4})` : `0 0 12px rgba(46,230,183,0.3)` }}>Confirm Borrow</div>
      </div>
      <Cursor lt={lt} path={[[0.4, 1720, 760], [1.35, 1484, 385], [2.0, 1484, 385], [3.65, 1274, 526], [5.2, 1274, 526]]} taps={[1.35, 3.65]} />
    </div>
  );
}

/* ───────── Scene 5 — The Carve (23–31s) ───────── */
function S5() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const steps = [
    { label: '1  Withdraw', sublabel: 'collateral slice', at: 0.6, color: C.blurpleHi },
    { label: '2  Transfer', sublabel: 'to bot wallet', at: 2.2, color: C.teal },
    { label: '3  Supply + Borrow', sublabel: 'on Jupiter Lend', at: 3.8, color: C.green },
  ];
  const resultP = Easing.easeOutBack(clamp((lt - 5.4) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - exitP }}>
      <Copy lt={lt} dur={dur} x={92} y={300} headline={<span>The <span style={{ color: C.teal }}>Carve</span></span>} sub="You never confirm these — the platform runs all 3 steps automatically." micro="Your remaining Wallet collateral stays untouched." maxW={560} size={72} />
      {/* Flow diagram */}
      <div style={{ position: 'absolute', left: 730, top: 160, display: 'flex', flexDirection: 'column', gap: 28, width: 880 }}>
        {/* Nodes row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {['Account Wallet', 'Bot Wallet', 'Jupiter Lend'].map((node, i) => {
            const nodeP = Easing.easeOutCubic(clamp((lt - (0.2 + i * 0.3)) / 0.5, 0, 1));
            const icons = ['wallet', 'bot', 'landmark'];
            const colors = [C.blurple, C.blurpleHi, C.teal];
            return (
              <div key={node} style={{ opacity: nodeP, transform: `scale(${0.8 + nodeP * 0.2})`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 72, height: 72, borderRadius: 20, background: i === 2 ? C.tealDim : 'linear-gradient(150deg, rgba(124,108,255,0.25), rgba(77,124,254,0.18))', border: `1.5px solid ${colors[i]}55`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={icons[i]} size={30} color={colors[i]} />
                </div>
                <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text, textAlign: 'center' }}>{node}</span>
              </div>
            );
          })}
        </div>
        {/* Steps — animated arrows between nodes */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 10 }}>
          {steps.map((s, i) => {
            const p = Easing.easeOutCubic(clamp((lt - s.at) / 0.55, 0, 1));
            return (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 18, opacity: p, transform: `translateX(${(1 - p) * 40}px)` }}>
                <div style={{ width: 200, fontFamily: FM, fontWeight: 700, fontSize: 19, color: s.color }}>{s.label}</div>
                <div style={{ flex: 1, height: 2, borderRadius: 1, background: `linear-gradient(90deg, ${s.color}, ${s.color}33)`, boxShadow: `0 0 8px ${s.color}55` }} />
                <div style={{ width: 180, fontFamily: FUI, fontSize: 15, color: C.sub }}>{s.sublabel}</div>
              </div>
            );
          })}
        </div>
        {/* Result chip */}
        <div style={{ marginTop: 16, overflow: 'hidden' }}>
          <div style={{ opacity: clamp(resultP, 0, 1), transform: `translateY(${(1 - clamp(resultP, 0, 1)) * 30}px)`, padding: '18px 26px', borderRadius: 15, background: 'rgba(52,211,153,0.07)', border: '1.5px solid rgba(52,211,153,0.4)', display: 'flex', alignItems: 'center', gap: 16, boxShadow: '0 0 30px rgba(52,211,153,0.12)' }}>
            <Icon name="check" size={26} color={C.green} stroke={2.5} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.green }}>Borrowed USDC lands in the bot</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Scene 6 — Loan Plan / Carry Assistant (31–39.6s) ───────── */
function S6() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const cardP = Easing.easeOutCubic(clamp((lt - 0.3) / 0.6, 0, 1));
  const barP = interpolate([0.9, 2.1], [0, 40], Easing.easeInOutCubic)(lt);
  const manageP = Easing.easeOutBack(clamp((lt - 2.1) / 0.55, 0, 1));
  const carryP = Easing.easeOutBack(clamp((lt - 3.1) / 0.6, 0, 1));
  const repayP = Easing.easeOutBack(clamp((lt - 3.9) / 0.6, 0, 1));
  const stats = [
    { v: '11.8%', l: 'Vault Yield', c: C.teal },
    { v: '5.3%', l: 'Borrow APR', c: C.blurpleHi },
    { v: '+6.5%', l: 'Net Edge', c: C.green },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - exitP }}>
      <Copy lt={lt} dur={dur} x={92} y={286} headline={<span>Keep the carry,<br />or <span style={{ color: C.teal }}>repay</span></span>} sub="The Carry Assistant weighs vault yield against borrow cost, then recommends the better move." micro="Idle cash auto-parks to earn — toggle it in Settings → Cash Management." maxW={540} size={58} />
      {/* Carry Trade Loan card */}
      <div style={{ position: 'absolute', left: 726, top: 92, width: 1120, ...panel, padding: 30, opacity: clamp(cardP, 0, 1), transform: `translateY(${(1 - clamp(cardP, 0, 1)) * 30}px)`, boxShadow: tealGlow }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20 }}>
          <InfLogo size={44} />
          <div style={{ marginLeft: 14, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 24, color: C.text }}>INF</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 8, background: 'rgba(46,230,183,0.12)', border: '1px solid rgba(46,230,183,0.3)' }}>
                <Icon name="trending-up" size={13} color={C.teal} />
                <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 13, color: C.teal }}>5.7%</span>
              </span>
            </div>
            <div style={{ fontFamily: FUI, fontSize: 15, color: C.sub, marginTop: 3 }}>Carry Trade Loan · collateral still earns while pledged</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 34, color: C.text }}>$800</div>
            <div style={{ fontFamily: FUI, fontSize: 14, color: C.sub }}>borrowed</div>
          </div>
        </div>
        {/* Loan Health */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{ fontFamily: FUI, fontSize: 15, color: C.sub }}>Loan Health</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FUI, fontWeight: 700, fontSize: 15, color: C.green }}><Icon name="check" size={15} color={C.green} stroke={2.5} /> Healthy</span>
        </div>
        <HealthBar fillPct={barP} h={12} showMarks fillColor={C.green} />
        <div style={{ display: 'flex', gap: 16, marginTop: 10, marginBottom: 22, fontFamily: FM, fontSize: 13 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>{Math.round(barP)}% LTV</span>
          <span style={{ color: C.green }}>Safe 50%</span>
          <span style={{ color: 'rgba(255,255,255,0.45)' }}>Max Borrow 75%</span>
          <span style={{ color: C.red }}>Liquidation 80%</span>
        </div>
        {/* Manage button */}
        <div style={{ opacity: clamp(manageP, 0, 1), transform: `scale(${0.96 + clamp(manageP, 0, 1) * 0.04})`, padding: '13px', borderRadius: 13, textAlign: 'center', fontFamily: FUI, fontWeight: 700, fontSize: 18, color: '#fff', background: 'linear-gradient(100deg, #4d7cfe, #7c6cff)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 24, boxShadow: `0 0 ${16 + clamp(manageP, 0, 1) * 20}px rgba(124,108,255,0.4)` }}>
          <Icon name="landmark" size={19} color="#fff" /> Manage
        </div>
        {/* Loan Plan */}
        <div style={{ fontFamily: FUI, fontSize: 15, color: C.sub, marginBottom: 12 }}>Loan Plan</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
          {/* Carry Trade (recommended + selected) */}
          <div style={{ flex: 1.15, opacity: clamp(carryP, 0, 1), transform: `translateY(${(1 - clamp(carryP, 0, 1)) * 20}px)`, padding: '18px 20px', borderRadius: 16, background: 'rgba(124,108,255,0.07)', border: '1.5px solid rgba(124,108,255,0.5)', boxShadow: '0 0 26px rgba(124,108,255,0.15)' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <span style={{ padding: '4px 11px', borderRadius: 20, fontFamily: FUI, fontWeight: 700, fontSize: 12, color: '#fff', background: 'rgba(124,108,255,0.9)' }}>Recommended</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 11px', borderRadius: 20, fontFamily: FUI, fontWeight: 700, fontSize: 12, color: C.blurpleHi, background: 'rgba(124,108,255,0.15)', border: '1px solid rgba(124,108,255,0.4)' }}><Icon name="check" size={11} color={C.blurpleHi} stroke={3} /> Selected</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <Icon name="trending-up" size={22} color={C.text} />
              <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 22, color: C.text }}>Carry Trade</span>
            </div>
            <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
              {stats.map((s) => (
                <div key={s.l} style={{ flex: 1, padding: '12px 6px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.1)', textAlign: 'center' }}>
                  <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 21, color: s.c }}>{s.v}</div>
                  <div style={{ fontFamily: FUI, fontSize: 12, color: C.sub, marginTop: 4 }}>{s.l}</div>
                </div>
              ))}
            </div>
            <div style={{ fontFamily: FUI, fontSize: 14, color: C.sub, lineHeight: 1.45 }}>Keep the loan and earn yield on the borrowed cash. Your vault: <span style={{ color: C.teal }}>OnRe ONyc</span>.</div>
          </div>
          {/* Repay */}
          <div style={{ flex: 1, opacity: clamp(repayP, 0, 1), transform: `translateY(${(1 - clamp(repayP, 0, 1)) * 20}px)`, padding: '18px 20px', borderRadius: 16, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(140,150,220,0.14)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <Icon name="rotate-ccw" size={22} color={C.sub} />
              <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 22, color: C.text }}>Repay</span>
            </div>
            <div style={{ flex: 1, fontFamily: FUI, fontSize: 14, color: C.sub, lineHeight: 1.45, marginBottom: 16 }}>Brings any parked funds back to cash, clears the loan, and returns your INF to your account.</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', borderRadius: 11, fontFamily: FUI, fontWeight: 700, fontSize: 15, color: C.blurpleHi, background: 'rgba(124,108,255,0.1)', border: '1px solid rgba(124,108,255,0.4)' }}><Icon name="rotate-ccw" size={15} color={C.blurpleHi} /> Repay Loan</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Scene 7 — Health bar (38–44s) ───────── */
function S7() {
  const { localTime: lt, duration: dur } = useSprite();
  const inP = Easing.easeOutCubic(clamp((lt - 0.2) / 0.6, 0, 1));
  const ltvP = interpolate([0.8, 2.4], [0, 50], Easing.easeInOutCubic)(lt);
  // Status chip cycles: Healthy → Watch → At Risk
  const chipPhase = lt < 2.0 ? 0 : lt < 3.5 ? 1 : 2;
  const chipLabels = ['Healthy', 'Watch', 'At Risk'];
  const chipColors = [C.green, C.amber, C.red];
  const chipBg = ['rgba(52,211,153,0.12)', 'rgba(245,169,75,0.12)', 'rgba(244,86,110,0.12)'];
  const chipBorder = ['rgba(52,211,153,0.4)', 'rgba(245,169,75,0.4)', 'rgba(244,86,110,0.4)'];
  const telegramP = Easing.easeOutBack(clamp((lt - 3.8) / 0.6, 0, 1));
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const barColor = ltvP < 50 ? C.green : ltvP < 75 ? C.amber : C.red;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Copy lt={lt} dur={dur} x={92} y={380} headline="Live health bar" sub="Alerts fire before anything gets close to liquidation." maxW={560} size={66} />
      {/* Health panel */}
      <div style={{ position: 'absolute', left: 750, top: 220, width: 860, ...panel, padding: '32px 36px', boxShadow: tealGlow, opacity: (1 - exitP) * inP, transform: `translateY(${(1 - inP) * 40}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 26 }}>
          <InfLogo size={46} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.text }}>INF collateral · Per-bot loan</div>
          </div>
          {/* Status chip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 10, background: chipBg[chipPhase], border: `1px solid ${chipBorder[chipPhase]}` }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: chipColors[chipPhase], boxShadow: `0 0 8px ${chipColors[chipPhase]}` }} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: chipColors[chipPhase] }}>{chipLabels[chipPhase]}</span>
          </div>
        </div>
        {/* LTV Bar */}
        <div style={{ marginBottom: 12 }}>
          <HealthBar fillPct={ltvP} h={18} showMarks fillColor={barColor} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontFamily: FM, fontSize: 14, color: C.faint }}>0%</span>
          <span style={{ fontFamily: FM, fontSize: 14, color: C.green }}>Safe 50%</span>
          <span style={{ fontFamily: FM, fontSize: 14, color: 'rgba(255,255,255,0.45)' }}>Max 75%</span>
          <span style={{ fontFamily: FM, fontSize: 14, color: C.red }}>Liq 80%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 20px', borderRadius: 13, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(140,150,220,0.1)' }}>
          <span style={{ fontFamily: FUI, fontSize: 17, color: C.sub }}>Current LTV</span>
          <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 22, color: barColor }}>{Math.round(ltvP)}%</span>
        </div>
      </div>
      {/* Telegram alert */}
      <div style={{ position: 'absolute', right: 80, top: 120, width: 500, opacity: clamp(telegramP, 0, 1) * (1 - exitP), transform: `translateY(${(1 - clamp(telegramP, 0, 1)) * -28}px)`, ...panel, borderRadius: 16, padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 15, border: '1px solid rgba(245,169,75,0.4)', boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 28px rgba(245,169,75,0.12)' }}>
        <div style={{ width: 42, height: 42, borderRadius: 12, background: 'rgba(245,169,75,0.14)', border: '1px solid rgba(245,169,75,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon name="alert-triangle" size={21} color={C.amber} />
        </div>
        <div>
          <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text, marginBottom: 3 }}>Loan health dropping</div>
          <div style={{ fontFamily: FUI, fontSize: 14, color: C.sub }}>SOL Momentum · INF collateral</div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Scene 8 — Auto-Defend (44–51s) ───────── */
function S8() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const defenses = [
    { step: '1', label: 'Top Up', desc: 'Carve more collateral from account', color: C.blurpleHi, at: 0.5 },
    { step: '2', label: 'Repay', desc: 'Use spare USDC in the bot', color: C.teal, at: 2.0 },
    { step: '3', label: 'Unpark', desc: 'Pull parked savings from Vault', color: C.green, at: 3.5 },
  ];
  const doneP = Easing.easeOutCubic(clamp((lt - 5.2) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - exitP }}>
      <Copy lt={lt} dur={dur} x={92} y={340} headline={<span><span style={{ color: C.amber }}>Auto-Defend</span></span>} sub="Tried in order — the platform acts before you have to." micro="Switch on in Manage → Auto Top-Up & Auto Repay." maxW={560} size={68} />
      <div style={{ position: 'absolute', left: 740, top: 200, width: 920, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {defenses.map((d, i) => {
          const p = Easing.easeOutBack(clamp((lt - d.at) / 0.55, 0, 1));
          // Dim once the next step appears
          const nextAt = defenses[i + 1]?.at ?? 99;
          const dimP = i < defenses.length - 1 ? Easing.easeInOutQuad(clamp((lt - (nextAt + 0.4)) / 0.5, 0, 1)) : 0;
          return (
            <div key={d.step} style={{ opacity: clamp(p, 0, 1) * (1 - dimP * 0.6), transform: `translateX(${(1 - clamp(p, 0, 1)) * 60}px)`, ...panel, padding: '22px 28px', display: 'flex', alignItems: 'center', gap: 22, border: `1px solid ${d.color}33` }}>
              <div style={{ width: 56, height: 56, borderRadius: 16, background: `${d.color}18`, border: `2px solid ${d.color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 24, color: d.color }}>{d.step}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 22, color: d.color, marginBottom: 5 }}>{d.label}</div>
                <div style={{ fontFamily: FUI, fontSize: 16, color: C.sub }}>{d.desc}</div>
              </div>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: clamp(p, 0, 1) ? `${d.color}22` : 'transparent', border: `2px solid ${d.color}44`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="check" size={14} color={d.color} stroke={2.5} />
              </div>
            </div>
          );
        })}
        {/* Done result */}
        <div style={{ overflow: 'hidden' }}>
          <div style={{ opacity: clamp(doneP, 0, 1), transform: `translateY(${(1 - clamp(doneP, 0, 1)) * 24}px)`, padding: '16px 24px', borderRadius: 13, background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.3)', display: 'flex', alignItems: 'center', gap: 14 }}>
            <Icon name="shield-check" size={22} color={C.green} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 18, color: C.green }}>Loan health restored — no action needed from you</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* Manage-dialog helpers */
function ManageRow({ title, hint, action, filled, p }) {
  const pp = clamp(p, 0, 1);
  return (
    <div style={{ opacity: pp, transform: `translateX(${(1 - pp) * 30}px)`, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ width: 176 }}>
        <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text }}>{title}</div>
        <div style={{ fontFamily: FM, fontSize: 11.5, color: C.faint, marginTop: 2 }}>{hint}</div>
      </div>
      <div style={{ flex: 1, padding: '10px 14px', borderRadius: 10, background: 'rgba(10,12,24,0.8)', border: '1px solid rgba(140,150,220,0.14)', fontFamily: FM, fontSize: 16, color: C.faint }}>0.00</div>
      <div style={{ padding: '9px 14px', borderRadius: 9, fontFamily: FUI, fontWeight: 700, fontSize: 13, color: C.sub, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(140,150,220,0.18)' }}>Max</div>
      <div style={{ padding: '9px 18px', borderRadius: 9, fontFamily: FUI, fontWeight: 700, fontSize: 14, color: filled ? '#fff' : C.faint, background: filled ? 'linear-gradient(100deg, #4d7cfe, #7c6cff)' : 'rgba(255,255,255,0.03)', border: filled ? 'none' : '1px solid rgba(140,150,220,0.14)' }}>{action}</div>
    </div>
  );
}
function ToggleRow({ label, on, glow }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderRadius: 12, background: glow ? 'rgba(124,108,255,0.08)' : 'transparent', border: `1px solid ${glow ? 'rgba(124,108,255,0.5)' : 'transparent'}`, boxShadow: glow ? '0 0 20px rgba(124,108,255,0.2)' : 'none', transition: 'background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text }}>{label}</span>
        <Icon name="info" size={14} color={C.faint} />
      </div>
      <div style={{ position: 'relative', width: 52, height: 30, borderRadius: 15, background: on ? 'linear-gradient(100deg, #6d5cff, #7c6cff)' : 'rgba(255,255,255,0.1)', boxShadow: on ? '0 0 12px rgba(124,108,255,0.5)' : 'none', transition: 'background 0.2s ease, box-shadow 0.2s ease' }}>
        <div style={{ position: 'absolute', top: 3, left: on ? 25 : 3, width: 24, height: 24, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
      </div>
    </div>
  );
}

/* ───────── Scene 9 — Manage Loan dialog (52.7–60.3s) ───────── */
function S9() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const dlgP = Easing.easeOutBack(clamp((lt - 0.3) / 0.6, 0, 1));
  const rows = [
    { title: 'Borrow More', hint: 'up to $200', action: 'Borrow', filled: true, at: 0.7 },
    { title: 'Repay', hint: '$800 owed', action: 'Repay', filled: false, at: 1.0 },
    { title: 'Add Collateral', hint: 'free wallet assets only', action: 'Add', filled: false, at: 1.3 },
    { title: 'Remove Collateral', hint: 'frees pledged assets', action: 'Remove', filled: false, at: 1.6 },
  ];
  const togP = Easing.easeOutBack(clamp((lt - 2.3) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - exitP }}>
      <Copy lt={lt} dur={dur} x={92} y={330} headline={<span>Tap <span style={{ color: C.blurpleHi }}>Manage</span></span>} sub="Borrow more, repay, or adjust collateral — anytime, in one place." micro="Flip on Auto Top-Up & Auto Repay here for hands-off defense." maxW={520} size={64} />
      {/* Manage Loan dialog */}
      <div style={{ position: 'absolute', left: 706, top: 74, width: 780, ...panel, padding: 30, opacity: clamp(dlgP, 0, 1), transform: `scale(${0.9 + clamp(dlgP, 0, 1) * 0.1}) translateY(${(1 - clamp(dlgP, 0, 1)) * 24}px)`, transformOrigin: 'top center', boxShadow: '0 30px 80px rgba(0,0,0,0.7), 0 0 34px rgba(124,108,255,0.14)' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <Icon name="landmark" size={24} color={C.blurpleHi} />
          <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 27, color: C.text, flex: 1 }}>Manage Loan</span>
          <Icon name="x" size={22} color={C.faint} />
        </div>
        <div style={{ fontFamily: FUI, fontSize: 15, color: C.sub, marginBottom: 20 }}>Borrow more, repay, or add collateral.</div>
        {/* Health projection */}
        <div style={{ padding: '16px 18px', borderRadius: 13, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(140,150,220,0.12)', marginBottom: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontFamily: FUI, fontSize: 14, color: C.sub }}>Loan Health</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FUI, fontWeight: 700, fontSize: 14, color: C.green }}><Icon name="check" size={14} color={C.green} stroke={2.5} /> Healthy</span>
          </div>
          <HealthBar fillPct={40} h={10} showMarks fillColor={C.green} />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9, fontFamily: FM, fontSize: 12.5, color: C.faint }}>
            <span>Borrowed $800</span>
            <span>Backed by $2,000</span>
          </div>
        </div>
        {/* Action rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 15, marginBottom: 20 }}>
          {rows.map((r) => (
            <ManageRow key={r.title} title={r.title} hint={r.hint} action={r.action} filled={r.filled} p={Easing.easeOutCubic(clamp((lt - r.at) / 0.5, 0, 1))} />
          ))}
        </div>
        {/* Divider */}
        <div style={{ height: 1, background: 'rgba(140,150,220,0.14)', margin: '0 0 16px' }} />
        {/* Auto toggles (the answer to "where do I turn it on") */}
        <div style={{ opacity: clamp(togP, 0, 1), transform: `translateY(${(1 - clamp(togP, 0, 1)) * 16}px)`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ToggleRow label="Auto Top-Up" on={lt >= 3.6} glow={lt >= 3.6} />
          <ToggleRow label="Auto Repay" on={lt >= 4.5} glow={lt >= 4.5} />
        </div>
      </div>
      <Cursor lt={lt} path={[[0.3, 1640, 820], [3.1, 1398, 593], [3.8, 1398, 593], [4.5, 1398, 653], [6.2, 1398, 653]]} taps={[3.6, 4.5]} />
    </div>
  );
}

/* ───────── Scene 10 — Repay & Close (56–65s) ───────── */
function S10() {
  const { localTime: lt, duration: dur } = useSprite();
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const waterfall = [
    { step: '1', label: 'Unpark savings → USDC', color: C.teal, at: 0.5 },
    { step: '2', label: 'Repay debt in full', color: C.blurpleHi, at: 2.0 },
    { step: '3', label: 'Collateral returns to Wallet', color: C.green, at: 3.5 },
  ];
  const retryP = Easing.easeOutBack(clamp((lt - 5.4) / 0.65, 0, 1));
  const flourish = interpolate([5.3, 5.9, 7.0], [0, 1, 0], [Easing.easeOutCubic, Easing.easeInOutSine])(lt);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - exitP }}>
      <Copy lt={lt} dur={dur} x={92} y={330} headline="Repay & Close" sub="Every step is resumable — Retry picks up exactly where it left off." micro="Leftover USDC stays in the bot as idle balance." maxW={580} size={64} />
      <div style={{ position: 'absolute', left: 750, top: 180, width: 880, display: 'flex', flexDirection: 'column', gap: 22 }}>
        {waterfall.map((w) => {
          const p = Easing.easeOutCubic(clamp((lt - w.at) / 0.55, 0, 1));
          return (
            <div key={w.step} style={{ opacity: clamp(p, 0, 1), transform: `translateX(${(1 - clamp(p, 0, 1)) * 50}px)`, ...panel, padding: '24px 30px', display: 'flex', alignItems: 'center', gap: 22, border: `1px solid ${w.color}33` }}>
              <div style={{ width: 54, height: 54, borderRadius: 15, background: `${w.color}14`, border: `2px solid ${w.color}55`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontFamily: FD, fontWeight: 700, fontSize: 24, color: w.color }}>{w.step}</span>
              </div>
              <div style={{ flex: 1, fontFamily: FUI, fontWeight: 700, fontSize: 22, color: C.text }}>{w.label}</div>
              {clamp(p, 0, 1) > 0.9 && <Icon name="check" size={22} color={w.color} stroke={2.5} />}
            </div>
          );
        })}
        {/* Retry badge */}
        <div style={{ overflow: 'hidden' }}>
          <div style={{ opacity: clamp(retryP, 0, 1), transform: `translateY(${(1 - clamp(retryP, 0, 1)) * 30}px)`, display: 'flex', alignItems: 'center', gap: 14, padding: '18px 26px', borderRadius: 15, background: 'rgba(46,230,183,0.07)', border: `1.5px solid rgba(46,230,183,${0.3 + flourish * 0.4})`, boxShadow: flourish ? `0 0 ${flourish * 32}px rgba(46,230,183,0.25)` : 'none' }}>
            <Icon name="rotate-ccw" size={24} color={C.teal} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 20, color: C.teal }}>Retry picks up exactly where it left off</div>
              <div style={{ fontFamily: FUI, fontSize: 15, color: C.sub, marginTop: 4 }}>Safe to tap Retry after any interruption — never double-pays</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Player shell (verbatim copy from HowBorrowWorksVideo) ───────── */
const W = 1920, H = 1080, DUR = 69;
function TutorialPlayerShell({ duration = DUR, children }) {
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
    <div className="absolute inset-0 bg-black">
      <div ref={wrapRef} className="absolute inset-0 flex items-center justify-center overflow-hidden">
        <div style={{ width: W, height: H, position: 'relative', transform: `scale(${scale})`, transformOrigin: 'center', flexShrink: 0, overflow: 'hidden' }}>
          <TimelineContext.Provider value={ctx}>{children}</TimelineContext.Provider>
        </div>
        {ended && (
          <button
            type="button"
            onClick={replay}
            className="absolute inset-0 flex items-center justify-center bg-black/40"
            data-testid="button-perbot-tutorial-replay-overlay"
            aria-label="Replay video"
          >
            <span className="flex items-center gap-2.5 rounded-full border border-teal-400/40 bg-black/70 px-5 py-3 text-sm font-semibold text-teal-300">
              <RotateCcw className="w-4 h-4" /> Replay
            </span>
          </button>
        )}
      </div>
      <div className="absolute bottom-0 left-0 right-0 flex items-center gap-2 sm:gap-3 px-2.5 sm:px-4 py-2 bg-black/75 backdrop-blur-sm select-none">
        <button
          type="button"
          onClick={togglePlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-white"
          data-testid="button-perbot-tutorial-play-pause"
          aria-label={ended ? 'Replay' : playing ? 'Pause' : 'Play'}
        >
          {ended ? <RotateCcw className="w-3.5 h-3.5" /> : playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
        </button>
        <span className="w-9 shrink-0 font-mono text-[11px] tabular-nums text-white" data-testid="text-perbot-tutorial-elapsed">{fmt(time)}</span>
        <div
          ref={barRef}
          className="relative flex-1 h-7 flex items-center cursor-pointer touch-none"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubUp}
          onPointerCancel={onScrubUp}
          data-testid="scrub-perbot-tutorial-video"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
        >
          <div className="absolute left-0 right-0 h-1 rounded-full bg-white/15" />
          <div className="absolute left-0 h-1 rounded-full" style={{ width: `${pct}%`, background: `linear-gradient(90deg, #7c6cff, #2ee6b7)` }} />
          <div className="absolute h-3.5 w-3.5 rounded-full bg-white shadow-md" style={{ left: `${pct}%`, marginLeft: -7 }} />
        </div>
        <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-white/50" data-testid="text-perbot-tutorial-total">{fmt(duration)}</span>
      </div>
    </div>
  );
}

/* ───────── App ───────── */
export default function HowPerbotBorrowWorksVideo() {
  return (
    <TutorialPlayerShell duration={DUR}>
      <Background />
      <Sprite start={0.0}  end={4.2}><S1 /></Sprite>
      <Sprite start={4.1}  end={10.2}><S2 /></Sprite>
      <Sprite start={10.1} end={17.2}><S3 /></Sprite>
      <Sprite start={17.1} end={23.2}><S4 /></Sprite>
      <Sprite start={23.1} end={31.2}><S5 /></Sprite>
      <Sprite start={31.1} end={39.6}><S6 /></Sprite>
      <Sprite start={39.5} end={45.7}><S7 /></Sprite>
      <Sprite start={45.6} end={52.8}><S8 /></Sprite>
      <Sprite start={52.7} end={60.3}><S9 /></Sprite>
      <Sprite start={60.2} end={69.0}><S10 /></Sprite>
    </TutorialPlayerShell>
  );
}
