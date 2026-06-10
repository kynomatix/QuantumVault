// @ts-nocheck
// QuantumVault — brand launch video. Self-contained timeline engine + scenes.
// Ported from the standalone build into the app as <LaunchVideo />.
import React from 'react';

/* ───────────────────────── Engine ───────────────────────── */
const Easing = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => (--t) * t * t + 1,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  easeOutQuart: (t) => 1 - (--t) * t * t * t,
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t),
  easeInExpo: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  easeInBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  easeOutElastic: (t) => { const c4 = (2 * Math.PI) / 3; if (t === 0) return 0; if (t === 1) return 1; return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1; },
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
        const easeFn = Array.isArray(ease) ? (ease[i] || Easing.linear) : ease;
        return output[i] + (output[i + 1] - output[i]) * easeFn(local);
      }
    }
    return output[output.length - 1];
  };
}
const TimelineContext = React.createContext({ time: 0, duration: 10, playing: false });
const useTimeline = () => React.useContext(TimelineContext);
const useTime = () => React.useContext(TimelineContext).time;
const SpriteContext = React.createContext({ localTime: 0, progress: 0, duration: 0 });
const useSprite = () => React.useContext(SpriteContext);
function Sprite({ start = 0, end = Infinity, children, keepMounted = false }) {
  const { time } = useTimeline();
  const visible = time >= start && time <= end;
  if (!visible && !keepMounted) return null;
  const duration = end - start;
  const localTime = Math.max(0, time - start);
  const progress = duration > 0 && isFinite(duration) ? clamp(localTime / duration, 0, 1) : 0;
  const value = { localTime, progress, duration, visible };
  return <SpriteContext.Provider value={value}>{typeof children === 'function' ? children(value) : children}</SpriteContext.Provider>;
}

/* ───────────────────────── Brand kit ───────────────────────── */
const C = {
  bg: '#06070f', text: '#f3f4fb', sub: '#9ea4c2', faint: '#5c618a',
  purple: '#6d5cff', purpleHi: '#8b8cff', violet: '#5b6bff',
  blue: '#3b82f6', cyan: '#46c6ff',
  green: '#34d399', greenHi: '#52e5a8', red: '#f4566e',
  solGreen: '#14F195', solPurple: '#9945FF', solTeal: '#19FB9B',
  panelBorder: 'rgba(132,124,255,0.18)',
};
const FUI = "'Plus Jakarta Sans', system-ui, sans-serif";
const FD = "'Space Grotesk', system-ui, sans-serif";
const FM = "'JetBrains Mono', ui-monospace, monospace";

const LOGO_SRC = '/images/qv-launch-logo.webp';
function Logo({ size = 64, gradient = false, glow = 0.0, color = '#f4f5fb' }) {
  // White logo art; `glow` adds a purple/blue bloom for hero moments.
  return (
    <img src={LOGO_SRC} alt="QuantumVault" width={size} height={size}
      style={{ width: size, height: size, display: 'block', objectFit: 'contain', filter: glow ? `drop-shadow(0 0 ${glow}px rgba(109,92,255,0.9)) drop-shadow(0 0 ${glow * 2}px rgba(70,150,255,0.55))` : 'none' }} />
  );
}

function Wordmark({ size = 40, gap = 16, logoSize, gradient = false, glow = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap }}>
      <Logo size={logoSize || size * 1.5} gradient={gradient} glow={glow} />
      <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: size, color: C.text, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>QuantumVault</span>
    </div>
  );
}

// ── Lucide icons (clean 2px rounded line icons, 24x24) ──
const LUCIDE = {
  'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  store: '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7"/>',
  wallet: '<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
  'line-chart': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  'flask-conical': '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
};
function Icon({ name, size = 22, color = 'currentColor', stroke = 2 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: LUCIDE[name] || '' }} />;
}

function SolanaMark({ w = 56 }) {
  const h = w * (311.7 / 397.7);
  const gid = React.useMemo(() => 'sol' + Math.random().toString(36).slice(2), []);
  return (
    <svg width={w} height={h} viewBox="0 0 397.7 311.7" fill="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="360.88" y1="-37.46" x2="141.21" y2="383.29">
          <stop offset="0" stopColor="#00FFA3" /><stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill={`url(#${gid})`}>
        <path d="M64.6,237.9c2.4-2.4,5.7-3.8,9.2-3.8h317.4c5.8,0,8.7,7,4.6,11.1l-62.7,62.7c-2.4,2.4-5.7,3.8-9.2,3.8H6.5c-5.8,0-8.7-7-4.6-11.1L64.6,237.9z" />
        <path d="M64.6,3.8C67.1,1.4,70.4,0,73.8,0h317.4c5.8,0,8.7,7,4.6,11.1l-62.7,62.7c-2.4,2.4-5.7,3.8-9.2,3.8H6.5c-5.8,0-8.7-7-4.6-11.1L64.6,3.8z" />
        <path d="M333.1,120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8,0-8.7,7-4.6,11.1l62.7,62.7c2.4,2.4,5.7,3.8,9.2,3.8h317.4c5.8,0,8.7-7,4.6-11.1L333.1,120.1z" />
      </g>
    </svg>
  );
}

