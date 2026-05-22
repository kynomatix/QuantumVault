import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Caught render error:", error, errorInfo);
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
            className="w-64 h-auto"
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
          </div>
          <div className="flex gap-3">
            <Button
              onClick={this.handleReload}
              className="bg-violet-500 hover:bg-violet-600 text-white"
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
