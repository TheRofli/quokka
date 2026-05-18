# Quokka First Run Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a trustworthy first-run flow that takes a Windows user from empty Quokka to a working local chat model with a visible scan, recommendation, download/add/start/smoke-test sequence, and a transparent repair/action log.

**Architecture:** Add a small Autopilot backend contract for readiness scoring, starter recommendations, smoke tests, and action logging. Reuse existing runtime install, Model Library download, model creation, model start, Doctor, and Chat APIs instead of creating a second model-management path. The frontend upgrades the existing `FirstRunWizard` into a guided state machine that orchestrates those existing APIs and shows what Quokka changed.

**Tech Stack:** FastAPI, Pydantic, Python unittest, React, TypeScript, Vite, existing Quokka API client, existing Electron desktop bridge.

---

## Current Workspace Note

Before implementing this feature, finish or intentionally fold in the existing uncommitted WSL runtime switch patch:

- `backend/app/schemas/api.py`
- `backend/app/services/model_service.py`
- `frontend/src/components/control/control-panel.tsx`
- `frontend/src/types/api.ts`
- `backend/tests/test_model_service_paths.py`

That patch is compatible with this plan because Autopilot will need `switch_wsl_runtime` and path conversion trust actions.

---

## File Map

**Backend schemas**
- Modify: `backend/app/schemas/api.py`
- Add Autopilot response/request models, action log models, readiness score models, and smoke test response models.

**Backend service**
- Create: `backend/app/services/autopilot_service.py`
- Responsible for readiness scoring, starter recommendation, model payload generation, smoke testing, and append-only action log persistence.

**Backend routes**
- Create: `backend/app/api/routes/autopilot.py`
- Modify: `backend/app/main.py`
- Expose `/api/autopilot/readiness`, `/api/autopilot/actions`, `/api/autopilot/plan/starter`, and `/api/autopilot/smoke-test/{model_id}`.

**Backend tests**
- Create: `backend/tests/test_autopilot_service.py`
- Cover score calculation, recommendation choice, action log append/read, and Windows path trust messages.

**Frontend types/API**
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/api/client.ts`
- Mirror backend types and add `getAutopilotReadiness`, `getAutopilotActions`, `createStarterPlan`, and `runAutopilotSmokeTest`.

**Frontend UI**
- Modify: `frontend/src/components/onboarding/first-run-wizard.tsx`
- Replace current static four-card wizard with a guided Autopilot sequence.

**Frontend app wiring**
- Modify: `frontend/src/App.tsx`
- Pass `models`, `refresh`, `setMode`, and `onOpenChat`-style callbacks into the wizard.

---

## Task 0: Finish The Existing WSL Runtime Switch Patch

**Files:**
- Modify: `backend/app/schemas/api.py`
- Modify: `backend/app/services/model_service.py`
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/components/control/control-panel.tsx`
- Test: `backend/tests/test_model_service_paths.py`

- [ ] **Step 1: Verify the current WSL switch patch**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest discover -s tests
.venv\Scripts\python.exe -m compileall app
cd ..\frontend
npm run build
cd ..
git diff --check
```

Expected:

```text
Ran 7 tests
OK
frontend build exits 0
git diff --check has no whitespace errors
```

- [ ] **Step 2: Commit the WSL switch patch before Autopilot work**

Run:

```powershell
git add backend/app/schemas/api.py backend/app/services/model_service.py frontend/src/types/api.ts frontend/src/components/control/control-panel.tsx backend/tests/test_model_service_paths.py
git commit -m "Add WSL runtime switch repair action"
```

Expected: one clean commit. If the user wants the changes pushed immediately, run `git push`.

---

## Task 1: Add Autopilot Schemas

**Files:**
- Modify: `backend/app/schemas/api.py`

- [ ] **Step 1: Add Pydantic models**

Append these models after `TestLaunchResponse`:

```python
class AutopilotReadinessItem(BaseModel):
    id: str
    label: str
    status: str = Field(pattern="^(pass|warn|fail|info)$")
    detail: str
    fix_action: str | None = None


