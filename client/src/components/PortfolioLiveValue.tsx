export function portfolioValueClass(value: number | null): string {
  return value === null ? 'text-muted-foreground' : value >= 0 ? 'text-emerald-400' : 'text-red-400';
}

export function PortfolioLiveValue({ value, format, signed = false }: {
  value: number | null;
  format: 'dollar' | 'percent';
  signed?: boolean;
}) {
  if (value === null) return <>—</>;
  const sign = signed && value >= 0 ? '+' : '';
  return <>{format === 'dollar' ? `${sign}$${value.toFixed(2)}` : `${sign}${value.toFixed(2)}%`}</>;
}

export function PortfolioPartialNotice({ partial }: { partial: boolean }) {
  return partial ? (
    <p className="text-sm text-muted-foreground" role="status">
      Some balances could not be read just now. Totals will return shortly.
    </p>
  ) : null;
}
