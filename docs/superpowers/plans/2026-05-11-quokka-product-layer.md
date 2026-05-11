# Quokka Product Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Quokka from a local model dashboard into a friend-friendly local LLM control center.

**Architecture:** Add small backend contracts only where the UI needs facts it cannot safely infer: model diagnostics and benchmark-profile application. Keep the UI incremental: reuse existing Add Model, LLM Tests, profiles, and Quokka Lab bridge instead of adding new flows from scratch.

**Tech Stack:** FastAPI/Pydantic backend, React/TypeScript frontend, existing Quokka API client and dashboard state.

---

### Task 1: Backend Product Contracts

**Files:**
- Modify: `backend/app/schemas/api.py`
- Modify: `backend/app/api/routes/models.py`
- Modify: `backend/app/services/model_service.py`

- [ ] Add `ModelDoctorCheck`, `ModelDoctorResponse`, and `ApplyBenchmarkProfileRequest`.
- [ ] Add `GET /api/models/{model_id}/doctor`.
- [ ] Add `POST /api/models/{model_id}/apply-benchmark-profile`.
- [ ] Keep these endpoints safe: diagnostics read filesystem/port state only; apply creates or updates a profile, never starts a model.

### Task 2: Frontend API And Types

**Files:**
- Modify: `frontend/src/types/api.ts`
- Modify: `frontend/src/api/client.ts`

- [ ] Mirror the backend types.
- [ ] Add `getModelDoctor(modelId)`.
- [ ] Add `applyBenchmarkProfile(modelId, payload)`.

### Task 3: First Run Wizard

**Files:**
- Create: `frontend/src/components/onboarding/first-run-wizard.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] Show the wizard when there are zero models unless dismissed.
- [ ] Provide actions: add model, open LLM Tests, copy Quokka Lab endpoint.
- [ ] Keep it non-blocking: user can dismiss and continue.

### Task 4: Model Health Doctor And Library

**Files:**
- Modify: `frontend/src/components/control/control-panel.tsx`

- [ ] Group model list by Running, Needs Attention, Stopped, Other.
- [ ] Add a Doctor panel in Details with checks returned from backend.
- [ ] Add Quokka Lab bridge card with `/api/lab/models` copy/open guidance.

### Task 5: Benchmark Apply Flow

**Files:**
- Modify: `frontend/src/components/dashboard/benchmark-dialog.tsx`

- [ ] Add "Save profile" action for completed benchmark results.
- [ ] Send `launch_params` and `final_recommended_launch` to backend.
- [ ] Show user-facing success/error text in the terminal rail.

### Task 6: Chat Profiles

**Files:**
- Modify: `frontend/src/components/chat/chat-workspace.tsx`

- [ ] Add compact profiles: Balanced, Fast, Coding, Deep reasoning, Strict JSON.
- [ ] Profiles adjust temperature/top-p/max-tokens/system prompt behavior in the existing chat request.
- [ ] Keep manual controls usable.

### Task 7: Install And Update Guidance

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `README.md`

- [ ] Add Settings guidance for `quokka`, `quokka update`, and Git pull fallback.
- [ ] Explain how Quokka Lab can discover running Quokka models.

### Verification

- [ ] `cd backend && .venv\Scripts\python.exe -m compileall app`
- [ ] `cd frontend && npm run build`