// soft neon glow frame around a panel (mimics the screenshots' edge-glow)
function neon(rgba1, rgba2) {
  return `0 0 0 1px rgba(255,255,255,0.04) inset, 0 30px 90px rgba(0,0,0,0.65), 0 0 42px ${rgba1}, 0 0 96px ${rgba2}`;
}
const panelBase = {
  background: 'linear-gradient(165deg, rgba(22,24,44,0.97), rgba(9,10,21,0.99))',
  border: '1px solid rgba(150,130,255,0.16)',
  borderRadius: 22,
};

function Background() {
  const t = useTime();
  const drift = Math.sin(t * 0.4) * 18;
  const streak = (x, y, rot, len, col, op, w = 2) => ({
    position: 'absolute', left: x, top: y, width: len, height: w,
    background: `linear-gradient(90deg, transparent, ${col}, transparent)`,
    transform: `rotate(${rot}deg)`, opacity: op, borderRadius: 4,
  });
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#05060e' }}>
      {/* base radial wash */}
      <div style={{ position: 'absolute', inset: '-20%', background: 'radial-gradient(1200px 800px at 30% 18%, rgba(80,50,180,0.30), transparent 60%), radial-gradient(1100px 760px at 82% 84%, rgba(30,90,220,0.26), transparent 62%), radial-gradient(900px 900px at 60% 50%, rgba(10,12,30,0.0), #05060e 78%)' }} />
      {/* diagonal neon streaks */}
      <div style={{ position: 'absolute', inset: 0, transform: `translateX(${drift}px)` }}>
        <div style={streak(-120, 120, 38, 720, 'rgba(160,110,255,0.55)', 0.5)} />
        <div style={streak(-160, 200, 38, 540, 'rgba(120,90,255,0.4)', 0.35)} />
        <div style={streak(-90, 300, 38, 460, 'rgba(120,90,255,0.3)', 0.25)} />
      </div>
      <div style={{ position: 'absolute', inset: 0, transform: `translateX(${-drift}px)` }}>
        <div style={streak(1320, 760, 38, 760, 'rgba(70,160,255,0.6)', 0.55)} />
        <div style={streak(1380, 840, 38, 560, 'rgba(70,160,255,0.4)', 0.35)} />
        <div style={streak(1280, 900, 38, 460, 'rgba(70,198,255,0.32)', 0.25)} />
      </div>
      {/* fine grid sparkle */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.5, background: 'radial-gradient(circle at 50% 50%, transparent 60%, rgba(5,6,14,0.7) 100%)' }} />
      {/* vignette */}
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 320px rgba(0,0,0,0.85)' }} />
    </div>
  );
}