class AutopilotReadinessResponse(BaseModel):
    score_percent: int = Field(ge=0, le=100)
    summary: str
    hardware_class: str
    recommended_runtime: ProviderType
    recommended_profile: str
    bottlenecks: list[str] = Field(default_factory=list)
    items: list[AutopilotReadinessItem] = Field(default_factory=list)


class AutopilotStarterPlanRequest(BaseModel):
    use_case: str = Field(default="chat", pattern="^(chat|coding|small_fast)$")
    runtime: ProviderType | None = None


class AutopilotStarterPlanResponse(BaseModel):
    name: str
    repo_id: str
    filename: str
    download_url: str
    size_bytes: int | None = None
    quantization: str | None = None
    why: str
    create_model: CreateModelRequest


class AutopilotActionLogEntry(BaseModel):
    id: str
    timestamp: datetime
    action: str
    status: str = Field(pattern="^(planned|running|completed|failed)$")
    summary: str
    details: list[str] = Field(default_factory=list)
    undo_hint: str | None = None
    confidence: str = Field(default="medium", pattern="^(low|medium|high)$")


class AutopilotActionLogRequest(BaseModel):
    action: str
    status: str = Field(pattern="^(planned|running|completed|failed)$")
    summary: str
    details: list[str] = Field(default_factory=list)
    undo_hint: str | None = None
    confidence: str = Field(default="medium", pattern="^(low|medium|high)$")


class AutopilotSmokeTestResponse(BaseModel):
    model_id: str
    ok: bool
    summary: str
    latency_ms: float | None = None
    tokens_per_second: float | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    error: str | None = None
```

- [ ] **Step 2: Verify schema import**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
```

Expected: `compileall` exits 0.

---

## Task 2: Implement Autopilot Service

**Files:**
- Create: `backend/app/services/autopilot_service.py`
- Test: `backend/tests/test_autopilot_service.py`

- [ ] **Step 1: Write failing tests for readiness score and action log**

Create `backend/tests/test_autopilot_service.py`:

```python
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.domain.enums import ProviderType
from app.services.autopilot_service import AutopilotService, choose_hardware_class, score_readiness


class AutopilotServiceTests(unittest.TestCase):
    def test_score_readiness_penalizes_failures_and_warnings(self) -> None:
        result = score_readiness(pass_count=3, warn_count=1, fail_count=1)

        self.assertEqual(result, 55)

    def test_choose_hardware_class_uses_vram_first(self) -> None:
        self.assertEqual(choose_hardware_class(vram_gb=12.0, ram_gb=80.0), "mid_gpu")
        self.assertEqual(choose_hardware_class(vram_gb=4.0, ram_gb=32.0), "low_gpu")
        self.assertEqual(choose_hardware_class(vram_gb=None, ram_gb=32.0), "cpu_or_unknown")

    def test_action_log_persists_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            service = AutopilotService(data_dir=Path(temp_dir))
            entry = service.append_action(
                action="switch_runtime",
                status="completed",
                summary="Switched model to WSL runtime.",
                details=["Converted D:\\Models\\a.gguf to /mnt/d/Models/a.gguf."],
                undo_hint="Use Switch to Windows from Health Doctor.",
                confidence="high",
            )

            entries = service.list_actions()

        self.assertEqual(entries[0].id, entry.id)
        self.assertEqual(entries[0].confidence, "high")
        self.assertIn("WSL", entries[0].summary)

    def test_starter_plan_prefers_windows_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            service = AutopilotService(data_dir=Path(temp_dir))
            plan = service.create_starter_plan(runtime=ProviderType.WINDOWS_LLAMA_CPP, use_case="chat")

        self.assertEqual(plan.create_model.provider, ProviderType.WINDOWS_LLAMA_CPP)
        self.assertIn(".gguf", plan.filename.lower())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest tests.test_autopilot_service
```

