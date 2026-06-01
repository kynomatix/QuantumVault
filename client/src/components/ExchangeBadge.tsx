// Monochrome exchange marks (white webp on transparent) — same set used in the
// bot-creation flow. We use icons (not colored text pills) so the exchange never
// competes with the platform's color budget (green/red PnL, status dots). Phoenix
// is yellow/orange as a brand, so it too stays monochrome here for consistency.
const EXCHANGE_ICONS: Record<string, string> = {
  flash: '/images/exchange/Flash.webp',
  pacifica: '/images/exchange/Pacifica.webp',
  phoenix: '/images/exchange/Phoenix.webp',
};

const EXCHANGE_LABELS: Record<string, string> = {
  flash: 'Flash',
  pacifica: 'Pacifica',
  phoenix: 'Phoenix',
  drift: 'Drift',
};

export function ExchangeBadge({ protocol, className = '' }: { protocol?: string | null; className?: string }) {
  if (!protocol) return null;
  const key = protocol.toLowerCase();
  const label = EXCHANGE_LABELS[key];
  if (!label) return null;
  const icon = EXCHANGE_ICONS[key];
  if (icon) {
    // Sized to sit inline with the adjacent market text (text-xs line box).
    return (
      <img
        src={icon}
        alt={label}
        title={label}
        className={`h-4 w-4 shrink-0 object-contain opacity-80 ${className}`}
        data-testid={`badge-exchange-${key}`}
      />
    );
  }
  // Fallback for protocols without an icon (e.g. retired Drift): subtle text token.
  return (
    <span
      className={`text-[10px] font-medium text-muted-foreground ${className}`}
      title={label}
      data-testid={`badge-exchange-${key}`}
    >
      {label}
    </span>
  );
}
