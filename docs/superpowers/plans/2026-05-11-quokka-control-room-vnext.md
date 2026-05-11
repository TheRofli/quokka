# Quokka Control Room vNext Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Quokka into a coherent local LLM control room with a stable visual system, friend-friendly Windows model setup, calmer chat, stronger diagnostics, and a staged path toward a Rust runtime sidecar.

**Architecture:** Keep Electron + React + FastAPI as the product shell. Add small backend contracts for UI settings, diagnostics, downloads, chat persistence, and diagnostic export. Defer Rust to a later sidecar that replaces only low-level scanner/download/supervisor/log/metrics paths after the UX and contracts are stable.

**Tech Stack:** React, TypeScript, Tailwind design tokens, FastAPI, Pydantic, Python services, Electron IPC, GitHub Releases, official ggml-org llama.cpp Windows assets.

---

## Scope Split

This request spans multiple independent subsystems. Implement it as six shippable tracks instead of one giant refactor:

1. **Visual Shell and Design System:** shared layout primitives, unified page grid, status bar, empty states, softer graphite palette.
2. **Runtime Reliability:** Local Panel Health Doctor, repair actions, Windows llama.cpp setup, clearer error model.
3. **Model Library v2:** recommended shelves, hardware fit labels, disk preflight, resumable downloads.
4. **Chat Calm Mode:** streaming markdown, right sidebar, backend history, export, speed meter, stop.
5. **LLM Tests and Settings:** softer lab terminal, compare/apply flow, Control Center settings, diagnostic export.
6. **Rust Runtime Sidecar Preparation:** define sidecar boundary, do not rewrite the app yet.

---

## Existing File Map

**Shared shell**
- Modify: `frontend/src/App.tsx` for page layout and Settings Control Center.
- Modify: `frontend/src/components/app/top-status-bar.tsx` for consistent global status display.
- Modify: `frontend/src/index.css` for tokens, surfaces, density, and page grid utilities.
- Create: `frontend/src/components/app/page-shell.tsx` for `left / center / right inspector` layout.
- Create: `frontend/src/components/app/empty-state.tsx` for consistent actionable empty states.

**Local Panel**
- Modify: `frontend/src/components/control/control-panel.tsx` for compact metric rail, endpoint list, inspector tabs, Doctor block, and repair actions.
- Modify: `backend/app/services/model_service.py` for expanded doctor checks and repair fix payload handling.
- Modify: `backend/app/schemas/api.py` for richer doctor checks.
- Modify: `frontend/src/api/client.ts` and `frontend/src/types/api.ts` for new doctor/repair/test-launch methods.

**Model Library**
- Modify: `frontend/src/components/library/model-library.tsx` for recommendation shelves and better download cards.
- Modify: `backend/app/api/routes/library.py` for disk-space preflight and resume metadata.
- Modify: `backend/app/services/model_library_service.py` for GGUF/safetensors warnings and filename metadata parsing.
- Create: `backend/tests/test_model_library_downloads.py` for target path, disk-space, and resume behavior.

**Chat**
- Modify: `frontend/src/components/chat/chat-workspace.tsx` for calm message layout, right sidebar, streaming markdown, speed meter, export, and stop.
- Modify: `backend/app/api/routes/chat.py` for request cancellation hooks if feasible in FastAPI/httpx.
- Create: `backend/app/api/routes/chat_history.py` for user-data chat persistence.
- Modify: `backend/app/main.py` to include the chat history router.
- Create: `backend/tests/test_chat_history.py`.

**LLM Tests**
- Modify: `frontend/src/components/dashboard/benchmark-dialog.tsx` for softer terminal, readable candidates, history compare, and recommended profile.
- Modify: `backend/app/services/model_service.py` for better bad-run detection summaries and recommendation copy.
- Modify: `backend/app/schemas/api.py` for any missing compare/apply fields.

**Settings and desktop**
- Modify: `frontend/src/App.tsx` for Control Center sections.
- Modify: `desktop/src/main.cjs` and `desktop/src/preload.cjs` for diagnostic export IPC if backend cannot stream zip directly.
- Modify: `backend/app/api/routes/system.py` for UI settings and diagnostic export.
- Create: `backend/app/services/user_settings_service.py`.
- Create: `backend/tests/test_system_settings.py`.

**Rust sidecar**
- Create later: `runtime/README.md`.
- Create later: `runtime/quokka-runtime-contract.md`.
- Do not create Rust crates until the Python/React contracts are stable.

---

### Task 1: Shared Visual Shell