Expected: FAIL because `app.services.autopilot_service` does not exist.

- [ ] **Step 3: Create minimal service implementation**

Create `backend/app/services/autopilot_service.py`:

```python
from __future__ import annotations

from datetime import datetime
from pathlib import Path
import json
import uuid

from app.domain.enums import ProviderType
from app.schemas.api import (
    AutopilotActionLogEntry,
    AutopilotReadinessItem,
    AutopilotReadinessResponse,
    AutopilotSmokeTestResponse,
    AutopilotStarterPlanResponse,
    CreateModelRequest,
)


STARTER_MODELS = {
    "chat": {
        "name": "Gemma 3 4B Starter",
        "repo_id": "unsloth/gemma-3-4b-it-GGUF",
        "filename": "gemma-3-4b-it-Q4_K_M.gguf",
        "download_url": "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
        "why": "Small enough for first-run Windows testing and useful for general chat.",
        "quantization": "Q4_K_M",
    },
    "coding": {
        "name": "Qwen Coder Starter",
        "repo_id": "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF",
        "filename": "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "download_url": "https://huggingface.co/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "why": "Good starter coding model when VRAM is limited.",
        "quantization": "Q4_K_M",
    },
    "small_fast": {
        "name": "Small Fast Starter",
        "repo_id": "unsloth/gemma-3-1b-it-GGUF",
        "filename": "gemma-3-1b-it-Q4_K_M.gguf",
        "download_url": "https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf",
        "why": "Fastest low-risk starter for weak GPUs or CPU-only machines.",
        "quantization": "Q4_K_M",
    },
}


def score_readiness(pass_count: int, warn_count: int, fail_count: int) -> int:
    score = 100 - warn_count * 15 - fail_count * 30
    if pass_count == 0 and fail_count:
        score -= 15
    return max(0, min(100, score))


def choose_hardware_class(vram_gb: float | None, ram_gb: float | None) -> str:
    if vram_gb is None:
        return "cpu_or_unknown"
    if vram_gb >= 16:
        return "high_gpu"
    if vram_gb >= 8:
        return "mid_gpu"
    if vram_gb >= 4:
        return "low_gpu"
    return "cpu_or_unknown"


class AutopilotService:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = self.data_dir / "autopilot-actions.json"

    def list_actions(self) -> list[AutopilotActionLogEntry]:
        if not self.log_path.exists():
            return []
        payload = json.loads(self.log_path.read_text(encoding="utf-8"))
        return [AutopilotActionLogEntry.model_validate(item) for item in payload]

    def append_action(
        self,
        *,
        action: str,
        status: str,
        summary: str,
        details: list[str],
        undo_hint: str | None,
        confidence: str,
    ) -> AutopilotActionLogEntry:
        entry = AutopilotActionLogEntry(
            id=f"auto-{uuid.uuid4().hex[:10]}",
            timestamp=datetime.utcnow(),
            action=action,
            status=status,
            summary=summary,
            details=details,
            undo_hint=undo_hint,
            confidence=confidence,
        )
        entries = [entry, *self.list_actions()]
        self.log_path.write_text(json.dumps([item.model_dump(mode="json") for item in entries[:100]], indent=2), encoding="utf-8")
        return entry

    def create_starter_plan(self, *, runtime: ProviderType, use_case: str) -> AutopilotStarterPlanResponse:
        model = STARTER_MODELS.get(use_case, STARTER_MODELS["chat"])
        create_model = CreateModelRequest(
            provider=runtime,
            name=model["name"],
            model_path="",
            llama_server_path=None,
            port=8080,
            context_size=8192,
            batch_size=512,
            ubatch_size=128,
            quantization=model["quantization"],
            description=f"First-run starter model selected by Quokka Autopilot. {model['why']}",
        )
        return AutopilotStarterPlanResponse(
            name=model["name"],
            repo_id=model["repo_id"],
            filename=model["filename"],
            download_url=model["download_url"],
            size_bytes=None,
            quantization=model["quantization"],
            why=model["why"],
            create_model=create_model,
        )

    def build_readiness(
        self,
        *,
        vram_gb: float | None,
        ram_gb: float | None,
        runtime_installed: bool,
        models_dir: str,
    ) -> AutopilotReadinessResponse:
        items = [
            AutopilotReadinessItem(
                id="runtime",
                label="Windows llama.cpp",
                status="pass" if runtime_installed else "warn",
                detail="llama-server.exe is ready." if runtime_installed else "Quokka can install Windows llama.cpp before downloading a model.",
                fix_action=None if runtime_installed else "install_llama_cpp",
            ),
            AutopilotReadinessItem(
                id="models-dir",
                label="Model folder",
                status="pass",
                detail=models_dir,
            ),
        ]
        pass_count = sum(1 for item in items if item.status == "pass")
        warn_count = sum(1 for item in items if item.status == "warn")
        fail_count = sum(1 for item in items if item.status == "fail")
        hardware_class = choose_hardware_class(vram_gb=vram_gb, ram_gb=ram_gb)
        return AutopilotReadinessResponse(
            score_percent=score_readiness(pass_count, warn_count, fail_count),
            summary="Quokka can set up a starter local model." if fail_count == 0 else "Quokka found setup issues to fix first.",
            hardware_class=hardware_class,
            recommended_runtime=ProviderType.WINDOWS_LLAMA_CPP,
            recommended_profile="Balanced starter",
            bottlenecks=[] if hardware_class != "cpu_or_unknown" else ["GPU/VRAM telemetry is missing or too low for confident GPU fit."],
            items=items,
        )

    def smoke_test_error(self, model_id: str, error: str) -> AutopilotSmokeTestResponse:
        return AutopilotSmokeTestResponse(model_id=model_id, ok=False, summary="Smoke test failed.", error=error)
```

