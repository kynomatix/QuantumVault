import { ToastAction } from "@/components/ui/toast";
import type { useToast } from "@/hooks/use-toast";

type ToastFn = ReturnType<typeof useToast>["toast"];

/**
 * A thrown error is a "session" error when its message mentions a lost/expired
 * session or asks the user to reconnect. Covers both client-side session guards
 * (e.g. an /api/auth/session check) and any session rejection echoed by the
 * server, so callers can branch on it without matching exact strings.
 */
export function isSessionError(e: unknown): boolean {
  const m = e instanceof Error ? e.message.toLowerCase() : String(e ?? "").toLowerCase();
  return m.includes("session") || m.includes("reconnect");
}

/**
 * Show a destructive toast for a session-expired failure that, instead of
 * dead-ending with a "reconnect your wallet" complaint, carries a one-tap
 * Reconnect action.
 *
 * The tap is a fresh user gesture (required so the wallet's signMessage prompt
 * isn't blocked by the browser), re-signs to re-establish the session via
 * retryAuth(), and on success transparently re-runs the original action.
 */
export function showReconnectToast(args: {
  toast: ToastFn;
  retryAuth: () => Promise<boolean>;
  /** Title of the failure toast, e.g. "Park failed". */
  title: string;
  /** Re-run after a successful reconnect (the action the user originally took). */
  retry: () => void;
}) {
  const { toast, retryAuth, title, retry } = args;
  toast({
    title,
    description: "Your wallet session expired. Reconnect to continue.",
    variant: "destructive",
    action: (
      <ToastAction
        altText="Reconnect your wallet"
        data-testid="button-reconnect-session"
        onClick={async () => {
          const ok = await retryAuth();
          if (ok) {
            toast({ title: "Reconnected", description: "Picking up where you left off…" });
            retry();
          } else {
            toast({
              title: "Reconnect failed",
              description: "Couldn't reconnect. Please reconnect your wallet and try again.",
              variant: "destructive",
            });
          }
        }}
      >
        Reconnect
      </ToastAction>
    ),
  });
}
