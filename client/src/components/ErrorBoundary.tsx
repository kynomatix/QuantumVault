import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const componentStack = errorInfo?.componentStack ?? null;
    this.setState({ componentStack });
    console.error("[ErrorBoundary] Caught render error:", error, errorInfo);

    // Best-effort: report client render crashes to the server so the component
    // stack is captured in the logs (client-only crashes are otherwise invisible).
    try {
      void fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          message: error?.message ?? String(error),
          stack: error?.stack ?? "",
          componentStack: componentStack ?? "",
          url: typeof window !== "undefined" ? window.location.href : "",
          userAgent:
            typeof navigator !== "undefined" ? navigator.userAgent : "",
        }),
      }).catch(() => {});
    } catch {
      // ignore — reporting must never break the fallback UI
    }
  }

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div
        className="min-h-screen w-full flex items-center justify-center bg-black px-6 py-12"
        data-testid="error-boundary-fallback"
      >
        <div className="max-w-md w-full flex flex-col items-center text-center gap-6">
          <img
            src="/images/oops.webp"
            alt="Something went wrong"
            className="w-full h-auto"
            data-testid="img-error-oops"
          />
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold text-white" data-testid="text-error-title">
              Something went wrong
            </h1>
            <p className="text-sm text-white/60" data-testid="text-error-description">
              We hit an unexpected error. Your funds and bots are safe — this is
              just a display glitch. Try reloading the page.
            </p>
            {this.state.error?.message && (
              <p
                className="text-xs text-white/30 font-mono mt-3 break-all"
                data-testid="text-error-message"
              >
                {this.state.error.message}
              </p>
            )}
            {this.state.componentStack && (
              <details className="mt-3 text-left">
                <summary className="text-[11px] text-white/30 cursor-pointer hover:text-white/50">
                  Technical details
                </summary>
                <pre
                  className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-white/5 p-3 text-[10px] leading-relaxed text-white/40"
                  data-testid="text-error-component-stack"
                >
                  {this.state.componentStack}
                </pre>
              </details>
            )}
          </div>
          <div className="flex gap-3">
            <Button
              onClick={this.handleReload}
              className="bg-indigo-500 hover:bg-indigo-600 text-white"
              data-testid="button-error-reload"
            >
              Reload page
            </Button>
            <Button
              onClick={this.handleHome}
              variant="outline"
              className="border-white/20 text-white hover:bg-white/5"
              data-testid="button-error-home"
            >
              Go home
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
