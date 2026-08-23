import {
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface QualificationEquityPoint {
  kind: 'start' | 'close' | 'evaluation';
  at: string;
  equity: number;
  decisionId?: string;
}

export function AiTraderPerformanceChart({ points }: { points: QualificationEquityPoint[] }) {
  const data = points.filter((point) =>
    typeof point.at === 'string'
    && typeof point.equity === 'number'
    && Number.isFinite(point.equity),
  );
  if (data.length < 2) {
    return <p className="text-xs text-muted-foreground">Immutable equity series unavailable.</p>;
  }
  const start = data[0].equity;
  const finish = data[data.length - 1].equity;
  return (
    <div className="h-44 w-full" data-testid="ai-trader-qualification-equity-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 2 }}>
          <XAxis
            dataKey="at"
            tick={{ fontSize: 9 }}
            tickFormatter={(value: string) => new Date(value).toLocaleDateString()}
            minTickGap={28}
          />
          <YAxis width={55} tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
          <ReferenceLine y={start} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
          <Tooltip
            formatter={(value: number) => [`$${value.toFixed(2)}`, 'Equity']}
            labelFormatter={(value) => new Date(String(value)).toLocaleString()}
          />
          <Line
            type="monotone"
            dataKey="equity"
            stroke={finish >= start ? '#34d399' : '#f87171'}
            strokeWidth={2}
            dot={data.length <= 12}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