/* ── kinetic headline ── */
function GradText({ children, from = C.purpleHi, to = C.cyan }) {
  return <span style={{ background: `linear-gradient(100deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>;
}
function Headline({ lt, dur, x, y, size = 96, lines, sub, align = 'left', maxW = 760 }) {
  const exitStart = dur - 0.45;
  const exitP = Easing.easeInCubic(clamp((lt - exitStart) / 0.45, 0, 1));
  const tx = align === 'center' ? '-50%' : '0';
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: maxW, transform: `translateX(${tx})`, textAlign: align }}>
      {lines.map((ln, i) => {
        const st = 0.18 + i * 0.12;
        const p = Easing.easeOutCubic(clamp((lt - st) / 0.55, 0, 1));
        return (
          <div key={i} style={{ overflow: 'hidden', padding: '0 6px', margin: '0 -6px' }}>
            <div style={{ transform: `translateY(${(1 - p) * (size * 0.9)}px)`, opacity: p * (1 - exitP), fontFamily: FD, fontWeight: 600, fontSize: size, lineHeight: 1.04, color: C.text, letterSpacing: '-0.035em' }}>
              {ln}
            </div>
          </div>
        );
      })}
      {sub && (() => {
        const p = Easing.easeOutCubic(clamp((lt - (0.18 + lines.length * 0.12 + 0.12)) / 0.5, 0, 1));
        return <div style={{ marginTop: 22, transform: `translateY(${(1 - p) * 16}px)`, opacity: p * (1 - exitP), fontFamily: FUI, fontWeight: 500, fontSize: size * 0.26, color: C.sub, letterSpacing: '0.01em' }}>{sub}</div>;
      })()}
    </div>
  );
}

/* ── 3D fly-in for screens ── */
function flyStyle(lt, dur, p = {}) {
  const inDur = p.inDur ?? 0.9, outDur = p.outDur ?? 0.55;
  const a = 0, b = inDur, c = dur - outDur, d = dur;
  const ez = [Easing.easeOutCubic, Easing.easeInOutSine, Easing.easeInCubic];
  const z = interpolate([a, b, c, d], [p.z0 ?? -1700, 0, p.zHold ?? 70, p.z1 ?? 560], ez)(lt);
  const ry = interpolate([a, b, c, d], [p.ry0 ?? -30, p.ryHold ?? -6.5, p.ryHold ?? -6.5, p.ry1 ?? 12], ez)(lt);
  const rx = interpolate([a, b, c, d], [p.rx0 ?? 17, p.rxHold ?? 5, p.rxHold ?? 5, p.rx1 ?? -8], ez)(lt);
  const yy = interpolate([a, b, c, d], [p.y0 ?? 170, 0, 0, p.y1 ?? -70], ez)(lt);
  const op = interpolate([a, b * 0.55, c, d], [0, 1, 1, 0])(lt);
  return { opacity: op, transform: `translateY(${yy}px) translateZ(${z}px) rotateX(${rx}deg) rotateY(${ry}deg)` };
}
function Stage3D({ children, style }) {
  return <div style={{ position: 'absolute', inset: 0, perspective: 1700, perspectiveOrigin: '52% 46%', ...style }}>
    <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}>{children}</div>
  </div>;
}

/* ── small UI atoms ── */
function StatCard({ label, value, sub, valColor = C.text, w = 250 }) {
  return (
    <div style={{ ...panelBase, width: w, padding: '18px 20px', borderRadius: 16, boxShadow: '0 12px 36px rgba(0,0,0,0.4)' }}>
      <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ fontFamily: FM, fontSize: 32, color: valColor, fontWeight: 700, marginTop: 8, letterSpacing: '-0.01em' }}>{value}</div>
      <div style={{ fontFamily: FUI, fontSize: 13, color: C.faint, marginTop: 6 }}>{sub}</div>
    </div>
  );
}
function BotRow({ name, market, pnl, pct, lev, up, w = 560, big }) {
  const col = up ? C.greenHi : C.red;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: w, padding: big ? '18px 22px' : '14px 18px', background: 'linear-gradient(180deg, rgba(28,30,54,0.7), rgba(16,18,34,0.7))', border: '1px solid rgba(150,130,255,0.12)', borderRadius: 14 }}>
      <div style={{ width: big ? 44 : 38, height: big ? 44 : 38, borderRadius: 11, background: 'linear-gradient(150deg, rgba(109,92,255,0.35), rgba(59,130,246,0.25))', border: '1px solid rgba(150,130,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name="bot" size={big ? 22 : 19} color={C.purpleHi} stroke={1.9} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: big ? 18 : 16, color: C.text, whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontFamily: FM, fontSize: big ? 13 : 12, color: C.faint, marginTop: 3 }}>{market}{lev ? ` · ${lev}` : ''}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontFamily: FM, fontWeight: 700, fontSize: big ? 19 : 16, color: col }}>{pnl}</div>
        <div style={{ fontFamily: FM, fontSize: big ? 13 : 12, color: col, opacity: 0.85, marginTop: 2 }}>{pct}</div>
      </div>
      <div style={{ width: 8, height: 8, borderRadius: 4, background: C.green, boxShadow: `0 0 10px ${C.green}`, flexShrink: 0 }} />
    </div>
  );
}

/* ───────────────────────── Scenes ───────────────────────── */

// Scene 0 — logo ignition
function SceneLogo() {
  const { localTime: lt, duration: dur } = useSprite();
  const bloom = Easing.easeOutCubic(clamp(lt / 0.7, 0, 1));
  const ring = Easing.easeOutQuart(clamp((lt - 0.15) / 1.1, 0, 1));
  const logoScale = interpolate([0, 0.7, dur - 0.5, dur], [0.5, 1, 1.04, 1.5], [Easing.easeOutBack, Easing.easeInOutSine, Easing.easeInCubic])(lt);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const wmP = Easing.easeOutCubic(clamp((lt - 0.75) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      {/* expanding glow ring */}
      <div style={{ position: 'absolute', width: 520, height: 520, borderRadius: '50%', border: '2px solid rgba(132,124,255,0.5)', transform: `scale(${0.3 + ring * 1.6})`, opacity: (1 - ring) * 0.8 }} />
      <div style={{ position: 'absolute', width: 360, height: 360, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,92,255,0.45), transparent 68%)', opacity: bloom * (1 - exitP * 0.7), transform: `scale(${0.8 + bloom * 0.5})` }} />
      <div style={{ transform: `scale(${logoScale})`, opacity: 1 - exitP }}>
        <Logo size={150} gradient glow={28} />
      </div>
      <div style={{ marginTop: 30, overflow: 'hidden', height: 78, opacity: 1 - exitP }}>
        <div style={{ transform: `translateY(${(1 - wmP) * 80}px)`, opacity: wmP, fontFamily: FUI, fontWeight: 700, fontSize: 62, color: C.text, letterSpacing: '-0.025em' }}>QuantumVault</div>
      </div>
      <div style={{ marginTop: 8, opacity: Easing.easeOutCubic(clamp((lt - 1.15) / 0.5, 0, 1)) * (1 - exitP), fontFamily: FM, fontSize: 17, letterSpacing: '0.42em', color: C.sub, paddingLeft: '0.42em' }}>AUTONOMOUS TRADING ON SOLANA</div>
    </div>
  );
}

// Scene 1 — dashboard fly-in
function DashboardCard({ lt }) {
  const cards = [
    { label: 'Available Balance', value: '$44.01', sub: 'Agent wallet USDC', c: C.text },
    { label: 'SOL Price', value: '$65.47', sub: 'Live from market', c: C.greenHi },
    { label: 'Total Trades', value: '10', sub: 'Bot executions', c: C.text },
    { label: 'Active Bots', value: '8', sub: 'TradingView bots', c: C.purpleHi },
  ];
  return (
    <div style={{ ...panelBase, width: 1180, height: 720, boxShadow: neon('rgba(109,92,255,0.32)', 'rgba(59,130,246,0.22)'), overflow: 'hidden', display: 'flex' }}>
      {/* sidebar */}
      <div style={{ width: 230, borderRight: '1px solid rgba(150,130,255,0.1)', padding: '26px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ marginBottom: 18 }}><Wordmark size={20} logoSize={30} /></div>
        {[['Dashboard', 'layout-dashboard'], ['My Bots', 'bot'], ['Marketplace', 'store'], ['Wallet', 'wallet'], ['Portfolio', 'line-chart'], ['Leaderboard', 'trophy']].map(([it, ic], i) => (
          <div key={it} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px', borderRadius: 11, background: i === 0 ? 'linear-gradient(90deg, rgba(109,92,255,0.28), rgba(109,92,255,0.06))' : 'transparent', border: i === 0 ? '1px solid rgba(132,124,255,0.4)' : '1px solid transparent' }}>
            <Icon name={ic} size={18} color={i === 0 ? C.purpleHi : 'rgba(178,182,210,0.7)'} stroke={2} />
            <span style={{ fontFamily: FUI, fontSize: 15, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? C.text : C.sub }}>{it}</span>
          </div>
        ))}
      </div>
      {/* main */}
      <div style={{ flex: 1, padding: '26px 28px' }}>
        <div style={{ display: 'flex', gap: 16, marginBottom: 22 }}>
          {cards.map((c, i) => {
            const p = Easing.easeOutBack(clamp((lt - (0.95 + i * 0.12)) / 0.5, 0, 1));
            return <div key={i} style={{ transform: `translateY(${(1 - p) * 26}px) scale(${0.9 + p * 0.1})`, opacity: clamp(p, 0, 1) }}><StatCard {...c} valColor={c.c} w={205} /></div>;
          })}
        </div>
        <div style={{ display: 'flex', gap: 18 }}>
          {/* open positions */}
          <div style={{ flex: 1.25, ...panelBase, borderRadius: 16, padding: 20, height: 430 }}>
            <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 22, color: C.text, marginBottom: 16 }}>Open Positions</div>
            {(() => {
              const p = Easing.easeOutCubic(clamp((lt - 1.5) / 0.5, 0, 1));
              return (
                <div style={{ opacity: p, transform: `translateY(${(1 - p) * 14}px)`, display: 'flex', alignItems: 'center', gap: 14, padding: 16, background: 'linear-gradient(180deg, rgba(28,30,54,0.6), rgba(16,18,34,0.5))', border: '1px solid rgba(150,130,255,0.14)', borderRadius: 13 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(150deg, rgba(109,92,255,0.4), rgba(59,130,246,0.25))', border: '1px solid rgba(150,130,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Icon name="trending-up" size={20} color={C.greenHi} stroke={2} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 16, color: C.text }}>ZEC 2H FLUX MOMENTUM</span>
                      <span style={{ fontFamily: FM, fontSize: 11, fontWeight: 700, color: C.green, padding: '3px 8px', borderRadius: 6, background: 'rgba(52,211,153,0.14)', border: '1px solid rgba(52,211,153,0.3)' }}>LONG</span>
                    </div>
                    <div style={{ fontFamily: FM, fontSize: 12, color: C.faint, marginTop: 4 }}>ZEC-PERP · 1.8900 @ $422.57</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: FM, fontSize: 11, color: C.faint }}>PNL</div>
                    <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 20, color: C.greenHi }}>+$57.38</div>
                  </div>
                </div>
              );
            })()}
            <div style={{ marginTop: 16, fontFamily: FUI, fontSize: 13, color: C.faint }}>Recent Trades</div>
            {['ZEC-PERP · LONG · executed', 'ICP-PERP · CLOSE · executed', 'SOL-PERP · LONG · executed'].map((r, i) => {
              const p = Easing.easeOutCubic(clamp((lt - (1.75 + i * 0.1)) / 0.4, 0, 1));
              return <div key={i} style={{ opacity: p * 0.8, marginTop: 12, height: 14, borderRadius: 4, background: 'rgba(150,150,200,0.08)', width: `${90 - i * 8}%` }} />;
            })}
          </div>
          {/* active bots */}
          <div style={{ flex: 1, ...panelBase, borderRadius: 16, padding: 20, height: 430 }}>
            <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 22, color: C.text, marginBottom: 16 }}>Active Bots</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[['ZEC 2H FLUX', '+$296.77', true], ['NEAR 2H', '+$47.00', true], ['AVAX 4H FLUX', '+$29.23', true], ['BTC 2H FLUX', '-$5.08', false]].map((b, i) => {
                const p = Easing.easeOutCubic(clamp((lt - (1.4 + i * 0.12)) / 0.45, 0, 1));
                return <div key={i} style={{ opacity: p, transform: `translateX(${(1 - p) * 30}px)` }}><BotRow name={b[0]} market={'PERP'} pnl={b[1]} pct={b[2] ? '' : ''} up={b[2]} w={300} /></div>;
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function SceneDashboard() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: -34, ryHold: -7, rx0: 16, rxHold: 4.5, y0: 150, zHold: 60 });
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Stage3D>
        <div style={{ position: 'absolute', left: 600, top: 175, ...fly, transformStyle: 'preserve-3d' }}>
          <DashboardCard lt={lt} />
        </div>
      </Stage3D>
      <Headline lt={lt} dur={dur} x={92} y={356} size={88} lines={[<span key="a">Automated</span>, <span key="b">trading, on</span>, <span key="c"><GradText>autopilot.</GradText></span>]} sub="Connect a wallet. Your agent does the rest." maxW={560} />
    </div>
  );
}

// Scene 2 — signals become trades
function TPModal({ lt }) {
  const setP = Easing.easeOutCubic(clamp((lt - 1.5) / 0.5, 0, 1));
  return (
    <div style={{ width: 560, ...panelBase, padding: 26, boxShadow: neon('rgba(109,92,255,0.4)', 'rgba(59,130,246,0.3)'), borderRadius: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderRadius: 12, background: 'rgba(20,22,40,0.7)', border: '1px solid rgba(150,130,255,0.12)' }}>
        <Icon name="sliders" size={18} color={C.sub} stroke={2} />
        <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 17, color: C.text }}>Hide TP / SL</span>
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 18 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FUI, fontSize: 14, fontWeight: 600, color: C.green, marginBottom: 8 }}>Take Profit (%)</div>
          <div style={{ fontFamily: FM, fontSize: 26, color: C.text, padding: '12px 16px', borderRadius: 11, background: 'rgba(15,16,30,0.8)', border: '1px solid rgba(150,130,255,0.16)' }}>2</div>
          <div style={{ fontFamily: FM, fontSize: 13, color: C.faint, marginTop: 6 }}>= $537.78</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FUI, fontSize: 14, fontWeight: 600, color: C.red, marginBottom: 8 }}>Stop Loss (%)</div>
          <div style={{ fontFamily: FM, fontSize: 26, color: C.text, padding: '12px 16px', borderRadius: 11, background: 'rgba(15,16,30,0.8)', border: '1px solid rgba(150,130,255,0.16)' }}>1</div>
          <div style={{ fontFamily: FM, fontSize: 13, color: C.faint, marginTop: 6 }}>= $521.97</div>
        </div>
      </div>
      <div style={{ marginTop: 18, padding: '16px', borderRadius: 12, textAlign: 'center', fontFamily: FUI, fontWeight: 700, fontSize: 17, color: '#fff', background: `linear-gradient(100deg, ${C.violet}, ${C.purple})`, boxShadow: `0 0 ${10 + setP * 26}px rgba(109,92,255,${0.4 + setP * 0.4})`, transform: `scale(${1 + setP * 0.02})` }}>Set TP / SL on Exchange</div>
    </div>
  );
}
function SceneSignal() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: 26, ryHold: 4, rx0: 14, rxHold: 4, y0: 120, z0: -1400, zHold: 50 });
  // signal pill flies from left into modal
  const sigP = Easing.easeOutCubic(clamp((lt - 0.5) / 0.7, 0, 1));
  const sigX = interpolate([0, 1], [-520, 0])(sigP);
  const sigFade = interpolate([0, 0.6, 1.3, 1.7, dur - 0.5, dur], [0, 1, 1, 0.0, 0, 0])(lt);
  // position card appears on right
  const posP = Easing.easeOutBack(clamp((lt - 1.75) / 0.6, 0, 1));
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={108} size={66} align="center" lines={[<span key="a">Signals become <GradText from={C.greenHi} to={C.cyan}>trades.</GradText></span>]} sub="TradingView & AI alerts → live orders on Solana, in milliseconds." maxW={1100} />
      <Stage3D style={{ perspectiveOrigin: '50% 50%' }}>
        <div style={{ position: 'absolute', left: 680, top: 360, ...fly, transformStyle: 'preserve-3d' }}>
          <TPModal lt={lt} />
        </div>
      </Stage3D>
      {/* signal pill */}
      <div style={{ position: 'absolute', left: 250, top: 470, transform: `translateX(${sigX}px)`, opacity: sigFade, display: 'flex', alignItems: 'center', gap: 14, padding: '16px 24px', borderRadius: 16, background: 'linear-gradient(100deg, rgba(34,211,153,0.16), rgba(59,130,246,0.16))', border: '1px solid rgba(52,229,168,0.45)', boxShadow: '0 0 40px rgba(52,211,153,0.35)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: `linear-gradient(150deg, ${C.green}, ${C.cyan})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="zap" size={20} color="#06131f" stroke={2.4} /></div>
        <div>
          <div style={{ fontFamily: FM, fontSize: 12, color: C.green, letterSpacing: '0.12em', fontWeight: 700 }}>TRADINGVIEW SIGNAL</div>
          <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 20, color: C.text }}>SOL · LONG · 12×</div>
        </div>
      </div>
      {/* filled position */}
      <div style={{ position: 'absolute', left: 1290, top: 470, opacity: posP * (1 - exitMain), transform: `translateX(${(1 - posP) * 40}px) scale(${0.92 + posP * 0.08})`, width: 330, padding: 22, borderRadius: 16, ...panelBase, boxShadow: '0 0 40px rgba(52,211,153,0.25)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{ width: 9, height: 9, borderRadius: 5, background: C.green, boxShadow: `0 0 10px ${C.green}` }} />
          <span style={{ fontFamily: FM, fontSize: 12, color: C.green, fontWeight: 700, letterSpacing: '0.08em' }}>ORDER FILLED</span>
        </div>
        <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 19, color: C.text }}>SOL-PERP LONG</div>
        <div style={{ fontFamily: FM, fontSize: 13, color: C.faint, marginTop: 4 }}>Size $537.78 · 12× · TP 2% / SL 1%</div>
        <div style={{ marginTop: 14, fontFamily: FM, fontWeight: 700, fontSize: 30, color: C.greenHi }}>+$57.38</div>
      </div>
    </div>
  );
}