- [ ] **Step 4: Run tests and confirm pass**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest tests.test_autopilot_service
```

Expected: 4 tests OK.

- [ ] **Step 5: Commit**

Run:

```powershell
git add backend/app/schemas/api.py backend/app/services/autopilot_service.py backend/tests/test_autopilot_service.py
git commit -m "Add first run autopilot service contract"
```

---

## Task 3: Add Autopilot Routes

**Files:**
- Create: `backend/app/api/routes/autopilot.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/services/model_service.py`

- [ ] **Step 1: Create route module**

Create `backend/app/api/routes/autopilot.py`:

```python
from __future__ import annotations

from time import perf_counter

import httpx
from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.core.settings import get_settings
from app.domain.enums import ProviderType
from app.schemas.api import (
    AutopilotActionLogEntry,
    AutopilotActionLogRequest,
    AutopilotReadinessResponse,
    AutopilotSmokeTestResponse,
    AutopilotStarterPlanRequest,
    AutopilotStarterPlanResponse,
)
from app.services.autopilot_service import AutopilotService
from app.services.model_service import ModelService

router = APIRouter(prefix="/autopilot", tags=["autopilot"])


def get_autopilot_service() -> AutopilotService:
    return AutopilotService(get_settings().data_dir)


@router.get("/readiness", response_model=AutopilotReadinessResponse)
def get_readiness(model_service: ModelService = Depends(get_model_service)) -> AutopilotReadinessResponse:
    metrics = model_service.get_system_metrics()
    runtime = model_service.get_runtime_setup_check()
    gpu = metrics.gpus[0] if metrics.gpus else None
    vram_gb = (gpu.memory_total_mb / 1024) if gpu and gpu.memory_total_mb else None
    ram_gb = (metrics.memory.total_mb / 1024) if metrics.memory.total_mb else None
    return get_autopilot_service().build_readiness(
        vram_gb=vram_gb,
        ram_gb=ram_gb,
        runtime_installed=bool(runtime.llama_server_candidates or runtime.path_has_llama_server),
        models_dir=runtime.models_dir,
    )


