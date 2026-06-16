// @ts-nocheck
// QuantumLab — product sizzle. Self-contained timeline engine + scenes.
// Ported from the standalone build into the app as <QuantumLabVideo />.
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
const lerp = (a, b, t) => a + (b - a) * t;
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
  purple: '#8b5cf6', purpleHi: '#a974ff', violet: '#7c5cff',
  blue: '#3b82f6', cyan: '#46c6ff',
  green: '#34d399', greenHi: '#52e5a8', red: '#f4566e',
  solGreen: '#14F195', solPurple: '#9945FF', solTeal: '#19FB9B',
  panelBorder: 'rgba(150,130,255,0.16)',
};
const FUI = "'Plus Jakarta Sans', system-ui, sans-serif";
const FD = "'Space Grotesk', system-ui, sans-serif";
const FM = "'JetBrains Mono', ui-monospace, monospace";
const nf = (n) => n.toLocaleString('en-US');
function typed(full, lt, start, cps) { if (lt < start) return ''; return full.slice(0, Math.max(0, Math.floor((lt - start) * cps))); }

const LOGO_SRC = '/images/qv-launch-logo.webp';
function Logo({ size = 64, glow = 0.0 }) {
  return (
    <img src={LOGO_SRC} alt="QuantumVault" width={size} height={size}
      style={{ width: size, height: size, display: 'block', objectFit: 'contain', filter: glow ? `drop-shadow(0 0 ${glow}px rgba(139,92,246,0.9)) drop-shadow(0 0 ${glow * 2}px rgba(70,150,255,0.55))` : 'none' }} />
  );
}
function Wordmark({ size = 40, gap = 16, logoSize, glow = 0 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap }}>
      <Logo size={logoSize || size * 1.5} glow={glow} />
      <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: size, color: C.text, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>QuantumVault</span>
    </div>
  );
}

// ── Lucide icons (clean 2px rounded line icons, 24x24) ──
const LUCIDE = {
  'flask-conical': '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  'trending-up': '<path d="M16 7h6v6"/><path d="m22 7-8.5 8.5-5-5L2 17"/>',
  'layout-grid': '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  'shield-alert': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
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

// QuantumLab beaker mark (gradient flask) + wordmark
function LabMark({ size = 40 }) {
  const gid = React.useMemo(() => 'lab' + Math.random().toString(36).slice(2), []);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ display: 'block', filter: 'drop-shadow(0 0 10px rgba(139,92,246,0.55))' }}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={C.purpleHi} /><stop offset="1" stopColor={C.blue} /></linearGradient></defs>
      <g stroke={`url(#${gid})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: LUCIDE['flask-conical'] }} />
    </svg>
  );
}
function GradText({ children, from = C.purpleHi, to = C.cyan }) {
  return <span style={{ background: `linear-gradient(100deg, ${from}, ${to})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>{children}</span>;
}

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
      <div style={{ position: 'absolute', inset: '-20%', background: 'radial-gradient(1200px 800px at 30% 18%, rgba(80,50,180,0.30), transparent 60%), radial-gradient(1100px 760px at 82% 84%, rgba(30,90,220,0.26), transparent 62%), radial-gradient(900px 900px at 60% 50%, rgba(10,12,30,0.0), #05060e 78%)' }} />
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
      <div style={{ position: 'absolute', inset: 0, opacity: 0.5, background: 'radial-gradient(circle at 50% 50%, transparent 60%, rgba(5,6,14,0.7) 100%)' }} />
      <div style={{ position: 'absolute', inset: 0, boxShadow: 'inset 0 0 320px rgba(0,0,0,0.85)' }} />
    </div>
  );
}

/* ── kinetic headline ── */
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
function Chip({ label, active, accent = C.purple }) {
  return (
    <div style={{ fontFamily: FUI, fontWeight: active ? 700 : 600, fontSize: 16, padding: '9px 16px', borderRadius: 10,
      color: active ? '#fff' : C.sub,
      background: active ? `linear-gradient(120deg, ${accent}, ${C.violet})` : 'rgba(28,30,52,0.75)',
      border: active ? `1px solid ${accent}` : '1px solid rgba(150,130,255,0.14)',
      boxShadow: active ? `0 0 18px ${accent}66` : 'none', whiteSpace: 'nowrap' }}>{label}</div>
  );
}
function ParamCard({ name, type, value, range, w, p = 1 }) {
  return (
    <div style={{ width: w, padding: '13px 16px', borderRadius: 13, background: 'linear-gradient(180deg, rgba(28,30,54,0.6), rgba(16,18,34,0.55))', border: '1px solid rgba(150,130,255,0.14)', opacity: p, transform: `translateY(${(1 - p) * 16}px)` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: FM, fontWeight: 600, fontSize: 16, color: C.text }}>{name}</span>
          <span style={{ fontFamily: FUI, fontSize: 11, fontWeight: 700, color: C.purpleHi, padding: '2px 7px', borderRadius: 6, background: 'rgba(139,92,246,0.16)', border: '1px solid rgba(150,110,255,0.3)' }}>{type}</span>
        </div>
        <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 18, color: C.text }}>{value}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontFamily: FUI, fontSize: 13, color: C.faint }}>{range[0]}</span>
        <span style={{ fontFamily: FM, fontSize: 12, color: C.faint }}>{range[1]}</span>
      </div>
    </div>
  );
}

/* ───────────────────────── Scenes ───────────────────────── */

// Scene 0 — logo ignition → QuantumLab subtitle
function SceneLogo() {
  const { localTime: lt, duration: dur } = useSprite();
  const bloom = Easing.easeOutCubic(clamp(lt / 0.7, 0, 1));
  const ring = Easing.easeOutQuart(clamp((lt - 0.15) / 1.1, 0, 1));
  const ring2 = Easing.easeOutQuart(clamp((lt - 0.4) / 1.2, 0, 1));
  const logoScale = interpolate([0, 0.7, dur - 0.5, dur], [0.5, 1, 1.04, 1.5], [Easing.easeOutBack, Easing.easeInOutSine, Easing.easeInCubic])(lt);
  const exitP = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const wmP = Easing.easeOutCubic(clamp((lt - 0.78) / 0.6, 0, 1));
  const subP = Easing.easeOutCubic(clamp((lt - 1.25) / 0.6, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', width: 520, height: 520, borderRadius: '50%', border: '2px solid rgba(150,110,255,0.5)', transform: `translateY(-58px) scale(${0.3 + ring * 1.6})`, opacity: (1 - ring) * 0.8 }} />
      <div style={{ position: 'absolute', width: 520, height: 520, borderRadius: '50%', border: '1.5px solid rgba(70,160,255,0.4)', transform: `translateY(-58px) scale(${0.3 + ring2 * 2.1})`, opacity: (1 - ring2) * 0.6 }} />
      <div style={{ position: 'absolute', width: 360, height: 360, borderRadius: '50%', background: 'radial-gradient(circle, rgba(120,80,255,0.45), transparent 68%)', opacity: bloom * (1 - exitP * 0.7), transform: `translateY(-58px) scale(${0.8 + bloom * 0.5})` }} />
      <div style={{ transform: `scale(${logoScale})`, opacity: 1 - exitP }}>
        <Logo size={146} glow={28} />
      </div>
      <div style={{ marginTop: 30, overflow: 'hidden', height: 74, opacity: 1 - exitP }}>
        <div style={{ transform: `translateY(${(1 - wmP) * 80}px)`, opacity: wmP, fontFamily: FUI, fontWeight: 700, fontSize: 60, color: C.text, letterSpacing: '-0.025em' }}>QuantumVault</div>
      </div>
      <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 13, opacity: subP * (1 - exitP), transform: `translateY(${(1 - subP) * 14}px)` }}>
        <LabMark size={28} />
        <span style={{ fontFamily: FM, fontSize: 19, letterSpacing: '0.32em', color: C.sub, paddingLeft: '0.32em' }}><GradText from={C.purpleHi} to={C.cyan}>QUANTUMLAB</GradText> · STRATEGY BACKTESTING</span>
      </div>
    </div>
  );
}