// Scene 3 — bots that never sleep
function SceneBots() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: -26, ryHold: -6, rx0: 14, rxHold: 4, y0: 140, zHold: 55 });
  const bots = [
    ['ZEC 2H FLUX MOMENTUM', 'ZEC-PERP', '+$296.77', '+296.8%', '10×', true],
    ['NEAR 2H STRATEGY', 'NEAR-PERP', '+$47.00', '+88.7%', '8×', true],
    ['AVAX 4H FLUX MOMENTUM', 'AVAX-PERP', '+$29.23', '+58.5%', '6×', true],
    ['SOL 12H FLUX MOMENTUM', 'SOL-PERP', '+$15.20', '+12.7%', '12×', true],
    ['BTC 2H FLUX MOMENTUM', 'BTC-PERP', '-$5.08', '-5.1%', '14×', false],
  ];
  // count-up big number
  const cuP = Easing.easeOutExpo(clamp((lt - 0.7) / 1.3, 0, 1));
  const bigVal = (296.77 * cuP);
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={92} y={150} size={80} lines={[<span key="a">Bots that</span>, <span key="b"><GradText from={C.greenHi} to={C.cyan}>never sleep.</GradText></span>]} sub="Run a fleet of strategies, 24/7. Long and short, fully automated." maxW={560} />
      {/* big PnL callout */}
      <div style={{ position: 'absolute', left: 96, top: 560, opacity: clamp((lt - 0.7) / 0.4, 0, 1) * (1 - exitMain) }}>
        <div style={{ fontFamily: FUI, fontSize: 16, fontWeight: 600, color: C.faint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Top bot · realized PnL</div>
        <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 132, color: C.greenHi, letterSpacing: '-0.03em', lineHeight: 1, textShadow: '0 0 50px rgba(52,211,153,0.5)' }}>+{bigVal.toFixed(2)}<span style={{ fontSize: 60 }}>%</span></div>
      </div>
      {/* bots panel flying */}
      <Stage3D style={{ perspectiveOrigin: '70% 50%' }}>
        <div style={{ position: 'absolute', left: 1010, top: 150, ...fly, transformStyle: 'preserve-3d' }}>
          <div style={{ ...panelBase, width: 770, padding: 26, boxShadow: neon('rgba(109,92,255,0.32)', 'rgba(59,130,246,0.22)') }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
              <span style={{ fontFamily: FD, fontWeight: 600, fontSize: 26, color: C.text }}>Active Bots</span>
              <span style={{ fontFamily: FM, fontSize: 14, color: C.green, padding: '6px 12px', borderRadius: 8, background: 'rgba(52,211,153,0.12)', border: '1px solid rgba(52,211,153,0.3)' }}>● 8 running</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {bots.map((b, i) => {
                const p = Easing.easeOutCubic(clamp((lt - (0.55 + i * 0.13)) / 0.5, 0, 1));
                return <div key={i} style={{ opacity: p, transform: `translateX(${(1 - p) * 40}px)` }}><BotRow name={b[0]} market={b[1] + ' · both'} lev={b[4]} pnl={b[2]} pct={b[3]} up={b[5]} w={718} big /></div>;
              })}
            </div>
          </div>
        </div>
      </Stage3D>
    </div>
  );
}

