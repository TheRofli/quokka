import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, BrainCircuit, ChevronDown, FileText, Image, Paperclip, Pencil, Plus, Send, Sparkles, Trash2, Thermometer, Zap } from "lucide-react";

import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatTimestamp } from "@/lib/utils";
import type { ChatAttachment, ChatCompletionResponse, ChatMessagePayload, ModelView } from "@/types/api";
import { TokenCostPanel } from "./token-cost-panel";
import { ModelInfoCard } from "./model-info-card";
import { SessionAnalytics } from "./session-analytics";
import { EnhancedMessageBubble } from "./enhanced-message-bubble";

type ChatRole = "user" | "assistant";
type ChatMode = "chat";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thinkingContent?: string | null;
  thinkingTokens?: number | null;
  createdAt: string;
  attachments?: ChatAttachment[];
  finishReason?: string | null;
  truncated?: boolean;
  maxTokens?: number;
}

interface ChatSession {
  id: string;
  title: string;
  mode?: ChatMode;
  modelId: string | null;
  messages: ChatMessage[];
  updatedAt: string;
}

interface ChatWorkspaceProps {
  models: ModelView[];
}

const STORAGE_KEY = "quokka.chat.sessions.v1";
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSession(modelId: string | null): ChatSession {
  const now = new Date().toISOString();
  return {
    id: uid("chat"),
    title: "New chat",
    mode: "chat",
    modelId,
    messages: [],
    updatedAt: now,
  };
}

function loadSessions(defaultModelId: string | null): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as ChatSession[]) : [];
    return parsed.length ? parsed.map((session) => ({ ...session, mode: "chat" })) : [createSession(defaultModelId)];
  } catch {
    return [createSession(defaultModelId)];
  }
}

function modelLabel(model: ModelView) {
  const quant = model.artifact?.quantization ? ` ${model.artifact.quantization}` : "";
  return `${model.name}${quant}`;
}

function attachmentIcon(attachment: ChatAttachment) {
  return attachment.mime_type.startsWith("image/") ? Image : FileText;
}

function estimateTokens(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.round(words * 1.35));
}

