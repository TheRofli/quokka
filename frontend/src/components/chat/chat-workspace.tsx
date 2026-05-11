import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit,
  Download,
  FileText,
  Image,
  MessageSquarePlus,
  Paperclip,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
  Zap,
} from "lucide-react";

import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatTimestamp } from "@/lib/utils";
import type { ChatAttachment, ChatCompletionResponse, ChatMessagePayload, ModelView } from "@/types/api";
import { EnhancedMessageBubble, MarkdownText } from "./enhanced-message-bubble";

type ChatRole = "user" | "assistant";
type ChatMode = "chat";
type ThinkingMode = "instant" | "thinking";
type ChatProfileId = "balanced" | "fast" | "coding" | "deep" | "strict_json";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  thinkingContent?: string | null;
  thinkingTokens?: number | null;
  thinkingMs?: number | null;
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
const SIDEBAR_STORAGE_KEY = "quokka.chat.rightSidebar.open";
const AUTO_MAX_TOKENS_CAP = 16_384;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const quickPrompts = [
  "Explain why this model is slow and what to tune first.",
  "Compare these two local models for coding work.",
  "Rewrite this prompt to be clearer and stricter.",
  "Summarize this llama.cpp log and list fixes.",
];

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

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function deriveAutoMaxTokens(contextSize: number, usedTokens: number, profileDefault?: number | null) {
  if (profileDefault && Number.isFinite(profileDefault) && profileDefault > 0) {
    return clampNumber(profileDefault, 512, 32_768);
  }
  const base = contextSize
    ? clampNumber(Math.round(contextSize * 0.25), 2_048, AUTO_MAX_TOKENS_CAP)
    : 8_192;
  const availableRoom = contextSize ? Math.max(512, contextSize - usedTokens - 256) : base;
  return Math.round(clampNumber(Math.min(base, availableRoom), 512, 32_768));
}

function formatCompactNumber(value?: number | null, fractionDigits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: fractionDigits,
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
  }).format(value);
}