// Scene 4 — backtest / optimize / publish
function PerfChart({ lt }) {
  const drawP = Easing.easeInOutCubic(clamp((lt - 0.55) / 1.1, 0, 1));
  const cuP = Easing.easeOutExpo(clamp((lt - 0.7) / 1.0, 0, 1));
  // path across 660 wide, 200 tall area
  const pts = [[0, 175], [70, 168], [140, 172], [210, 150], [280, 158], [350, 120], [420, 128], [490, 60], [560, 48], [620, 38], [660, 30]];
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const areaD = d + ` L660 210 L0 210 Z`;
  return (
    <div style={{ ...panelBase, width: 740, padding: 28, boxShadow: neon('rgba(109,92,255,0.3)', 'rgba(59,130,246,0.22)') }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <span style={{ fontFamily: FD, fontWeight: 600, fontSize: 24, color: C.text }}>Performance Chart</span>
        <div style={{ display: 'flex', gap: 8 }}>{['7D', '30D', '90D', 'All'].map((t, i) => <span key={t} style={{ fontFamily: FM, fontSize: 13, padding: '6px 12px', borderRadius: 8, color: i === 3 ? '#fff' : C.sub, background: i === 3 ? C.purple : 'rgba(30,32,54,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>{t}</span>)}</div>
      </div>
      <svg width="684" height="216" viewBox="0 0 684 216" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="pcArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(52,211,153,0.32)" /><stop offset="1" stopColor="rgba(52,211,153,0)" /></linearGradient>
        </defs>
        {[0, 52, 104, 156, 208].map((y) => <line key={y} x1="0" y1={y} x2="684" y2={y} stroke="rgba(150,150,200,0.08)" strokeWidth="1" />)}
        <path d={areaD} fill="url(#pcArea)" opacity={drawP} />
        <path d={d} fill="none" stroke={C.greenHi} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - drawP} style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.6))' }} />
        <circle cx={660} cy={30} r="6" fill={C.greenHi} opacity={drawP > 0.97 ? 1 : 0} style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.9))' }} />
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
        <span style={{ fontFamily: FM, fontSize: 15, color: C.sub }}>12 trades · 58% win</span>
        <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 30, color: C.greenHi }}>+{(206.44 * cuP).toFixed(2)}%</span>
      </div>
    </div>
  );
}
function MiniCard({ title, desc, icon, accent }) {
  return (
    <div style={{ ...panelBase, width: 270, padding: 22, borderRadius: 16, boxShadow: '0 16px 44px rgba(0,0,0,0.45)' }}>
      <div style={{ width: 46, height: 46, borderRadius: 12, background: `linear-gradient(150deg, ${accent}55, ${accent}22)`, border: `1px solid ${accent}66`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}><Icon name={icon} size={22} color={accent} stroke={2} /></div>
      <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 19, color: C.text }}>{title}</div>
      <div style={{ fontFamily: FUI, fontSize: 14, color: C.sub, marginTop: 6, lineHeight: 1.45 }}>{desc}</div>
    </div>
  );
}
function SceneLab() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: 22, ryHold: 0, rx0: 12, rxHold: 3, y0: 120, zHold: 40, inDur: 0.8 });
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const minis = [
    { title: 'QuantumLab', desc: 'Backtest thousands of strategy variants in seconds.', icon: 'flask-conical', accent: '#a974ff' },
    { title: 'Marketplace', desc: 'Publish a bot. Earn from every subscriber.', icon: 'store', accent: '#46c6ff' },
    { title: 'Telegram alerts', desc: 'Live fills & daily PnL, straight to your phone.', icon: 'bell', accent: '#52e5a8' },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={92} size={64} align="center" lines={[<span key="a">Backtest. Optimize. <GradText>Publish.</GradText></span>]} sub="From idea to live, income-earning strategy — all in one place." maxW={1200} />
      <Stage3D style={{ perspectiveOrigin: '50% 42%' }}>
        <div style={{ position: 'absolute', left: 590, top: 280, ...fly, transformStyle: 'preserve-3d' }}>
          <PerfChart lt={lt} />
        </div>
      </Stage3D>
      {/* mini cards fan */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 790, display: 'flex', justifyContent: 'center', gap: 26 }}>
        {minis.map((m, i) => {
          const p = Easing.easeOutBack(clamp((lt - (0.9 + i * 0.13)) / 0.55, 0, 1));
          return <div key={i} style={{ opacity: clamp(p, 0, 1) * (1 - exitMain), transform: `translateY(${(1 - p) * 40}px) scale(${0.9 + p * 0.1})` }}><MiniCard {...m} /></div>;
        })}
      </div>
    </div>
  );
}