**Files:**
- Create: `frontend/src/components/app/page-shell.tsx`
- Create: `frontend/src/components/app/empty-state.tsx`
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/app/top-status-bar.tsx`

- [ ] **Step 1: Add a reusable page shell component**

Create `frontend/src/components/app/page-shell.tsx`:

```tsx
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageShellProps {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
  rightOpen?: boolean;
  className?: string;
}

export function PageShell({ left, center, right, rightOpen = true, className }: PageShellProps) {
  return (
    <main
      className={cn(
        "mt-4 grid min-h-0 flex-1 overflow-hidden rounded-[var(--radius-soft)] border border-line/70 bg-panel/55",
        left && right && rightOpen
          ? "xl:grid-cols-[320px_minmax(0,1fr)_360px]"
          : left
            ? "xl:grid-cols-[320px_minmax(0,1fr)]"
            : right && rightOpen
              ? "xl:grid-cols-[minmax(0,1fr)_360px]"
              : "grid-cols-1",
        className,
      )}
    >
      {left ? <aside className="min-h-0 overflow-y-auto border-b border-line/70 bg-shell/35 xl:border-b-0 xl:border-r">{left}</aside> : null}
      <section className="min-h-0 overflow-y-auto">{center}</section>
      {right && rightOpen ? <aside className="min-h-0 overflow-y-auto border-t border-line/70 bg-shell/35 xl:border-l xl:border-t-0">{right}</aside> : null}
    </main>
  );
}
```

- [ ] **Step 2: Add a shared empty state**

Create `frontend/src/components/app/empty-state.tsx`:

```tsx
import { ReactNode } from "react";
import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  eyebrow?: string;
  title: string;
  body: string;
  actions?: ReactNode;
}

