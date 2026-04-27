import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ModelView } from "@/types/api";

interface ModelInfoCardProps {
  model: ModelView;
}

export function ModelInfoCard({ model }: ModelInfoCardProps) {
  const profile = model.active_profile;
  
  return (
    <div className="rounded-xl border border-line/60 bg-gradient-to-br from-white/[0.03] to-white/[0.01] p-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold text-milk">{model.name}</h3>
          <p className="text-sm text-milk/60">{model.provider} • {model.modality.toUpperCase()}</p>
        </div>
        <Badge 
          variant={model.runtime.health_ok ? "success" : "warning"}
          className="capitalize"
        >
          {model.runtime.status}
        </Badge>
      </div>
      
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-milk/50">Context Size</p>
          <p className="text-sm font-medium text-milk">
            {profile?.context_size ? `${profile.context_size.toLocaleString()} tokens` : 'N/A'}
          </p>
        </div>
        <div>
          <p className="text-xs text-milk/50">Quantization</p>
          <p className="text-sm font-medium text-milk">
            {model.artifact?.quantization || 'N/A'}
          </p>
        </div>
        <div>
          <p className="text-xs text-milk/50">Temperature</p>
          <p className="text-sm font-medium text-milk">
            {profile?.temperature ?? 'N/A'}
          </p>
        </div>
        <div>
          <p className="text-xs text-milk/50">Top-P</p>
          <p className="text-sm font-medium text-milk">
            {profile?.top_p ?? 'N/A'}
          </p>
        </div>
      </div>
      
      {model.metadata?.family && (
        <div className="mt-3 pt-3 border-t border-line/30">
          <p className="text-xs text-milk/50">Model Family</p>
          <p className="text-sm text-milk">{model.metadata.family}</p>
        </div>
      )}
      
      {model.pricing && (
        <div className="mt-3 pt-3 border-t border-line/30">
          <p className="text-xs text-milk/50">Pricing</p>
          <div className="grid grid-cols-2 gap-2 mt-1">
            <div>
              <p className="text-xs text-milk/60">Input: ${model.pricing.input}/M tokens</p>
            </div>
            <div>
              <p className="text-xs text-milk/60">Output: ${model.pricing.output}/M tokens</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}