export function PhoenixUnavailableNotice() {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3 text-sm space-y-1" data-testid="phoenix-money-unavailable">
      <p className="font-medium">Phoenix money controls are unavailable</p>
      <p className="text-xs text-muted-foreground">Trading, deposits, subscriptions, borrowing and yield deposits are not enabled for this account. Existing records remain available to review.</p>
      <p className="text-xs text-muted-foreground">Fees and minimum deposits are unknown until a server preview is available.</p>
    </div>
  );
}