@router.post("/plan/starter", response_model=AutopilotStarterPlanResponse)
def create_starter_plan(payload: AutopilotStarterPlanRequest) -> AutopilotStarterPlanResponse:
    runtime = payload.runtime or ProviderType.WINDOWS_LLAMA_CPP
    return get_autopilot_service().create_starter_plan(runtime=runtime, use_case=payload.use_case)


@router.get("/actions", response_model=list[AutopilotActionLogEntry])
def list_actions() -> list[AutopilotActionLogEntry]:
    return get_autopilot_service().list_actions()


@router.post("/actions", response_model=AutopilotActionLogEntry)
def append_action(payload: AutopilotActionLogRequest) -> AutopilotActionLogEntry:
    return get_autopilot_service().append_action(
        action=payload.action,
        status=payload.status,
        summary=payload.summary,
        details=payload.details,
        undo_hint=payload.undo_hint,
        confidence=payload.confidence,
    )


@router.post("/smoke-test/{model_id}", response_model=AutopilotSmokeTestResponse)
async def run_smoke_test(model_id: str, model_service: ModelService = Depends(get_model_service)) -> AutopilotSmokeTestResponse:
    model = model_service.get_model_view(model_id)
    payload = {
        "model": model.name,
        "messages": [{"role": "user", "content": "Reply with one short sentence: Quokka smoke test passed."}],
        "max_tokens": 32,
        "temperature": 0.1,
        "stream": False,
    }
    started = perf_counter()
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(f"{model.endpoint.rstrip('/')}/v1/chat/completions", json=payload)
        response.raise_for_status()
        data = response.json()
        content = str(data.get("choices", [{}])[0].get("message", {}).get("content", ""))
        elapsed_ms = (perf_counter() - started) * 1000
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        completion_tokens = int(usage.get("completion_tokens") or max(1, len(content.split())))
        return AutopilotSmokeTestResponse(
            model_id=model_id,
            ok=True,
            summary="Model answered the smoke test.",
            latency_ms=round(elapsed_ms, 1),
            tokens_per_second=round(completion_tokens / max(elapsed_ms / 1000, 0.001), 2),
            prompt_tokens=usage.get("prompt_tokens") if isinstance(usage.get("prompt_tokens"), int) else None,
            completion_tokens=completion_tokens,
        )
    except Exception as exc:  # noqa: BLE001
        return get_autopilot_service().smoke_test_error(model_id, str(exc))
```

- [ ] **Step 2: Register route**

Modify `backend/app/main.py` import:

```python
from app.api.routes import autopilot, chat, config, lab, library, models, profiles, system
```

Add router near the other API routers:

```python
app.include_router(autopilot.router, prefix=settings.api_prefix)
```

- [ ] **Step 3: Compile backend**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
```

Expected: compile exits 0.

- [ ] **Step 4: Commit**

Run:

```powershell
git add backend/app/api/routes/autopilot.py backend/app/main.py
git commit -m "Expose first run autopilot API"
```

---

## Task 4: Add Frontend Types And API Client

**Files:**
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] **Step 1: Add TypeScript types**

Add these interfaces near existing runtime/library types in `frontend/src/types/api.ts`:

```ts
export interface AutopilotReadinessItem {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  detail: string;
  fix_action?: string | null;
}

export interface AutopilotReadinessResponse {
  score_percent: number;
  summary: string;
  hardware_class: string;
  recommended_runtime: ModelProvider;
  recommended_profile: string;
  bottlenecks: string[];
  items: AutopilotReadinessItem[];
}

export interface AutopilotStarterPlanRequest {
  use_case: "chat" | "coding" | "small_fast";
  runtime?: ModelProvider | null;
}

export interface AutopilotStarterPlanResponse {
  name: string;
  repo_id: string;
  filename: string;
  download_url: string;
  size_bytes?: number | null;
  quantization?: string | null;
  why: string;
  create_model: CreateModelRequest;
}

export interface AutopilotActionLogEntry {
  id: string;
  timestamp: string;
  action: string;
  status: "planned" | "running" | "completed" | "failed";
  summary: string;
  details: string[];
  undo_hint?: string | null;
  confidence: "low" | "medium" | "high";
}

export interface AutopilotActionLogRequest {
  action: string;
  status: "planned" | "running" | "completed" | "failed";
  summary: string;
  details: string[];
  undo_hint?: string | null;
  confidence: "low" | "medium" | "high";
}

export interface AutopilotSmokeTestResponse {
  model_id: string;
  ok: boolean;
  summary: string;
  latency_ms?: number | null;
  tokens_per_second?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error?: string | null;
}
```