function ContextRing({ usedTokens, contextSize }: { usedTokens: number; contextSize: number }) {
  const percent = contextSize ? Math.min(100, Math.round((usedTokens / contextSize) * 100)) : 0;
  const free = Math.max(contextSize - usedTokens, 0);
  return (
    <div
      className="group relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line bg-black/25 shadow-[inset_0_0_0_5px_rgba(0,0,0,0.26)]"
      style={{ background: `conic-gradient(rgb(var(--color-accent)) ${percent}%, rgba(255,255,255,0.08) 0)` }}
      title={`Context window: ${percent}% used, ${free} tokens left`}
    >
      <div className="grid h-[27px] w-[27px] place-items-center rounded-full bg-[#151411] text-[10px] font-semibold text-milk/65">
        {percent}
      </div>
      <div className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-56 rounded-lg border border-line bg-[#20201d] px-3 py-3 text-center text-xs leading-5 text-milk/70 shadow-2xl group-hover:block">
        <p className="font-semibold text-milk">Context window</p>
        <p className="mt-1">{percent}% used ({100 - percent}% left)</p>
        <p>{usedTokens} / {contextSize || "unknown"} tokens estimated</p>
        <p className="mt-1 text-milk/42">Response tokens are set beside the ring.</p>
      </div>
    </div>
  );
}

function ThinkingBlock({ content, tokens }: { content: string; tokens?: number | null }) {
  return (
    <details className="group mb-3 rounded-lg border border-line/80 bg-black/15 px-3 py-2" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-milk/70">
        <span className="grid h-6 w-6 place-items-center rounded-full border border-line bg-white/[0.035] text-accent">
          <BrainCircuit className="h-3.5 w-3.5" />
        </span>
        <span>Думаю...</span>
        {tokens ? <span className="text-xs text-milk/35">{tokens} tokens</span> : null}
        <ChevronDown className="ml-auto h-4 w-4 text-milk/35 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 border-l border-line pl-4 text-sm leading-6 text-milk/55">
        <p className="whitespace-pre-wrap">{content}</p>
      </div>
    </details>
  );
}

function splitStreamingReasoning(raw: string) {
  const lower = raw.toLowerCase();
  const start = lower.indexOf("<think>");
  if (start < 0) {
    return { answer: raw, thinking: "" };
  }

  const before = raw.slice(0, start);
  const afterStart = raw.slice(start + "<think>".length);
  const afterLower = afterStart.toLowerCase();
  const end = afterLower.indexOf("</think>");
  if (end < 0) {
    return { answer: before.trimStart(), thinking: afterStart };
  }

  const thinking = afterStart.slice(0, end);
  const afterThinking = afterStart.slice(end + "</think>".length);
  return { answer: `${before}${afterThinking}`.trimStart(), thinking };
}

function estimateThinkingTokens(text: string) {
  return text.trim() ? Math.max(1, Math.round(text.trim().split(/\s+/).length * 1.35)) : 0;
}

function LiveAssistantBubble({
  answer,
  thinking,
  showThinking,
  onShowThinkingChange,
}: {
  answer: string;
  thinking: string;
  showThinking: boolean;
  onShowThinkingChange: (value: boolean) => void;
}) {
  const thinkingTokens = estimateThinkingTokens(thinking);
  return (
    <div className="flex justify-start">
      <div className="max-w-[min(1120px,92%)] rounded-lg border border-line bg-white/[0.035] px-5 py-4 shadow-glow">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-milk/35">
          <Bot className="h-3.5 w-3.5" />
          assistant
          <span className="ml-auto inline-flex items-center gap-1.5 normal-case tracking-normal text-milk/45">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent/70 [animation-delay:160ms]" />
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent/45 [animation-delay:320ms]" />
          </span>
        </div>
        <div className="rounded-lg border border-line/80 bg-black/15 px-3 py-2">
          <label className="flex cursor-pointer select-none items-center gap-2 text-sm font-medium text-milk/70">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(event) => onShowThinkingChange(event.target.checked)}
              className="h-3.5 w-3.5 accent-[rgb(var(--color-accent))]"
            />
            <BrainCircuit className="h-4 w-4 text-accent" />
            Думаю сейчас
            {thinkingTokens ? <span className="text-xs text-milk/35">{thinkingTokens} tokens</span> : null}
          </label>
          {showThinking ? (
            <div className="mt-3 max-h-56 overflow-y-auto border-l border-line pl-4 text-sm leading-6 text-milk/55">
              <p className="whitespace-pre-wrap">{thinking || "Жду reasoning-чанки от локальной модели..."} </p>
            </div>
          ) : null}
        </div>
        {answer ? <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-milk/78">{answer}</p> : null}
      </div>
    </div>
  );
}

async function readAttachment(file: File): Promise<ChatAttachment> {
  if (imageTypes.has(file.type)) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return { name: file.name, mime_type: file.type, data_url: dataUrl };
  }

  const text = await file.text();
  return { name: file.name, mime_type: file.type || "text/plain", text: text.slice(0, 120_000) };
}