// Scene 5 — lockup
function SceneLockup() {
  const { localTime: lt, duration: dur } = useSprite();
  const logoP = Easing.easeOutBack(clamp(lt / 0.8, 0, 1));
  const tagP = Easing.easeOutCubic(clamp((lt - 0.7) / 0.6, 0, 1));
  const solP = Easing.easeOutCubic(clamp((lt - 1.0) / 0.6, 0, 1));
  const urlP = Easing.easeOutCubic(clamp((lt - 1.4) / 0.6, 0, 1));
  const bloom = Easing.easeOutCubic(clamp(lt / 0.9, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', width: 700, height: 700, borderRadius: '50%', background: 'radial-gradient(circle, rgba(99,92,255,0.3), transparent 65%)', opacity: bloom, transform: `scale(${0.7 + bloom * 0.5})` }} />
      <div style={{ transform: `scale(${0.85 + logoP * 0.15})`, opacity: clamp(logoP, 0, 1) }}>
        <Wordmark size={64} logoSize={96} gradient glow={20} gap={22} />
      </div>
      <div style={{ marginTop: 44, display: 'flex', alignItems: 'center', gap: 26, opacity: tagP, transform: `translateY(${(1 - tagP) * 18}px)` }}>
        <div style={{ width: 90, height: 2, background: `linear-gradient(90deg, transparent, ${C.purple})` }} />
        <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 40, letterSpacing: '0.18em', color: C.text }}>BUILT FOR <GradText from={C.solGreen} to={C.solPurple}>SOLANA</GradText></span>
        <div style={{ opacity: solP, transform: `scale(${0.6 + solP * 0.4})` }}><SolanaMark w={62} /></div>
        <div style={{ width: 90, height: 2, background: `linear-gradient(90deg, ${C.blue}, transparent)` }} />
      </div>
      <div style={{ marginTop: 40, opacity: urlP, fontFamily: FM, fontSize: 22, letterSpacing: '0.16em', color: C.sub }}>myquantumvault.com</div>
      <div style={{ position: 'absolute', bottom: 42, opacity: urlP * 0.7, fontFamily: FUI, fontSize: 13, color: C.faint, letterSpacing: '0.04em' }}>Illustrative product UI. Trading involves substantial risk of loss. Not financial advice.</div>
    </div>
  );
}