- [ ] **Step 2: Add client methods**

Import the new types in `frontend/src/api/client.ts` and add:

```ts
getAutopilotReadiness: () => request<AutopilotReadinessResponse>("/autopilot/readiness"),
createAutopilotStarterPlan: (payload: AutopilotStarterPlanRequest) =>
  request<AutopilotStarterPlanResponse>("/autopilot/plan/starter", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
getAutopilotActions: () => request<AutopilotActionLogEntry[]>("/autopilot/actions"),
appendAutopilotAction: (payload: AutopilotActionLogRequest) =>
  request<AutopilotActionLogEntry>("/autopilot/actions", {
    method: "POST",
    body: JSON.stringify(payload),
  }),
runAutopilotSmokeTest: (modelId: string) =>
  request<AutopilotSmokeTestResponse>(`/autopilot/smoke-test/${modelId}`, { method: "POST" }),
```

- [ ] **Step 3: Build frontend**

Run:

```powershell
cd frontend
npm run build
```

Expected: TypeScript build exits 0.

- [ ] **Step 4: Commit**

Run:

```powershell
git add frontend/src/types/api.ts frontend/src/api/client.ts
git commit -m "Add frontend autopilot API client"
```

---

## Task 5: Replace Static FirstRunWizard With Guided Autopilot

**Files:**
- Modify: `frontend/src/components/onboarding/first-run-wizard.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Update component props**

Change props in `first-run-wizard.tsx`:

```ts
interface FirstRunWizardProps {
  modelCount: number;
  onAddModel: () => void;
  onOpenLibrary: () => void;
  onOpenTests: () => void;
  onOpenChat: () => void;
  onDismiss: () => void;
  onRefreshModels: () => Promise<void>;
}
```

Update `App.tsx` where `FirstRunWizard` is rendered:

```tsx
<FirstRunWizard
  modelCount={models.length}
  onAddModel={() => setAddDialogOpen(true)}
  onOpenLibrary={() => setMode("library")}
  onOpenTests={() => setMode("tests")}
  onOpenChat={() => setMode("chat")}
  onDismiss={dismissFirstRun}
  onRefreshModels={refreshDashboard}
/>
```

`refreshDashboard` is already returned by `useQuokkaDashboard()` in `frontend/src/App.tsx`.

- [ ] **Step 2: Add wizard state machine**

In `first-run-wizard.tsx`, add:

```ts
type AutopilotStep = "scan" | "recommend" | "download" | "add" | "launch" | "test" | "chat";