export function EmptyState({ icon: Icon, eyebrow, title, body, actions }: EmptyStateProps) {
  return (
    <div className="grid min-h-[360px] place-items-center px-6 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-line/70 bg-shell/70 text-accent">
          <Icon className="h-5 w-5" />
        </div>
        {eyebrow ? <p className="mt-5 text-xs font-semibold uppercase tracking-[0.24em] text-accent">{eyebrow}</p> : null}
        <h2 className="mt-2 text-2xl font-semibold text-milk">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-milk/52">{body}</p>
        {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add design tokens and low-border surfaces**

Modify `frontend/src/index.css` by keeping existing theme tokens and adding utility classes:

```css
.quokka-page {
  background:
    radial-gradient(circle at 24% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 34rem),
    linear-gradient(180deg, color-mix(in srgb, var(--panel) 72%, transparent), var(--shell));
}

.quokka-zone {
  border: 1px solid color-mix(in srgb, var(--line) 68%, transparent);
  background: color-mix(in srgb, var(--panel) 62%, transparent);
  box-shadow: var(--shadow-soft);
}

.quokka-divider {
  border-color: color-mix(in srgb, var(--line) 62%, transparent);
}
```

- [ ] **Step 4: Convert Settings to PageShell**

Modify `frontend/src/App.tsx` so Settings uses `PageShell` instead of a hand-written grid. Keep existing section content and move the right rail into `right`.

- [ ] **Step 5: Verify layout build**

Run:

```powershell
cd frontend
npm run build
```

Expected: build succeeds without TypeScript errors.

---

### Task 2: Local Panel Control Room Polish

**Files:**
- Modify: `frontend/src/components/control/control-panel.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/api.ts`
- Modify: `backend/app/schemas/api.py`
- Modify: `backend/app/services/model_service.py`

- [ ] **Step 1: Persist selected inspector tab**

In `control-panel.tsx`, initialize the inspector tab from localStorage:

```tsx
const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => {
  const saved = window.localStorage.getItem("quokka.control.inspectorTab");
  return saved === "details" || saved === "config" || saved === "logs" || saved === "doctor" ? saved : "details";
});

useEffect(() => {
  window.localStorage.setItem("quokka.control.inspectorTab", inspectorTab);
}, [inspectorTab]);
```

- [ ] **Step 2: Add Doctor tab**

Add `doctor` to the existing inspector tab union. The Doctor tab renders checks returned by `api.getModelDoctor(selectedModel.id)` with statuses `pass`, `warn`, `fail`, and `info`.

- [ ] **Step 3: Expand backend doctor checks**

In `backend/app/services/model_service.py`, update `diagnose_model()` so Windows llama.cpp models return checks for:

```python
[
    "model-file",
    "gguf-header",
    "llama-server",
    "port",
    "architecture",
    "last-runtime-error",
]
```

Each failed check should include an `action` where Quokka can fix it: `set_model_path`, `set_llama_server_path`, or `change_port`.

- [ ] **Step 4: Add repair actions to UI**

In `control-panel.tsx`, for checks with actions:

```tsx
const repairLabel = {
  set_model_path: "Choose model",
  set_llama_server_path: "Choose llama-server",
  change_port: "Use free port",
}[check.action];
```

Use the Electron file picker for model/server paths and call `api.applyModelDoctorFix`.

- [ ] **Step 5: Make top metrics compact and stable**

Replace wide metric cards with fixed `minmax(160px, 1fr)` cells and constant-height values. Long GPU names should truncate instead of stretching the row.

- [ ] **Step 6: Verify**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
cd ..\frontend
npm run build
```

Expected: both pass.

---

### Task 3: Model Library v2

**Files:**
- Modify: `frontend/src/components/library/model-library.tsx`
- Modify: `backend/app/api/routes/library.py`
- Modify: `backend/app/services/model_library_service.py`
- Create: `backend/tests/test_model_library_downloads.py`

- [ ] **Step 1: Add recommendation shelves**

In `model-library.tsx`, create category chips:

```tsx
const shelves = [
  { id: "recommended", label: "Recommended for your GPU", query: "gguf q4_k_m chat" },
  { id: "coding", label: "Coding", query: "qwen coder gguf" },
  { id: "chat", label: "Chat", query: "gemma gguf instruct" },
  { id: "small", label: "Small / Fast", query: "3b 4b gguf q4" },
  { id: "vision", label: "Vision", query: "vision gguf mmproj" },
] as const;
```

Clicking a shelf runs `api.searchLibraryModels(shelf.query)`.

- [ ] **Step 2: Estimate fit labels**

Add a frontend helper:

```tsx
function fitLabel(sizeBytes?: number | null, vramGb?: number | null) {
  if (!sizeBytes || !vramGb) return "Fit unknown";
  const modelGb = sizeBytes / 1024 / 1024 / 1024;
  if (modelGb < vramGb * 0.72) return "Good GPU fit";
  if (modelGb < vramGb * 1.15) return "Tight fit";
  return "CPU / low GPU offload";
}
```

- [ ] **Step 3: Warn about non-GGUF**

In `model_library_service.py`, add:

```python
def model_file_warning(filename: str) -> str | None:
    lowered = filename.lower()
    if lowered.endswith((".safetensors", ".bin", ".pt", ".pth")):
        return "This is not a GGUF file. Quokka needs a GGUF export for llama.cpp."
    if not lowered.endswith(".gguf"):
        return "Only GGUF files can be added directly to Windows llama.cpp."
    return None
```

Expose warnings in library file metadata if the backend starts returning non-GGUF candidates later.

- [ ] **Step 4: Disk-space preflight**

Before download, use `shutil.disk_usage(target_root).free`. If `size_bytes` is known and free space is below `size_bytes * 1.1`, reject with a clear message.

- [ ] **Step 5: Resume download**

In `_download_worker`, if a `.part` file exists, send `Range: bytes=<current>-` and append to the part file. If the server returns `206`, continue; if it returns `200`, restart the partial file.

- [ ] **Step 6: Test download helpers**

Create tests for:

```python
def test_non_gguf_warning():
    assert model_file_warning("model.safetensors")

def test_gguf_has_no_warning():
    assert model_file_warning("model.Q4_K_M.gguf") is None
```

- [ ] **Step 7: Verify**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest discover tests
cd ..\frontend
npm run build
```

Expected: tests and build pass.

---

### Task 4: Chat Calm Mode

**Files:**
- Modify: `frontend/src/components/chat/chat-workspace.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/api.ts`
- Create: `backend/app/api/routes/chat_history.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_chat_history.py`

- [ ] **Step 1: Keep markdown live during streaming**

Ensure the streaming message is rendered through the same markdown renderer as final messages. Do not switch to raw text while `isStreaming`.

- [ ] **Step 2: Keep thinking collapsed**

Store collapsed thinking IDs in localStorage:

```tsx
const THINKING_COLLAPSED_KEY = "quokka.chat.thinking.collapsed";
```

Default all completed thinking blocks to collapsed. Do not auto-open them when the assistant response finishes.

- [ ] **Step 3: Add calm bubbles**

User messages should be soft gray bubbles aligned right. Assistant messages should have no outer border and use a thin left accent line.

- [ ] **Step 4: Add streaming speed**

Track `generationStartedAt`, `streamedTokenEstimate`, and `activeTokPerSecond`. Display tok/s only while streaming; after completion set display to `0`.

- [ ] **Step 5: Backend chat history**

Create `chat_history.py` with endpoints:

```python
@router.get("/chat/history")
def list_threads() -> list[ChatThreadSummary]: ...

@router.get("/chat/history/{thread_id}")
def get_thread(thread_id: str) -> ChatThread: ...

@router.put("/chat/history/{thread_id}")
def save_thread(thread_id: str, payload: ChatThread) -> ChatThread: ...

@router.delete("/chat/history/{thread_id}")
def delete_thread(thread_id: str) -> ApiMessage: ...
```

Persist JSON files under `get_settings().data_dir / "chat"`.

- [ ] **Step 6: Export chat**

Add a button in the right sidebar that creates a `.md` file from the active thread and downloads it in browser mode. In desktop mode, use the same browser download behavior for v1.

- [ ] **Step 7: Stop request**

Use `AbortController` in `chat-workspace.tsx` for stream requests. The Stop button should abort the active request, finalize the partial assistant message, and set tok/s to `0`.

- [ ] **Step 8: Verify**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest discover tests
cd ..\frontend
npm run build
```

Expected: tests and build pass.

---

### Task 5: LLM Tests Lab Polish

**Files:**
- Modify: `frontend/src/components/dashboard/benchmark-dialog.tsx`
- Modify: `backend/app/services/model_service.py`
- Modify: `backend/app/schemas/api.py`

- [ ] **Step 1: Softer terminal theme**

Keep the terminal layout, but use existing design tokens:

```tsx
const terminalClass = "bg-shell/70 text-milk/78 border-line/60";
const selectedClass = "border-live/50 bg-live/8 text-live";
const warningClass = "text-warning";
const passClass = "text-success";
```

- [ ] **Step 2: Readable candidate rows**

Render candidates as:

```text
ctx 8192 -> 48 tok/s, TTFT 0.31s
ctx 16384 -> 52 tok/s, TTFT 0.34s selected
```

Use `selected_values` from the benchmark run to mark selected candidates.

- [ ] **Step 3: Bad-run detection copy**

In benchmark run summaries, detect:

```python
if "HTTP 503" in error or "Loading model" in error:
    summary = "Model is still loading. Wait for readiness before running the next candidate."
elif "out of memory" in error.lower() or "cuda" in error.lower() and "memory" in error.lower():
    summary = "Likely VRAM pressure. Try lower ctx, lower batch, or a smaller quant."
elif "address already in use" in error.lower():
    summary = "Port is busy. Change the model port or stop the other process."
```

- [ ] **Step 4: Recommended profile panel**

When `final_recommended_launch` exists, show:

```tsx
<section>
  <p>Recommended launch profile</p>
  <code>{run.final_recommended_launch}</code>
  <button>Apply profile</button>
</section>
```

Use existing `api.applyBenchmarkProfile`.

- [ ] **Step 5: Verify**

Run:

```powershell
cd frontend
npm run build
```

Expected: build passes.

---

### Task 6: Settings Control Center and Diagnostic Export

**Files:**
- Create: `backend/app/services/user_settings_service.py`
- Modify: `backend/app/api/routes/system.py`
- Modify: `backend/app/schemas/api.py`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/types/api.ts`
- Create: `backend/tests/test_system_settings.py`

- [ ] **Step 1: Add user settings schema**

In `api.py`, add:

```python
class UiSettings(BaseModel):
    theme: str = "quokka"
    density: str = Field(default="comfortable", pattern="^(compact|comfortable|spacious)$")
    radius: str = Field(default="soft", pattern="^(square|soft|round)$")
    accent: str = "bronze"
    chat_default_profile: str = "balanced"
    model_download_dir: str | None = None
```

- [ ] **Step 2: Add settings service**

Create `user_settings_service.py` with JSON read/write under `get_settings().data_dir / "settings.json"`. If the file is missing, return defaults.

- [ ] **Step 3: Add settings endpoints**

Add:

```python
@router.get("/settings", response_model=UiSettings)
def get_ui_settings() -> UiSettings: ...

@router.put("/settings", response_model=UiSettings)
def save_ui_settings(payload: UiSettings) -> UiSettings: ...
```

- [ ] **Step 4: Add diagnostic export**

Add:

```python
@router.get("/diagnostics/export")
def export_diagnostics() -> FileResponse: ...
```

The zip should include runtime checks, app update status, redacted config, and recent logs. Redact local usernames in logs by replacing `Path.home()` with `%USERPROFILE%`.

- [ ] **Step 5: Settings UI sections**

In `App.tsx`, render sections:

```text
Appearance
Runtime
Updates
Chat
Library
Privacy / Logs
Diagnostics
```

Each section should use low-border rows, not many separate cards.

- [ ] **Step 6: Reset UI layout**

Add a button that removes:

```text
quokka.sidebar.open
quokka.chat.sidebar.open
quokka.control.inspectorTab
quokka.theme
```

Then reloads the window.

- [ ] **Step 7: Verify**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest discover tests
cd ..\frontend
npm run build
```

Expected: tests and build pass.

---

### Task 7: Add Model Wizard Completion

**Files:**
- Modify: `frontend/src/components/dashboard/add-model-dialog.tsx`
- Modify: `backend/app/services/model_service.py`

- [ ] **Step 1: Add source tabs**

Use source choices:

```tsx
const sourceModes = ["GGUF file", "Scan folder", "Model Library", "Ollama endpoint"] as const;
```

Each source should end by setting `draft.model_path` or provider-specific metadata.

- [ ] **Step 2: Add runtime tabs**

Use runtime choices:

```tsx
const runtimeModes = ["Windows llama.cpp", "WSL llama.cpp", "Ollama", "OpenAI-compatible"] as const;
```

The existing `CreateModelRequest` can already represent Windows and WSL. Add Ollama/OpenAI-compatible only after backend config creation supports them.

- [ ] **Step 3: Preflight summary**

Render checks from `api.testModelLaunch(draft)`:

```text
GGUF header ok
llama-server ok
port free
architecture confirmed on first start
```

- [ ] **Step 4: Better unsupported model error**

In `model_service.py`, parse recent logs for common unsupported architecture lines:

```python
if "unknown model architecture" in recent_log.lower():
    raise RuntimeError("This GGUF architecture is not supported by your llama.cpp build. Install a newer llama.cpp runtime from Settings.")
```

- [ ] **Step 5: Verify**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
cd ..\frontend
npm run build
```

Expected: both pass.

---

### Task 8: Rust Sidecar Preparation

**Files:**
- Create: `runtime/quokka-runtime-contract.md`
- Create: `runtime/README.md`
- Modify later: none in app runtime until contract is approved.

- [ ] **Step 1: Define the sidecar boundary**

Create `runtime/quokka-runtime-contract.md` with commands:

```text
quokka-runtime scan-models --roots D:\Models;D:\LLM --json
quokka-runtime download --url <url> --target <path> --resume --json
quokka-runtime tail-log --path <path> --jsonl
quokka-runtime metrics --json
quokka-runtime gguf-info --path <path> --json
```

- [ ] **Step 2: Define why Rust is not first**

Create `runtime/README.md` stating:

```text
Quokka keeps Electron + React + FastAPI for product iteration.
Rust enters only for low-level IO/runtime work after contracts are stable.
Do not rewrite Chat, Benchmark orchestration, Hugging Face search, or UI in Rust.
```

- [ ] **Step 3: Verify no app code depends on the sidecar**

Run:

```powershell
rg "quokka-runtime" frontend backend desktop
```

Expected: only docs mention the sidecar until implementation starts.

---

## Release Order

1. Implement Tasks 1, 2, 6, and 7 as `v0.2.1` because they improve the whole app and Windows setup.
2. Implement Task 3 as `v0.2.2` because downloads need careful testing.
3. Implement Task 4 as `v0.2.3` because chat persistence/cancel touches data and request lifecycles.
4. Implement Task 5 as `v0.2.4` because LLM Tests can ship independently.
5. Implement Task 8 as docs first, then build the Rust sidecar only when IO/runtime pain is measurable.

---

## Verification Matrix

Run after each release slice:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
.venv\Scripts\python.exe -m unittest discover tests
cd ..\frontend
npm run build
cd ..\desktop
npm run check
```

Run before publishing an installer:

```powershell
cd ..
.\scripts\build-windows-installer.ps1
```

Publish a release after version bump:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
.\scripts\publish-github-release.ps1 -Version 0.2.1 -InstallerPath "desktop\release\Quokka Setup 0.2.1.exe"
```

---

## Self-Review

- **Spec coverage:** The plan maps the requested visual shell, Local Panel, Model Library, Chat, LLM Tests, Settings, Add Model, and Rust sidecar into concrete tasks.
- **Scope control:** The full request is too large for one safe commit, so it is split into release slices with independent verification.
- **No Rust rewrite:** Rust is explicitly delayed to sidecar contracts; Electron/React/FastAPI stay as the product layer.
- **Risk:** Chat persistence and download resume need the most careful testing because they touch user data and long-running IO.