// Scene 1 — "Test before you trade." — Setup & Run config
function ConfigPanel({ lt }) {
  const params = [
    { name: 'swingLookback', type: 'int', value: '5', range: ['Swing Lookback', '3 – 12'] },
    { name: 'rsiLen', type: 'int', value: '14', range: ['RSI Length', '7 – 21'] },
    { name: 'emaLen', type: 'int', value: '50', range: ['EMA Length', '30 – 100'] },
    { name: 'sweepBufferPct', type: 'float', value: '0.1', range: ['Sweep Buffer %', '0.02 – 0.5'] },
    { name: 'atrLen', type: 'int', value: '14', range: ['ATR Length', '7 – 21'] },
    { name: 'atrStopMult', type: 'float', value: '1.0', range: ['ATR Stop Mult', '0.5 – 2.5'] },
  ];
  const sweepP = Easing.easeOutCubic(clamp((lt - 1.9) / 0.6, 0, 1));
  return (
    <div style={{ ...panelBase, width: 1480, height: 720, boxShadow: neon('rgba(139,92,246,0.32)', 'rgba(59,130,246,0.22)'), overflow: 'hidden', display: 'flex' }}>
      {/* left — strategy + parsed params */}
      <div style={{ flex: 1.45, padding: '26px 28px', borderRight: '1px solid rgba(150,130,255,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 20 }}>
          <div style={{ width: 42, height: 42, borderRadius: 11, background: 'linear-gradient(150deg, rgba(139,92,246,0.4), rgba(59,130,246,0.25))', border: '1px solid rgba(150,130,255,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="code" size={20} color={C.purpleHi} /></div>
          <div>
            <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 26, color: C.text }}>Stop-Run Reversal v2</div>
            <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginTop: 2 }}>15 optimizable params · Pine v6</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <Icon name="sliders" size={17} color={C.sub} />
          <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 18, color: C.text }}>Parsed Parameters</span>
          <span style={{ fontFamily: FM, fontSize: 12, fontWeight: 700, color: C.cyan, padding: '4px 10px', borderRadius: 7, background: 'rgba(70,198,255,0.12)', border: '1px solid rgba(70,198,255,0.3)', marginLeft: 'auto' }}>15 optimizable</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {params.map((pm, i) => {
            const p = Easing.easeOutCubic(clamp((lt - (1.0 + i * 0.1)) / 0.45, 0, 1));
            return <ParamCard key={i} {...pm} w={420} p={p} />;
          })}
        </div>
      </div>
      {/* right — run configuration */}
      <div style={{ flex: 1, padding: '26px 26px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Icon name="activity" size={18} color={C.purpleHi} />
          <span style={{ fontFamily: FD, fontWeight: 600, fontSize: 21, color: C.text }}>Run Configuration</span>
        </div>
        <div style={{ fontFamily: FUI, fontSize: 12.5, fontWeight: 700, letterSpacing: '0.08em', color: C.faint, marginBottom: 10 }}>MARKETS</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginBottom: 18 }}>
          {[['SOL', 1], ['BTC', 0], ['ETH', 0], ['AVAX', 0], ['SUI', 0], ['ARB', 1], ['INJ', 0], ['NEAR', 0]].map(([m, a], i) => {
            const p = clamp((lt - (0.7 + i * 0.04)) / 0.3, 0, 1);
            return <div key={m} style={{ opacity: p, transform: `scale(${0.8 + p * 0.2})` }}><Chip label={m} active={!!a} /></div>;
          })}
        </div>
        <div style={{ fontFamily: FUI, fontSize: 12.5, fontWeight: 700, letterSpacing: '0.08em', color: C.faint, marginBottom: 10 }}>TIMEFRAMES</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginBottom: 18 }}>
          {[['1m', 0], ['15m', 0], ['1h', 0], ['2h', 1], ['4h', 1], ['12h', 0]].map(([m, a], i) => {
            const p = clamp((lt - (0.95 + i * 0.04)) / 0.3, 0, 1);
            return <div key={m} style={{ opacity: p, transform: `scale(${0.8 + p * 0.2})` }}><Chip label={m} active={!!a} accent={C.blue} /></div>;
          })}
        </div>
        <div style={{ fontFamily: FUI, fontSize: 12.5, fontWeight: 700, letterSpacing: '0.08em', color: C.faint, marginBottom: 10 }}>BACKTEST PERIOD</div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 'auto' }}>
          {['01 / 01 / 2023', '13 / 06 / 2026'].map((d, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderRadius: 11, background: 'rgba(15,16,30,0.8)', border: '1px solid rgba(150,130,255,0.16)' }}>
              <Icon name="calendar" size={15} color={C.faint} />
              <span style={{ fontFamily: FM, fontSize: 16, color: C.text }}>{d}</span>
            </div>
          ))}
        </div>
        <div style={{ padding: '14px 16px', borderRadius: 13, background: 'rgba(15,16,30,0.6)', border: '1px solid rgba(150,130,255,0.12)', margin: '16px 0', textAlign: 'center' }}>
          <div style={{ fontFamily: FUI, fontSize: 14, color: C.sub }}>2 markets × 2 timeframes = <span style={{ color: C.text, fontWeight: 700 }}>4 combos</span></div>
          <div style={{ fontFamily: FM, fontSize: 13, color: C.faint, marginTop: 5 }}>Search space: <span style={{ color: C.cyan }}>25T</span> · Optimizer tests <span style={{ color: C.purpleHi }}>15K</span> samples</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '17px', borderRadius: 13, fontFamily: FUI, fontWeight: 700, fontSize: 19, color: '#fff', background: `linear-gradient(100deg, ${C.violet}, ${C.purple})`, boxShadow: `0 0 ${14 + sweepP * 30}px rgba(139,92,246,${0.4 + sweepP * 0.45})`, transform: `scale(${1 + sweepP * 0.02})` }}>
          <Icon name="zap" size={20} color="#fff" /> Full Sweep
        </div>
      </div>
    </div>
  );
}
function SceneConfig() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: -28, ryHold: 0, rx0: 15, rxHold: 4, y0: 150, zHold: 40, inDur: 0.85 });
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={62} size={70} align="center" lines={[<span key="a">Test before you <GradText>trade.</GradText></span>]} sub="Load a strategy, pick markets & timeframes, set the period — then sweep." maxW={1300} />
      <Stage3D style={{ perspectiveOrigin: '50% 44%' }}>
        <div style={{ position: 'absolute', left: 220, top: 282, ...fly, transformStyle: 'preserve-3d' }}>
          <ConfigPanel lt={lt} />
        </div>
      </Stage3D>
    </div>
  );
}

