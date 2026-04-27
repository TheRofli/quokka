import { cn } from "@/lib/utils";
import { ModelView } from "@/types/api";

interface TokenCostPanelProps {
  inputTokens: number;
  outputTokens: number;
  model: ModelView | null;
  contextSize: number;
  tokensPerSecond?: number;
  vramUsage?: number; // Percentage of VRAM usage
}

export function TokenCostPanel({ 
  inputTokens, 
  outputTokens, 
  model, 
  contextSize, 
  tokensPerSecond,
  vramUsage
}: TokenCostPanelProps) {
  // Calculate costs based on model pricing if available
  const inputPricePerMillion = model?.pricing?.input || 0;
  const outputPricePerMillion = model?.pricing?.output || 0;
  
  const inputCost = (inputTokens / 1_000_000) * inputPricePerMillion;
  const outputCost = (outputTokens / 1_000_000) * outputPricePerMillion;
  const totalCost = inputCost + outputCost;
  const contextPercentage = contextSize ? (inputTokens / contextSize) * 100 : 0;
  
  return (
    <div className="rounded-xl border border-line/60 bg-gradient-to-br from-white/[0.03] to-white/[0.01] p-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="text-center">
          <p className="text-xs text-milk/50">Input</p>
          <p className="text-lg font-bold text-blue-400">{inputTokens.toLocaleString()}</p>
          <p className="text-xs text-blue-400/70">${inputCost.toFixed(6)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-milk/50">Output</p>
          <p className="text-lg font-bold text-green-400">{outputTokens.toLocaleString()}</p>
          <p className="text-xs text-green-400/70">${outputCost.toFixed(6)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-milk/50">Total</p>
          <p className="text-lg font-bold text-accent">{(inputTokens + outputTokens).toLocaleString()}</p>
          <p className="text-xs text-accent/70">${totalCost.toFixed(6)}</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-milk/50">Speed</p>
          <p className="text-lg font-bold text-purple-400">
            {tokensPerSecond ? `${tokensPerSecond.toFixed(1)}` : '--'}
          </p>
          <p className="text-xs text-purple-400/70">tok/s</p>
        </div>
      </div>
      
      <div className="mt-3">
        <div className="flex justify-between text-xs text-milk/60">
          <span>Context usage</span>
          <span>{contextPercentage.toFixed(1)}%</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-black/30">
          <div 
            className="h-full rounded-full bg-gradient-to-r from-accent to-accent/70 transition-all duration-300"
            style={{ width: `${Math.min(100, contextPercentage)}%` }}
          />
        </div>
      </div>
      
      {vramUsage !== undefined && (
        <div className="mt-3">
          <div className="flex justify-between text-xs text-milk/60">
            <span>VRAM usage</span>
            <span>{vramUsage.toFixed(1)}%</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-black/30">
            <div 
              className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all duration-300"
              style={{ width: `${Math.min(100, vramUsage)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}