export function EnhancedChatWorkspace({ models }: ChatWorkspaceProps) {
  const activeModels = useMemo(
    () => models.filter((model) => ["running", "warming"].includes(model.runtime.status)),
    [models]
  );
  const defaultModelId = activeModels[0]?.id ?? models[0]?.id ?? null;
  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions(defaultModelId));
  const [activeSessionId, setActiveSessionId] = useState(() => sessions[0]?.id ?? "");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [liveAnswer, setLiveAnswer] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [showLiveThinking, setShowLiveThinking] = useState(true);
  const [maxTokensDraft, setMaxTokensDraft] = useState("2048");
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [error, setError] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState("");
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);
  const [vramUsage, setVramUsage] = useState<number | null>(null); // This would come from system metrics
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const sessionModel = models.find((model) => model.id === activeSession?.modelId) ?? null;
  const selectedModel =
    sessionModel && ["running", "warming"].includes(sessionModel.runtime.status)
      ? sessionModel
      : activeModels[0] ?? sessionModel ?? models[0] ?? null;
  const maxTokens = useMemo(() => {
    const parsed = Number(maxTokensDraft);
    return Number.isFinite(parsed) ? Math.min(32768, Math.max(16, parsed || 2048)) : 2048;
  }, [maxTokensDraft]);
  const contextSize = selectedModel?.active_profile?.context_size ?? 0;
  const usedTokens = useMemo(() => {
    const historyTokens =
      activeSession?.messages.reduce((total, message) => total + estimateTokens(message.content), 0) ?? 0;
    const attachmentTokens = attachments.reduce((total, attachment) => total + estimateTokens(attachment.text ?? ""), 0);
    return historyTokens + estimateTokens(draft) + attachmentTokens;
  }, [activeSession?.messages, attachments, draft]);

  // Calculate output tokens from the current response
  const outputTokens = useMemo(() => {
    return estimateTokens(liveAnswer);
  }, [liveAnswer]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    if (!activeSession || !defaultModelId) {
      return;
    }
    const sessionModel = models.find((model) => model.id === activeSession.modelId);
    if (sessionModel && ["running", "warming"].includes(sessionModel.runtime.status)) {
      return;
    }
    if (activeSession.modelId === defaultModelId) {
      return;
    }
    setSessions((current) =>
      current.map((session) => (session.id === activeSession.id ? { ...session, modelId: defaultModelId } : session))
    );
  }, [activeSession, defaultModelId, models]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [activeSession?.messages.length, isSending]);

  const updateSession = (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
    setSessions((current) => current.map((session) => (session.id === sessionId ? updater(session) : session)));
  };

  const newChat = () => {
    const session = createSession(defaultModelId);
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setDraft("");
    setAttachments([]);
  };

  const beginRenameChat = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setEditingTitleDraft(session.title);
  };

  const commitRenameChat = (session: ChatSession) => {
    const nextTitle = editingTitleDraft.trim();
    if (!nextTitle) {
      setEditingSessionId(null);
      return;
    }
    updateSession(session.id, (current) => ({ ...current, title: nextTitle, updatedAt: new Date().toISOString() }));
    setEditingSessionId(null);
    setEditingTitleDraft("");
  };

  const deleteChat = (sessionId: string) => {
    if (!window.confirm("Delete this chat?")) {
      return;
    }
    setSessions((current) => {
      const remaining = current.filter((session) => session.id !== sessionId);
      const nextSessions = remaining.length ? remaining : [createSession(defaultModelId)];
      if (activeSessionId === sessionId) {
        setActiveSessionId(nextSessions[0].id);
        setDraft("");
        setAttachments([]);
      }
      return nextSessions;
    });
  };

  const applyPreset = (preset: string) => {
    switch(preset) {
      case 'creative':
        setTemperature(0.8);
        setTopP(0.95);
        break;
      case 'balanced':
        setTemperature(0.7);
        setTopP(0.9);
        break;
      case 'precise':
        setTemperature(0.2);
        setTopP(0.8);
        break;
      case 'fast':
        setTemperature(0.5);
        setTopP(0.9);
        break;
      default:
        setTemperature(0.7);
        setTopP(0.9);
    }
  };

  const send = async () => {
    if (!activeSession || !selectedModel || (!draft.trim() && !attachments.length)) {
      return;
    }

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: uid("msg"),
      role: "user",
      content: draft.trim() || "Analyze the attached file.",
      createdAt: now,
      attachments,
    };

    const nextMessages = [...activeSession.messages, userMessage];
    updateSession(activeSession.id, (session) => ({
      ...session,
      title: session.messages.length ? session.title : userMessage.content.slice(0, 48),
      messages: nextMessages,
      updatedAt: now,
    }));
    setDraft("");
    setAttachments([]);
    setIsSending(true);
    setLiveAnswer("");
    setLiveThinking("");
    setShowLiveThinking(true);
    setError(null);

    try {
      const payloadMessages: ChatMessagePayload[] = nextMessages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: message.content }));
      let rawContent = "";
      let explicitThinking = "";
      let finalResponse: ChatCompletionResponse | null = null;
      
      // Track timing for tokens per second calculation
      const startTime = Date.now();
      let tokenCount = 0;
      
      await api.streamChatCompletion(
        {
          model_id: selectedModel.id,
          messages: payloadMessages,
          attachments: userMessage.attachments ?? [],
          max_tokens: maxTokens,
          temperature: temperature,
          top_p: topP,
          timeout_seconds: 300,
        },
        (event) => {
          if (event.type === "error") {
            throw new Error(event.detail);
          }
          if (event.type === "thinking_delta") {
            explicitThinking += event.delta;
            setLiveThinking(explicitThinking);
            return;
          }
          if (event.type === "delta") {
            rawContent += event.delta;
            tokenCount++;
            
            // Update tokens per second approximately every 500ms
            if (tokenCount % 10 === 0) { // Update every 10 tokens
              const elapsed = (Date.now() - startTime) / 1000; // in seconds
              if (elapsed > 0) {
                setTokensPerSecond(Math.round(tokenCount / elapsed));
              }
            }
            
            const parsed = splitStreamingReasoning(rawContent);
            setLiveAnswer(parsed.answer);
            if (!explicitThinking) {
              setLiveThinking(parsed.thinking);
            }
            return;
          }
          if (event.type === "done") {
            finalResponse = event.response;
            // Final calculation for tokens per second
            const elapsed = (Date.now() - startTime) / 1000; // in seconds
            if (elapsed > 0) {
              setTokensPerSecond(Math.round(tokenCount / elapsed));
            }
          }
        }
      );

      const parsed = splitStreamingReasoning(rawContent);
      const response =
        finalResponse ??
        ({
          model_id: selectedModel.id,
          model_name: selectedModel.name,
          content: parsed.answer,
          thinking_content: explicitThinking || parsed.thinking || null,
          thinking_tokens_estimate: estimateThinkingTokens(explicitThinking || parsed.thinking),
          created_at: new Date().toISOString(),
          finish_reason: null,
          truncated: false,
          max_tokens: maxTokens,
        } satisfies ChatCompletionResponse);
      const assistantMessage: ChatMessage = {
        id: uid("msg"),
        role: "assistant",
        content: response.content,
        thinkingContent: response.thinking_content,
        thinkingTokens: response.thinking_tokens_estimate,
        createdAt: response.created_at,
        finishReason: response.finish_reason,
        truncated: response.truncated,
        maxTokens: response.max_tokens,
      };
      updateSession(activeSession.id, (session) => ({
        ...session,
        messages: [...session.messages, assistantMessage],
        updatedAt: response.created_at,
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Chat request failed");
    } finally {
      setIsSending(false);
      setLiveAnswer("");
      setLiveThinking("");
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) {
      return;
    }
    const parsed = await Promise.all(Array.from(files).map(readAttachment));
    setAttachments((current) => [...current, ...parsed]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <main className="mt-4 grid min-h-0 flex-1 gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="min-h-[680px] px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-accent">Chat</p>
            <h2 className="mt-1 text-xl font-semibold text-milk">Local threads</h2>
          </div>
          <Button size="icon" variant="secondary" onClick={newChat}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="mt-4 space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-3 transition-colors",
                session.id === activeSession?.id ? "border-accent/45 bg-accent/10" : "border-line bg-white/[0.025] hover:border-accent/25"
              )} 
            >
              {editingSessionId === session.id ? (
                <div className="min-w-0 flex-1">
                  <Input
                    value={editingTitleDraft}
                    onChange={(event) => setEditingTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitRenameChat(session);
                      }
                      if (event.key === "Escape") {
                        setEditingSessionId(null);
                      }
                    }}
                    autoFocus
                    title="Rename this local conversation. Press Enter to save or Escape to cancel."
                  />
                </div>
              ) : (
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setActiveSessionId(session.id)}
                  title="Open this saved local thread."
                >
                  <p className="truncate text-sm font-semibold text-milk">{session.title}</p>
                  <p className="mt-1 text-xs text-milk/40">{formatTimestamp(session.updatedAt)}</p>
                </button>
              )}
              <div className="flex shrink-0 gap-1">
                <Button
                  size="icon"
                  variant="ghost"
                  title="Rename this chat."
                  onClick={(event) => {
                    event.stopPropagation();
                    if (editingSessionId === session.id) {
                      commitRenameChat(session);
                    } else {
                      beginRenameChat(session);
                    }
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Delete this chat from local browser storage."
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteChat(session.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
        
        {/* Add session analytics */}
        {sessions.length > 1 && (
          <div className="mt-4">
            <SessionAnalytics sessions={sessions} />
          </div>
        )}
      </Card>

      <Card className="flex min-h-[680px] flex-col overflow-hidden">
        {/* Model info card */}
        <div className="border-b border-line px-5 py-4">
          {selectedModel && <ModelInfoCard model={selectedModel} />}
        </div>
        
        {/* Token cost panel */}
        <div className="border-b border-line px-5 py-3">
          <TokenCostPanel 
            inputTokens={usedTokens}
            outputTokens={outputTokens}
            model={selectedModel}
            contextSize={contextSize}
            tokensPerSecond={tokensPerSecond || undefined}
            vramUsage={vramUsage || undefined}
          />
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {!activeSession?.messages.length ? (
            <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
              <div className="rounded-lg border border-line bg-white/[0.04] p-4 text-accent">
                <Sparkles className="h-7 w-7" />
              </div>
              <h3 className="mt-4 text-2xl font-semibold text-milk">Ask the local model.</h3>
              <p className="mt-2 max-w-lg text-sm leading-6 text-milk/50">
                Attach code, notes, or an image, then choose the local model from the composer.
              </p>
            </div>
          ) : null}

          {activeSession?.messages.map((message) => (
            <EnhancedMessageBubble key={message.id} message={message} />
          ))}
          {isSending ? (
            <LiveAssistantBubble
              answer={liveAnswer}
              thinking={liveThinking}
              showThinking={showLiveThinking}
              onShowThinkingChange={setShowLiveThinking}
            />
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-line px-5 py-4">
          {error ? <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
          {attachments.length ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((attachment) => {
                const Icon = attachmentIcon(attachment);
                return (
                  <span key={attachment.name} className="inline-flex items-center gap-2 rounded-md border border-line bg-white/[0.04] px-2 py-1 text-xs text-milk/55">
                    <Icon className="h-3.5 w-3.5" />
                    {attachment.name}
                  </span>
                );
              })}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Message Quokka..."
            className="min-h-[92px]"
          />
          
          {/* Advanced controls */}
          <div className="mt-3 border-t border-line/50 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <select 
                  className="h-8 rounded-lg border border-line bg-[#191815] px-2 text-xs text-milk outline-none focus:border-accent/60"
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  <option value="">Presets</option>
                  <option value="creative">Creative</option>
                  <option value="balanced">Balanced</option>
                  <option value="precise">Precise</option>
                  <option value="fast">Fast</option>
                </select>
                
                <div className="flex items-center gap-1">
                  <label htmlFor="temp-slider" className="text-xs text-milk/60">Temp:</label>
                  <input
                    id="temp-slider"
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={temperature}
                    onChange={(e) => setTemperature(parseFloat(e.target.value))}
                    className="w-16"
                  />
                  <span className="text-xs text-milk/70 w-8">{temperature.toFixed(2)}</span>
                </div>
                
                <div className="flex items-center gap-1">
                  <label htmlFor="topp-slider" className="text-xs text-milk/60">Top-P:</label>
                  <input
                    id="topp-slider"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={topP}
                    onChange={(e) => setTopP(parseFloat(e.target.value))}
                    className="w-16"
                  />
                  <span className="text-xs text-milk/70 w-8">{topP.toFixed(2)}</span>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min="1"
                  max="32768"
                  value={maxTokens}
                  onChange={(e) => setMaxTokensDraft(String(parseInt(e.target.value) || 2048))}
                  className="h-8 w-20 text-xs"
                  title="Max tokens for the next response"
                />
                <span className="text-xs text-milk/50">max</span>
              </div>
            </div>
          </div>
          
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void onFiles(event.target.files)} />
              <select
                className="h-9 min-w-[260px] rounded-lg border border-line bg-[#191815] px-3 text-sm text-milk outline-none focus:border-accent/60"
                value={selectedModel?.id ?? ""}
                onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, modelId: event.target.value }))}
                disabled={!activeSession}
                title="Choose which running local endpoint receives this message. Quokka auto-selects the first active model when possible."
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
              <ContextRing usedTokens={usedTokens} contextSize={contextSize || 1} />
              <Input
                type="text"
                inputMode="numeric"
                value={maxTokensDraft}
                onChange={(event) => {
                  const next = event.target.value.replace(/\D/g, "");
                  if (next.length <= 5) {
                    setMaxTokensDraft(next);
                  }
                }}
                onBlur={() => setMaxTokensDraft(String(maxTokens))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setMaxTokensDraft(String(maxTokens));
                    event.currentTarget.blur();
                  }
                }}
                className="h-9 w-28"
                title="max_tokens for the next assistant answer. Raise it if answers are cut off; lower it for faster short replies."
              />
              <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()} title="Attach text files or images for the selected local model to analyze.">
                <Paperclip className="h-4 w-4" />
                Attach
              </Button>
            </div>
            <Button variant="primary" size="sm" disabled={isSending || !selectedModel} onClick={() => void send()} title="Send the message to the selected local model. Enter sends; Shift+Enter inserts a newline.">
              <Send className="h-4 w-4" />
              {isSending ? "Thinking" : "Send"}
            </Button>
            <span className="text-xs text-milk/35">Enter to send · Shift+Enter newline</span>
          </div>
        </div>
      </Card>
    </main>
  );
}