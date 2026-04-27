import { type ChangeEvent, type ClipboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Bot,
  BrainCircuit,
  ChevronDown,
  CheckCircle2,
  Circle,
  Code2,
  Edit3,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  GitCompare,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatTimestamp } from "@/lib/utils";
import type { AgentRunResponse, AgentRunStatusResponse, AgentSettings, AgentWorkspaceReviewResponse, ChatAttachment, ModelView } from "@/types/api";

interface AgentLabProps {
  models: ModelView[];
}

interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: ChatAttachment[];
  run?: AgentRunResponse;
  runId?: string;
}

interface WorkspaceThread {
  id: string;
  title: string;
  updatedAt: string;
  messages: AgentMessage[];
}

interface WorkspaceRoot {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
  threads: WorkspaceThread[];
}

type DirectoryInput = HTMLInputElement & { webkitdirectory?: boolean };
type LocalFile = File & { path?: string; webkitRelativePath?: string };
type AgentSettingSetter = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => void;

declare global {
  interface Window {
    quokkaDesktop?: {
      openFolder: () => Promise<string | null>;
      openWorkspace?: (folderPath: string, target: string) => Promise<{ ok: boolean; message: string }>;
      openTerminal?: (folderPath: string) => Promise<{ ok: boolean; message: string }>;
    };
  }
}

const WORKSPACE_STORAGE_KEY = "quokka.agent.workspaces.v2";
const LEGACY_WORKSPACE_STORAGE_KEY = "quokka.agent.workspaces.v1";
const SETTINGS_STORAGE_KEY = "quokka.agent.settings.v1";
const DEFAULT_SETTINGS: AgentSettings = {
  agent_max_tokens: 4096,
  patch_max_tokens: 4096,
  context_budget_percent: 72,
  auto_compact: true,
  keep_last_messages: 12,
  file_context_limit_kb: 4096,
  approval_mode: "auto_readonly",
};

const ATTACHMENT_LIMIT = 12;
const ATTACHMENT_TEXT_LIMIT = 120_000;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "generating_patch", "applying_patch", "reviewing"]);
const TEXT_ATTACHMENT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "text/css",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/xml",
]);

function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function modelLabel(model: ModelView) {
  const quant = model.artifact?.quantization ? ` ${model.artifact.quantization}` : "";
  return `${model.name}${quant}`;
}

function estimateTokens(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, Math.round(words * 1.35));
}

function shortPath(path: string, max = 58) {
  if (path.length <= max) {
    return path;
  }
  return `...${path.slice(-(max - 3))}`;
}

function summarizeTask(prompt: string) {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (!clean) {
    return "Пользователь готовит новую задачу для локального агента.";
  }
  const clipped = clean.length > 150 ? `${clean.slice(0, 150)}...` : clean;
  return `Пользователь просит: ${clipped}`;
}

function approvalModeCopy(mode: AgentSettings["approval_mode"]) {
  if (mode === "auto_readonly") {
    return "Read-only planning: Quokka scans the workspace, suggests likely files, and returns a plan without writing files.";
  }
  if (mode === "review") {
    return "Review mode: Quokka generates a plan, then waits for your approval before writing changes to disk.";
  }
  return "Manual mode: every file write requires explicit approval.";
}

function workspaceId(path: string) {
  return path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `workspace-${Date.now()}`;
}

function baseName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function inferDirectoryFromFile(file: LocalFile) {
  const relativePath = file.webkitRelativePath || file.name;
  const rootName = relativePath.split(/[\\/]/)[0] || "Local folder";
  if (file.path && file.webkitRelativePath && file.path.endsWith(file.webkitRelativePath)) {
    const path = file.path.slice(0, file.path.length - file.webkitRelativePath.length).replace(/[\\/]+$/, "");
    return { name: rootName, path: path || rootName };
  }
  return { name: rootName, path: rootName };
}

function compactError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Agent request failed.";
  }
}

function normalizeMessage(raw: unknown): AgentMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const item = raw as Partial<AgentMessage>;
  if (item.role !== "user" && item.role !== "assistant") {
    return null;
  }
  return {
    id: typeof item.id === "string" ? item.id : uid("agent-msg"),
    role: item.role,
    content: typeof item.content === "string" ? item.content : "",
    createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
    attachments: Array.isArray(item.attachments) ? item.attachments : [],
    run: item.run,
    runId: typeof item.runId === "string" ? item.runId : undefined,
  };
}

function normalizeWorkspaces(raw: unknown): WorkspaceRoot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry, index) => {
      const item = entry as Partial<WorkspaceRoot>;
      if (!item || typeof item !== "object" || typeof item.path !== "string") {
        return null;
      }
      const threads = Array.isArray(item.threads)
        ? item.threads.map((thread) => {
            const source = thread as Partial<WorkspaceThread>;
            return {
              id: typeof source.id === "string" ? source.id : uid("agent-thread"),
              title: typeof source.title === "string" ? source.title : "New local task",
              updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
              messages: Array.isArray(source.messages)
                ? source.messages.map(normalizeMessage).filter((message): message is AgentMessage => Boolean(message))
                : [],
            } satisfies WorkspaceThread;
          })
        : [];
      return {
        id: typeof item.id === "string" ? item.id : workspaceId(item.path || `workspace-${index}`),
        name: typeof item.name === "string" ? item.name : baseName(item.path),
        path: item.path,
        lastOpenedAt: typeof item.lastOpenedAt === "string" ? item.lastOpenedAt : new Date().toISOString(),
        threads,
      } satisfies WorkspaceRoot;
    })
    .filter((item): item is WorkspaceRoot => Boolean(item));
}

function readStoredWorkspaces() {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY);
    return raw ? normalizeWorkspaces(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function readStoredSettings() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    const parsed = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AgentSettings>) };
    if (parsed.file_context_limit_kb === 80) {
      parsed.file_context_limit_kb = DEFAULT_SETTINGS.file_context_limit_kb;
    }
    if (parsed.agent_max_tokens === 2048) {
      parsed.agent_max_tokens = DEFAULT_SETTINGS.agent_max_tokens;
    }
    if (!parsed.approval_mode || !["auto_readonly", "review", "manual"].includes(parsed.approval_mode)) {
      parsed.approval_mode = "auto_readonly";
    }
    return parsed;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function upsertWorkspace(current: WorkspaceRoot[], name: string, path: string) {
  const id = workspaceId(path);
  const existing = current.find((item) => item.id === id);
  if (existing) {
    return current.map((item) => (item.id === id ? { ...item, name, path, lastOpenedAt: new Date().toISOString() } : item));
  }
  return [{ id, name, path, lastOpenedAt: new Date().toISOString(), threads: [] }, ...current].slice(0, 16);
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment."));
    reader.readAsDataURL(file);
  });
}

async function readAttachment(file: File): Promise<ChatAttachment> {
  const mimeType = file.type || "application/octet-stream";
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
    return {
      name: file.name,
      mime_type: mimeType,
      data_url: await readFileAsDataUrl(file),
    };
  }
  if (mimeType.startsWith("text/") || TEXT_ATTACHMENT_TYPES.has(mimeType) || /\.(md|txt|json|yaml|yml|csv|ts|tsx|js|jsx|py|css|html|xml)$/i.test(file.name)) {
    const text = await file.text();
    return {
      name: file.name,
      mime_type: mimeType,
      text: text.slice(0, ATTACHMENT_TEXT_LIMIT),
    };
  }
  return {
    name: file.name,
    mime_type: mimeType,
    data_url: await readFileAsDataUrl(file),
  };
}

function attachmentIcon(attachment: ChatAttachment) {
  if (attachment.mime_type.startsWith("image/")) {
    return ImageIcon;
  }
  return FileText;
}

function NumericSetting({
  label,
  value,
  min,
  max,
  onChange,
  title,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  title: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const clamp = (nextValue: number) => Math.min(max, Math.max(min, nextValue || min));
  const commit = () => {
    const parsed = Number(draft);
    const nextValue = Number.isFinite(parsed) ? clamp(parsed) : value;
    setDraft(String(nextValue));
    onChange(nextValue);
  };

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <label className="block min-w-0" title={title}>
      <span className="mb-1.5 block truncate text-[10px] uppercase tracking-[0.16em] text-milk/42">{label}</span>
      <Input
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(event) => {
          const next = event.target.value.replace(/\D/g, "");
          if (next.length <= 6) {
            setDraft(next);
          }
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
        className="h-10 text-base"
      />
    </label>
  );
}

function ContextSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-line bg-white/[0.03]">
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-3 text-[11px] uppercase tracking-[0.2em] text-milk/38">
        {title}
        <ChevronDown className="h-4 w-4 text-milk/35 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line/70 px-3 py-3">{children}</div>
    </details>
  );
}