function formatMemoryMb(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(value >= 10 * 1024 ? 1 : 2)} GB`;
  }
  return `${Math.round(value)} MB`;
}

function statusTone(status?: string | null) {
  if (status === "running") {
    return "bg-success text-black";
  }
  if (status === "warming" || status === "starting") {
    return "bg-warning text-black";
  }
  if (status === "failed" || status === "crashed") {
    return "bg-danger text-black";
  }
  return "bg-milk/10 text-milk/60";
}

function sessionBucket(updatedAt: string) {
  const date = new Date(updatedAt);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  const value = date.getTime();
  if (value >= startToday) {
    return "Today";
  }
  if (value >= startYesterday) {
    return "Yesterday";
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function ContextRing({ usedTokens, contextSize }: { usedTokens: number; contextSize: number }) {
  const percent = contextSize ? Math.min(100, Math.round((usedTokens / contextSize) * 100)) : 0;
  const free = Math.max(contextSize - usedTokens, 0);
  return (
    <div
      className="group relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line/80 shadow-[inset_0_0_0_5px_rgba(0,0,0,0.18)]"
      style={{ background: `conic-gradient(rgb(var(--color-accent)) ${percent}%, rgb(var(--color-panel-2)) 0)` }}
      title={`Context window: ${percent}% used, ${free} tokens left`}
    >
      <div className="grid h-[27px] w-[27px] place-items-center rounded-full bg-panel text-[10px] font-semibold text-milk/65">
        {percent}
      </div>
      <div className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-56 rounded-2xl border border-line bg-panel-2 px-3 py-3 text-center text-xs leading-5 text-milk/70 shadow-2xl group-hover:block">
        <p className="font-semibold text-milk">Context window</p>
        <p className="mt-1">{percent}% used ({100 - percent}% left)</p>
        <p>{usedTokens} / {contextSize || "unknown"} tokens estimated</p>
        <p className="mt-1 text-milk/42">Estimated before sending. Attachments count too.</p>
      </div>
    </div>
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
    <div className="w-full">
      <div className="max-w-[min(860px,100%)]">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-milk/44">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
          generating
          {thinkingTokens ? <span>{thinkingTokens} tokens</span> : null}
          <button
            type="button"
            onClick={() => onShowThinkingChange(!showThinking)}
            className="ml-2 rounded-full border border-line/45 px-2 py-0.5 text-[11px] text-milk/48 transition hover:border-accent/45 hover:text-milk"
          >
            {showThinking ? "Hide" : "Show"}
          </button>
        </div>
        {showThinking ? (
          <div className="mb-3 max-h-48 overflow-y-auto border-l border-accent/35 bg-panel/18 py-1 pl-4 text-sm leading-6 text-milk/50">
            <p className="whitespace-pre-wrap">
              {thinking || "Waiting for reasoning chunks from the local model..."}
            </p>
          </div>
        ) : null}
        <div className="border-l border-accent/35 pl-4">
          {answer ? <MarkdownText content={answer} /> : null}
        </div>
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

export function ChatWorkspace({ models }: ChatWorkspaceProps) {
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
  const [showLiveThinking, setShowLiveThinking] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(0.9);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>("instant");
  const [chatProfileId, setChatProfileId] = useState<ChatProfileId>("balanced");
  const [chatSidebarOpen, setChatSidebarOpen] = useState(() => window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "0");
  const [error, setError] = useState<string | null>(null);
  const [promptNotice, setPromptNotice] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitleDraft, setEditingTitleDraft] = useState("");
  const [tokensPerSecond, setTokensPerSecond] = useState<number | null>(null);
  const [enableWebSearch, setEnableWebSearch] = useState(false);
  const [webSearchProvider, setWebSearchProvider] = useState<"duckduckgo" | "tavily">("duckduckgo");
  const [webSearchResults, setWebSearchResults] = useState(3);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const sessionModel = models.find((model) => model.id === activeSession?.modelId) ?? null;
  const selectedModel =
    sessionModel && ["running", "warming"].includes(sessionModel.runtime.status)
      ? sessionModel
      : activeModels[0] ?? sessionModel ?? models[0] ?? null;
  const selectedModelReady = selectedModel ? ["running", "warming"].includes(selectedModel.runtime.status) : false;
  const contextSize = selectedModel?.active_profile?.context_size ?? 0;
  const usedTokens = useMemo(() => {
    const historyTokens =
      activeSession?.messages.reduce((total, message) => total + estimateTokens(message.content), 0) ?? 0;
    const attachmentTokens = attachments.reduce((total, attachment) => total + estimateTokens(attachment.text ?? ""), 0);
    return historyTokens + estimateTokens(draft) + attachmentTokens;
  }, [activeSession?.messages, attachments, draft]);
  const maxTokens = useMemo(
    () => deriveAutoMaxTokens(contextSize, usedTokens, selectedModel?.active_profile?.api_default_completion_max_tokens),
    [contextSize, selectedModel?.active_profile?.api_default_completion_max_tokens, usedTokens]
  );
  const liveTokensPerSecond = isSending ? tokensPerSecond ?? 0 : 0;
  const contextPercent = contextSize ? Math.min(100, (usedTokens / contextSize) * 100) : 0;
  const contextLeft = contextSize ? Math.max(contextSize - usedTokens, 0) : 0;
  const activeSessionTokens = useMemo(
    () => activeSession?.messages.reduce((total, message) => total + estimateTokens(message.content), 0) ?? 0,
    [activeSession?.messages]
  );
  const totalMessages = useMemo(
    () => sessions.reduce((total, session) => total + session.messages.length, 0),
    [sessions]
  );
  const resourceUsage = selectedModel?.runtime.resource_usage;
  const vramDisplay = formatMemoryMb(resourceUsage?.vram_mb);
  const ramDisplay = formatMemoryMb(resourceUsage?.ram_mb);
  const selectedProfile = selectedModel?.active_profile;
  const chatProfile = chatProfiles.find((profile) => profile.id === chatProfileId) ?? chatProfiles[0];
  const modelEndpoint = selectedModel?.endpoint ?? "No endpoint";
  const groupedSessions = useMemo(() => {
    const groups: Array<{ label: string; sessions: ChatSession[] }> = [];
    for (const session of sessions) {
      const label = sessionBucket(session.updatedAt);
      const existing = groups.find((group) => group.label === label);
      if (existing) {
        existing.sessions.push(session);
      } else {
        groups.push({ label, sessions: [session] });
      }
    }
    return groups;
  }, [sessions]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, chatSidebarOpen ? "1" : "0");
  }, [chatSidebarOpen]);

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
    setPromptNotice(null);
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
        setPromptNotice(null);
      }
      return nextSessions;
    });
  };

  const exportActiveChat = () => {
    if (!activeSession) {
      return;
    }
    const lines = [
      `# ${activeSession.title}`,
      "",
      `Model: ${selectedModel?.name ?? "Unknown"}`,
      `Exported: ${new Date().toLocaleString()}`,
      "",
      ...activeSession.messages.flatMap((message) => [
        `## ${message.role === "user" ? "User" : "Quokka assistant"}`,
        message.thinkingContent ? `> Thinking: ${message.thinkingTokens ?? estimateThinkingTokens(message.thinkingContent)} tokens` : "",
        message.content,
        "",
      ]),
    ].filter(Boolean);
    downloadText(`${safeFileName(activeSession.title)}.md`, lines.join("\n"), "text/markdown;charset=utf-8");
    setPromptNotice("Chat exported as Markdown.");
  };

  const stopGeneration = () => {
    if (!abortControllerRef.current) {
      return;
    }
    abortControllerRef.current.abort();
    setPromptNotice("Stopping generation...");
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

  const applyChatProfile = (profileId: ChatProfileId) => {
    const profile = chatProfiles.find((item) => item.id === profileId) ?? chatProfiles[0];
    setChatProfileId(profile.id);
    setTemperature(profile.temperature);
    setTopP(profile.topP);
    setThinkingMode(profile.thinkingMode);
    setPromptNotice(`${profile.label} profile applied.`);
  };

  const send = async () => {
    if (!activeSession || !selectedModelReady || !selectedModel || (!draft.trim() && !attachments.length)) {
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
    setShowLiveThinking(false);
    setTokensPerSecond(0);
    setError(null);
    setPromptNotice(null);

    let rawContent = "";
    let explicitThinking = "";
    let finalResponse: ChatCompletionResponse | null = null;
    const startTime = Date.now();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const modeMessage: ChatMessagePayload = {
        role: "system",
        content:
          thinkingMode === "thinking"
            ? `${chatProfile.system} Use careful reasoning before answering. Keep any final answer clear and practical.`
            : `${chatProfile.system} Answer directly and do not include chain-of-thought or <think> blocks in the final response.`,
      };
      const payloadMessages: ChatMessagePayload[] = [
        modeMessage,
        ...nextMessages
        .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({ role: message.role, content: message.content })),
      ];
      const updateSpeed = () => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed <= 0.15) {
          return;
        }
        const estimatedTokens = estimateTokens(`${rawContent} ${explicitThinking}`);
        setTokensPerSecond(Number((estimatedTokens / elapsed).toFixed(1)));
      };
      
      // Prepare the API request with web search parameters if enabled
      const apiRequest = {
        model_id: selectedModel.id,
        messages: payloadMessages,
        attachments: userMessage.attachments ?? [],
        max_tokens: Math.max(128, Math.round(maxTokens * chatProfile.maxTokenScale)),
        temperature: temperature,
        top_p: topP,
        timeout_seconds: 300,
      };
      
      // Add web search parameters if enabled
      if (enableWebSearch) {
        Object.assign(apiRequest, {
          enable_web_search: true,
          web_search_provider: webSearchProvider,
          web_search_results: webSearchResults,
        });
      }
      
      await api.streamChatCompletion(
        apiRequest,
        (event) => {
          if (event.type === "error") {
            throw new Error(event.detail);
          }
          if (event.type === "thinking_delta") {
            explicitThinking += event.delta;
            setLiveThinking(explicitThinking);
            updateSpeed();
            return;
          }
          if (event.type === "delta") {
            rawContent += event.delta;
            const parsed = splitStreamingReasoning(rawContent);
            setLiveAnswer(parsed.answer);
            if (!explicitThinking) {
              setLiveThinking(parsed.thinking);
            }
            updateSpeed();
            return;
          }
          if (event.type === "done") {
            finalResponse = event.response;
            updateSpeed();
          }
        },
        controller.signal
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
        thinkingMs: Date.now() - startTime,
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
      const aborted =
        controller.signal.aborted ||
        (nextError instanceof DOMException && nextError.name === "AbortError");
      if (aborted) {
        const parsed = splitStreamingReasoning(rawContent);
        const thinkingContent = explicitThinking || parsed.thinking || null;
        const stoppedAt = new Date().toISOString();
        if (parsed.answer.trim() || thinkingContent) {
          updateSession(activeSession.id, (session) => ({
            ...session,
            messages: [
              ...session.messages,
              {
                id: uid("msg"),
                role: "assistant",
                content: parsed.answer.trim() || "Generation stopped.",
                thinkingContent,
                thinkingTokens: estimateThinkingTokens(thinkingContent ?? ""),
                thinkingMs: Date.now() - startTime,
                createdAt: stoppedAt,
                finishReason: "cancelled",
                truncated: false,
                maxTokens,
              },
            ],
            updatedAt: stoppedAt,
          }));
        }
        setPromptNotice("Generation stopped.");
      } else {
        setError(nextError instanceof Error ? nextError.message : "Chat request failed");
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsSending(false);
      setLiveAnswer("");
      setLiveThinking("");
      setTokensPerSecond(0);
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
    <main className="flex h-full min-h-0 flex-1 overflow-hidden bg-transparent text-milk">
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_50%_22%,rgb(var(--color-accent)/0.055),transparent_28%),linear-gradient(180deg,rgb(var(--color-shell)/0.82),rgb(var(--color-surface)/0.68))]">
        {!chatSidebarOpen ? (
          <button
            type="button"
            onClick={() => setChatSidebarOpen(true)}
            className="absolute right-4 top-4 z-20 grid h-10 w-10 place-items-center rounded-full border border-line/55 bg-panel/80 text-milk/60 shadow-glow backdrop-blur hover:bg-milk/8 hover:text-milk"
            title="Open chat sidebar"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        ) : null}
        <header className="flex min-h-[64px] items-center justify-between gap-4 border-b border-line/35 bg-shell/35 px-5 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-accent/14 text-accent">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-milk">{selectedModel?.name ?? "Quokka local chat"}</p>
                <p className="truncate text-xs text-milk/42">{modelEndpoint}</p>
              </div>
            </div>
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            <div className="quokka-pill px-3 py-2 font-mono text-xs text-milk/58">
              tok/s <span className="text-milk">{formatCompactNumber(liveTokensPerSecond, 1)}</span>
            </div>
            <div className="quokka-pill px-3 py-2 font-mono text-xs text-milk/58">
              ctx <span className="text-milk">{contextPercent.toFixed(1)}%</span>
            </div>
            <div className="quokka-pill px-3 py-2 font-mono text-xs text-milk/58">
              vram <span className="text-milk">{vramDisplay}</span>
            </div>
            <div className="quokka-pill px-3 py-2 font-mono text-xs text-milk/58">
              {activeSession?.messages.length ?? 0} msg / {attachments.length} files
            </div>
            {!chatSidebarOpen ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setChatSidebarOpen(true)}
                className="h-11 rounded-full border border-line/55 bg-panel/54 px-3 text-milk/60 hover:bg-milk/8 hover:text-milk"
                title="Open chat sidebar"
              >
                <PanelRightOpen className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
            {!activeSession?.messages.length && !isSending ? (
              <div className="mx-auto flex h-full max-w-4xl flex-col items-center justify-center text-center">
                <div className="mb-5 flex items-center gap-3">
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-accent/18 text-accent shadow-glow">
                    <Zap className="h-6 w-6" />
                  </span>
                  <h1 className="text-2xl font-semibold tracking-[-0.02em] text-milk md:text-3xl">
                    {thinkingMode === "thinking" ? "Quokka thinking mode" : "Quokka instant mode"}
                  </h1>
                </div>
                <div className="inline-flex rounded-full border border-line/60 bg-panel/62 p-1">
                  <button
                    type="button"
                    onClick={() => setThinkingMode("instant")}
                    className={cn(
                      "rounded-full px-5 py-2 text-sm font-semibold transition",
                      thinkingMode === "instant" ? "bg-accent/18 text-accent" : "text-milk/52 hover:text-milk"
                    )}
                  >
                    No thinking
                  </button>
                  <button
                    type="button"
                    onClick={() => setThinkingMode("thinking")}
                    className={cn(
                      "rounded-full px-5 py-2 text-sm font-semibold transition",
                      thinkingMode === "thinking" ? "bg-accent/18 text-accent" : "text-milk/52 hover:text-milk"
                    )}
                  >
                    Thinking
                  </button>
                </div>
                <p className="mt-5 max-w-2xl text-sm leading-6 text-milk/54">
                  Calm local chat for prompts, logs, configs, and model behavior checks. Start a local model first, then use Quokka as a quiet
                  runtime-aware assistant instead of a noisy dashboard.
                </p>
                {!selectedModelReady ? (
                  <div className="mt-5 rounded-full border border-warning/35 bg-warning/10 px-4 py-2 text-sm text-warning">
                    Selected model is {selectedModel?.runtime.status ?? "offline"}. Start it in Local Panel before chatting.
                  </div>
                ) : null}
                <div className="mt-6 flex max-w-3xl flex-wrap justify-center gap-2">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      onClick={() => setDraft(prompt)}
                      disabled={!selectedModelReady}
                      className="rounded-full border border-line/60 bg-panel/48 px-3 py-2 text-sm text-milk/62 transition hover:border-accent/45 hover:text-milk disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
                <div className="mt-7 grid w-full max-w-3xl gap-2 text-left md:grid-cols-3">
                  {[
                    ["Runtime-aware", "Quokka keeps model status, ctx, and VRAM nearby."],
                    ["Quiet by default", "Instant answers first, thinking details only when you ask."],
                    ["Local context", "Attach logs, configs, snippets, or images when needed."],
                  ].map(([title, body]) => (
                    <div key={title} className="rounded-2xl border border-line/40 bg-panel/28 px-4 py-3">
                      <p className="text-sm font-semibold text-milk">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-milk/45">{body}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4">
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
          </div>

          <div className="border-t border-line/35 bg-shell/78 px-4 py-4 backdrop-blur md:px-8">
            <div className="mx-auto w-full max-w-[860px]">
              {error ? (
                <div className="mb-3 flex items-start gap-2 rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                  <X className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              ) : null}

              {promptNotice ? (
                <div className="mb-3 rounded-2xl border border-accent/35 bg-accent/10 px-3 py-2 text-sm text-milk/68">
                  {promptNotice}
                </div>
              ) : null}

              {attachments.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                  {attachments.map((attachment) => {
                    const Icon = attachmentIcon(attachment);
                    return (
                      <span
                        key={attachment.name}
                        className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/12 px-3 py-1.5 text-xs text-milk/78"
                      >
                        <Icon className="h-3.5 w-3.5 text-accent" />
                        {attachment.name}
                      </span>
                    );
                  })}
                </div>
              ) : null}

              <div className="rounded-[26px] border border-line/50 bg-panel-2/72 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.26)]">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={selectedModelReady ? `Message ${selectedModel?.name || "Quokka local model"}...` : "Start a model in Local Panel before chatting..."}
                  disabled={!selectedModelReady}
                  className="min-h-[104px] resize-none border-0 bg-transparent px-3 py-3 text-base leading-7 text-milk shadow-none outline-none placeholder:text-milk/34 focus-visible:ring-0"
                />

                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line/35 pt-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="inline-flex rounded-full border border-line/55 bg-shell/42 p-1">
                      <button
                        type="button"
                        onClick={() => setThinkingMode("instant")}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                          thinkingMode === "instant" ? "bg-accent/18 text-accent" : "text-milk/50 hover:text-milk"
                        )}
                      >
                        Instant
                      </button>
                      <button
                        type="button"
                        onClick={() => setThinkingMode("thinking")}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                          thinkingMode === "thinking" ? "bg-accent/18 text-accent" : "text-milk/50 hover:text-milk"
                        )}
                      >
                        Think
                      </button>
                    </div>
                    <select
                      className="h-9 max-w-[260px] rounded-full border border-line/55 bg-shell/48 px-3 text-sm text-milk outline-none focus:border-accent/70"
                      value={selectedModel?.id ?? ""}
                      onChange={(event) => {
                        if (activeSession) {
                          updateSession(activeSession.id, (session) => ({ ...session, modelId: event.target.value }));
                        }
                      }}
                      disabled={!activeSession}
                    >
                      {models.map((model) => (
                        <option key={model.id} value={model.id} className="bg-panel">
                          {modelLabel(model)}
                        </option>
                      ))}
                    </select>

                    <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => void onFiles(event.target.files)} />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      className="h-9 rounded-full border border-line/55 px-3 text-milk/60 hover:bg-milk/8 hover:text-milk"
                      title="Attach files"
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    <ContextRing usedTokens={usedTokens} contextSize={contextSize} />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPromptNotice(
                          "Prompt improver is a placeholder for now. Next pass can rewrite your draft before sending."
                        )
                      }
                      className="grid h-10 w-10 place-items-center rounded-full border border-accent/35 bg-accent/12 text-accent transition hover:bg-accent/18"
                      title="Improve prompt (coming soon)"
                    >
                      <Wand2 className="h-4 w-4" />
                    </button>
                    {isSending ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={stopGeneration}
                        className="h-10 rounded-full border-warning/45 bg-warning/12 px-4 text-warning hover:bg-warning/18"
                      >
                        <Square className="mr-1.5 h-4 w-4" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!selectedModelReady}
                        onClick={() => void send()}
                        className="h-10 rounded-full bg-accent px-4 text-black hover:bg-accent/90"
                      >
                        <Send className="mr-1.5 h-4 w-4" />
                        Send
                      </Button>
                    )}
                  </div>
                </div>

              </div>
            </div>
          </div>
        </div>
      </section>
      {chatSidebarOpen ? (
        <aside className="hidden w-[326px] shrink-0 flex-col border-l border-line/45 bg-surface/82 md:flex">
          <div className="px-5 pb-4 pt-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-accent">Quokka</p>
                <h2 className="mt-1 text-xl font-semibold text-milk">Chat</h2>
              </div>
              <div className="flex items-center gap-1">
                <Button type="button" size="icon" variant="ghost" onClick={newChat} className="h-9 w-9 rounded-full text-milk/55 hover:bg-milk/8 hover:text-milk" title="New chat">
                  <Plus className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={exportActiveChat} disabled={!activeSession?.messages.length} className="h-9 w-9 rounded-full text-milk/55 hover:bg-milk/8 hover:text-milk disabled:opacity-35" title="Export chat">
                  <Download className="h-4 w-4" />
                </Button>
                <Button type="button" size="icon" variant="ghost" onClick={() => setChatSidebarOpen(false)} className="h-9 w-9 rounded-full text-milk/55 hover:bg-milk/8 hover:text-milk" title="Close chat sidebar">
                  <PanelRightClose className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <button type="button" onClick={newChat} className="mt-7 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-milk/12 text-sm font-semibold text-milk transition hover:bg-milk/18">
              <MessageSquarePlus className="h-4 w-4" />
              New chat
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {groupedSessions.map((group) => (
              <section key={group.label} className="mt-5 first:mt-2">
                <p className="px-3 text-xs font-semibold text-milk/42">{group.label}</p>
                <div className="mt-2 space-y-1">
                  {group.sessions.map((session) => {
                    const isActive = session.id === activeSession?.id;
                    return (
                      <div
                        key={session.id}
                        className={cn(
                          "group flex cursor-pointer items-center gap-2 rounded-2xl px-3 py-2.5 text-sm transition",
                          isActive ? "bg-milk/12 text-milk shadow-[inset_0_0_0_1px_rgb(var(--color-line)/0.35)]" : "text-milk/68 hover:bg-milk/7 hover:text-milk"
                        )}
                        onClick={() => setActiveSessionId(session.id)}
                      >
                        <div className="min-w-0 flex-1">
                          {editingSessionId === session.id ? (
                            <Input
                              value={editingTitleDraft}
                              autoFocus
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setEditingTitleDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  commitRenameChat(session);
                                }
                                if (event.key === "Escape") {
                                  setEditingSessionId(null);
                                }
                              }}
                              onBlur={() => commitRenameChat(session)}
                              className="h-7 rounded-lg border-line/60 bg-panel-2 px-2 text-xs text-milk"
                            />
                          ) : (
                            <>
                              <p className="truncate font-medium">{session.title}</p>
                              <p className="mt-0.5 truncate text-xs text-milk/36">{formatTimestamp(session.updatedAt)}</p>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button type="button" onClick={(event) => { event.stopPropagation(); beginRenameChat(session); }} className="grid h-7 w-7 place-items-center rounded-full text-milk/45 hover:bg-milk/10 hover:text-milk" title="Rename chat">
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button type="button" onClick={(event) => { event.stopPropagation(); deleteChat(session.id); }} className="grid h-7 w-7 place-items-center rounded-full text-milk/45 hover:bg-danger/15 hover:text-danger" title="Delete chat">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="border-t border-line/45 p-4">
            <div className="rounded-2xl border border-line/45 bg-shell/28 p-3">
              <div className="flex items-center gap-2">
                <span className={cn("h-2.5 w-2.5 rounded-full", selectedModel?.runtime.status === "running" ? "bg-success" : "bg-warning")} />
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-milk">{selectedModel?.name ?? "No model selected"}</p>
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase", statusTone(selectedModel?.runtime.status))}>
                  {selectedModel?.runtime.status ?? "offline"}
                </span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-milk/52">
                <span>{sessions.length} chats</span>
                <span className="text-right">{totalMessages} messages</span>
                <span>{formatCompactNumber(liveTokensPerSecond, 1)} tok/s</span>
                <span className="text-right">{vramDisplay} VRAM</span>
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-line/45 bg-shell/28 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-milk/38">Prompt controls</p>
                <ContextRing usedTokens={usedTokens} contextSize={contextSize} />
              </div>

              <label className="mt-3 block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-milk/38">Chat profile</span>
                <select
                  className="h-9 w-full rounded-full border border-line/60 bg-panel px-3 text-xs text-milk outline-none focus:border-accent/70"
                  value={chatProfileId}
                  onChange={(event) => applyChatProfile(event.target.value as ChatProfileId)}
                >
                  {chatProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id} className="bg-panel">
                      {profile.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-3 inline-flex w-full rounded-full border border-line/60 bg-panel/62 p-1">
                <button type="button" onClick={() => setThinkingMode("instant")} className={cn("flex-1 rounded-full px-3 py-2 text-xs font-semibold transition", thinkingMode === "instant" ? "bg-accent/18 text-accent" : "text-milk/52 hover:text-milk")}>
                  No thinking
                </button>
                <button type="button" onClick={() => setThinkingMode("thinking")} className={cn("flex-1 rounded-full px-3 py-2 text-xs font-semibold transition", thinkingMode === "thinking" ? "bg-accent/18 text-accent" : "text-milk/52 hover:text-milk")}>
                  Thinking
                </button>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl bg-panel/45 p-2 text-xs text-milk/52">
                <span><b className="block text-milk/78">{formatCompactNumber(usedTokens)}</b>input</span>
                <span><b className="block text-milk/78">{formatCompactNumber(contextLeft)}</b>ctx left</span>
                <span><b className="block text-milk/78">{attachments.length}</b>files</span>
              </div>

              <div className="mt-3 space-y-3 text-xs text-milk/58">
                <label className="flex items-center gap-2">
                  <span className="w-12 text-milk/42">Temp</span>
                  <input id="temp-slider" type="range" min="0" max="2" step="0.01" value={temperature} onChange={(event) => setTemperature(parseFloat(event.target.value))} className="min-w-0 flex-1 accent-[rgb(var(--color-accent))]" />
                  <span className="w-9 text-right text-milk/74">{temperature.toFixed(2)}</span>
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-12 text-milk/42">Top-P</span>
                  <input id="topp-slider" type="range" min="0" max="1" step="0.01" value={topP} onChange={(event) => setTopP(parseFloat(event.target.value))} className="min-w-0 flex-1 accent-[rgb(var(--color-accent))]" />
                  <span className="w-9 text-right text-milk/74">{topP.toFixed(2)}</span>
                </label>
              </div>

              <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                <select className="h-9 rounded-full border border-line/60 bg-panel px-3 text-xs text-milk outline-none focus:border-accent/70" onChange={(event) => applyPreset(event.target.value)} defaultValue="">
                  <option value="" className="bg-panel">Preset</option>
                  <option value="creative" className="bg-panel">Creative</option>
                  <option value="balanced" className="bg-panel">Balanced</option>
                  <option value="precise" className="bg-panel">Precise</option>
                  <option value="fast" className="bg-panel">Fast</option>
                </select>
                <span className="flex h-9 items-center rounded-full border border-line/60 bg-panel px-3 text-xs text-milk/62" title="Auto-derived from the selected model context window.">
                  {formatCompactNumber(maxTokens)} auto max
                </span>
              </div>

              <div className="mt-3 grid gap-1 text-[11px] text-milk/38">
                <span>Profile: {selectedProfile?.name ?? "default"}</span>
                <span>Batch: {selectedProfile?.batch_size ?? "--"} / u{selectedProfile?.ubatch_size ?? "--"}</span>
                <span>RAM: {ramDisplay}</span>
                <span>Session: {formatCompactNumber(activeSessionTokens)} tokens</span>
              </div>
            </div>

            <div className="mt-3 rounded-2xl border border-line/45 bg-shell/28 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-milk/38">Web search</p>
                  <p className="mt-1 text-xs text-milk/38">Optional retrieval before the local model answers.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setEnableWebSearch((value) => !value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
                    enableWebSearch ? "border-live/45 bg-live/12 text-live" : "border-line/55 text-milk/45 hover:text-milk"
                  )}
                >
                  {enableWebSearch ? "On" : "Off"}
                </button>
              </div>
              {enableWebSearch ? (
                <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
                  <select
                    className="h-9 rounded-full border border-line/60 bg-panel px-3 text-xs text-milk outline-none focus:border-accent/70"
                    value={webSearchProvider}
                    onChange={(event) => setWebSearchProvider(event.target.value as "duckduckgo" | "tavily")}
                  >
                    <option value="duckduckgo" className="bg-panel">DuckDuckGo</option>
                    <option value="tavily" className="bg-panel">Tavily</option>
                  </select>
                  <select
                    className="h-9 rounded-full border border-line/60 bg-panel px-3 text-xs text-milk outline-none focus:border-accent/70"
                    value={webSearchResults}
                    onChange={(event) => setWebSearchResults(parseInt(event.target.value, 10))}
                  >
                    {[1, 2, 3, 4, 5].map((num) => (
                      <option key={num} value={num} className="bg-panel">{num}</option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          </div>
        </aside>
      ) : null}
    </main>
  );
}

function safeFileName(value: string) {
  return (value || "quokka-chat")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "quokka-chat";
}

function downloadText(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

const chatProfiles: Array<{
  id: ChatProfileId;
  label: string;
  temperature: number;
  topP: number;
  thinkingMode: ThinkingMode;
  maxTokenScale: number;
  system: string;
}> = [
  {
    id: "balanced",
    label: "Balanced",
    temperature: 0.7,
    topP: 0.9,
    thinkingMode: "instant",
    maxTokenScale: 1,
    system: "Be helpful, concise, and practical. Match the user's language.",
  },
  {
    id: "fast",
    label: "Fast answer",
    temperature: 0.45,
    topP: 0.86,
    thinkingMode: "instant",
    maxTokenScale: 0.55,
    system: "Answer quickly and directly. Prefer short practical responses.",
  },
  {
    id: "coding",
    label: "Coding",
    temperature: 0.18,
    topP: 0.88,
    thinkingMode: "thinking",
    maxTokenScale: 1.2,
    system: "Focus on code correctness. Explain assumptions, edge cases, commands, and verification steps.",
  },
  {
    id: "deep",
    label: "Deep reasoning",
    temperature: 0.35,
    topP: 0.92,
    thinkingMode: "thinking",
    maxTokenScale: 1.6,
    system: "Reason carefully before answering. Provide structured, high-signal explanations without unnecessary verbosity.",
  },
  {
    id: "strict_json",
    label: "Strict JSON",
    temperature: 0.05,
    topP: 0.75,
    thinkingMode: "instant",
    maxTokenScale: 1,
    system: "Return valid JSON only. Do not include markdown fences, comments, or prose outside JSON.",
  },
];