/* ───────────────────────── Stage shell ───────────────────────── */
const W = 1920, H = 1080, DUR = 20;
function StageShell({ children }) {
  const [time, setTime] = React.useState(0);
  const [playing, setPlaying] = React.useState(true);
  const [scale, setScale] = React.useState(1);
  const wrapRef = React.useRef(null);
  const rafRef = React.useRef(null);
  const lastRef = React.useRef(null);
  React.useEffect(() => {
    const measure = () => {
      if (!wrapRef.current) return;
      const s = Math.min(wrapRef.current.clientWidth / W, wrapRef.current.clientHeight / H);
      setScale(Math.max(0.05, s));
    };
    measure();
    const ro = new ResizeObserver(measure); if (wrapRef.current) ro.observe(wrapRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  React.useEffect(() => {
    if (!playing) { lastRef.current = null; return; }
    const step = (ts) => {
      if (lastRef.current == null) lastRef.current = ts;
      const dt = (ts - lastRef.current) / 1000; lastRef.current = ts;
      setTime((t) => { let n = t + dt; if (n >= DUR) n = n % DUR; return n; });
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); lastRef.current = null; };
  }, [playing]);
  // Only animate while the video is on screen (saves CPU on the landing page).
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setPlaying(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const ctx = React.useMemo(() => ({ time, duration: DUR, playing, setTime, setPlaying }), [time, playing]);
  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: '#05060e', fontFamily: FUI }}>
      <div style={{ width: W, height: H, position: 'relative', transform: `scale(${scale})`, transformOrigin: 'center', flexShrink: 0, overflow: 'hidden' }}>
        <TimelineContext.Provider value={ctx}>{children}</TimelineContext.Provider>
      </div>
    </div>
  );
}

/* ───────────────────────── App ───────────────────────── */
export default function LaunchVideo() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <StageShell>
        <Background />
        <Sprite start={0.0} end={3.2}><SceneLogo /></Sprite>
        <Sprite start={3.1} end={7.0}><SceneDashboard /></Sprite>
        <Sprite start={6.9} end={10.6}><SceneSignal /></Sprite>
        <Sprite start={10.5} end={14.2}><SceneBots /></Sprite>
        <Sprite start={14.1} end={17.2}><SceneLab /></Sprite>
        <Sprite start={17.1} end={20.0}><SceneLockup /></Sprite>
      </StageShell>
    </div>
  );
}
