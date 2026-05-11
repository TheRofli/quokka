import { useEffect, useState } from "react";
import { Copy, DownloadCloud, FileSearch, FlaskConical, Play, X } from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import type { RuntimeSetupCheckResponse } from "@/types/api";

interface FirstRunWizardProps {
  onAddModel: () => void;
  onOpenLibrary: () => void;
  onOpenTests: () => void;
  onDismiss: () => void;
}

export function FirstRunWizard({ onAddModel, onOpenLibrary, onOpenTests, onDismiss }: FirstRunWizardProps) {
  const labEndpoint = `${window.location.origin.replace(/\/$/, "")}/api/lab/models`;
  const [runtimeCheck, setRuntimeCheck] = useState<RuntimeSetupCheckResponse | null>(null);

  useEffect(() => {
    api.getRuntimeSetupCheck().then(setRuntimeCheck).catch(() => setRuntimeCheck(null));
  }, []);

  return (
    <section className="quokka-soft-panel mb-3 rounded-[var(--radius-soft)] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-accent">First run</p>
          <h2 className="mt-2 text-xl font-semibold text-milk">Set up your first local model</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-milk/55">
            Quokka can scan a Windows drive, add a GGUF, start llama.cpp, then expose the running endpoint to Chat and Quokka Lab.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="quokka-control grid h-9 w-9 shrink-0 place-items-center text-milk/55 hover:text-milk"
          title="Dismiss first run wizard"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        <button type="button" onClick={onOpenLibrary} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-accent/65">
          <DownloadCloud className="h-5 w-5 text-accent" />
          <p className="mt-3 font-semibold text-milk">0. Download GGUF</p>
          <p className="mt-2 text-sm leading-5 text-milk/50">Search Hugging Face or paste a model URL, then download into Quokka.</p>
        </button>
        <button type="button" onClick={onAddModel} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-accent/65">
          <FileSearch className="h-5 w-5 text-accent" />
          <p className="mt-3 font-semibold text-milk">1. Add GGUF</p>
          <p className="mt-2 text-sm leading-5 text-milk/50">
            Scan D:\ or pick an exact model path. Windows runtime is the default.
            {runtimeCheck?.llama_server_candidates.length ? " llama-server.exe was found." : " Pick llama-server.exe if needed."}
          </p>
        </button>
        <button type="button" onClick={onOpenTests} className="quokka-panel rounded-[var(--radius-control)] p-4 text-left transition hover:border-live/65">
          <FlaskConical className="h-5 w-5 text-live" />
          <p className="mt-3 font-semibold text-milk">2. Tune it</p>
          <p className="mt-2 text-sm leading-5 text-milk/50">Run quick or smart auto tests to find ctx, batch, KV cache, and tok/s sweet spots.</p>
        </button>
        <div className="quokka-panel rounded-[var(--radius-control)] p-4">
          <Play className="h-5 w-5 text-success" />
          <p className="mt-3 font-semibold text-milk">3. Use it everywhere</p>
          <p className="mt-2 text-sm leading-5 text-milk/50">Quokka Lab can discover active models from the bridge endpoint.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="quokka-control mt-3 rounded-[var(--radius-control)]"
            onClick={() => void navigator.clipboard.writeText(labEndpoint)}
          >
            <Copy className="h-4 w-4" />
            Copy Lab endpoint
          </Button>
        </div>
      </div>
    </section>
  );
}
