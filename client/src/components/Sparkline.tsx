import { useMemo, useState } from "react";

export interface SparklinePoint {
  date: string;
  pnlPercent: number;
}

interface SparklineProps {
  data: SparklinePoint[];
  width?: number;
  height?: number;
  desktopWidth?: number;
  desktopHeight?: number;
  className?: string;
  rangeLabel?: string;
  testId?: string;
}

interface ChartView {
  points: Array<{ x: number; y: number }>;
  path: string;
  areaPath: string;
  isUp: boolean;
  endValue: number;
}

function buildView(data: SparklinePoint[], width: number, height: number): ChartView | null {
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.pnlPercent);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const span = max - min || 1;
  const padX = 1;
  const padY = 2;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const points = values.map((v, i) => {
    const x = padX + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
    const y = padY + innerH - ((v - min) / span) * innerH;
    return { x, y };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const areaPath = `${path} L${points[points.length - 1].x.toFixed(2)},${height} L${points[0].x.toFixed(2)},${height} Z`;
  const endValue = values[values.length - 1];
  return { points, path, areaPath, isUp: endValue >= 0, endValue };
}

export function Sparkline({
  data,
  width = 96,
  height = 28,
  desktopWidth,
  desktopHeight,
  className = "",
  rangeLabel = "All",
  testId,
}: SparklineProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const dW = desktopWidth ?? width;
  const dH = desktopHeight ?? height;

  const mobileView = useMemo(() => buildView(data, width, height), [data, width, height]);
  const desktopView = useMemo(() => buildView(data, dW, dH), [data, dW, dH]);

  if (!mobileView || !desktopView) {
    return (
      <div
        className={`inline-flex items-center justify-center text-[10px] text-muted-foreground/50 ${className}`}
        style={{ minWidth: width, minHeight: height }}
        data-testid={testId}
        title="Not enough data yet"
      >
        —
      </div>
    );
  }

  const stroke = desktopView.isUp ? "rgb(52 211 153)" : "rgb(248 113 113)";
  const fill = desktopView.isUp ? "rgba(52, 211, 153, 0.15)" : "rgba(248, 113, 113, 0.15)";

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = e.clientX - rect.left;
    let nearest = 0;
    let bestDist = Infinity;
    for (let i = 0; i < desktopView.points.length; i++) {
      const d = Math.abs(desktopView.points[i].x - relX);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    }
    setHoverIdx(nearest);
  };

  const hovered = hoverIdx !== null ? data[hoverIdx] : null;
  const hoveredPoint = hoverIdx !== null ? desktopView.points[hoverIdx] : null;
  const formattedPct = desktopView.endValue >= 0 ? `+${desktopView.endValue.toFixed(2)}%` : `${desktopView.endValue.toFixed(2)}%`;

  return (
    <div
      className={`relative inline-block ${className}`}
      data-testid={testId}
      title={`${rangeLabel} P&L: ${formattedPct}`}
    >
      {/* Desktop: hover-enabled, larger */}
      <svg
        width={dW}
        height={dH}
        viewBox={`0 0 ${dW} ${dH}`}
        className="hidden md:block"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <path d={desktopView.areaPath} fill={fill} stroke="none" />
        <path d={desktopView.path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
        {hoveredPoint && <circle cx={hoveredPoint.x} cy={hoveredPoint.y} r={2} fill={stroke} />}
      </svg>
      {/* Mobile: narrower, no hover */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block md:hidden"
      >
        <path d={mobileView.areaPath} fill={fill} stroke="none" />
        <path d={mobileView.path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      {hovered && (
        <div
          className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-[10px] text-popover-foreground shadow-md ring-1 ring-border z-10 hidden md:block"
        >
          <div className="font-mono">{rangeLabel} · <span style={{ color: stroke }}>{formattedPct}</span></div>
        </div>
      )}
    </div>
  );
}