// Scene 2 — "Thousands of variants, in seconds." — Optimization Heatmap
const HEAT_COLS = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h'];
const HEAT_ROWS = ['AVAX', 'BERA', 'SOL', 'SUI', 'APT', 'OP', 'TON', 'SEI', 'ARB', 'BTC', 'DOGE'];
// [row, col] -> { p: profit%, lev, cfgs }
const HEAT = {
  'AVAX|15m': { p: 1533, lev: 4, cfgs: 20 }, 'AVAX|30m': { p: 1983, lev: 5, cfgs: 7 }, 'AVAX|1h': { p: 2283, lev: 8, cfgs: 45 }, 'AVAX|2h': { p: 2516, lev: 5, cfgs: 22 }, 'AVAX|4h': { p: 2321, lev: 6, cfgs: 20 }, 'AVAX|12h': { p: 522, lev: 9, cfgs: 4 },
  'BERA|30m': { p: 1795, lev: 5, cfgs: 9 }, 'BERA|1h': { p: 1581, lev: 5, cfgs: 18 },
  'SOL|1m': { p: 717, lev: 18, cfgs: 23 }, 'SOL|5m': { p: 1046, lev: 1, cfgs: 22 }, 'SOL|15m': { p: 1083, lev: 1, cfgs: 10 }, 'SOL|30m': { p: 944, lev: 1, cfgs: 11 }, 'SOL|1h': { p: 1675, lev: 4, cfgs: 18 }, 'SOL|2h': { p: 6215, lev: 13, cfgs: 130, best: true }, 'SOL|4h': { p: 2297, lev: 4, cfgs: 30 }, 'SOL|8h': { p: 965, lev: 7, cfgs: 10 }, 'SOL|12h': { p: 3091, lev: 10, cfgs: 43 },
  'SUI|30m': { p: 938, lev: 1, cfgs: 9 }, 'SUI|1h': { p: 1408, lev: 2, cfgs: 19 }, 'SUI|2h': { p: 939, lev: 3, cfgs: 10 }, 'SUI|4h': { p: 1416, lev: 3, cfgs: 10 }, 'SUI|12h': { p: 1888, lev: 3, cfgs: 10 },
  'APT|30m': { p: 835, lev: 3, cfgs: 10 }, 'APT|1h': { p: 1237, lev: 3, cfgs: 13 },
  'OP|30m': { p: 801, lev: 3, cfgs: 10 }, 'OP|1h': { p: 732, lev: 3, cfgs: 20 },
  'TON|30m': { p: 463, lev: 2, cfgs: 10 }, 'TON|1h': { p: 1172, lev: 3, cfgs: 19 },
  'SEI|30m': { p: 348, lev: 5, cfgs: 9 }, 'SEI|1h': { p: 383, lev: 5, cfgs: 17 },
  'ARB|1h': { p: 908, lev: 4, cfgs: 10 }, 'ARB|2h': { p: 582, lev: 4, cfgs: 6 }, 'ARB|4h': { p: 1505, lev: 7, cfgs: 18 }, 'ARB|12h': { p: 1999, lev: 10, cfgs: 10 },
  'BTC|4h': { p: 2023, lev: 9, cfgs: 11 },
  'DOGE|4h': { p: 780, lev: 2, cfgs: 8 },
};
function heatColor(p) {
  const t = clamp((p - 350) / 3000, 0, 1);
  const stops = [[126, 58, 196], [108, 66, 220], [70, 104, 222], [52, 150, 224], [70, 198, 255]];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const c = stops[i].map((v, k) => Math.round(lerp(v, stops[i + 1][k], f)));
  return c;
}
function HeatmapPanel({ lt }) {
  const cellW = 120, cellH = 56, gap = 6, labelW = 50;
  const startPop = 0.95;
  const colDelay = 0.16, rowDelay = 0.018, cellDur = 0.42;
  return (
    <div style={{ ...panelBase, width: 1248, padding: '24px 26px 22px', boxShadow: neon('rgba(139,92,246,0.32)', 'rgba(70,160,255,0.24)') }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Icon name="layout-grid" size={22} color={C.purpleHi} />
          <div>
            <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 23, color: C.text }}>Optimization Heatmap</div>
            <div style={{ fontFamily: FUI, fontSize: 13, color: C.faint, marginTop: 1 }}>119 completed runs · 56 ticker/timeframe combos</div>
          </div>
        </div>
        <div style={{ fontFamily: FM, fontSize: 13, color: C.sub, padding: '8px 14px', borderRadius: 9, background: 'rgba(30,32,54,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>Best Profit %</div>
      </div>
      {/* grid */}
      <div style={{ position: 'relative' }}>
        {/* header row */}
        <div style={{ display: 'flex', gap, marginBottom: gap, paddingLeft: labelW }}>
          {HEAT_COLS.map((c) => <div key={c} style={{ width: cellW, textAlign: 'center', fontFamily: FM, fontSize: 14, fontWeight: 600, color: c === '2h' ? C.cyan : C.faint }}>{c}</div>)}
        </div>
        {HEAT_ROWS.map((r, ri) => (
          <div key={r} style={{ display: 'flex', gap, marginBottom: gap, alignItems: 'center' }}>
            <div style={{ width: labelW, fontFamily: FUI, fontSize: 14, fontWeight: 700, color: C.sub }}>{r}</div>
            {HEAT_COLS.map((c, ci) => {
              const cell = HEAT[`${r}|${c}`];
              const appear = startPop + ci * colDelay + ri * rowDelay;
              const p = Easing.easeOutCubic(clamp((lt - appear) / cellDur, 0, 1));
              if (!cell) {
                return <div key={c} style={{ width: cellW, height: cellH, borderRadius: 10, background: 'rgba(255,255,255,0.018)', border: '1px solid rgba(150,130,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5 + p * 0.5 }}><span style={{ color: 'rgba(140,140,180,0.35)', fontFamily: FM, fontSize: 14 }}>—</span></div>;
              }
              const [cr, cg, cb] = heatColor(cell.p);
              const best = cell.best;
              const bestPulse = best ? (0.5 + 0.5 * Math.sin((lt - 3.0) * 4)) * clamp((lt - 2.9) / 0.4, 0, 1) : 0;
              return (
                <div key={c} style={{
                  width: cellW, height: cellH, borderRadius: 10, padding: '6px 9px',
                  background: `linear-gradient(150deg, rgba(${cr},${cg},${cb},${0.5 + (best ? 0.4 : 0)}), rgba(${cr},${cg},${cb},${0.22 + (best ? 0.25 : 0)}))`,
                  border: best ? `1.5px solid ${C.cyan}` : `1px solid rgba(${cr},${cg},${cb},0.55)`,
                  boxShadow: best ? `0 0 ${20 + bestPulse * 26}px rgba(70,198,255,${0.5 + bestPulse * 0.4})` : 'none',
                  opacity: p, transform: `scale(${0.82 + p * 0.18})`, overflow: 'hidden',
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                }}>
                  <div style={{ fontFamily: FM, fontWeight: 700, fontSize: best ? 18 : 16, color: '#fff', lineHeight: 1 }}>+{nf(cell.p)}%</div>
                  <div style={{ fontFamily: FM, fontSize: 11, color: 'rgba(255,255,255,0.72)', marginTop: 3 }}>@{cell.lev}× · {cell.cfgs} cfgs</div>
                </div>
              );
            })}
          </div>
        ))}
        {/* scan line sweeping with population */}
        {(() => {
          const total = labelW + HEAT_COLS.length * (cellW + gap);
          const scanP = clamp((lt - startPop) / (HEAT_COLS.length * colDelay + 0.4), 0, 1);
          const x = labelW + scanP * (HEAT_COLS.length * (cellW + gap));
          const vis = scanP > 0.01 && scanP < 0.99 ? 1 : 0;
          return <div style={{ position: 'absolute', top: 30, bottom: 0, left: x, width: 3, background: `linear-gradient(180deg, transparent, ${C.cyan}, transparent)`, boxShadow: `0 0 18px ${C.cyan}`, opacity: vis * 0.9 }} />;
        })()}
      </div>
    </div>
  );
}
function SceneHeatmap() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: 22, ryHold: 0, rx0: 13, rxHold: 3, y0: 130, zHold: 30, inDur: 0.8 });
  // sample counter
  const samples = Math.round(interpolate([0.95, 3.2], [0, 15000], Easing.easeOutCubic)(lt));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={84} y={70} size={58} lines={[<span key="a">Thousands of</span>, <span key="b">variants,</span>, <span key="c"><GradText>in seconds.</GradText></span>]} sub="Sweep every parameter combo. The optimizer surfaces what actually holds up." maxW={470} />
      {/* live sweep counter */}
      <div style={{ position: 'absolute', left: 88, top: 470, opacity: clamp((lt - 0.9) / 0.4, 0, 1) }}>
        <div style={{ fontFamily: FUI, fontSize: 15, fontWeight: 600, color: C.faint, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Samples evaluated</div>
        <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 88, color: C.cyan, letterSpacing: '-0.02em', lineHeight: 1, textShadow: '0 0 44px rgba(70,198,255,0.5)' }}>{nf(samples)}</div>
        <div style={{ display: 'flex', gap: 24, marginTop: 18 }}>
          <div><div style={{ fontFamily: FM, fontWeight: 700, fontSize: 28, color: C.purpleHi }}>25T</div><div style={{ fontFamily: FUI, fontSize: 13, color: C.faint }}>search space</div></div>
          <div><div style={{ fontFamily: FM, fontWeight: 700, fontSize: 28, color: C.text }}>119</div><div style={{ fontFamily: FUI, fontSize: 13, color: C.faint }}>runs</div></div>
        </div>
      </div>
      <Stage3D style={{ perspectiveOrigin: '60% 48%' }}>
        <div style={{ position: 'absolute', left: 648, top: 130, ...fly, transformStyle: 'preserve-3d' }}>
          <HeatmapPanel lt={lt} />
        </div>
      </Stage3D>
    </div>
  );
}

