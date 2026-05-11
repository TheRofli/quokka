import { Component, type ErrorInfo, type ReactNode } from "react";

interface RuntimeErrorBoundaryProps {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface RuntimeErrorBoundaryState {
  error: Error | null;
}

export class RuntimeErrorBoundary extends Component<RuntimeErrorBoundaryProps, RuntimeErrorBoundaryState> {
  state: RuntimeErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): RuntimeErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Quokka UI panel crashed", error, info);
  }

  reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-shell/88 px-4 backdrop-blur-sm">
        <div className="w-full max-w-xl rounded-2xl border border-danger/35 bg-[#171717] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-danger">Quokka recovered</p>
          <h2 className="mt-2 text-xl font-semibold text-milk">{this.props.fallbackTitle ?? "Panel failed to render"}</h2>
          <p className="mt-3 text-sm leading-6 text-milk/62">
            Quokka caught the UI error instead of leaving a blank gray screen. Close this panel and try again.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-xl border border-line bg-black/35 p-3 text-xs text-milk/58">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="mt-4 h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-shell transition-colors hover:bg-[#c39a72]"
            onClick={this.reset}
          >
            Close panel
          </button>
        </div>
      </div>
    );
  }
}