const steps: { id: AutopilotStep; label: string }[] = [
  { id: "scan", label: "Scan PC" },
  { id: "recommend", label: "Pick model" },
  { id: "download", label: "Download GGUF" },
  { id: "add", label: "Add model" },
  { id: "launch", label: "Launch" },
  { id: "test", label: "Smoke test" },
  { id: "chat", label: "Open chat" },
];
```

Add state:

```ts
const [activeStep, setActiveStep] = useState<AutopilotStep>("scan");
const [readiness, setReadiness] = useState<AutopilotReadinessResponse | null>(null);
const [plan, setPlan] = useState<AutopilotStarterPlanResponse | null>(null);
const [actions, setActions] = useState<AutopilotActionLogEntry[]>([]);
const [running, setRunning] = useState(false);
const [message, setMessage] = useState<string | null>(null);
const [error, setError] = useState<string | null>(null);
```

- [ ] **Step 3: Add scan and plan functions**

Add:

```ts
const scan = async () => {
  setRunning(true);
  setError(null);
  try {
    const nextReadiness = await api.getAutopilotReadiness();
    const nextPlan = await api.createAutopilotStarterPlan({
      use_case: "chat",
      runtime: nextReadiness.recommended_runtime,
    });
    const nextActions = await api.getAutopilotActions();
    setReadiness(nextReadiness);
    setPlan(nextPlan);
    setActions(nextActions);
    setActiveStep("recommend");
    setMessage(nextReadiness.summary);
  } catch (nextError) {
    setError(nextError instanceof Error ? nextError.message : "Autopilot scan failed");
  } finally {
    setRunning(false);
  }
};
```

- [ ] **Step 4: Add trust-log helper**

Add:

```ts
const logAction = async (summary: string, details: string[], status: "planned" | "running" | "completed" | "failed" = "completed") => {
  const entry = await api.appendAutopilotAction({
    action: activeStep,
    status,
    summary,
    details,
    undo_hint: "Open Health Doctor to inspect or reverse runtime/path changes.",
    confidence: "medium",
  });
  setActions((current) => [entry, ...current].slice(0, 8));
};
```

- [ ] **Step 5: Keep v1 orchestration honest and semi-manual**

Do not hide all steps behind one button yet. Render one primary CTA per step:

```tsx
{activeStep === "scan" ? <Button onClick={() => void scan()}>Scan this PC</Button> : null}
{activeStep === "recommend" ? <Button onClick={onOpenLibrary}>Open recommended download</Button> : null}
{activeStep === "download" ? <Button onClick={onOpenLibrary}>Continue in Model Library</Button> : null}
{activeStep === "add" ? <Button onClick={onAddModel}>Add downloaded GGUF</Button> : null}
{activeStep === "launch" ? <Button onClick={onRefreshModels}>Refresh model status</Button> : null}
{activeStep === "test" ? <Button onClick={onOpenTests}>Run LLM Tests</Button> : null}
{activeStep === "chat" ? <Button onClick={onOpenChat}>Open Chat</Button> : null}
```

This keeps v1 safe: Quokka guides the user and logs actions, but it does not silently download/start/change everything in one click until the trust layer is proven.

- [ ] **Step 6: Render readiness score and trust log**

Render:

```tsx
<div className="rounded-[var(--radius-soft)] border border-line/70 bg-shell/45 p-4">
  <p className="text-xs uppercase tracking-[0.24em] text-accent">Local AI readiness</p>
  <p className="mt-2 text-4xl font-semibold text-milk">{readiness?.score_percent ?? "--"}%</p>
  <p className="mt-2 text-sm text-milk/52">{readiness?.summary ?? "Scan this PC to get a local AI readiness score."}</p>
</div>
```

Render each readiness item with `pass/warn/fail/info` color and each action log entry with timestamp, confidence, and undo hint.

- [ ] **Step 7: Build frontend**

Run:

```powershell
cd frontend
npm run build
```

Expected: TypeScript build exits 0.

- [ ] **Step 8: Commit**

Run:

```powershell
git add frontend/src/components/onboarding/first-run-wizard.tsx frontend/src/App.tsx
git commit -m "Add guided first run autopilot wizard"
```

---

## Task 6: Add Trust Doctor Copy To Existing Repair Actions

**Files:**
- Modify: `backend/app/schemas/api.py`
- Modify: `backend/app/services/model_service.py`
- Modify: `frontend/src/components/control/control-panel.tsx`

- [ ] **Step 1: Extend doctor checks with trust metadata**

Modify `ModelDoctorCheck`:

```python
class ModelDoctorCheck(BaseModel):
    id: str
    label: str
    status: str = Field(pattern="^(pass|warn|fail|info)$")
    detail: str
    action: str | None = None
    fix_summary: str | None = None
    undo_hint: str | None = None
    confidence: str = Field(default="medium", pattern="^(low|medium|high)$")