// Scene 3 — "See every outcome." — equity chart + insights count-up
function EquityPanel({ lt }) {
  const drawP = Easing.easeInOutCubic(clamp((lt - 0.6) / 1.3, 0, 1));
  const pts = [[0, 196], [55, 188], [110, 192], [165, 170], [215, 178], [270, 150], [325, 156], [380, 118], [430, 126], [490, 72], [545, 80], [600, 44], [650, 30], [684, 22]];
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const areaD = d + ` L684 230 L0 230 Z`;
  return (
    <div style={{ ...panelBase, width: 760, padding: 28, boxShadow: neon('rgba(52,211,153,0.26)', 'rgba(59,130,246,0.2)') }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontFamily: FD, fontWeight: 600, fontSize: 23, color: C.text }}>Equity Curve · SOL 2h</span>
        <div style={{ display: 'flex', gap: 8 }}>{['1Y', '2Y', 'All'].map((t, i) => <span key={t} style={{ fontFamily: FM, fontSize: 13, padding: '6px 12px', borderRadius: 8, color: i === 2 ? '#fff' : C.sub, background: i === 2 ? C.green : 'rgba(30,32,54,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>{t}</span>)}</div>
      </div>
      <svg width="704" height="236" viewBox="0 0 704 236" style={{ display: 'block', overflow: 'visible' }}>
        <defs><linearGradient id="eqArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(52,211,153,0.34)" /><stop offset="1" stopColor="rgba(52,211,153,0)" /></linearGradient></defs>
        {[0, 57, 114, 171, 228].map((y) => <line key={y} x1="0" y1={y} x2="704" y2={y} stroke="rgba(150,150,200,0.08)" strokeWidth="1" />)}
        <path d={areaD} fill="url(#eqArea)" opacity={drawP} />
        <path d={d} fill="none" stroke={C.greenHi} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - drawP} style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.6))' }} />
        <circle cx={684} cy={22} r="6" fill={C.greenHi} opacity={drawP > 0.96 ? 1 : 0} style={{ filter: 'drop-shadow(0 0 8px rgba(52,211,153,0.9))' }} />
      </svg>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <span style={{ fontFamily: FM, fontSize: 15, color: C.sub }}>93 trades · 19.9% max DD</span>
        <span style={{ fontFamily: FM, fontWeight: 700, fontSize: 26, color: C.greenHi }}>net +617.3%</span>
      </div>
    </div>
  );
}
function InsightsPanel({ lt }) {
  const rows = [
    ['1', 'SOL', '2h', '+2469.1%', '59.1%', '3.70', '4×', true],
    ['2', 'SOL', '4h', '+2297.4%', '38.9%', '3.39', '4×', false],
    ['3', 'BTC', '4h', '+2022.6%', '57.1%', '10.33', '9×', false],
    ['4', 'ARB', '4h', '+1505.1%', '76.3%', '4.59', '7×', false],
    ['5', 'AVAX', '4h', '+1462.9%', '45.9%', '3.24', '3×', false],
  ];
  return (
    <div style={{ ...panelBase, width: 720, padding: 26, boxShadow: neon('rgba(139,92,246,0.28)', 'rgba(59,130,246,0.2)') }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 16 }}>
        <Icon name="trophy" size={20} color="#f5c542" />
        <span style={{ fontFamily: FD, fontWeight: 600, fontSize: 22, color: C.text }}>Best per Ticker / Timeframe</span>
      </div>
      <div style={{ display: 'flex', fontFamily: FUI, fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', color: C.faint, padding: '0 8px 10px' }}>
        <span style={{ width: 30 }}>#</span><span style={{ width: 78 }}>TICKER</span><span style={{ width: 50 }}>TF</span><span style={{ flex: 1 }}>LEV. PROFIT</span><span style={{ width: 86 }}>WIN</span><span style={{ width: 64 }}>PF</span><span style={{ width: 50, textAlign: 'right' }}>LEV</span>
      </div>
      {rows.map((r, i) => {
        const p = Easing.easeOutCubic(clamp((lt - (0.7 + i * 0.13)) / 0.5, 0, 1));
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', fontFamily: FM, fontSize: 16, padding: '12px 8px', borderRadius: 11, marginTop: 5,
            background: r[7] ? 'linear-gradient(90deg, rgba(52,211,153,0.14), rgba(52,211,153,0.03))' : (i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent'),
            border: r[7] ? '1px solid rgba(52,229,168,0.4)' : '1px solid transparent',
            opacity: p, transform: `translateX(${(1 - p) * 26}px)` }}>
            <span style={{ width: 30, color: r[7] ? C.greenHi : C.faint, fontWeight: 700 }}>{r[0]}</span>
            <span style={{ width: 78, color: C.text, fontWeight: 700 }}>{r[1]}</span>
            <span style={{ width: 50, color: C.cyan }}>{r[2]}</span>
            <span style={{ flex: 1, color: r[7] ? C.greenHi : C.cyan, fontWeight: 700 }}>{r[3]}</span>
            <span style={{ width: 86, color: C.text }}>{r[4]}</span>
            <span style={{ width: 64, color: C.sub }}>{r[5]}</span>
            <span style={{ width: 50, textAlign: 'right', color: C.purpleHi, fontWeight: 700 }}>{r[6]}</span>
          </div>
        );
      })}
    </div>
  );
}
function SceneOutcome() {
  const { localTime: lt, duration: dur } = useSprite();
  const flyEq = flyStyle(lt, dur, { ry0: -24, ryHold: -3, rx0: 12, rxHold: 3, y0: 120, zHold: 30, inDur: 0.8 });
  const flyIn = flyStyle(lt, dur, { ry0: 24, ryHold: 3, rx0: 12, rxHold: 3, y0: 150, zHold: 30, inDur: 0.85 });
  const cuP = Easing.easeOutExpo(clamp((lt - 0.7) / 1.5, 0, 1));
  const winP = Easing.easeOutExpo(clamp((lt - 1.0) / 1.3, 0, 1));
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={56} size={64} align="center" lines={[<span key="a">See every <GradText from={C.greenHi} to={C.cyan}>outcome.</GradText></span>]} sub="Equity curve, win rate, drawdown, profit factor — the full picture, ranked." maxW={1200} />
      <Stage3D style={{ perspectiveOrigin: '32% 50%' }}>
        <div style={{ position: 'absolute', left: 110, top: 300, ...flyEq, transformStyle: 'preserve-3d' }}><EquityPanel lt={lt} /></div>
      </Stage3D>
      <Stage3D style={{ perspectiveOrigin: '70% 50%' }}>
        <div style={{ position: 'absolute', left: 1090, top: 296, ...flyIn, transformStyle: 'preserve-3d' }}><InsightsPanel lt={lt} /></div>
      </Stage3D>
      {/* big count-up callout */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 70, display: 'flex', justifyContent: 'center', gap: 70, alignItems: 'flex-end', opacity: clamp((lt - 0.7) / 0.4, 0, 1) * (1 - exitMain) }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: FUI, fontSize: 15, fontWeight: 600, color: C.faint, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Top leveraged profit</div>
          <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 96, color: C.greenHi, letterSpacing: '-0.03em', lineHeight: 1, textShadow: '0 0 50px rgba(52,211,153,0.5)' }}>+{(2469.1 * cuP).toFixed(1)}<span style={{ fontSize: 48 }}>%</span></div>
        </div>
        <div style={{ display: 'flex', gap: 44, paddingBottom: 14 }}>
          {[['Win rate', `${(59.1 * winP).toFixed(1)}%`, C.text, 'target'], ['Profit factor', `${(3.70 * winP).toFixed(2)}`, C.cyan, 'gauge'], ['Trades', `${Math.round(93 * winP)}`, C.purpleHi, 'activity']].map((s, i) => (
            <div key={i} style={{ textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'center', marginBottom: 6 }}><Icon name={s[3]} size={15} color={C.faint} /><span style={{ fontFamily: FUI, fontSize: 14, color: C.faint }}>{s[0]}</span></div>
              <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 44, color: s[2], lineHeight: 1 }}>{s[1]}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Scene 4 — "Go live in one click." — deploy morph
function SceneDeploy() {
  const { localTime: lt, duration: dur } = useSprite();
  const cardP = Easing.easeOutBack(clamp((lt - 0.3) / 0.7, 0, 1));
  const deployP = Easing.easeInOutCubic(clamp((lt - 1.7) / 0.7, 0, 1));
  const ctaPulse = 0.5 + 0.5 * Math.sin(lt * 5);
  const liveP = Easing.easeOutBack(clamp((lt - 2.0) / 0.7, 0, 1));
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.45)) / 0.45, 0, 1));
  const burst = clamp((lt - 2.0) / 0.5, 0, 1);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={92} size={70} align="center" lines={[<span key="a">And you're <GradText from={C.greenHi} to={C.cyan}>live.</GradText></span>]} sub="The winning strategy runs as an automated bot — executing on Solana, 24/7." maxW={1200} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 330, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 1 - exitMain }}>
        {/* winning strategy card — shrinks/rises as deploy completes */}
        <div style={{ width: 720, ...panelBase, padding: 28, boxShadow: neon('rgba(52,211,153,0.3)', 'rgba(139,92,246,0.22)'),
          opacity: clamp(cardP, 0, 1) * (1 - deployP * 0.55), transform: `translateY(${(1 - cardP) * 40 - deployP * 36}px) scale(${(0.9 + cardP * 0.1) * (1 - deployP * 0.06)})` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontFamily: FM, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', color: C.greenHi, padding: '5px 11px', borderRadius: 7, background: 'rgba(52,211,153,0.13)', border: '1px solid rgba(52,229,168,0.35)' }}>★ BEST STRATEGY</span>
            <span style={{ fontFamily: FUI, fontSize: 15, color: C.faint }}>119 runs ranked</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 30, color: C.text }}>Stop-Run Reversal v2</div>
              <div style={{ fontFamily: FM, fontSize: 16, color: C.sub, marginTop: 6 }}>SOL · 2h · 4× leverage · 59.1% win</div>
            </div>
            <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 46, color: C.greenHi, textShadow: '0 0 30px rgba(52,211,153,0.4)' }}>+2469.1%</div>
          </div>
        </div>

        {/* Deploy CTA — fades into the live bot row */}
        <div style={{ position: 'relative', marginTop: 30, height: 92, width: 720, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* CTA button */}
          <div style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 13, padding: '18px 34px', borderRadius: 15, fontFamily: FUI, fontWeight: 700, fontSize: 22, color: '#fff',
            background: `linear-gradient(100deg, ${C.violet}, ${C.purple})`,
            boxShadow: `0 0 ${20 + ctaPulse * 34}px rgba(139,92,246,${0.45 + ctaPulse * 0.4})`,
            opacity: clamp(cardP, 0, 1) * (1 - deployP), transform: `scale(${(0.9 + cardP * 0.1) * (1 + ctaPulse * 0.02 - deployP * 0.1)})` }}>
            <Icon name="rocket" size={24} color="#fff" /> Deploy to live
          </div>
          {/* live bot row */}
          <div style={{ position: 'absolute', width: 720, display: 'flex', alignItems: 'center', gap: 16, padding: '18px 22px', borderRadius: 15,
            background: 'linear-gradient(180deg, rgba(28,40,40,0.85), rgba(14,22,22,0.85))', border: '1px solid rgba(52,229,168,0.45)',
            boxShadow: `0 0 ${30 + burst * 40}px rgba(52,211,153,${0.3 + burst * 0.3})`,
            opacity: clamp(liveP, 0, 1), transform: `translateY(${(1 - liveP) * 26}px) scale(${0.94 + clamp(liveP, 0, 1) * 0.06})` }}>
            <div style={{ width: 46, height: 46, borderRadius: 12, background: 'linear-gradient(150deg, rgba(52,211,153,0.4), rgba(70,198,255,0.25))', border: '1px solid rgba(52,229,168,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name="bot" size={23} color={C.greenHi} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 19, color: C.text }}>SOL 2H · STOP-RUN REVERSAL v2</span>
                <span style={{ fontFamily: FM, fontSize: 12, fontWeight: 700, color: C.green, padding: '3px 9px', borderRadius: 6, background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,229,168,0.4)' }}>4×</span>
              </div>
              <div style={{ fontFamily: FM, fontSize: 13, color: C.faint, marginTop: 4 }}>SOL-PERP · auto-executing on Solana</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 9, height: 9, borderRadius: 5, background: C.green, boxShadow: `0 0 ${8 + ctaPulse * 8}px ${C.green}` }} />
              <span style={{ fontFamily: FM, fontSize: 14, fontWeight: 700, color: C.greenHi, letterSpacing: '0.08em' }}>LIVE</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Scene A — "Meet your Lab Assistant." — AI orchestrator (the big new thing)
function AssistantPanel({ lt }) {
  const greet = "Hi — I'm your Lab Assistant. I can help you find your way around QuantumLab: drafting strategies, running backtests, reading your results, and understanding why a strategy wins or loses. What would you like to do?";
  const shown = typed(greet, lt, 0.6, 70);
  const typing = lt > 0.6 && shown.length < greet.length;
  const caret = typing && Math.sin(lt * 16) > 0;
  const doneAt = 0.6 + greet.length / 70;
  const chipsP = Easing.easeOutCubic(clamp((lt - (doneAt + 0.15)) / 0.5, 0, 1));
  const chips = ['Open the Creator', 'Open Backtest Setup', 'See my results', 'Why is my strategy losing?'];
  return (
    <div style={{ ...panelBase, width: 680, height: 588, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: neon('rgba(139,92,246,0.36)', 'rgba(59,130,246,0.24)') }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '22px 26px', borderBottom: '1px solid rgba(150,130,255,0.12)' }}>
        <div style={{ width: 46, height: 46, borderRadius: 13, background: 'linear-gradient(150deg, rgba(139,92,246,0.9), rgba(59,130,246,0.7))', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 22px rgba(139,92,246,0.6)' }}><Icon name="sparkles" size={23} color="#fff" /></div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 22, color: C.text }}>Lab Assistant</div>
          <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginTop: 1 }}>Guides you around QuantumLab</div>
        </div>
        <div style={{ color: C.faint, fontSize: 22 }}>×</div>
      </div>
      <div style={{ flex: 1, padding: '24px 26px' }}>
        <div style={{ background: 'rgba(30,33,58,0.7)', border: '1px solid rgba(150,130,255,0.14)', borderRadius: 16, padding: '18px 20px', maxWidth: 540 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
            <Icon name="bot" size={15} color={C.purpleHi} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 13, letterSpacing: '0.08em', color: C.purpleHi }}>ASSISTANT</span>
          </div>
          <div style={{ fontFamily: FUI, fontSize: 20, lineHeight: 1.5, color: C.text }}>
            {shown}<span style={{ opacity: caret ? 1 : 0, color: C.purpleHi }}>▌</span>
          </div>
        </div>
      </div>
      <div style={{ padding: '0 26px 16px', display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {chips.map((ch, i) => {
          const p = Easing.easeOutBack(clamp((chipsP * 4 - i) , 0, 1));
          return <div key={ch} style={{ fontFamily: FUI, fontWeight: 600, fontSize: 15.5, padding: '10px 16px', borderRadius: 11, color: C.purpleHi, background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(150,110,255,0.32)', opacity: clamp(p, 0, 1), transform: `translateY(${(1 - p) * 12}px) scale(${0.9 + clamp(p, 0, 1) * 0.1})` }}>{ch}</div>;
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 26px', borderTop: '1px solid rgba(150,130,255,0.12)' }}>
        <div style={{ flex: 1, padding: '14px 18px', borderRadius: 13, background: 'rgba(15,16,30,0.8)', border: '1px solid rgba(150,130,255,0.16)', fontFamily: FUI, fontSize: 16, color: C.faint }}>Ask the assistant…</div>
        <div style={{ width: 50, height: 50, borderRadius: 13, background: `linear-gradient(120deg, ${C.violet}, ${C.purple})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 18px rgba(139,92,246,0.5)' }}><Icon name="arrow-right" size={22} color="#fff" /></div>
      </div>
    </div>
  );
}
function SceneAssistant() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: -26, ryHold: 3, rx0: 12, rxHold: 3, y0: 150, zHold: 30, inDur: 0.85 });
  const pillars = [
    { icon: 'sparkles', label: 'Create', desc: 'Draft a strategy from one sentence' },
    { icon: 'layout-grid', label: 'Test', desc: 'Sweep thousands of param combos' },
    { icon: 'gauge', label: 'Refine', desc: 'Read results, cut what overfits' },
    { icon: 'rocket', label: 'Deploy', desc: 'Ship a live bot on Solana' },
  ];
  const pStart = 1.3, pGap = 0.85;
  const railFill = clamp((lt - pStart) / (pGap * pillars.length), 0, 1);
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={52} size={62} align="center" lines={[<span key="a">Meet your <GradText>Lab Assistant.</GradText></span>]} sub="One assistant runs the whole lab — from a plain-English idea to a live bot on Solana." maxW={1320} />
      <Stage3D style={{ perspectiveOrigin: '32% 54%' }}>
        <div style={{ position: 'absolute', left: 132, top: 322, ...fly, transformStyle: 'preserve-3d' }}><AssistantPanel lt={lt} /></div>
      </Stage3D>
      {/* orchestration rail */}
      <div style={{ position: 'absolute', left: 900, top: 320, width: 880, opacity: clamp((lt - 0.9) / 0.5, 0, 1) }}>
        <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 21, color: C.text, marginBottom: 6, letterSpacing: '-0.01em' }}>It runs <GradText from={C.purpleHi} to={C.cyan}>the whole lab</GradText></div>
        <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint, marginBottom: 22 }}>Create. Test. Refine. Deploy — orchestrated end to end.</div>
        <div style={{ position: 'relative', paddingLeft: 34 }}>
          {/* vertical rail */}
          <div style={{ position: 'absolute', left: 13, top: 30, bottom: 30, width: 3, background: 'rgba(150,130,255,0.14)', borderRadius: 2 }} />
          <div style={{ position: 'absolute', left: 13, top: 30, width: 3, height: `calc((100% - 60px) * ${railFill})`, background: `linear-gradient(180deg, ${C.purpleHi}, ${C.cyan})`, borderRadius: 2, boxShadow: `0 0 14px ${C.purple}` }} />
          {pillars.map((pl, i) => {
            const a = Easing.easeOutBack(clamp((lt - (pStart + i * pGap)) / 0.6, 0, 1));
            const on = lt > pStart + i * pGap + 0.1;
            return (
              <div key={pl.label} style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: i < 3 ? 18 : 0, opacity: clamp(0.35 + a * 0.65, 0, 1), transform: `translateX(${(1 - clamp(a, 0, 1)) * 24}px)` }}>
                <div style={{ position: 'absolute', left: 0, width: 28, height: 28, borderRadius: 14, background: on ? `linear-gradient(140deg, ${C.purpleHi}, ${C.blue})` : 'rgba(40,42,66,0.9)', border: on ? 'none' : '1px solid rgba(150,130,255,0.2)', boxShadow: on ? `0 0 16px ${C.purple}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', marginLeft: 0 }}>
                  {on && <Icon name="circle-check" size={17} color="#fff" />}
                </div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 16, padding: '16px 22px', borderRadius: 15, background: on ? 'linear-gradient(120deg, rgba(36,32,66,0.92), rgba(20,22,42,0.92))' : 'rgba(20,22,40,0.6)', border: on ? '1px solid rgba(150,130,255,0.34)' : '1px solid rgba(150,130,255,0.12)', boxShadow: on ? '0 14px 40px rgba(0,0,0,0.4)' : 'none', marginLeft: 10 }}>
                  <div style={{ width: 48, height: 48, borderRadius: 13, background: 'linear-gradient(150deg, rgba(139,92,246,0.32), rgba(59,130,246,0.2))', border: '1px solid rgba(150,130,255,0.26)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name={pl.icon} size={24} color={on ? C.purpleHi : C.sub} /></div>
                  <div>
                    <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 23, color: C.text }}>{pl.label}</div>
                    <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint, marginTop: 2 }}>{pl.desc}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Scene B — "Describe it in plain English." — AI Strategy Creator
function GeneratorPanels({ lt }) {
  const idea = "Create a counter-trend strategy that only takes mean-reversion trades once it detects the market is trapped in a range. Fade overextensions back toward the middle, but require confluence — a momentum stall, a volatility contraction — so it isn't blindly catching a falling knife. Lean toward a less-obvious edge: don't rely on any single generic indicator — use them only for confluence across different axes (trend, volatility, momentum, location). For risk, scale out across multiple take-profits, move the stop to breakeven after the first target hits, and trail the runner with an ATR-based stop.";
  const ideaShown = typed(idea, lt, 0.5, 150);
  const ideaTyping = lt > 0.7 && ideaShown.length < idea.length;
  const ideaCaret = ideaTyping && Math.sin(lt * 16) > 0;
  const code = `//@version=6
strategy("Stop-Run Reversal v2", overlay=true, initial_capital=100,
  commission_type=strategy.commission.percent, commission_value=0.05,
  default_qty_type=strategy.cash, default_qty_value=100, slippage=1)

// DATE FILTER (REQUIRED — QuantumLab reads these by name)
useDateFilter  = input.bool(true, "Enable Date Filter", group="Date Range")
backtestStart  = input.time(timestamp("1 Jan 2020"), "Start Date")
backtestEnd    = input.time(timestamp("31 Dec 2035"), "End Date")
inDateRange    = not useDateFilter or (time >= backtestStart and time <= backtestEnd)

// PARAMETERS — orthogonal, non-collinear set
swingLookback  = input.int(5, "Swing Lookback", minval=3, maxval=12)
sweepBufferPct = input.float(0.10, "Sweep Buffer %", minval=0.02, maxval=0.5)
rsiLen         = input.int(14, "RSI Length", minval=7, maxval=21)
emaLen         = input.int(50, "EMA Length", minval=30, maxval=100)
atrLen         = input.int(14, "ATR Length", minval=7, maxval=21)
atrStopMult    = input.float(1.0, "ATR Stop Mult", minval=0.5, maxval=2.5)`;
  const codeStart = 2.3, codeCps = 360;
  const codeShown = typed(code, lt, codeStart, codeCps);
  const codeDone = lt > codeStart + code.length / codeCps;
  const genPulse = (0.5 + 0.5 * Math.sin(lt * 6)) * clamp((lt - 1.6) / 0.4, 0, 1) * (codeDone ? 0 : 1);
  const codeDoneT = codeStart + code.length / codeCps;
  const compP = Easing.easeOutBack(clamp((lt - codeDoneT) / 0.5, 0, 1));
  // ── Second AI reviewer: scans the draft, grades it, offers Apply fixes ──
  const scanStart = codeDoneT + 0.25;
  const scanP = clamp((lt - scanStart) / 0.95, 0, 1);
  const scanning = scanP > 0.02 && scanP < 0.98;
  const reviewBarP = Easing.easeOutCubic(clamp((lt - (scanStart + 0.75)) / 0.4, 0, 1));
  const reviewExpand = Easing.easeOutCubic(clamp((lt - (scanStart + 1.05)) / 0.7, 0, 1));
  const findingsStart = scanStart + 1.65;
  const applyP = Easing.easeOutBack(clamp((lt - (findingsStart + 1.55)) / 0.5, 0, 1));
  const applyPulse = (0.5 + 0.5 * Math.sin(lt * 5)) * clamp((lt - (findingsStart + 1.65)) / 0.4, 0, 1);
  const findings = [
    ['FAIL', 'ROUND-TRIP PROTECTION', 'Initial trailing stop sits below the invalidation point \u2014 zero profit protection, full give-back before TP1.'],
    ['FAIL', 'CODE INTEGRITY', 'entrySL, riskUnits, tp1Level, tp2Level used before declaration \u2014 won\u2019t compile in Pine v6.'],
    ['FAIL', 'EXECUTION LOGIC', 'Trail updates detect TP fills on the current bar \u2014 latency misses intrabar bracket protection.'],
    ['PASS', 'STRUCTURE & EXITS', 'Date filter, native exits, structural entry and no external dependencies are correctly implemented.'],
  ];
  const revH = 58 + reviewExpand * 414;
  // render code lines with comment two-tone
  const lines = codeShown.split('\n');
  return (
    <div style={{ display: 'flex', gap: 22, width: 1640 }}>
      {/* left — prompt */}
      <div style={{ ...panelBase, width: 600, height: 612, padding: 26, display: 'flex', flexDirection: 'column', boxShadow: neon('rgba(139,92,246,0.3)', 'rgba(59,130,246,0.18)') }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <div style={{ width: 50, height: 50, borderRadius: 14, background: 'linear-gradient(150deg, rgba(139,92,246,0.85), rgba(59,130,246,0.6))', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 20px rgba(139,92,246,0.5)' }}><Icon name="sparkles" size={24} color="#fff" /></div>
          <div>
            <div style={{ fontFamily: FD, fontWeight: 600, fontSize: 26, color: C.text }}>AI Strategy Creator</div>
            <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginTop: 2 }}>Describe a trading idea in plain English</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FUI, fontWeight: 700, fontSize: 15, padding: '9px 16px', borderRadius: 10, color: '#fff', background: `linear-gradient(120deg, ${C.violet}, ${C.purple})` }}><Icon name="sparkles" size={15} color="#fff" /> New idea</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FUI, fontWeight: 600, fontSize: 15, padding: '9px 16px', borderRadius: 10, color: C.sub, background: 'rgba(28,30,52,0.75)', border: '1px solid rgba(150,130,255,0.14)' }}>↻ Improve</div>
        </div>
        <div style={{ flex: 1, padding: '16px 18px', borderRadius: 14, background: 'rgba(15,16,30,0.7)', border: '1px solid rgba(150,130,255,0.16)', fontFamily: FUI, fontSize: 15.5, lineHeight: 1.5, color: C.text, overflow: 'hidden' }}>
          {ideaShown || <span style={{ color: C.faint }}>e.g. Create a counter-trend strategy that fades overextensions back toward the middle of a range…</span>}<span style={{ opacity: ideaCaret ? 1 : 0, color: C.purpleHi }}>▌</span>
        </div>
        <div style={{ display: 'flex', gap: 10, margin: '16px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: FUI, fontWeight: 600, fontSize: 14, padding: '9px 14px', borderRadius: 10, color: C.sub, background: 'rgba(20,22,40,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}><Icon name="zap" size={14} color={C.purpleHi} /> Engine: Auto</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: FUI, fontWeight: 600, fontSize: 14, padding: '9px 14px', borderRadius: 10, color: C.sub, background: 'rgba(20,22,40,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>Key: …39d3</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11, padding: '17px', borderRadius: 14, fontFamily: FUI, fontWeight: 700, fontSize: 20, color: '#fff', background: `linear-gradient(100deg, ${C.violet}, ${C.purple})`, boxShadow: `0 0 ${16 + genPulse * 30}px rgba(139,92,246,${0.4 + genPulse * 0.4})`, transform: `scale(${1 + genPulse * 0.015})` }}>
          <Icon name="sparkles" size={21} color="#fff" /> Generate strategy
        </div>
      </div>
      {/* right — generated Pine code */}
      <div style={{ ...panelBase, position: 'relative', width: 1018, height: 612, padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: neon('rgba(70,160,255,0.28)', 'rgba(139,92,246,0.2)') }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '18px 22px', borderBottom: '1px solid rgba(150,130,255,0.12)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: FUI, fontWeight: 700, fontSize: 15, padding: '7px 13px', borderRadius: 9, color: C.greenHi, background: 'rgba(52,211,153,0.13)', border: '1px solid rgba(52,229,168,0.35)', opacity: clamp(compP, 0, 1), transform: `scale(${0.85 + clamp(compP, 0, 1) * 0.15})` }}><Icon name="circle-check" size={15} color={C.greenHi} /> Compiles</div>
          <span style={{ fontFamily: FM, fontSize: 13, color: C.sub, padding: '6px 12px', borderRadius: 8, background: 'rgba(30,32,54,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>kimi-k2.6</span>
          <span style={{ fontFamily: FM, fontSize: 13, color: C.sub, padding: '6px 12px', borderRadius: 8, background: 'rgba(30,32,54,0.7)', border: '1px solid rgba(150,130,255,0.14)' }}>1 pass</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: FUI, fontSize: 14, color: C.sub }}>Copy</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: FUI, fontWeight: 700, fontSize: 15, padding: '9px 16px', borderRadius: 10, color: '#fff', background: `linear-gradient(100deg, ${C.blue}, ${C.cyan})`, opacity: clamp(compP, 0, 1) }}><Icon name="play" size={15} color="#fff" /> Open in Setup & Run</div>
          </div>
        </div>
        <div style={{ flex: 1, padding: '18px 24px', fontFamily: FM, fontSize: 15.5, lineHeight: 1.62, whiteSpace: 'pre-wrap', overflow: 'hidden' }}>
          {lines.map((ln, i) => {
            const isComment = ln.trimStart().startsWith('//');
            const last = i === lines.length - 1;
            return <div key={i} style={{ color: isComment ? 'rgba(110,200,160,0.7)' : '#c7d0f2' }}>{ln || '\u00a0'}{last && !codeDone && <span style={{ color: C.cyan, opacity: Math.sin(lt * 16) > 0 ? 1 : 0 }}>▌</span>}</div>;
          })}
        </div>
        {/* AI reviewer scan sweep */}
        <div style={{ position: 'absolute', left: 0, right: 0, top: 62, bottom: 0, pointerEvents: 'none', opacity: scanning ? 1 : 0 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: `${scanP * 100}%`, background: 'linear-gradient(180deg, rgba(70,198,255,0), rgba(70,198,255,0.07))' }} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: `${scanP * 100}%`, height: 2, background: `linear-gradient(90deg, transparent, ${C.cyan}, transparent)`, boxShadow: `0 0 18px ${C.cyan}` }} />
        </div>
        <div style={{ position: 'absolute', top: 78, left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderRadius: 12, background: 'rgba(16,18,34,0.94)', border: '1px solid rgba(70,198,255,0.45)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', opacity: scanning ? 1 : 0 }}>
          <div style={{ width: 9, height: 9, borderRadius: 5, background: C.cyan, boxShadow: `0 0 9px ${C.cyan}`, opacity: Math.sin(lt * 13) > 0 ? 1 : 0.3 }} />
          <span style={{ fontFamily: FUI, fontWeight: 600, fontSize: 15, color: C.text }}>AI Reviewer · analyzing draft…</span>
        </div>
        {/* Reviewer notes — collapsed bar that expands with the grades */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: revH, background: 'rgba(8,9,18,0.99)', display: 'flex', flexDirection: 'column', overflow: 'hidden', opacity: clamp(reviewBarP, 0, 1), boxShadow: '0 -26px 64px rgba(0,0,0,0.7)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 24px', borderTop: '1px solid rgba(150,130,255,0.22)', flexShrink: 0 }}>
            <Icon name="lightbulb" size={20} color="#f5c542" />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 19, color: C.text }}>Reviewer notes</span>
            <span style={{ fontFamily: FUI, fontSize: 14, color: C.faint }}>independent check — optional</span>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, opacity: clamp(reviewExpand, 0, 1) }}>
              <span style={{ fontFamily: FUI, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.05em', color: '#ff8294', padding: '5px 10px', borderRadius: 7, background: 'rgba(244,86,110,0.14)', border: '1px solid rgba(244,86,110,0.42)' }}>3 FAIL</span>
              <span style={{ fontFamily: FUI, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.05em', color: '#54e5a8', padding: '5px 10px', borderRadius: 7, background: 'rgba(52,211,153,0.14)', border: '1px solid rgba(52,229,168,0.42)' }}>1 PASS</span>
            </div>
          </div>
          <div style={{ flex: 1, padding: '4px 24px 18px', overflow: 'hidden', opacity: clamp(reviewExpand, 0, 1) }}>
            <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginBottom: 12 }}>The reviewer grades the draft and flags risk — it doesn't change your code. Apply fixes to have the AI revise it, or backtest as-is.</div>
            {findings.map((f, i) => {
              const fail = f[0] === 'FAIL';
              const p = Easing.easeOutCubic(clamp((lt - (findingsStart + i * 0.28)) / 0.42, 0, 1));
              return (
                <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '7px 0', opacity: p, transform: `translateY(${(1 - p) * 10}px)` }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: FUI, fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', padding: '6px 0', borderRadius: 7, color: fail ? '#ff8294' : '#54e5a8', background: fail ? 'rgba(244,86,110,0.14)' : 'rgba(52,211,153,0.14)', border: `1px solid ${fail ? 'rgba(244,86,110,0.42)' : 'rgba(52,229,168,0.42)'}`, flexShrink: 0, marginTop: 1, width: 56 }}>{f[0]}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 15.5, color: C.text }}>{f[1]}</div>
                    <div style={{ fontFamily: FUI, fontSize: 14, lineHeight: 1.4, color: C.sub, marginTop: 2 }}>{f[2]}</div>
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', alignItems: 'center', gap: 11, alignSelf: 'flex-start', marginTop: 14, padding: '13px 24px', borderRadius: 12, fontFamily: FUI, fontWeight: 700, fontSize: 17, color: '#fff', width: 'fit-content', background: `linear-gradient(100deg, ${C.violet}, ${C.purple})`, boxShadow: `0 0 ${14 + applyPulse * 28}px rgba(139,92,246,${0.4 + applyPulse * 0.4})`, opacity: clamp(applyP, 0, 1), transform: `translateY(${(1 - clamp(applyP, 0, 1)) * 12}px) scale(${1 + applyPulse * 0.02})` }}>
              <Icon name="sparkles" size={18} color="#fff" /> Apply fixes
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function SceneGenerator() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: 24, ryHold: -2, rx0: 13, rxHold: 3, y0: 140, zHold: 30, inDur: 0.85 });
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={960} y={56} size={62} align="center" lines={[<span key="a">Describe it in <GradText>plain English.</GradText></span>]} sub="The AI drafts a Pine v6 strategy — then a second AI reviews it for risk before you ever backtest." maxW={1320} />
      <Stage3D style={{ perspectiveOrigin: '50% 50%' }}>
        <div style={{ position: 'absolute', left: 140, top: 300, ...fly, transformStyle: 'preserve-3d' }}><GeneratorPanels lt={lt} /></div>
      </Stage3D>
    </div>
  );
}

// Scene C — "Deploy in a few clicks." — Pacifica deploy modal
function DeployModal({ lt }) {
  const slideP = Easing.easeOutCubic(clamp((lt - 0.8) / 0.8, 0, 1));
  const depositPulse = (0.5 + 0.5 * Math.sin(lt * 4)) * clamp((lt - 1.6) / 0.5, 0, 1);
  const row = (label, value, color) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
      <span style={{ fontFamily: FUI, fontSize: 17, color: C.sub }}>{label}</span>
      <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 19, color }}>{value}</span>
    </div>
  );
  return (
    <div style={{ width: 600, background: 'linear-gradient(165deg, rgba(20,22,42,0.99), rgba(8,9,19,1))', border: '1px solid rgba(150,130,255,0.2)', borderRadius: 22, overflow: 'hidden', boxShadow: neon('rgba(139,92,246,0.32)', 'rgba(245,158,11,0.18)') }}>
      {/* step 1 */}
      <div style={{ padding: '22px 26px 18px', borderBottom: '1px solid rgba(150,130,255,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 5 }}>
          <Icon name="code" size={19} color={C.purpleHi} />
          <span style={{ fontFamily: FUI, fontWeight: 800, fontSize: 17, letterSpacing: '0.02em', color: C.text }}>STEP 1 — EXPORT PINE SCRIPT</span>
          <span style={{ marginLeft: 'auto', color: C.faint, fontSize: 19 }}>×</span>
        </div>
        <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint, marginBottom: 15 }}>Load this strategy into TradingView before setting up the alert.</div>
        <div style={{ display: 'flex', gap: 12 }}>
          {[['Copy', 'code'], ['Export', 'arrow-right']].map(([t, ic]) => (
            <div key={t} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '13px', borderRadius: 12, fontFamily: FUI, fontWeight: 600, fontSize: 17, color: C.text, background: 'rgba(30,33,56,0.8)', border: '1px solid rgba(150,130,255,0.16)' }}><Icon name={ic} size={17} color={C.sub} /> {t}</div>
          ))}
        </div>
      </div>
      {/* step 2 */}
      <div style={{ padding: '20px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 16 }}>
          <Icon name="shield" size={19} color={C.purpleHi} />
          <span style={{ fontFamily: FUI, fontWeight: 800, fontSize: 17, letterSpacing: '0.02em', color: C.text }}>STEP 2 — CREATE BOT & GET WEBHOOK</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <span style={{ fontFamily: FUI, fontSize: 15, color: C.faint, whiteSpace: 'nowrap' }}>Capital $</span>
          <div style={{ flex: 1, padding: '13px 16px', borderRadius: 11, background: 'rgba(15,16,30,0.85)', border: '1px solid rgba(150,130,255,0.18)', fontFamily: FM, fontWeight: 700, fontSize: 20, color: C.text }}>1000</div>
          <div style={{ padding: '13px 18px', borderRadius: 11, background: 'rgba(30,33,56,0.8)', border: '1px solid rgba(150,130,255,0.16)', fontFamily: FUI, fontWeight: 600, fontSize: 16, color: C.sub }}>Max</div>
        </div>
        <div style={{ fontFamily: FUI, fontSize: 13.5, color: C.faint, marginBottom: 16 }}>Available in agent wallet: $0.00 USDC</div>
        <div style={{ borderTop: '1px solid rgba(150,130,255,0.1)', paddingTop: 14 }}>
          {row('Investment Amount', '$462', C.text)}
          {row('Equity Buffer', '+$538', C.cyan)}
          {/* slider */}
          <div style={{ position: 'relative', height: 8, borderRadius: 4, background: 'rgba(40,42,66,0.9)', margin: '12px 0 8px' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${46 * slideP}%`, borderRadius: 4, background: `linear-gradient(90deg, ${C.violet}, ${C.purple})` }} />
            <div style={{ position: 'absolute', left: `${46 * slideP}%`, top: '50%', width: 20, height: 20, marginLeft: -10, marginTop: -10, borderRadius: 10, background: '#1a1c2e', border: `3px solid ${C.purpleHi}`, boxShadow: '0 2px 8px rgba(0,0,0,0.5)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: FUI, fontSize: 14, color: C.faint }}><span>46% trading</span><span>54% buffer (auto)</span></div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: FUI, fontSize: 14, color: C.faint, marginBottom: 8 }}>Exchange</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 16px', borderRadius: 12, background: 'rgba(15,16,30,0.85)', border: '1px solid rgba(150,130,255,0.18)' }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: `linear-gradient(140deg, ${C.purpleHi}, ${C.blue})`, transform: 'rotate(45deg)' }} />
            <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 18, color: C.text }}>Pacifica</span>
            <span style={{ marginLeft: 'auto', color: C.faint }}>▾</span>
          </div>
        </div>
        <div style={{ borderTop: '1px solid rgba(150,130,255,0.1)', marginTop: 16, paddingTop: 10 }}>
          {row('Set Leverage', '3×', C.purpleHi)}
          {row('Projected Profit', '+$3858.35', C.cyan)}
          {row('Worst-Case Loss', '−$358.28', C.purpleHi)}
        </div>
        <div style={{ borderTop: '1px solid rgba(150,130,255,0.1)', marginTop: 14, paddingTop: 14 }}>
          {[['Auto Top-Up', 'Recommended ON for this setup', true], ['Profit Reinvest', 'Recommended OFF for this setup', false]].map(([t, d, on]) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
              <div>
                <div style={{ fontFamily: FUI, fontWeight: 700, fontSize: 17, color: C.text }}>{t}</div>
                <div style={{ fontFamily: FUI, fontSize: 13.5, color: C.faint, marginTop: 1 }}>{d}</div>
              </div>
              <div style={{ width: 52, height: 28, borderRadius: 14, background: on ? `linear-gradient(120deg, ${C.violet}, ${C.purple})` : 'rgba(40,42,66,0.9)', position: 'relative', boxShadow: on ? `0 0 14px ${C.purple}66` : 'none' }}>
                <div style={{ position: 'absolute', top: 3, left: on ? 27 : 3, width: 22, height: 22, borderRadius: 11, background: '#11121e' }} />
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 11, alignItems: 'flex-start', padding: '14px 16px', borderRadius: 13, background: 'rgba(60,50,140,0.18)', border: '1px solid rgba(120,100,230,0.3)', margin: '14px 0' }}>
          <Icon name="shield" size={17} color={C.purpleHi} />
          <span style={{ fontFamily: FUI, fontSize: 14.5, lineHeight: 1.45, color: C.sub }}>Keep $538 as buffer in your agent wallet with Auto Top-Up enabled to survive drawdown periods.</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 11, padding: '17px', borderRadius: 14, fontFamily: FUI, fontWeight: 800, fontSize: 19, color: '#1a1206', background: 'linear-gradient(100deg, #f5b942, #f97316)', boxShadow: `0 0 ${16 + depositPulse * 30}px rgba(245,158,11,${0.4 + depositPulse * 0.4})`, transform: `scale(${1 + depositPulse * 0.012})` }}>
          <Icon name="zap" size={19} color="#1a1206" /> Deposit $1000.00 USDC
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontFamily: FM, fontSize: 13.5, color: C.faint }}><span>Wallet: $0.00 USDC</span><span>0.0359 SOL</span></div>
      </div>
    </div>
  );
}
function SceneDeployModal() {
  const { localTime: lt, duration: dur } = useSprite();
  const fly = flyStyle(lt, dur, { ry0: 22, ryHold: -7, rx0: 12, rxHold: 4, y0: 120, zHold: 0, inDur: 0.85 });
  const statP = Easing.easeOutCubic(clamp((lt - 0.9) / 0.6, 0, 1));
  const exitMain = Easing.easeInCubic(clamp((lt - (dur - 0.5)) / 0.5, 0, 1));
  const stats = [['Projected profit', '+$3,858', C.cyan, 'trending-up'], ['Worst-case loss', '−$358', C.purpleHi, 'shield'], ['Leverage', '3×', C.text, 'gauge']];
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Headline lt={lt} dur={dur} x={90} y={150} size={70} lines={[<span key="a">Deploy in a</span>, <span key="b"><GradText>few clicks.</GradText></span>]} sub="Export the Pine script, create the bot, fund it — projected and worst-case spelled out before a cent moves." maxW={680} />
      <div style={{ position: 'absolute', left: 96, top: 560, display: 'flex', flexDirection: 'column', gap: 16, opacity: statP * (1 - exitMain) }}>
        {stats.map((s, i) => {
          const p = Easing.easeOutCubic(clamp((lt - (0.9 + i * 0.13)) / 0.5, 0, 1));
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 16, opacity: p, transform: `translateX(${(1 - p) * 24}px)` }}>
              <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(150deg, rgba(139,92,246,0.28), rgba(59,130,246,0.18))', border: '1px solid rgba(150,130,255,0.26)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name={s[3]} size={24} color={s[2]} /></div>
              <div>
                <div style={{ fontFamily: FUI, fontSize: 15, color: C.faint }}>{s[0]}</div>
                <div style={{ fontFamily: FM, fontWeight: 700, fontSize: 36, color: s[2], lineHeight: 1.1 }}>{s[1]}</div>
              </div>
            </div>
          );
        })}
      </div>
      <Stage3D style={{ perspectiveOrigin: '70% 50%' }}>
        <div style={{ position: 'absolute', left: 1180, top: 44, ...fly, transformStyle: 'preserve-3d' }}>
          <div style={{ transform: 'scale(0.93)', transformOrigin: 'top center' }}><DeployModal lt={lt} /></div>
        </div>
      </Stage3D>
    </div>
  );
}

// Scene 5 — lockup
function SceneLockup() {
  const { localTime: lt, duration: dur } = useSprite();
  const logoP = Easing.easeOutBack(clamp(lt / 0.8, 0, 1));
  const tagP = Easing.easeOutCubic(clamp((lt - 0.65) / 0.6, 0, 1));
  const subP = Easing.easeOutCubic(clamp((lt - 0.95) / 0.6, 0, 1));
  const solP = Easing.easeOutCubic(clamp((lt - 1.2) / 0.6, 0, 1));
  const urlP = Easing.easeOutCubic(clamp((lt - 1.5) / 0.6, 0, 1));
  const bloom = Easing.easeOutCubic(clamp(lt / 0.9, 0, 1));
  const marks = ['AUTOMATE', 'EXECUTE', 'OPTIMIZE', 'SECURE'];
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', width: 760, height: 760, borderRadius: '50%', background: 'radial-gradient(circle, rgba(120,80,255,0.3), transparent 65%)', opacity: bloom, transform: `scale(${0.7 + bloom * 0.5})` }} />
      <div style={{ transform: `scale(${0.85 + logoP * 0.15})`, opacity: clamp(logoP, 0, 1) }}>
        <Wordmark size={62} logoSize={94} glow={20} gap={22} />
      </div>
      <div style={{ marginTop: 30, opacity: tagP, transform: `translateY(${(1 - tagP) * 16}px)`, fontFamily: FUI, fontWeight: 600, fontSize: 26, color: C.sub, letterSpacing: '0.02em' }}>Advanced Trade Automation Suite</div>
      <div style={{ marginTop: 34, display: 'flex', alignItems: 'center', gap: 24, opacity: subP, transform: `translateY(${(1 - subP) * 16}px)` }}>
        <div style={{ width: 70, height: 2, background: `linear-gradient(90deg, transparent, ${C.purple})` }} />
        <span style={{ fontFamily: FUI, fontWeight: 700, fontSize: 30, letterSpacing: '0.14em', color: C.text }}>BUILT FOR <GradText from={C.solGreen} to={C.solPurple}>SOLANA</GradText></span>
        <div style={{ opacity: solP, transform: `scale(${0.6 + solP * 0.4})` }}><SolanaMark w={52} /></div>
        <div style={{ width: 70, height: 2, background: `linear-gradient(90deg, ${C.blue}, transparent)` }} />
      </div>
      {/* submark strip */}
      <div style={{ marginTop: 30, display: 'flex', alignItems: 'center', gap: 16, opacity: urlP }}>
        {marks.map((m, i) => (
          <React.Fragment key={m}>
            <span style={{ fontFamily: FM, fontSize: 16, letterSpacing: '0.22em', color: C.faint }}>{m}</span>
            {i < marks.length - 1 && <span style={{ width: 4, height: 4, borderRadius: 2, background: C.purple }} />}
          </React.Fragment>
        ))}
      </div>
      <div style={{ marginTop: 30, opacity: urlP, fontFamily: FM, fontSize: 21, letterSpacing: '0.16em', color: C.sub }}>myquantumvault.com</div>
      <div style={{ position: 'absolute', bottom: 40, opacity: urlP * 0.7, fontFamily: FUI, fontSize: 13, color: C.faint, letterSpacing: '0.04em' }}>Illustrative product UI. Trading involves substantial risk of loss. Not financial advice.</div>
    </div>
  );
}

/* ───────────────────────── Stage shell ───────────────────────── */
const W = 1920, H = 1080, DUR = 56;
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
  // Only animate while on screen (saves CPU on the landing page).
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
export default function QuantumLabVideo() {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <StageShell>
        <Background />
        <Sprite start={0.0} end={3.5}><SceneLogo /></Sprite>
        <Sprite start={3.4} end={9.9}><SceneAssistant /></Sprite>
        <Sprite start={9.8} end={19.8}><SceneGenerator /></Sprite>
        <Sprite start={19.7} end={25.4}><SceneConfig /></Sprite>
        <Sprite start={25.3} end={31.2}><SceneHeatmap /></Sprite>
        <Sprite start={31.1} end={37.4}><SceneOutcome /></Sprite>
        <Sprite start={37.3} end={43.6}><SceneDeployModal /></Sprite>
        <Sprite start={43.5} end={48.3}><SceneDeploy /></Sprite>
        <Sprite start={48.2} end={56.0}><SceneLockup /></Sprite>
      </StageShell>
    </div>
  );
}
