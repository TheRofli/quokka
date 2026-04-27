import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTimestamp } from "@/lib/utils";
import type { ChatSession } from "@/types/api";

interface SessionAnalyticsProps {
  sessions: ChatSession[];
}

// Helper function to estimate tokens (similar to the one in the original chat workspace)
function estimateTokens(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.round(words * 1.35));
}

export function SessionAnalytics({ sessions }: SessionAnalyticsProps) {
  // Calculate total statistics across all sessions
  const totalTokens = sessions.reduce((sum, session) => {
    return sum + session.messages.reduce((msgSum, msg) => {
      return msgSum + estimateTokens(msg.content);
    }, 0);
  }, 0);
  
  const totalMessages = sessions.reduce((sum, session) => sum + session.messages.length, 0);
  const activeSessions = sessions.filter(session => session.messages.length > 0).length;
  
  // Calculate total cost across all sessions (using pricing if available)
  const totalCost = sessions.reduce((sum, session) => {
    // This would require actual model pricing information to calculate properly
    // For now, we'll return 0 but this could be enhanced with real pricing data
    return sum;
  }, 0);
  
  return (
    <div className="rounded-xl border border-line/60 bg-gradient-to-br from-white/[0.03] to-white/[0.01] p-4">
      <h3 className="text-lg font-semibold text-milk">Session Analytics</h3>
      
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="text-center p-3 rounded-lg bg-black/20">
          <p className="text-2xl font-bold text-accent">{sessions.length}</p>
          <p className="text-sm text-milk/60">Total Chats</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/20">
          <p className="text-2xl font-bold text-blue-400">{totalMessages}</p>
          <p className="text-sm text-milk/60">Total Messages</p>
        </div>
        <div className="text-center p-3 rounded-lg bg-black/20">
          <p className="text-2xl font-bold text-green-400">{totalTokens.toLocaleString()}</p>
          <p className="text-sm text-milk/60">Total Tokens</p>
        </div>
      </div>
      
      <div className="mt-4">
        <h4 className="text-sm font-medium text-milk/80 mb-2">Recent Sessions</h4>
        <div className="space-y-2 max-h-60 overflow-y-auto">
          {sessions.slice(0, 5).map((session) => {
            const sessionTokens = session.messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
            const modelId = session.modelId ? session.modelId.split('-')[0] : 'unknown';
            
            return (
              <div 
                key={session.id} 
                className="flex justify-between items-center p-2 rounded border border-line/30 hover:bg-white/[0.02]"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-milk/80 truncate">{session.title}</span>
                    <Badge variant="neutral" className="text-xs capitalize">
                      {modelId}
                    </Badge>
                  </div>
                  <p className="text-xs text-milk/50">{formatTimestamp(session.updatedAt)}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-milk/70">
                    {session.messages.length} msg • {sessionTokens.toLocaleString()} tok
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}