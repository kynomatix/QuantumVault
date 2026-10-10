import { createChart, CrosshairMode } from "lightweight-charts";
/** Common price canvas for AI decision and Signal Bot history charts. */
export function createSharedTradePriceChart(container: HTMLElement) {
  return createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 360,
    layout: { background: { color: 'transparent' }, textColor: '#9ca3af', fontFamily: getComputedStyle(container).fontFamily, fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
    crosshair: { mode: CrosshairMode.Normal },
    timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(255,255,255,0.12)' },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
  });
}