```

- [ ] **Step 2: Populate metadata in `diagnose_model()`**

For path/runtime actions, include explicit copy:

```python
add_check(
    "runtime",
    "Runtime",
    "fail",
    "This model is configured for WSL but still points to a Windows path.",
    "switch_wsl_runtime",
    fix_summary="Convert the model path from D:\\... to /mnt/d/... and rebuild the WSL launch command.",
    undo_hint="Use Switch to Windows to convert /mnt/d/... back to D:\\...",
    confidence="high",
)
```

Update `add_check()` helper signature to accept the new optional fields and pass them into `ModelDoctorCheck`.

- [ ] **Step 3: Show a confirm panel before applying repair**

In `control-panel.tsx`, when a check has `action`, render:

```tsx
<div className="mt-3 rounded-[var(--radius-control)] border border-line/60 bg-shell/45 p-3">
  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">Before Quokka fixes this</p>
  <p className="mt-2 text-sm text-milk/60">{check.fix_summary ?? "Quokka will apply the selected repair action and refresh Health Doctor."}</p>
  {check.undo_hint ? <p className="mt-2 text-xs text-milk/42">Undo: {check.undo_hint}</p> : null}
  <p className="mt-2 text-xs text-milk/42">Confidence: {check.confidence}</p>
</div>
```

- [ ] **Step 4: Build and compile**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
cd ..\frontend
npm run build
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

Run:

```powershell
git add backend/app/schemas/api.py backend/app/services/model_service.py frontend/src/components/control/control-panel.tsx
git commit -m "Add trust metadata to doctor repairs"
```

---

## Task 7: Full Verification

**Files:**
- All touched files.

- [ ] **Step 1: Backend tests**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m unittest discover -s tests
```

Expected: all tests OK.

- [ ] **Step 2: Backend compile**

Run:

```powershell
cd backend
.venv\Scripts\python.exe -m compileall app
```

Expected: compile exits 0.

- [ ] **Step 3: Frontend build**

Run:

```powershell
cd frontend
npm run build
```

Expected: build exits 0.

- [ ] **Step 4: Desktop syntax check**

Run:

```powershell
cd desktop
npm run check
```

Expected: Node syntax checks exit 0.

- [ ] **Step 5: Git diff check**

Run:

```powershell
cd ..
git diff --check
git status --short
```

Expected: no whitespace errors. `git status --short` should show no uncommitted implementation files after commits.

---

## Manual Smoke Test

Run Quokka and verify:

1. Start with zero configured models or clear `quokka.firstRun.dismissed` in browser localStorage.
2. First Run Wizard appears.
3. Click `Scan this PC`.
4. Readiness score appears with runtime/model folder checks.
5. Starter model recommendation appears.
6. Trust log shows prior actions or empty state.
7. Open Model Library from the wizard.
8. Download a small GGUF or use an already downloaded test GGUF.
9. Add it to Local Panel.
10. Start model.
11. Run smoke test or LLM Tests.
12. Open Chat.

Expected user feeling: Quokka is guiding the setup, not dumping raw infrastructure words.

---

## Self-Review

- **Spec coverage:** This plan covers First Run Autopilot, Trust Doctor, readiness score, action log, starter recommendation, smoke test, and reuse of existing Model Library/Local Panel/Chat pieces.
- **Scope control:** The first version is guided and semi-manual. It does not silently download/start/change everything in one click, because trust and undo need to be proven before full automation.
- **Type consistency:** Backend models map one-to-one to frontend interfaces. Route names match client methods.
- **Risk:** The starter Hugging Face URLs may change over time. If a URL fails, update `STARTER_MODELS` to a stable GGUF repo before shipping.
- **Testing:** Backend service tests cover deterministic logic. UI is covered by TypeScript build and manual smoke test for v1.