function MiniContextRing({
  usedTokens,
  contextSize,
  responseTokens,
}: {
  usedTokens: number;
  contextSize: number;
  responseTokens: number;
}) {
  const safeContext = Math.max(contextSize, 1);
  const percent = Math.min(100, Math.round((usedTokens / safeContext) * 100));
  const left = Math.max(safeContext - usedTokens, 0);
  return (
    <div
      className="group relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line bg-black/25 shadow-[inset_0_0_0_5px_rgba(0,0,0,0.26)]"
      style={{
        background: `conic-gradient(rgb(var(--color-accent)) ${percent}%, rgba(255,255,255,0.08) 0)`,
      }}
      title={`Context window: ${percent}% used, ${left} tokens left`}
    >
      <div className="grid h-[27px] w-[27px] place-items-center rounded-full bg-[#151411] text-[10px] font-semibold text-milk/65">
        {percent}
      </div>
      <div className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-56 rounded-lg border border-line bg-[#20201d] px-3 py-3 text-center text-xs leading-5 text-milk/70 shadow-2xl group-hover:block">
        <p className="font-semibold text-milk">Context window</p>
        <p className="mt-1">{percent}% used ({100 - percent}% left)</p>
        <p>{usedTokens} / {safeContext} tokens estimated</p>
        <p className="mt-1 text-milk/42">Response budget: {responseTokens} tokens</p>
      </div>
    </div>
  );
}

const OPEN_TARGETS = [
  { id: "vscode", label: "VS Code", icon: "▰" },
  { id: "visualstudio", label: "Visual Studio", icon: "◆" },
  { id: "cursor", label: "Cursor", icon: "◈" },
  { id: "explorer", label: "File Explorer", icon: "▣" },
  { id: "gitbash", label: "Git Bash", icon: "◇" },
  { id: "androidstudio", label: "Android Studio", icon: "△" },
  { id: "idea", label: "IntelliJ IDEA", icon: "▥" },
  { id: "pycharm", label: "PyCharm", icon: "▤" },
] as const;

function OpenWorkspaceMenu({
  workspace,
  onMessage,
}: {
  workspace: WorkspaceRoot | null;
  onMessage: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const openTarget = async (target: string) => {
    setOpen(false);
    if (!workspace) {
      onMessage("Open a workspace folder first.");
      return;
    }
    const result = await window.quokkaDesktop?.openWorkspace?.(workspace.path, target);
    if (!result?.ok) {
      onMessage(result?.message ?? "Desktop wrapper could not open this app. Try File Explorer or check PATH.");
    } else {
      onMessage(null);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-line/80 bg-white/[0.03] px-3 text-sm font-semibold text-milk/68 transition hover:border-accent/40 hover:text-milk disabled:opacity-40"
        disabled={!workspace}
        onClick={() => setOpen((value) => !value)}
        title="Open this workspace in an external editor or file manager."
      >
        <Code2 className="h-4 w-4 text-accent" />
        Open in
        <ChevronDown className="h-3.5 w-3.5 text-milk/35" />
      </button>
      {open ? (
        <div className="absolute right-0 top-11 z-30 w-56 rounded-lg border border-line bg-[#20201d] p-1 shadow-2xl">
          {OPEN_TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-milk/74 hover:bg-white/[0.06] hover:text-milk"
              onClick={() => void openTarget(target.id)}
            >
              <span className="grid h-5 w-5 place-items-center rounded bg-white/[0.05] text-xs text-accent">{target.icon}</span>
              {target.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingBlock({ run }: { run: AgentRunResponse }) {
  if (!run.thinking_content) {
    return null;
  }
  return (
    <details className="mb-3 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-milk/70">
        <BrainCircuit className="h-4 w-4 text-accent" />
        Thinking trace
        {run.thinking_tokens_estimate ? <span className="text-xs text-milk/38">{run.thinking_tokens_estimate} tokens</span> : null}
        <ChevronDown className="ml-auto h-4 w-4 text-milk/35" />
      </summary>
      <p className="mt-3 whitespace-pre-wrap border-l border-accent/35 pl-4 text-sm leading-6 text-milk/56">{run.thinking_content}</p>
    </details>
  );
}

function LiveAgentTrace({
  workspace,
  model,
  attachmentCount,
  promptText,
  settings,
}: {
  workspace: WorkspaceRoot | null;
  model: ModelView | null;
  attachmentCount: number;
  promptText: string;
  settings: AgentSettings;
}) {
  return (
    <details open className="max-w-[min(980px,92%)] rounded-lg border border-accent/25 bg-white/[0.045] px-4 py-3 text-sm text-milk/68 shadow-glow">
      <summary className="flex cursor-pointer list-none items-center gap-3">
        <span className="inline-flex gap-1">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent/70 [animation-delay:160ms]" />
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent/45 [animation-delay:320ms]" />
        </span>
        Agent is working...
        <ChevronDown className="ml-auto h-4 w-4 text-milk/35" />
      </summary>
      <div className="mt-4 space-y-2 border-l border-accent/25 pl-4 text-xs leading-5 text-milk/52">
        <p className="text-milk/72">{summarizeTask(promptText)}</p>
        <p>1. Проверяю workspace: {workspace?.name ?? "folder"}.</p>
        <p>2. Собираю релевантные файлы и сжимаю их под окно контекста.</p>
        <p>3. Запрашиваю {model ? modelLabel(model) : "selected local model"} в режиме: {approvalModeCopy(settings.approval_mode)}</p>
        {attachmentCount ? <p>4. Добавляю {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"} в пакет задачи.</p> : null}
        <p className="text-milk/35">Живой внутренний &lt;think&gt; появится тут только после перехода Agent API на streaming; сейчас endpoint возвращает reasoning одним финальным ответом.</p>
      </div>
    </details>
  );
}

function AgentRunPanel({ run }: { run: AgentRunResponse }) {
  return (
    <div className="mt-3 space-y-3">
      <div className="inline-flex items-center rounded-full border border-accent/35 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
        Read-only plan
      </div>
      {run.warning ? (
        <div className="rounded-lg border border-warning/45 bg-warning/10 px-3 py-2 text-xs leading-5 text-milk/70 whitespace-pre-wrap">
          {run.warning}
        </div>
      ) : null}
      <div className="grid gap-2 text-xs text-milk/48 md:grid-cols-3">
        <span className="rounded-md border border-line bg-black/15 px-2 py-1">
          files {run.included_files.length}/{run.inspected_files.length}
        </span>
        <span className="rounded-md border border-line bg-black/15 px-2 py-1">
          context {run.used_context_tokens_estimate}/{run.context_budget_tokens}
        </span>
        <span className="rounded-md border border-line bg-black/15 px-2 py-1">mode {run.settings.approval_mode}</span>
      </div>
      {run.steps.length ? (
        <div className="rounded-lg border border-line bg-black/15 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-milk/42">Run steps</p>
          <div className="mt-2 space-y-2">
            {run.steps.map((step, index) => (
              <div key={`${run.id}-step-${step.title}-${index}`} className="text-xs leading-5 text-milk/62">
                <p className="font-medium text-milk/78">{index + 1}. {step.title}</p>
                {step.detail ? <p className="text-milk/42">{step.detail}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {run.included_files.length ? (
        <div className="rounded-lg border border-line bg-black/15 px-3 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-milk/42">Included files</p>
          <div className="mt-2 space-y-1.5">
            {run.included_files.slice(0, 8).map((file) => (
              <div
                key={`${run.id}-panel-file-${file.path}`}
                className="truncate rounded-md border border-line/80 bg-white/[0.03] px-2 py-1.5 text-xs text-milk/58"
                title={file.reason ?? file.path}
              >
                <FileCode2 className="mr-1.5 inline h-3.5 w-3.5 text-accent/80" />
                {file.path}
              </div>
            ))}
            {run.included_files.length > 8 ? (
              <p className="text-xs text-milk/38">+{run.included_files.length - 8} more files in the context deck.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const RUN_TASK_COPY: Record<string, string> = {
  inspect: "Review workspace and task scope",
  context: "Pack relevant files into context",
  model: "Ask the local model for a plan",
  review: "Prepare a review snapshot",
  patch: "Apply the approved patch",
  final_review: "Review changed files",
};

function taskLabel(id: string, fallback: string) {
  return RUN_TASK_COPY[id] ?? fallback;
}

function reviewHasChanges(review?: AgentWorkspaceReviewResponse | null) {
  return Boolean(review?.files.length);
}

function reviewSummaryText(review: AgentWorkspaceReviewResponse) {
  return `${review.files.length} ${review.files.length === 1 ? "file" : "files"} changed`;
}

function eventNarration(event: AgentRunStatusResponse["events"][number]) {
  if (event.type === "tool" && event.title === "Inspect workspace") {
    return "Starting with the workspace scan and task boundary.";
  }
  if (event.title === "Files scanned") {
    return "Now collecting candidate files for the local context window.";
  }
  if (event.type === "context") {
    return "Packing relevant files, attachments, and the request into context.";
  }
  if (event.title === "Local model request") {
    return "Asking the selected local model for a safe implementation plan.";
  }
  if (event.title === "Model plan generated") {
    return "The model returned a plan. Preparing the review surface next.";
  }
  if (event.type === "review") {
    return "Reading Git status and diff so the review panel can stay attached to the run.";
  }
  if (event.type === "approval") {
    return event.detail ?? "Waiting for permission before any future patch step.";
  }
  if (event.type === "patch" && event.title === "Patch generation started") {
    return "Generating a patch for the approved plan.";
  }
  if (event.type === "patch" && event.title === "Patch applied") {
    return event.detail ? `Wrote changes and captured a review snapshot: ${event.detail}` : "Wrote changes and captured a review snapshot.";
  }
  if (event.type === "cancel") {
    return "Stopped this run before the next agent step.";
  }
  if (event.type === "error") {
    return event.detail ?? "The agent run failed.";
  }
  return event.detail ?? event.title;
}

function EventEditSummary({
  event,
  review,
}: {
  event: AgentRunStatusResponse["events"][number];
  review?: AgentWorkspaceReviewResponse | null;
}) {
  if (event.type !== "review" || !reviewHasChanges(review) || !review) {
    return null;
  }
  const visibleFiles = review.files.slice(0, 4);
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      <p className="text-milk/38">Edited {reviewSummaryText(review)}</p>
      {visibleFiles.map((file) => (
        <p key={`${event.id}-${file.path}`} className="text-milk/42">
          Edited <span className="font-medium text-sky-300/85">{file.path}</span>{" "}
          <span className="text-success">+{file.additions}</span>{" "}
          <span className="text-danger">-{file.deletions}</span>
        </p>
      ))}
    </div>
  );
}

function formatRunDuration(startedAt: string, finishedAt?: string | null) {
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return "--";
  }
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatMetric(value?: number | null, suffix = "") {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return `${Math.round(value)}${suffix}`;
}

function modelResourceChips(model?: ModelView | null) {
  const usage = model?.runtime.resource_usage;
  if (!usage) {
    return [];
  }
  return [
    formatMetric(usage.gpu_percent, "%") ? `GPU ${formatMetric(usage.gpu_percent, "%")}` : null,
    formatMetric(usage.vram_mb, " MB") ? `VRAM ${formatMetric(usage.vram_mb, " MB")}` : null,
    formatMetric(usage.cpu_percent, "%") ? `CPU ${formatMetric(usage.cpu_percent, "%")}` : null,
    formatMetric(usage.ram_mb, " MB") ? `RAM ${formatMetric(usage.ram_mb, " MB")}` : null,
    usage.process_count ? `${usage.process_count} proc` : null,
  ].filter((item): item is string => Boolean(item));
}

function runStatusCopy(status: AgentRunStatusResponse["status"]) {
  if (status === "waiting_for_approval") {
    return "waiting";
  }
  if (status === "generating_patch") {
    return "previewing";
  }
  if (status === "applying_patch") {
    return "writing";
  }
  return status.replace(/_/g, " ");
}

function diffLineClass(line: string) {
  if (line.startsWith("diff --git") || line.startsWith("Index: ")) {
    return "bg-accent/10 text-accent";
  }
  if (line.startsWith("@@")) {
    return "bg-info/10 text-info";
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-success/10 text-success";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-danger/10 text-danger";
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-milk/58";
  }
  return "text-milk/62";
}

function friendlyRunError(error?: string | null) {
  if (!error) {
    return null;
  }
  if (error.includes("file operations")) {
    return "The local model answered with text instead of concrete file writes. Quokka now retries once with a stricter patch prompt; if it repeats, ask for a shorter direct file task.";
  }
  return error;
}

function AgentRunTimeline({
  run,
  model,
  onApprove,
  onRetry,
  onReject,
  onReview,
}: {
  run: AgentRunStatusResponse;
  model?: ModelView | null;
  onApprove: () => void;
  onRetry: () => void;
  onReject: () => void;
  onReview: () => void;
}) {
  const planItems = run.plan.filter((item) => item.id !== "approval");
  const completedCount = planItems.filter((item) => item.status === "completed").length;
  const runningItem = planItems.find((item) => item.status === "running");
  const review = run.review ?? run.patch_preview ?? null;
  const changeFiles = review?.files.length ? review.files : run.edits ?? [];
  const insertions = review?.insertions ?? changeFiles.reduce((total, file) => total + file.additions, 0);
  const deletions = review?.deletions ?? changeFiles.reduce((total, file) => total + file.deletions, 0);
  const hasChanges = Boolean(changeFiles.length);
  const activeRun = ACTIVE_RUN_STATUSES.has(run.status);
  const visibleMessages = (run.messages ?? []).filter((message) => message.type !== "approval_request").slice(-3);
  const visibleEvents = run.events
    .filter((event) => !["Run created"].includes(event.title))
    .slice(-3);
  const previewReady = run.approval_status === "patch_preview_ready" && Boolean(run.patch_preview);
  const approvalWaiting = run.approval_required && (run.approval_status === "waiting" || previewReady);
  const approvalDone = ["approved", "rejected", "applied"].includes(run.approval_status);
  const resourceChips = modelResourceChips(model);
  const runError = friendlyRunError(run.error);
  const phase = runningItem ? taskLabel(runningItem.id, runningItem.title) : runStatusCopy(run.status);
  const runModelName = run.model_name ?? "selected model";
  const contextSize = model?.active_profile?.context_size ?? run.result?.context_budget_tokens ?? 0;
  const usedContext = run.result?.used_context_tokens_estimate ?? 0;
  const contextPercent = contextSize ? Math.min(100, Math.round((usedContext / contextSize) * 100)) : null;

  return (
    <div className="w-full max-w-[880px]">
      <div className="overflow-hidden rounded-[22px] border border-white/10 bg-[#191916]/92 shadow-[0_18px_70px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 py-3 text-sm text-milk/55">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-line/80 bg-white/[0.035] text-milk/50">
            <Loader2 className={cn("h-3.5 w-3.5", activeRun ? "animate-spin text-accent" : "")} />
          </span>
          <span className="font-semibold text-milk/76">{completedCount} out of {planItems.length} tasks completed</span>
          <span className="hidden text-xs text-milk/34 sm:inline">elapsed {formatRunDuration(run.created_at, run.finished_at)}</span>
          <span className={cn(
            "ml-auto rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
            run.status === "failed"
              ? "border-danger/30 bg-danger/10 text-danger"
              : run.status === "cancelled"
                ? "border-warning/30 bg-warning/10 text-warning"
                : run.status === "completed"
                  ? "border-success/25 bg-success/10 text-success"
                  : "border-accent/30 bg-accent/10 text-accent"
          )}>
            {runStatusCopy(run.status)}
          </span>
        </div>

        <div className="grid gap-3 border-t border-line/45 px-4 py-3 md:grid-cols-[minmax(0,1fr)_190px]">
          <ol className="space-y-1.5">
          {planItems.map((item, index) => {
            const isCompleted = item.status === "completed";
            const isRunning = item.status === "running";
            const isFailed = item.status === "failed";
            return (
              <li key={item.id} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[13px]">
                <span className="mt-0.5 grid h-4 w-4 place-items-center">
                  {isCompleted ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-milk/45" />
                  ) : isRunning ? (
                    <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-accent/45">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                    </span>
                  ) : isFailed ? (
                    <X className="h-3.5 w-3.5 text-danger" />
                  ) : (
                    <Circle className="h-3 w-3 text-milk/25" />
                  )}
                </span>
                <div className="min-w-0">
                  <p
                    className={cn(
                      "truncate leading-5",
                      isCompleted && "text-milk/38 line-through decoration-milk/28",
                      isRunning && "font-medium text-milk",
                      isFailed && "text-danger",
                      !isCompleted && !isRunning && !isFailed && "text-milk/50"
                    )}
                  >
                    <span className="mr-2 text-milk/32">{index + 1}.</span>
                    {taskLabel(item.id, item.title)}
                  </p>
                  {item.detail ? (
                    <p className={cn("truncate text-[11px] leading-4", isRunning ? "text-accent/75" : isFailed ? "text-danger/85" : "text-milk/36")} title={item.detail}>{item.detail}</p>
                  ) : null}
                </div>
              </li>
            );
          })}
          </ol>

          <div className="rounded-2xl border border-line/55 bg-black/18 p-3 text-[11px] leading-5 text-milk/46">
            <p className="truncate font-semibold text-milk/72" title={phase}>Now: {phase}</p>
            <p className="truncate" title={runModelName}>Model: {runModelName}</p>
            <p>Context: {contextPercent !== null ? `${contextPercent}%` : "--"} {usedContext ? `(${usedContext} tokens)` : ""}</p>
            <p>Patch budget: {run.result?.settings.patch_max_tokens ?? "--"} tokens</p>
            {resourceChips.length ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {resourceChips.slice(0, 5).map((chip) => (
                  <span key={chip} className="rounded-md border border-line/55 bg-white/[0.035] px-1.5 py-0.5 text-[10px] text-milk/55">
                    {chip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-milk/32">Load appears here when Quokka sees the model process.</p>
            )}
          </div>
        </div>

        {hasChanges ? (
          <button
            type="button"
            className="flex w-full items-center gap-3 border-t border-line/70 px-4 py-2.5 text-left text-sm transition hover:bg-white/[0.035]"
            onClick={onReview}
          >
            <span className="font-medium text-milk/70">{changeFiles.length} {changeFiles.length === 1 ? "file" : "files"} changed</span>
            <span className="text-success">+{insertions}</span>
            <span className="text-danger">-{deletions}</span>
            <span className="ml-auto inline-flex items-center gap-1 font-semibold text-milk/80">
              Review changes
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
          </button>
        ) : null}

        {approvalWaiting ? (
          <div className="border-t border-accent/20 bg-accent/10 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-accent" />
              <p className="text-sm font-semibold text-milk/78">{previewReady ? "Patch preview ready" : "Ready for patch preview"}</p>
              <p className="text-xs text-milk/42">
                {previewReady ? "Review the diff, then apply it to disk or retry patch generation." : "Approve only the preview step. Quokka will not write files yet."}
              </p>
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  className="rounded-full border border-line bg-white/[0.035] px-3 py-1.5 text-xs font-semibold text-milk/62 hover:border-danger/45 hover:text-danger"
                  onClick={onReject}
                >
                  Reject
                </button>
                {previewReady ? (
                  <button
                    type="button"
                    className="rounded-full border border-line bg-white/[0.035] px-3 py-1.5 text-xs font-semibold text-milk/62 hover:border-accent/45 hover:text-milk"
                    onClick={onRetry}
                  >
                    Retry patch
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-full border border-accent/45 bg-accent/20 px-3 py-1.5 text-xs font-semibold text-milk hover:bg-accent/28"
                  onClick={onApprove}
                >
                  {previewReady ? "Apply patch" : "Generate preview"}
                </button>
              </div>
            </div>
          </div>
        ) : approvalDone ? (
          <div className="border-t border-line/60 px-4 py-2.5 text-xs text-milk/45">
            {run.approval_status === "applied" ? "Applied. Quokka attached the final review." : run.approval_status === "approved" ? "Approved. Quokka is preparing the next step." : "Patch step was rejected."}
          </div>
        ) : null}
      </div>

      {runError ? (
        <p className="mt-2 rounded-xl border border-danger/35 bg-danger/10 px-3 py-2 text-xs leading-5 text-danger">{runError}</p>
      ) : null}

      <div className="mt-2 max-h-24 space-y-2 overflow-y-auto px-2">
        {visibleMessages.length ? (
          visibleMessages.map((message) => (
            <div key={message.id} className="text-xs leading-5 text-milk/70">
              <p>{message.content}</p>
              {message.type === "file_changes" && changeFiles.length ? (
                <div className="mt-2 space-y-1.5 text-xs">
                  <p className="text-milk/38">Edited {changeFiles.length} {changeFiles.length === 1 ? "file" : "files"}</p>
                  {changeFiles.slice(0, 6).map((file) => (
                    <p key={`${message.id}-${file.path}`} className="text-milk/42">
                      Edited <span className="font-medium text-sky-300/85">{file.path}</span>{" "}
                      <span className="text-success">+{file.additions}</span>{" "}
                      <span className="text-danger">-{file.deletions}</span>
                    </p>
                  ))}
                  <button type="button" className="inline-flex items-center gap-1 font-semibold text-milk/75 hover:text-milk" onClick={onReview}>
                    Review changes <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
              ) : null}
            </div>
          ))
        ) : visibleEvents.map((event) => (
          <div key={event.id} className="text-xs leading-5 text-milk/70">
            <p>{eventNarration(event)}</p>
            {event.detail && !eventNarration(event).includes(event.detail) ? <p className="mt-1 text-xs text-milk/38">{event.detail}</p> : null}
            <EventEditSummary event={event} review={review} />
          </div>
        ))}
        {activeRun ? (
          <div className="flex items-center gap-2 text-xs text-milk/54">
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent/70 [animation-delay:160ms]" />
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent/45 [animation-delay:320ms]" />
            </span>
            {runningItem ? `${taskLabel(runningItem.id, runningItem.title)}...` : "Working..."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentContextPanel({
  workspace,
  thread,
  model,
  run,
  agentRun,
  settings,
  setSetting,
  deckTab,
  setDeckTab,
}: {
  workspace: WorkspaceRoot | null;
  thread: WorkspaceThread | null | undefined;
  model: ModelView | null;
  run: AgentRunResponse | null;
  agentRun: AgentRunStatusResponse | null;
  settings: AgentSettings;
  setSetting: AgentSettingSetter;
  deckTab: "context" | "review";
  setDeckTab: (tab: "context" | "review") => void;
}) {
  const [review, setReview] = useState<AgentWorkspaceReviewResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const visibleReview = agentRun?.review ?? agentRun?.patch_preview ?? review;

  const refreshReview = async () => {
    if (!workspace) {
      setReview(null);
      return;
    }
    setReviewLoading(true);
    setReviewError(null);
    try {
      setReview(await api.getAgentReview(workspace.path));
    } catch (nextError) {
      setReviewError(compactError(nextError));
    } finally {
      setReviewLoading(false);
    }
  };

  useEffect(() => {
    if (deckTab === "review") {
      void refreshReview();
    }
  }, [deckTab, workspace?.path]);

  return (
    <aside className="hidden min-h-0 overflow-hidden border-l border-line/70 bg-black/14 xl:flex xl:flex-col">
      <div className="border-b border-line/70 px-4 py-4">
        <p className="text-[11px] uppercase tracking-[0.24em] text-accent">Context Deck</p>
        <h2 className="mt-2 truncate text-lg font-semibold text-milk">{thread?.title ?? "Ready for task"}</h2>
        <p className="mt-1 truncate text-xs text-milk/42" title={workspace?.path}>
          {workspace?.path ?? "Open a workspace to start"}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            className={cn("rounded-lg border px-3 py-2 text-sm font-semibold transition-colors", deckTab === "context" ? "border-accent/45 bg-accent/12 text-milk" : "border-line bg-white/[0.025] text-milk/52 hover:text-milk")}
            onClick={() => setDeckTab("context")}
          >
            Context
          </button>
          <button
            type="button"
            className={cn("rounded-lg border px-3 py-2 text-sm font-semibold transition-colors", deckTab === "review" ? "border-accent/45 bg-accent/12 text-milk" : "border-line bg-white/[0.025] text-milk/52 hover:text-milk")}
            onClick={() => setDeckTab("review")}
          >
            Review
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {deckTab === "review" ? (
          <>
            <div className="rounded-lg border border-line bg-white/[0.03] px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.2em] text-accent">Review panel</p>
                  <p className="mt-2 text-sm font-semibold text-milk">{visibleReview?.summary ?? "Workspace changes"}</p>
                  <p className="mt-1 text-xs leading-5 text-milk/42">
                    Run-attached review. Git diff when available, Quokka patch diff for non-git folders.
                  </p>
                </div>
                <button
                  type="button"
                  className="rounded-md border border-line bg-white/[0.03] p-2 text-milk/55 hover:border-accent/45 hover:text-milk"
                  onClick={() => void refreshReview()}
                  disabled={!workspace || reviewLoading}
                  title="Refresh Git status and diff."
                >
                  <RefreshCw className={cn("h-4 w-4", reviewLoading ? "animate-spin" : "")} />
                </button>
              </div>
              {reviewError ? <p className="mt-3 rounded-md border border-danger/35 bg-danger/10 px-2 py-2 text-xs text-danger">{reviewError}</p> : null}
              {visibleReview && !visibleReview.is_git_repo ? (
                <p className="mt-3 rounded-md border border-warning/35 bg-warning/10 px-2 py-2 text-xs leading-5 text-milk/65">
                  {visibleReview.files.length ? "This workspace is not a Git repository, so Quokka is showing its internal patch review." : visibleReview.summary}
                </p>
              ) : null}
            </div>

            {visibleReview ? (
              <div className="rounded-lg border border-line bg-white/[0.03]">
                <div className="flex items-center justify-between border-b border-line px-3 py-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-milk">
                    <GitCompare className="h-4 w-4 text-accent" />
                    {visibleReview.files.length} files changed
                  </div>
                  <div className="text-sm">
                    <span className="text-success">+{visibleReview.insertions}</span>
                    <span className="mx-1 text-milk/30">/</span>
                    <span className="text-danger">-{visibleReview.deletions}</span>
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {visibleReview.files.map((file) => (
                    <div key={file.path} className="flex items-center gap-2 border-b border-line/55 px-3 py-2 text-xs last:border-b-0">
                      <span className="w-8 shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-center text-milk/45">{file.status}</span>
                      <span className="min-w-0 flex-1 truncate text-milk/70" title={file.path}>{file.path}</span>
                      {file.binary ? (
                        <span className="text-milk/35">binary</span>
                      ) : (
                        <span className="shrink-0">
                          <span className="text-success">+{file.additions}</span>
                          <span className="mx-1 text-milk/25">/</span>
                          <span className="text-danger">-{file.deletions}</span>
                        </span>
                      )}
                    </div>
                  ))}
                  {!visibleReview.files.length ? <p className="px-3 py-4 text-sm text-milk/42">No local changes.</p> : null}
                </div>
              </div>
            ) : null}

            {visibleReview?.diff ? (
              <div className="max-h-[420px] overflow-auto rounded-lg border border-line bg-black/30 py-2 font-mono text-[11px] leading-5">
                {visibleReview.diff.split(/\r?\n/).map((line, index) => (
                  <div key={`${index}-${line.slice(0, 20)}`} className={cn("min-w-max whitespace-pre px-3", diffLineClass(line))}>
                    {line || " "}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <>
        <ContextSection title="Selected model">
          <p className="text-sm font-semibold text-milk">{model ? modelLabel(model) : "No model"}</p>
          <p className="mt-2 text-xs leading-5 text-milk/45">
            The agent uses this active local endpoint for planning. Pick a running coding model for best results.
          </p>
        </ContextSection>

        <ContextSection title="Agent settings">
          <div className="grid gap-3">
            <NumericSetting
              label="Agent tokens"
              min={256}
              max={16384}
              value={settings.agent_max_tokens}
              onChange={(value) => setSetting("agent_max_tokens", value)}
              title="Maximum output budget for one agent response. Bigger values allow longer plans but can take longer."
            />
            <NumericSetting
              label="Context %"
              min={10}
              max={95}
              value={settings.context_budget_percent}
              onChange={(value) => setSetting("context_budget_percent", value)}
              title="How much of the model context Quokka may fill with workspace files and task text."
            />
            <NumericSetting
              label="Patch tokens"
              min={512}
              max={16384}
              value={settings.patch_max_tokens}
              onChange={(value) => setSetting("patch_max_tokens", value)}
              title="Reserved output budget for future patch/diff generation."
            />
            <NumericSetting
              label="History"
              min={2}
              max={80}
                value={settings.keep_last_messages}
                onChange={(value) => setSetting("keep_last_messages", value)}
                title="How many recent messages stay in memory before compaction."
              />
            <label className="block min-w-0" title={approvalModeCopy(settings.approval_mode)}>
              <span className="mb-1.5 block truncate text-[10px] uppercase tracking-[0.16em] text-milk/42">Run mode</span>
              <select
                className="h-10 w-full rounded-lg border border-line bg-[#191815] px-3 text-sm text-milk outline-none focus:border-accent/60"
                value={settings.approval_mode}
                onChange={(event) => setSetting("approval_mode", event.target.value as AgentSettings["approval_mode"])}
              >
                <option value="auto_readonly">Read-only planning</option>
                <option value="review">Review &amp; approve writes</option>
                <option value="manual">Manual approval</option>
              </select>
              <p className="mt-2 text-xs leading-5 text-milk/42">{approvalModeCopy(settings.approval_mode)}</p>
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-line bg-black/15 px-3 py-2 text-sm text-milk/60" title="Future long runs can compact old messages automatically.">
              <input type="checkbox" checked={settings.auto_compact} onChange={(event) => setSetting("auto_compact", event.target.checked)} />
              Auto compact history
            </label>
            <details className="rounded-lg border border-line bg-black/12 px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em] text-milk/35">Advanced context</summary>
              <div className="mt-3">
                <NumericSetting
                  label="File context KB"
                  min={64}
                  max={16384}
                  value={settings.file_context_limit_kb}
                  onChange={(value) => setSetting("file_context_limit_kb", value)}
                  title="Maximum text from workspace files packed into one agent request. Large projects can use 4096 KB or more, but bigger context can slow prompts."
                />
              </div>
            </details>
          </div>
        </ContextSection>

        <ContextSection title="Run trace" defaultOpen={Boolean(agentRun ?? run)}>
          {agentRun?.events.length ? (
            <div className="space-y-2">
              {agentRun.events.slice(-12).map((event) => (
                <div key={`${agentRun.id}-side-event-${event.id}`} className="flex gap-2 text-xs leading-5 text-milk/55">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="font-semibold text-milk/70">{event.title}</p>
                    {event.detail ? <p className="truncate text-milk/38" title={event.detail}>{event.detail}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : run ? (
            <div className="space-y-2">
              {run.steps.map((step) => (
                <div key={`${run.id}-side-${step.title}`} className="flex gap-2 text-xs leading-5 text-milk/55">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="font-semibold text-milk/70">{step.title}</p>
                    {step.detail ? <p className="truncate text-milk/38" title={step.detail}>{step.detail}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-milk/42">No agent run yet. This panel will show the workspace scan, packed context, and local model request.</p>
          )}
        </ContextSection>

        <ContextSection title="Included files" defaultOpen={Boolean(run?.included_files.length)}>
          {run?.included_files.length ? (
            <div className="space-y-1.5">
              {run.included_files.slice(0, 18).map((file) => (
                <div key={`${run.id}-context-${file.path}`} className="truncate rounded-md border border-line bg-black/15 px-2 py-1.5 text-xs text-milk/52" title={file.reason ?? file.path}>
                  <FileCode2 className="mr-1.5 inline h-3.5 w-3.5 text-accent/80" />
                  {file.path}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm leading-6 text-milk/42">Relevant files will appear here after the first scan.</p>
          )}
        </ContextSection>
          </>
        )}
      </div>
    </aside>
  );
}

export function AgentLab({ models }: AgentLabProps) {
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const storedWorkspaces = useMemo(() => readStoredWorkspaces(), []);
  const runnableModels = useMemo(() => models.filter((model) => ["running", "warming"].includes(model.runtime.status)), [models]);
  const [selectedModelId, setSelectedModelId] = useState(runnableModels[0]?.id ?? models[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceRoot[]>(storedWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(storedWorkspaces[0]?.id ?? "");
  const [activeThreadId, setActiveThreadId] = useState(storedWorkspaces[0]?.threads[0]?.id ?? "");
  const [settings, setSettings] = useState<AgentSettings>(() => readStoredSettings());
  const [isRunning, setIsRunning] = useState(false);
  const [runningWorkspaceId, setRunningWorkspaceId] = useState<string | null>(null);
  const [runningThreadId, setRunningThreadId] = useState<string | null>(null);
  const [runningAttachmentCount, setRunningAttachmentCount] = useState(0);
  const [runningPrompt, setRunningPrompt] = useState("");
  const [deckTab, setDeckTab] = useState<"context" | "review">("context");
  const [error, setError] = useState<string | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState("");
  const [activeAgentRun, setActiveAgentRun] = useState<AgentRunStatusResponse | null>(null);
  const [liveThinking, setLiveThinking] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadDraft, setThreadDraft] = useState("");

  const selectedModel = models.find((model) => model.id === selectedModelId) ?? runnableModels[0] ?? models[0] ?? null;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const activeThread = activeWorkspace?.threads.find((thread) => thread.id === activeThreadId) ?? activeWorkspace?.threads[0] ?? null;
  const latestRun = useMemo(
    () => activeThread?.messages.slice().reverse().find((message) => message.run)?.run ?? null,
    [activeThread?.messages]
  );
  const effectiveSettings = useMemo<AgentSettings>(() => ({ ...settings }), [settings]);
  const visibleRunIsActive = isRunning && runningWorkspaceId === activeWorkspace?.id && runningThreadId === (activeThread?.id ?? null);
  const agentBusy = isRunning;
  const contextSize = selectedModel?.active_profile?.context_size ?? 0;
  const agentUsedTokens = useMemo(() => {
    const historyTokens = activeThread?.messages.reduce((total, message) => total + estimateTokens(message.content), 0) ?? 0;
    const attachmentTokens = attachments.reduce((total, attachment) => total + estimateTokens(attachment.text ?? attachment.name), 0);
    return historyTokens + estimateTokens(prompt) + attachmentTokens;
  }, [activeThread?.messages, attachments, prompt]);

  useEffect(() => {
    const input = directoryInputRef.current as DirectoryInput | null;
    if (!input) {
      return;
    }
    input.webkitdirectory = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspaces));
    if (!activeWorkspaceId && workspaces[0]) {
      setActiveWorkspaceId(workspaces[0].id);
    }
  }, [activeWorkspaceId, workspaces]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    return () => {
      runAbortRef.current?.abort();
      runAbortRef.current = null;
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, []);

  const chooseFolder = async () => {
    if (typeof window.quokkaDesktop?.openFolder === "function") {
      try {
        const folderPath = await window.quokkaDesktop.openFolder();
        if (folderPath) {
          const id = workspaceId(folderPath);
          setWorkspaces((current) => upsertWorkspace(current, baseName(folderPath), folderPath));
          setActiveWorkspaceId(id);
          setActiveThreadId("");
          setError(null);
          return;
        }
      } catch {
        // Browser directory input remains the fallback when the desktop bridge is unavailable.
      }
    }
    directoryInputRef.current?.click();
  };

  const openTerminal = async () => {
    if (!activeWorkspace) {
      setError("Open a workspace folder first.");
      return;
    }
    const result = await window.quokkaDesktop?.openTerminal?.(activeWorkspace.path);
    if (!result?.ok) {
      setError(result?.message ?? "Desktop wrapper could not open a terminal.");
    } else {
      setError(null);
    }
  };

  const handleDirectoryInput = (event: ChangeEvent<HTMLInputElement>) => {
    const first = event.target.files?.[0] as LocalFile | undefined;
    if (!first) {
      return;
    }
    const folder = inferDirectoryFromFile(first);
    const id = workspaceId(folder.path);
    setWorkspaces((current) => upsertWorkspace(current, folder.name, folder.path));
    setActiveWorkspaceId(id);
    setActiveThreadId("");
    event.target.value = "";
  };

  const updateWorkspace = (workspaceIdValue: string, updater: (workspace: WorkspaceRoot) => WorkspaceRoot) => {
    setWorkspaces((current) => current.map((workspace) => (workspace.id === workspaceIdValue ? updater(workspace) : workspace)));
  };

  const createThreadForWorkspace = (workspace: WorkspaceRoot, title = "New local task") => {
    const thread: WorkspaceThread = {
      id: uid("agent-thread"),
      title,
      updatedAt: new Date().toISOString(),
      messages: [],
    };
    updateWorkspace(workspace.id, (item) => ({ ...item, threads: [thread, ...item.threads] }));
    setActiveWorkspaceId(workspace.id);
    setActiveThreadId(thread.id);
    return thread;
  };

  const createThread = (title = "New local task") => {
    if (!activeWorkspace) {
      void chooseFolder();
      return null;
    }
    return createThreadForWorkspace(activeWorkspace, title);
  };

  const renameWorkspace = (workspace: WorkspaceRoot) => {
    const nextName = workspaceDraft.trim();
    if (nextName) {
      setWorkspaces((current) => current.map((item) => (item.id === workspace.id ? { ...item, name: nextName } : item)));
    }
    setEditingWorkspaceId(null);
    setWorkspaceDraft("");
  };

  const deleteWorkspace = (workspace: WorkspaceRoot) => {
    const next = workspaces.filter((item) => item.id !== workspace.id);
    setWorkspaces(next);
    if (activeWorkspaceId === workspace.id) {
      setActiveWorkspaceId(next[0]?.id ?? "");
      setActiveThreadId(next[0]?.threads[0]?.id ?? "");
    }
  };

  const renameThread = (workspace: WorkspaceRoot, thread: WorkspaceThread) => {
    const nextTitle = threadDraft.trim();
    if (nextTitle) {
      updateWorkspace(workspace.id, (item) => ({
        ...item,
        threads: item.threads.map((candidate) => (candidate.id === thread.id ? { ...candidate, title: nextTitle } : candidate)),
      }));
    }
    setEditingThreadId(null);
    setThreadDraft("");
  };

  const deleteThread = (workspace: WorkspaceRoot, thread: WorkspaceThread) => {
    const nextThreads = workspace.threads.filter((item) => item.id !== thread.id);
    updateWorkspace(workspace.id, (item) => ({ ...item, threads: nextThreads }));
    if (activeThreadId === thread.id) {
      setActiveThreadId(nextThreads[0]?.id ?? "");
    }
  };

  const addAttachments = async (files: File[]) => {
    if (!files.length) {
      return;
    }
    setError(null);
    try {
      const remaining = Math.max(ATTACHMENT_LIMIT - attachments.length, 0);
      const nextFiles = files.slice(0, remaining);
      const nextAttachments = await Promise.all(nextFiles.map(readAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, ATTACHMENT_LIMIT));
    } catch (nextError) {
      setError(compactError(nextError));
    }
  };

  const handleAttachmentInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    void addAttachments(files);
    event.target.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (!files.length) {
      return;
    }
    event.preventDefault();
    void addAttachments(files);
  };

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const runAgent = async () => {
    if (agentBusy) {
      return;
    }
    if (!activeWorkspace) {
      await chooseFolder();
      return;
    }
    if (!selectedModel || !prompt.trim()) {
      return;
    }

    const now = new Date().toISOString();
    const targetThread =
      activeThread ??
      ({
        id: uid("agent-thread"),
        title: prompt.trim().slice(0, 72) || "New local task",
        updatedAt: now,
        messages: [],
      } satisfies WorkspaceThread);
    const userMessage: AgentMessage = {
      id: uid("agent-msg"),
      role: "user",
      content: prompt.trim(),
      createdAt: now,
      attachments,
    };

    setActiveThreadId(targetThread.id);
    updateWorkspace(activeWorkspace.id, (workspace) => {
      const exists = workspace.threads.some((thread) => thread.id === targetThread.id);
      if (!exists) {
        return {
          ...workspace,
          threads: [
            {
              ...targetThread,
              title: userMessage.content.slice(0, 72),
              updatedAt: now,
              messages: [userMessage],
            },
            ...workspace.threads,
          ],
        };
      }
      return {
        ...workspace,
        threads: workspace.threads.map((item) =>
          item.id === targetThread.id
            ? {
                ...item,
                title: item.messages.length ? item.title : userMessage.content.slice(0, 72),
                updatedAt: now,
                messages: [...item.messages, userMessage],
              }
            : item
        ),
      };
    });
    const requestAttachments = attachments;
    setPrompt("");
    setAttachments([]);
    setIsRunning(true);
    setRunningWorkspaceId(activeWorkspace.id);
    setRunningThreadId(targetThread.id);
    setRunningAttachmentCount(requestAttachments.length);
    setRunningPrompt(userMessage.content);
    setError(null);
    setDeckTab("context");
    setActiveAgentRun(null);
    setLiveThinking(null);

    try {
      const agentRun = await api.startAgentRun({
        model_id: selectedModel.id,
        workspace_path: activeWorkspace.path,
        prompt: userMessage.content,
        attachments: requestAttachments,
        settings: effectiveSettings,
      });

      setActiveAgentRun(agentRun);
      const runId = agentRun.id;
      const wsId = activeWorkspace.id;
      const threadId = targetThread.id;

      const finishRun = (finalRun: AgentRunStatusResponse) => {
        clearPolling();
        setActiveAgentRun(finalRun);
        setLiveThinking(null);

        if (finalRun.result) {
          const assistantMessage: AgentMessage = {
            id: uid("agent-msg"),
            role: "assistant",
            content: finalRun.result.content,
            createdAt: finalRun.result.created_at,
            run: finalRun.result,
            runId: finalRun.id,
          };
          setWorkspaces((current) =>
            current.map((workspace) => {
              if (workspace.id !== wsId) {
                return workspace;
              }
              return {
                ...workspace,
                threads: workspace.threads.map((thread) =>
                  thread.id === threadId ? { ...thread, updatedAt: finalRun.result!.created_at, messages: [...thread.messages, assistantMessage] } : thread
                ),
              };
            })
          );
        }

        if (finalRun.patch_preview || finalRun.review) {
          setDeckTab("review");
        }
        setIsRunning(false);
        setRunningWorkspaceId(null);
        setRunningThreadId(null);
        setRunningAttachmentCount(0);
        setRunningPrompt("");
      };

      pollingRef.current = setInterval(async () => {
        try {
          const status = await api.getAgentRun(runId);
          setActiveAgentRun(status);

          if (status.live_thinking) {
            setLiveThinking(status.live_thinking);
          }

          const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
          if (terminalStatuses.has(status.status) || status.status === "waiting_for_approval") {
            finishRun(status);
          }
        } catch (pollError) {
          clearPolling();
          setError(compactError(pollError));
          setIsRunning(false);
          setRunningWorkspaceId(null);
          setRunningThreadId(null);
          setRunningAttachmentCount(0);
          setRunningPrompt("");
        }
      }, 600);
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === "AbortError") {
        setError("Agent run stopped.");
      } else {
        setError(compactError(nextError));
      }
      setIsRunning(false);
      setRunningWorkspaceId(null);
      setRunningThreadId(null);
      setRunningAttachmentCount(0);
      setRunningPrompt("");
    }
  };

  const stopActiveRun = async () => {
    clearPolling();

    if (activeAgentRun?.id) {
      try {
        await api.cancelAgentRun(activeAgentRun.id);
      } catch {
        // Best effort cancellation
      }
    }

    runAbortRef.current?.abort();
    runAbortRef.current = null;
    setIsRunning(false);
    setRunningWorkspaceId(null);
    setRunningThreadId(null);
    setRunningAttachmentCount(0);
    setRunningPrompt("");
    setActiveAgentRun(null);
    setLiveThinking(null);
  };

  const sendRunAction = async (action: "generate_patch" | "apply" | "retry_patch") => {
    if (!activeAgentRun?.id) return;
    try {
      const runId = activeAgentRun.id;
      clearPolling();
      const updated = await api.approveAgentRun(runId, action);
      setActiveAgentRun(updated);
      setError(null);
      if (updated.patch_preview || updated.review) {
        setDeckTab("review");
      }

      if (!ACTIVE_RUN_STATUSES.has(updated.status)) {
        setIsRunning(false);
        return;
      }

      pollingRef.current = setInterval(async () => {
        try {
          const status = await api.getAgentRun(runId);
          setActiveAgentRun(status);
          if (status.live_thinking) {
            setLiveThinking(status.live_thinking);
          }
          const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
          const pausedForReview = status.status === "waiting_for_approval" && Boolean(status.patch_preview);
          if (terminalStatuses.has(status.status) || pausedForReview) {
            clearPolling();
            setActiveAgentRun(status);
            setLiveThinking(null);
            setIsRunning(false);
            setRunningWorkspaceId(null);
            setRunningThreadId(null);
            setRunningAttachmentCount(0);
            setRunningPrompt("");
            if (status.review || status.patch_preview) {
              setDeckTab("review");
            }
          }
        } catch (pollError) {
          clearPolling();
          setError(compactError(pollError));
          setIsRunning(false);
        }
      }, 600);
    } catch (nextError) {
      setError(compactError(nextError));
    }
  };

  const approveRun = async () => {
    if (!activeAgentRun?.id) return;
    const action = activeAgentRun.patch_preview && activeAgentRun.approval_status === "patch_preview_ready" ? "apply" : "generate_patch";
    setIsRunning(true);
    await sendRunAction(action);
  };

  const retryPatchGeneration = async () => {
    if (!activeAgentRun?.id) return;
    setIsRunning(true);
    await sendRunAction("retry_patch");
  };

  const rejectRun = async () => {
    if (!activeAgentRun?.id) return;
    try {
      const updated = await api.approveAgentRun(activeAgentRun.id, "reject");
      setActiveAgentRun(updated);
      setIsRunning(false);
      setRunningWorkspaceId(null);
      setRunningThreadId(null);
      setRunningAttachmentCount(0);
      setRunningPrompt("");
    } catch (nextError) {
      setError(compactError(nextError));
    }
  };

  const setSetting: AgentSettingSetter = (key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="mt-4 grid h-[calc(100vh-2rem)] overflow-hidden rounded-lg border border-line/70 bg-panel/75 shadow-[0_0_0_1px_rgba(176,139,102,0.08),0_34px_90px_rgba(0,0,0,0.38)] lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_380px]">
      <input ref={directoryInputRef} type="file" multiple className="hidden" onChange={handleDirectoryInput} />
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        accept="image/*,.pdf,.txt,.md,.json,.yaml,.yml,.csv,.ts,.tsx,.js,.jsx,.py,.css,.html,.xml"
        onChange={handleAttachmentInput}
      />

      <aside className="hidden min-h-0 overflow-hidden border-r border-line/70 bg-black/16 px-4 py-4 lg:flex lg:flex-col">
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-4 py-4 text-left text-sm font-semibold text-milk transition hover:border-accent/60 hover:bg-accent/16"
          onClick={() => void chooseFolder()}
          title="Choose a real project folder. Agent Lab stores threads under that workspace."
        >
          <FolderOpen className="h-4 w-4 text-accent" />
          Open project folder
        </button>

        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="text-xs font-medium text-milk/35">Workspaces</p>
            <button className="rounded-md border border-line bg-white/[0.03] p-1.5 text-milk/60 hover:border-accent/45 hover:text-milk" onClick={() => void chooseFolder()} title="Add workspace folder">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="space-y-1">
              {workspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
                    workspace.id === activeWorkspace?.id ? "bg-white/[0.06] text-milk" : "text-milk/55 hover:bg-white/[0.035] hover:text-milk"
                  )}
                >
                  {editingWorkspaceId === workspace.id ? (
                    <Input
                      autoFocus
                      value={workspaceDraft}
                      onChange={(event) => setWorkspaceDraft(event.target.value)}
                      onBlur={() => renameWorkspace(workspace)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          renameWorkspace(workspace);
                        }
                        if (event.key === "Escape") {
                          setEditingWorkspaceId(null);
                        }
                      }}
                      className="h-8 text-sm"
                    />
                  ) : (
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                      onClick={() => {
                        setActiveWorkspaceId(workspace.id);
                        setActiveThreadId(workspace.threads[0]?.id ?? "");
                      }}
                      title={workspace.path}
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-accent/65" />
                      <span className="truncate">{workspace.name}</span>
                    </button>
                  )}
                  <button
                    className="rounded-md p-1 text-milk/35 opacity-0 hover:bg-accent/10 hover:text-accent group-hover:opacity-100"
                    onClick={() => createThreadForWorkspace(workspace)}
                    title="Create thread in this workspace"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="rounded-md p-1 text-milk/35 opacity-0 hover:bg-white/[0.06] hover:text-milk group-hover:opacity-100"
                    onClick={() => {
                      setEditingWorkspaceId(workspace.id);
                      setWorkspaceDraft(workspace.name);
                    }}
                    title="Rename workspace label"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="rounded-md p-1 text-milk/35 opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                    onClick={() => deleteWorkspace(workspace)}
                    title="Remove workspace from Agent Lab. This does not delete files from disk."
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {!workspaces.length ? (
                <button className="w-full rounded-lg border border-dashed border-line px-3 py-4 text-left text-sm leading-6 text-milk/42 hover:border-accent/40 hover:text-milk" onClick={() => void chooseFolder()}>
                  No folders yet. Add your first project workspace.
                </button>
              ) : null}
            </div>

            <div className="mt-6 mb-2 flex items-center justify-between px-1">
              <p className="text-xs font-medium text-milk/35">Threads</p>
              <button
                className="rounded-md border border-line bg-white/[0.03] p-1.5 text-milk/60 hover:border-accent/45 hover:text-milk disabled:opacity-35"
                onClick={() => createThread()}
                disabled={!activeWorkspace}
                title="Create thread in the selected workspace"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1">
              {activeWorkspace?.threads.map((thread) => (
                <div
                  key={thread.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-lg px-2 py-1.5 transition-colors",
                    thread.id === activeThread?.id ? "bg-accent/10 text-milk" : "text-milk/55 hover:bg-white/[0.035] hover:text-milk"
                  )}
                >
                  {editingThreadId === thread.id ? (
                    <Input
                      autoFocus
                      value={threadDraft}
                      onChange={(event) => setThreadDraft(event.target.value)}
                      onBlur={() => activeWorkspace && renameThread(activeWorkspace, thread)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && activeWorkspace) {
                          renameThread(activeWorkspace, thread);
                        }
                        if (event.key === "Escape") {
                          setEditingThreadId(null);
                        }
                      }}
                      className="h-8 text-sm"
                    />
                  ) : (
                    <button className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={() => setActiveThreadId(thread.id)}>
                      <Circle className={cn("h-2 w-2 shrink-0", thread.id === activeThread?.id ? "fill-accent text-accent" : "text-milk/25")} />
                      <span className="truncate">{thread.title}</span>
                    </button>
                  )}
                  <button
                    className="rounded-md p-1 text-milk/35 opacity-0 hover:bg-white/[0.06] hover:text-milk group-hover:opacity-100"
                    onClick={() => {
                      setEditingThreadId(thread.id);
                      setThreadDraft(thread.title);
                    }}
                    title="Rename thread"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    className="rounded-md p-1 text-milk/35 opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
                    onClick={() => activeWorkspace && deleteThread(activeWorkspace, thread)}
                    title="Delete thread"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {activeWorkspace && !activeWorkspace.threads.length ? <p className="px-2 py-2 text-sm leading-6 text-milk/35">No threads in this folder yet.</p> : null}
            </div>
          </div>
        </div>

        <div className="border-t border-line pt-3 text-xs leading-5 text-milk/35">
          <p>{activeWorkspace ? activeWorkspace.name : "No workspace selected"}</p>
          <p className="truncate" title={activeWorkspace?.path}>{activeWorkspace?.path ?? "Open a project folder"}</p>
        </div>
      </aside>

      <section className="flex min-h-0 flex-col bg-[radial-gradient(circle_at_50%_0%,rgba(176,139,102,0.08),transparent_34%)]">
        <div className="flex h-[52px] items-center justify-between border-b border-line/55 bg-black/10 px-5">
          <div className="flex min-w-0 items-center gap-2 text-sm text-milk/62">
            <Bot className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate">{activeWorkspace ? activeWorkspace.name : "Choose a workspace"}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden max-w-[360px] truncate text-xs text-milk/35 md:block" title={activeWorkspace?.path}>
              {activeWorkspace?.path ?? "No folder opened"}
            </span>
            <OpenWorkspaceMenu workspace={activeWorkspace} onMessage={setError} />
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-line/80 bg-white/[0.03] px-3 text-sm font-semibold text-milk/68 transition hover:border-accent/40 hover:text-milk disabled:opacity-40"
              onClick={() => void openTerminal()}
              disabled={!activeWorkspace}
              title="Open a terminal in the selected workspace folder."
            >
              <Terminal className="h-4 w-4 text-accent" />
              Terminal
            </button>
            <Badge variant={selectedModel?.runtime.health_ok ? "success" : "warning"}>{selectedModel?.runtime.status ?? "offline"}</Badge>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {!activeThread?.messages.length ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl border border-accent/25 bg-accent/10 text-accent shadow-glow">
                <Bot className="h-7 w-7" />
              </div>
              <h1 className="mt-5 text-2xl font-semibold text-milk">{activeWorkspace ? "Let's build" : "Open a local folder"}</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-milk/45">
                {activeWorkspace
                  ? "Start a thread in this workspace. Quokka will scan the folder, pack relevant files, and ask your selected local model for a safe plan."
                  : "Choose the project folder first. Threads live inside workspaces, so each project keeps its own agent history."}
              </p>
              <button
                className="mt-6 flex min-w-[280px] items-center justify-center gap-3 rounded-lg border border-accent/35 bg-accent/12 px-6 py-4 text-base font-semibold text-milk transition hover:border-accent/70 hover:bg-accent/18"
                onClick={() => (activeWorkspace ? createThread() : void chooseFolder())}
              >
                {activeWorkspace ? <Plus className="h-5 w-5 text-accent" /> : <FolderOpen className="h-5 w-5 text-accent" />}
                {activeWorkspace ? "Create workspace thread" : "Open project folder"}
              </button>
            </div>
          ) : null}

          <div className="space-y-4">
            {activeThread?.messages.map((message) => (
              <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[min(1100px,94%)] rounded-lg border px-4 py-3", message.role === "user" ? "border-accent/35 bg-accent/12" : "border-line bg-white/[0.035]")}>
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-milk/35">
                    {message.role === "assistant" ? <Bot className="h-3.5 w-3.5" /> : null}
                    {message.role}
                    <span className="normal-case tracking-normal">{formatTimestamp(message.createdAt)}</span>
                  </div>
                  {message.attachments?.length ? (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {message.attachments.map((attachment) => {
                        const Icon = attachmentIcon(attachment);
                        return (
                          <span key={`${message.id}-${attachment.name}`} className="inline-flex items-center gap-1 rounded-md border border-line bg-black/15 px-2 py-1 text-xs text-milk/45">
                            <Icon className="h-3.5 w-3.5 text-accent/75" />
                            {attachment.name}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  {message.run ? <ThinkingBlock run={message.run} /> : null}
                  <p className="whitespace-pre-wrap text-sm leading-6 text-milk/78">{message.content}</p>
                  {message.run ? <AgentRunPanel run={message.run} /> : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        {liveThinking && agentBusy ? (
          <div className="border-t border-accent/20 bg-accent/[0.04] px-6 py-3">
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-accent">
              <BrainCircuit className="h-3.5 w-3.5 animate-pulse" />
              Agent is thinking...
            </div>
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-milk/55">
              {liveThinking.length > 1200 ? `...${liveThinking.slice(-1200)}` : liveThinking}
            </p>
          </div>
        ) : null}

        {activeAgentRun?.status === "waiting_for_approval" ? (
          <div className="border-t border-accent/25 bg-accent/[0.08] px-6 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-accent" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-milk/85">
                  {activeAgentRun.patch_preview ? "Patch preview ready" : "Ready for patch preview"}
                </p>
                <p className="text-xs text-milk/45">
                  {activeAgentRun.patch_preview
                    ? "Review the diff first. Apply writes it to disk; Retry asks the model for a new patch."
                    : "This approval only generates a patch preview. Quokka will not write files yet."}
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-line bg-white/[0.035] px-4 py-2 text-sm font-semibold text-milk/62 transition hover:border-danger/45 hover:text-danger"
                onClick={() => void rejectRun()}
              >
                Reject
              </button>
              {activeAgentRun.patch_preview ? (
                <button
                  type="button"
                  className="rounded-full border border-line bg-white/[0.035] px-4 py-2 text-sm font-semibold text-milk/62 transition hover:border-accent/45 hover:text-milk"
                  onClick={() => void retryPatchGeneration()}
                >
                  Retry patch generation
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-full border border-accent/50 bg-accent/20 px-4 py-2 text-sm font-semibold text-milk transition hover:bg-accent/30"
                onClick={() => void approveRun()}
              >
                {activeAgentRun.patch_preview ? "Apply patch" : "Generate patch preview"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="border-t border-line/60 bg-[#12120f]/88 px-5 py-4 backdrop-blur-xl">
          {agentBusy ? (
            <div className="mb-3 flex justify-center">
              <LiveAgentTrace
                workspace={activeWorkspace}
                model={selectedModel}
                attachmentCount={runningAttachmentCount}
                promptText={runningPrompt}
                settings={effectiveSettings}
              />
            </div>
          ) : null}
          <div className="w-full rounded-[24px] border border-white/10 bg-[#20201d]/92 p-3 shadow-[0_0_0_1px_rgba(176,139,102,0.05),0_22px_70px_rgba(0,0,0,0.46)]">
            {error ? <p className="mb-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null}
            {attachments.length ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {attachments.map((attachment, index) => {
                  const Icon = attachmentIcon(attachment);
                  return (
                    <span key={`${attachment.name}-${index}`} className="inline-flex items-center gap-2 rounded-lg border border-line bg-black/15 px-2.5 py-1.5 text-xs text-milk/55">
                      <Icon className="h-3.5 w-3.5 text-accent/75" />
                      {attachment.name}
                      <button className="text-milk/35 hover:text-milk" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} title="Remove attachment">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
            ) : null}
            <Textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!agentBusy) {
                    void runAgent();
                  }
                }
              }}
              placeholder={activeWorkspace ? "Ask Quokka Agent to inspect, plan, or explain this folder..." : "Open a folder before starting an agent thread..."}
              className="min-h-[92px] resize-none border-0 bg-transparent px-2 py-2 text-base leading-7 shadow-none focus:border-0 focus:ring-0"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select
                className="h-11 rounded-xl border border-line/80 bg-black/20 px-3 text-sm font-medium text-milk/70 outline-none transition focus:border-accent/60"
                value={effectiveSettings.approval_mode}
                onChange={(event) => setSetting("approval_mode", event.target.value as AgentSettings["approval_mode"])}
                title={approvalModeCopy(effectiveSettings.approval_mode)}
              >
                <option value="auto_readonly">Read only</option>
                <option value="review">Review writes</option>
                <option value="manual">Manual</option>
              </select>
              <select
                className="h-11 min-w-[280px] flex-1 rounded-xl border border-line/80 bg-black/20 px-3 text-sm text-milk outline-none transition focus:border-accent/60"
                value={selectedModel?.id ?? ""}
                onChange={(event) => setSelectedModelId(event.target.value)}
                title="Local model used by Agent Lab"
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{modelLabel(model)}</option>
                ))}
              </select>
              <MiniContextRing usedTokens={agentUsedTokens} contextSize={contextSize || 1} responseTokens={settings.agent_max_tokens} />
              <button
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-line/80 bg-white/[0.025] px-3 text-sm font-semibold text-milk/65 transition hover:border-accent/40 hover:text-milk"
                onClick={() => attachmentInputRef.current?.click()}
                title="Attach screenshots, images, PDFs, or text files. You can also paste a screenshot with Ctrl+V while the input is focused."
              >
                <Paperclip className="h-4 w-4" />
                Attach
              </button>
              <button
                type="button"
                className="grid h-11 w-11 place-items-center rounded-xl border border-line/80 bg-white/[0.025] text-milk/52 transition hover:border-accent/40 hover:text-milk"
                title="Voice input placeholder. File and image attachments already work through Attach or Ctrl+V."
              >
                <Mic className="h-4 w-4" />
              </button>
              {agentBusy ? (
                <Button className="h-11 px-5" variant="secondary" onClick={() => void stopActiveRun()} title="Stop the active agent run.">
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
              ) : (
                <Button className="h-11 px-5" variant="primary" disabled={!activeWorkspace || !selectedModel || !prompt.trim()} onClick={() => void runAgent()} title="Start agent run. Enter starts; Shift+Enter inserts a newline.">
                  <Send className="h-4 w-4" />
                  Start
                </Button>
              )}
              <span className="ml-auto text-xs text-milk/35">Enter to send · Shift+Enter newline</span>
            </div>
          </div>
        </div>
      </section>
      <AgentContextPanel
        workspace={activeWorkspace}
        thread={activeThread}
        model={selectedModel}
        run={latestRun}
        agentRun={activeAgentRun}
        settings={settings}
        setSetting={setSetting}
        deckTab={deckTab}
        setDeckTab={setDeckTab}
      />
    </main>
  );
}
