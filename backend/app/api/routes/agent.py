from __future__ import annotations

import re
import asyncio
import difflib
import json
import subprocess
import time
import uuid
import os
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import httpx
from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.core.errors import BadRequestError
from app.domain.enums import ProviderType
from app.schemas.api import (
    AgentApprovalRequest,
    AgentPlanItem,
    AgentRunRequest,
    AgentRunEvent,
    AgentRunMessage,
    AgentRunResponse,
    AgentRunStatusResponse,
    AgentRunStep,
    AgentWorkspaceReviewRequest,
    AgentWorkspaceReviewResponse,
    AgentDiffFile,
    AgentWorkspaceFile,
)
from app.schemas.config import ModelConfig
from app.services.model_service import ModelService

router = APIRouter(prefix="/agent", tags=["agent"])

IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".vite",
    ".turbo",
    "coverage",
    ".cache",
}
PROTECTED_WRITE_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".next",
}
TEXT_EXTENSIONS = {
    ".bat",
    ".c",
    ".cfg",
    ".cjs",
    ".cpp",
    ".cs",
    ".css",
    ".env",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".mjs",
    ".ps1",
    ".py",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
SYSTEM_MESSAGE = (
    "You are Quokka Agent Lab, a local coding agent running inside a desktop model manager. "
    "You are currently in read-only planning mode. Use the provided workspace snapshot, answer in the user's language, "
    "identify likely files to edit, propose a safe step-by-step plan, and list checks to run. "
    "Do not claim you edited files or ran commands. If you expose reasoning, keep it concise and separate from the final plan."
)
PATCH_SYSTEM_MESSAGE = (
    "You are Quokka Agent Lab applying an approved patch inside a selected local workspace. "
    "This is the WRITE phase, not the planning phase. Do not return a plan, checklist, explanation, or questions. "
    "The first non-whitespace character of your response must be '{' and the last must be '}'. "
    "Return only a JSON object, no markdown and no prose. The JSON shape is: "
    "{\"summary\":\"short summary\",\"operations\":[{\"action\":\"write\",\"path\":\"relative/path\",\"content\":\"full UTF-8 file content\"}]}. "
    "Allowed actions are write and delete. Paths must be relative to the workspace. "
    "Do not use absolute paths, parent directories, symlinks, or binary content. "
    "For write operations, include the complete final file content, not a diff. "
    "If the user asks for a single HTML file, write index.html with the complete HTML, CSS, and JavaScript."
)

AGENT_RUNS: dict[str, AgentRunStatusResponse] = {}
AGENT_TASKS: dict[str, asyncio.Task[None]] = {}
AGENT_RUN_LIMIT = 40
MAX_PATCH_OPERATIONS = 12
MAX_PATCH_FILE_CHARS = 600_000
MAX_PATCH_TOTAL_CHARS = 2_000_000


@router.post("/review", response_model=AgentWorkspaceReviewResponse)
async def review_workspace(payload: AgentWorkspaceReviewRequest) -> AgentWorkspaceReviewResponse:
    workspace = _resolve_workspace(payload.workspace_path)
    return _build_workspace_review(workspace)


@router.post("/runs", response_model=AgentRunStatusResponse)
async def create_agent_run(
    payload: AgentRunRequest,
    model_service: ModelService = Depends(get_model_service),
) -> AgentRunStatusResponse:
    model = model_service.config_service.get_model(payload.model_id)
    workspace = _resolve_workspace(payload.workspace_path)
    run_id = f"agent-run-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow()
    run = AgentRunStatusResponse(
        id=run_id,
        status="queued",
        prompt=payload.prompt,
        model_id=model.id,
        model_name=model.name,
        workspace_path=str(workspace),
        created_at=now,
        updated_at=now,
        plan=_initial_agent_plan(),
    )
    AGENT_RUNS[run_id] = run
    _trim_agent_runs()
    _append_agent_event(run, "run", "Run created", "Queued a local agent run with persistent status.", "queued")
    AGENT_TASKS[run_id] = asyncio.create_task(_execute_agent_run(run_id, payload, model_service))
    return run


@router.get("/runs/{run_id}", response_model=AgentRunStatusResponse)
async def get_agent_run(run_id: str) -> AgentRunStatusResponse:
    run = AGENT_RUNS.get(run_id)
    if not run:
        raise BadRequestError("Agent run was not found. It may have been cleared after an app restart.")
    return run


@router.get("/runs", response_model=list[AgentRunStatusResponse])
async def list_agent_runs(workspace_path: str | None = None) -> list[AgentRunStatusResponse]:
    runs = sorted(AGENT_RUNS.values(), key=lambda item: item.created_at, reverse=True)
    if workspace_path:
        try:
            workspace = str(_resolve_workspace(workspace_path))
        except BadRequestError:
            return []
        runs = [run for run in runs if run.workspace_path == workspace]
    return runs[:20]


@router.post("/runs/{run_id}/approval", response_model=AgentRunStatusResponse)
async def approve_agent_run(
    run_id: str,
    payload: AgentApprovalRequest,
    model_service: ModelService = Depends(get_model_service),
) -> AgentRunStatusResponse:
    run = AGENT_RUNS.get(run_id)
    if not run:
        raise BadRequestError("Agent run was not found.")

    action = payload.action
    if action == "approve":
        action = "apply" if run.patch_preview and run.pending_patch_operations else "generate_patch"

    if action == "reject":
        run.approval_status = "rejected"
        run.approval_required = False
        run.status = "completed"
        run.finished_at = datetime.utcnow()
        run.updated_at = run.finished_at
        run.pending_patch_operations = []
        _update_plan_item(run, "approval", "failed", payload.note or "Patch step rejected.")
        _append_agent_event(run, "approval", "Patch rejected", payload.note or "No files were changed.", "warning")
        _append_agent_message(run, "approval_request", "Patch rejected. No files were changed.")
        return run

    if action in {"generate_patch", "retry_patch"}:
        if run.status not in {"waiting_for_approval", "failed"}:
            return run
        if not run.result:
            raise BadRequestError("The agent cannot generate a patch preview before a planning result exists.")
        if action == "retry_patch":
            run.patch_preview = None
            run.pending_patch_operations = []
            run.edits = []
            _append_agent_event(run, "patch", "Patch generation retry requested", payload.note or "Regenerating file operations from the current plan.", "warning")
        run.approval_status = "generating_patch"
        run.error = None
        run.approval_required = False
        run.status = "generating_patch"
        run.finished_at = None
        run.updated_at = datetime.utcnow()
        _update_plan_item(run, "approval", "completed", payload.note or "Approved to generate a patch preview.")
        _ensure_plan_item(
            run,
            AgentPlanItem(
                id="patch",
                title="Generate patch preview",
                status="running",
                detail="Ask the local model for concrete file operations without writing files.",
            ),
        )
        _ensure_plan_item(
            run,
            AgentPlanItem(
                id="apply",
                title="Apply reviewed patch",
                status="queued",
                detail="Wait until the patch preview is explicitly approved.",
            ),
        )
        _append_agent_event(run, "approval", "Patch preview approved", payload.note or "Generating a reviewable patch preview now.", "completed")
        _append_agent_message(run, "approval_request", "Approved to generate a patch preview. No files will be changed until you apply it.")
        task = AGENT_TASKS.get(run_id)
        if not task or task.done():
            AGENT_TASKS[run_id] = asyncio.create_task(_execute_agent_patch(run_id, model_service))
        return run

    if action == "apply":
        if run.status != "waiting_for_approval" or not run.pending_patch_operations:
            return run
        run.approval_status = "applying"
        run.error = None
        run.approval_required = False
        run.status = "applying_patch"
        run.finished_at = None
        run.updated_at = datetime.utcnow()
        _ensure_plan_item(run, AgentPlanItem(id="apply", title="Apply reviewed patch", status="running", detail="Writing approved changes to disk."))
        _append_agent_event(run, "approval", "Patch apply approved", payload.note or "Applying the reviewed patch now.", "completed")
        _append_agent_message(run, "approval_request", "Patch preview approved. Applying the reviewed file operations now.")
        task = AGENT_TASKS.get(run_id)
        if not task or task.done():
            AGENT_TASKS[run_id] = asyncio.create_task(_apply_agent_patch(run_id))
    return run


@router.get("/runs/{run_id}/review", response_model=AgentWorkspaceReviewResponse)
async def get_agent_run_review(run_id: str) -> AgentWorkspaceReviewResponse:
    run = AGENT_RUNS.get(run_id)
    if not run:
        raise BadRequestError("Agent run was not found.")
    if run.review:
        return run.review
    return _build_workspace_review(Path(run.workspace_path), internal_review=run.patch_preview)


@router.post("/runs/{run_id}/cancel", response_model=AgentRunStatusResponse)
async def cancel_agent_run(run_id: str) -> AgentRunStatusResponse:
    run = AGENT_RUNS.get(run_id)
    if not run:
        raise BadRequestError("Agent run was not found.")
    if run.status not in {"queued", "running", "waiting_for_approval", "generating_patch", "applying_patch", "reviewing"}:
        return run

    task = AGENT_TASKS.get(run_id)
    if task and not task.done():
        task.cancel()

    now = datetime.utcnow()
    run.status = "cancelled"
    run.error = "Agent run stopped by user."
    run.finished_at = now
    run.updated_at = now
    for item in run.plan:
        if item.status in {"queued", "running"}:
            item.status = "skipped"
            item.detail = "Stopped by user."
    _append_agent_event(run, "cancel", "Run stopped", "User stopped the agent run.", "cancelled")
    return run


@router.post("/run", response_model=AgentRunResponse)
async def run_agent(
    payload: AgentRunRequest,
    model_service: ModelService = Depends(get_model_service),
) -> AgentRunResponse:
    return await _perform_agent_run(payload, model_service)


async def _perform_agent_run(
    payload: AgentRunRequest,
    model_service: ModelService,
    run_id: str | None = None,
) -> AgentRunResponse:
    started_at = time.perf_counter()
    model = model_service.config_service.get_model(payload.model_id)
    workspace = _resolve_workspace(payload.workspace_path)
    run = AGENT_RUNS.get(run_id) if run_id else None
    if run:
        run.model_name = model.name
        run.workspace_path = str(workspace)
        run.status = "running"
        run.updated_at = datetime.utcnow()
        _update_plan_item(run, "inspect", "running", f"Scanning {workspace.name}")
        _append_agent_event(run, "tool", "Inspect workspace", str(workspace), "running")
    profile = model.get_active_profile()
    context_size = profile.context_size if profile else 8192
    context_budget_tokens = max(512, int(context_size * (payload.settings.context_budget_percent / 100)))
    max_tokens = payload.settings.agent_max_tokens
    prompt_budget_tokens = max(512, min(context_budget_tokens, max(512, context_size - max_tokens - 512)))
    file_budget_chars = min(payload.settings.file_context_limit_kb * 1024, max(8_000, prompt_budget_tokens * 2))

    inspected, snippets, warning = _collect_workspace_context(workspace, payload.prompt, file_budget_chars)
    if run:
        _update_plan_item(run, "inspect", "completed", f"{len(inspected)} candidate text files")
        _update_plan_item(run, "context", "running", "Packing files into the model context")
        _append_agent_event(run, "tool", "Files scanned", f"{len(inspected)} candidate text files", "completed")
    snippets, fit_warning = _fit_snippets_to_prompt_budget(workspace, payload, snippets, prompt_budget_tokens)
    if fit_warning:
        warning = f"{warning or ''}\n{fit_warning}".strip()
    _sync_included_file_flags(inspected, snippets)
    prompt = _build_agent_prompt(workspace, payload, snippets, context_budget_tokens)
    if run:
        included_count = len([item for item in inspected if item.included])
        prompt_tokens = _estimate_tokens(prompt)
        _update_plan_item(run, "context", "completed", f"{included_count} files included, ~{prompt_tokens} tokens")
        _update_plan_item(run, "model", "running", f"Asking {model.name}")
        _append_agent_event(run, "context", "Context packed", f"{included_count} files included, ~{prompt_tokens} tokens estimated", "completed")
        _append_agent_event(run, "model", "Local model request", f"Sending plan request to {model.name}", "running")

    if model.provider == ProviderType.OLLAMA:
        content, finish_reason, thinking_content = await _agent_with_ollama(model, prompt, max_tokens, payload, run=run)
    else:
        content, finish_reason, thinking_content = await _agent_with_openai_compatible(model, prompt, max_tokens, payload, run=run)
    if run:
        _update_plan_item(run, "model", "completed", f"{round((time.perf_counter() - started_at) * 1000)} ms")
        _update_plan_item(run, "review", "running", "Reading Git status and diff")
        _append_agent_event(run, "model", "Model plan generated", f"{round((time.perf_counter() - started_at) * 1000)} ms", "completed")

    included = [item for item in inspected if item.included]
    visible_content, split_thinking = _split_hidden_reasoning(content)
    thinking = thinking_content or split_thinking or None
    if finish_reason in {"length", "max_tokens"}:
        warning = f"{warning or ''}\nModel stopped at max tokens; raise Agent max tokens for longer plans.".strip()

    steps = [
        AgentRunStep(title="Workspace selected", detail=str(workspace)),
        AgentRunStep(title="Files scanned", detail=f"{len(inspected)} candidate text files"),
        AgentRunStep(title="Context packed", detail=f"{len(included)} files included, ~{_estimate_tokens(prompt)} tokens estimated"),
        AgentRunStep(title="Model plan generated", detail=f"{round((time.perf_counter() - started_at) * 1000)} ms"),
    ]

    response_id = run_id or f"agent-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    return AgentRunResponse(
        id=response_id,
        model_id=model.id,
        model_name=model.name,
        workspace_path=str(workspace),
        created_at=datetime.utcnow(),
        content=visible_content,
        thinking_content=thinking,
        thinking_tokens_estimate=_estimate_tokens(thinking or "") if thinking else None,
        used_context_tokens_estimate=_estimate_tokens(prompt),
        context_budget_tokens=context_budget_tokens,
        inspected_files=inspected,
        included_files=included,
        steps=steps,
        settings=payload.settings,
        warning=warning or None,
    )


async def _execute_agent_run(
    run_id: str,
    payload: AgentRunRequest,
    model_service: ModelService,
) -> None:
    run = AGENT_RUNS.get(run_id)
    if not run:
        return

    try:
        response = await _perform_agent_run(payload, model_service, run_id=run_id)
        run.result = response
        _append_agent_message(run, "thinking_summary", _summarize_plan_response(response.content))
        run.review = _build_workspace_review(Path(response.workspace_path), internal_review=run.patch_preview)
        _update_plan_item(run, "review", "completed", run.review.summary)
        _append_agent_event(run, "review", "Review snapshot captured", run.review.summary, "completed")

        if payload.settings.approval_mode in {"review", "manual"}:
            run.status = "waiting_for_approval"
            run.approval_required = True
            run.approval_status = "waiting"
            _update_plan_item(run, "approval", "running", "Waiting for the next patch approval.")
            _append_agent_event(
                run,
                "approval",
                "Approval requested",
                "Ready to generate and apply the next patch inside this workspace.",
                "waiting",
            )
            _append_agent_message(run, "approval_request", "Ready to apply changes. Review the plan, then approve the patch step.")
        else:
            run.approval_required = False
            run.approval_status = "not_required"
            _update_plan_item(run, "approval", "completed", "Read-only auto mode finished.")
            run.status = "completed"
            run.finished_at = datetime.utcnow()
            run.updated_at = run.finished_at
    except asyncio.CancelledError:
        if run.status != "cancelled":
            run.status = "cancelled"
            run.error = "Agent run stopped by user."
            run.finished_at = datetime.utcnow()
            run.updated_at = run.finished_at
            for item in run.plan:
                if item.status in {"queued", "running"}:
                    item.status = "skipped"
                    item.detail = "Stopped by user."
            _append_agent_event(run, "cancel", "Run stopped", "User stopped the agent run.", "cancelled")
        return
    except Exception as exc:  # noqa: BLE001 - route tasks need to capture and display failures.
        run.status = "failed"
        run.error = str(exc)
        run.finished_at = datetime.utcnow()
        run.updated_at = run.finished_at
        for item in run.plan:
            if item.status == "running":
                item.status = "failed"
                item.detail = str(exc)[:500]
        _append_agent_event(run, "error", "Agent run failed", str(exc)[:1000], "failed")
    finally:
        AGENT_TASKS.pop(run_id, None)


async def _execute_agent_patch(run_id: str, model_service: ModelService) -> None:
    run = AGENT_RUNS.get(run_id)
    if not run:
        return
    started_at = time.perf_counter()
    try:
        if not run.result:
            raise BadRequestError("The agent cannot apply a patch before a planning result exists.")
        model = model_service.config_service.get_model(run.model_id)
        workspace = _resolve_workspace(run.workspace_path)
        settings = run.result.settings
        payload = AgentRunRequest(
            model_id=run.model_id,
            workspace_path=run.workspace_path,
            prompt=run.prompt,
            attachments=[],
            settings=settings,
        )
        file_budget_chars = min(settings.file_context_limit_kb * 1024, 260_000)

        run.status = "generating_patch"
        run.updated_at = datetime.utcnow()
        _update_plan_item(run, "patch", "running", "Generating concrete file operations.")
        _append_agent_event(run, "patch", "Patch preview generation started", "Asking the local model for concrete workspace file operations.", "running")
        _append_agent_message(run, "narration", "Generating a concrete patch preview for the approved plan. Files are still read-only.")

        inspected, snippets, warning = _collect_workspace_context(workspace, run.prompt, file_budget_chars)
        if warning:
            _append_agent_event(run, "context", "Patch context note", warning, "warning")
        async def request_patch(prompt_text: str) -> tuple[str, str | None, str | None]:
            if model.provider == ProviderType.OLLAMA:
                return await _agent_with_ollama(
                    model,
                    prompt_text,
                    settings.patch_max_tokens,
                    payload,
                    system_message=PATCH_SYSTEM_MESSAGE,
                    run=run,
                )
            return await _agent_with_openai_compatible(
                model,
                prompt_text,
                settings.patch_max_tokens,
                payload,
                system_message=PATCH_SYSTEM_MESSAGE,
                run=run,
            )

        prompt = _build_patch_prompt(workspace, run, snippets)
        content, finish_reason, thinking_content = await request_patch(prompt)
        visible_content, split_thinking = _split_hidden_reasoning(content)
        recovered_patch = False
        first_parse_error: BadRequestError | None = None
        try:
            patch_payload = _extract_patch_payload(visible_content)
            operations = _patch_operations_from_payload(patch_payload, run)
        except BadRequestError as parse_error:
            first_parse_error = parse_error
            recovered_payload = _recover_patch_payload(run, visible_content)
            if recovered_payload:
                patch_payload = recovered_payload
                operations = _patch_operations_from_payload(patch_payload, run)
                recovered_patch = True
            else:
                operations = []
                patch_payload = {}
        if not operations:
            _append_agent_event(
                run,
                "patch",
                "Patch format repair",
                "The model returned prose instead of file operations. Asking once more for strict JSON.",
                "warning",
            )
            _append_agent_message(
                run,
                "narration",
                "The local model returned a plan instead of files. I am asking once more for a strict patch payload.",
            )
            retry_prompt = _build_patch_retry_prompt(workspace, run, visible_content)
            content, finish_reason, retry_thinking = await request_patch(retry_prompt)
            visible_content, retry_split_thinking = _split_hidden_reasoning(content)
            thinking_content = "\n\n".join(
                part for part in [thinking_content, retry_thinking, retry_split_thinking] if part
            ) or None
            split_thinking = None
            try:
                patch_payload = _extract_patch_payload(visible_content)
                operations = _patch_operations_from_payload(patch_payload, run)
            except BadRequestError as retry_error:
                recovered_payload = _recover_patch_payload(run, visible_content) or _recover_patch_payload(
                    run,
                    run.result.content if run.result else "",
                )
                if not recovered_payload:
                    raise BadRequestError(
                        f"{retry_error} First parse error: {first_parse_error}. "
                        "The local model did not return concrete file operations after repair."
                    ) from retry_error
                patch_payload = recovered_payload
                operations = _patch_operations_from_payload(patch_payload, run)
                recovered_patch = True

        if recovered_patch:
            _append_agent_event(
                run,
                "patch",
                "Patch recovered",
                "Quokka normalized the local model output into safe workspace file operations.",
                "warning",
            )
            _append_agent_message(
                run,
                "narration",
                "The local model did not follow the patch schema cleanly, so I normalized the output into a safe workspace patch.",
            )

        _append_agent_message(run, "thinking_summary", str(patch_payload.get("summary") or "Patch generated. Validating file operations."))
        if thinking_content or split_thinking:
            run.result.thinking_content = "\n\n".join(part for part in [run.result.thinking_content, thinking_content, split_thinking] if part)
            run.result.thinking_tokens_estimate = _estimate_tokens(run.result.thinking_content)

        patch_review = _apply_patch_operations(workspace, operations, apply_changes=False)
        run.patch_preview = patch_review
        run.pending_patch_operations = [dict(operation) for operation in operations if isinstance(operation, dict)]
        run.edits = patch_review.files
        _update_plan_item(run, "patch", "completed", patch_review.summary)
        _update_plan_item(run, "apply", "queued", "Review the patch preview, then approve apply.")
        _append_agent_event(
            run,
            "patch",
            "Patch preview ready",
            patch_review.summary,
            "completed",
            {"files": [file.model_dump() for file in patch_review.files]},
        )
        _append_agent_message(
            run,
            "file_changes",
            f"Patch preview ready. {patch_review.summary}. No files have been changed yet.",
            {"files": [file.model_dump() for file in patch_review.files]},
        )

        if finish_reason in {"length", "max_tokens"}:
            run.error = "Patch may be incomplete because the model stopped at max tokens."
            _append_agent_event(run, "warning", "Patch output hit token limit", run.error, "warning")

        run.status = "waiting_for_approval"
        run.approval_required = True
        run.approval_status = "patch_preview_ready"
        run.finished_at = None
        run.updated_at = datetime.utcnow()
        _append_agent_message(
            run,
            "narration",
            f"Patch preview is ready in {round((time.perf_counter() - started_at) * 1000)} ms. Review the diff, then apply or retry generation.",
        )
    except asyncio.CancelledError:
        if run.status != "cancelled":
            run.status = "cancelled"
            run.error = "Agent patch stopped by user."
            run.finished_at = datetime.utcnow()
            run.updated_at = run.finished_at
            for item in run.plan:
                if item.status in {"queued", "running"}:
                    item.status = "skipped"
                    item.detail = "Stopped by user."
            _append_agent_event(run, "cancel", "Patch stopped", "User stopped the patch run.", "cancelled")
        return
    except Exception as exc:  # noqa: BLE001 - async task should surface any failure in the UI.
        run.status = "failed"
        run.error = str(exc)
        run.finished_at = datetime.utcnow()
        run.updated_at = run.finished_at
        _update_plan_item(run, "patch", "failed", str(exc)[:500])
        _append_agent_event(run, "error", "Patch failed", str(exc)[:1000], "failed")
        _append_agent_message(run, "error", str(exc)[:1000])
    finally:
        AGENT_TASKS.pop(run_id, None)


async def _apply_agent_patch(run_id: str) -> None:
    run = AGENT_RUNS.get(run_id)
    if not run:
        return
    started_at = time.perf_counter()
    try:
        if not run.pending_patch_operations:
            raise BadRequestError("There is no patch preview to apply. Generate a patch preview first.")
        workspace = _resolve_workspace(run.workspace_path)
        run.status = "applying_patch"
        run.updated_at = datetime.utcnow()
        _update_plan_item(run, "apply", "running", "Writing the approved patch to disk.")
        _append_agent_event(run, "apply", "Patch apply started", "Writing approved file operations to the workspace.", "running")

        patch_review = _apply_patch_operations(workspace, run.pending_patch_operations, apply_changes=True)
        run.patch_preview = patch_review
        run.edits = patch_review.files
        run.pending_patch_operations = []
        _update_plan_item(run, "apply", "completed", patch_review.summary)
        _append_agent_event(
            run,
            "apply",
            "Patch applied",
            patch_review.summary,
            "completed",
            {"files": [file.model_dump() for file in patch_review.files]},
        )
        _append_agent_message(
            run,
            "file_changes",
            f"Patch applied. {patch_review.summary}",
            {"files": [file.model_dump() for file in patch_review.files]},
        )

        run.status = "reviewing"
        _ensure_plan_item(run, AgentPlanItem(id="final_review", title="Review changes", status="running", detail="Capturing the changed files."))
        _append_agent_event(run, "review", "Review refresh started", "Capturing changed files and diff.", "running")
        run.review = _build_workspace_review(workspace, internal_review=patch_review)
        _update_plan_item(run, "final_review", "completed", run.review.summary)
        _append_agent_event(run, "review", "Review ready", run.review.summary, "completed")

        run.status = "completed"
        run.approval_required = False
        run.approval_status = "applied"
        run.finished_at = datetime.utcnow()
        run.updated_at = run.finished_at
        _append_agent_message(
            run,
            "narration",
            f"Done. Applied {len(patch_review.files)} file change{'s' if len(patch_review.files) != 1 else ''} in {round((time.perf_counter() - started_at) * 1000)} ms.",
        )
    except asyncio.CancelledError:
        if run.status != "cancelled":
            run.status = "cancelled"
            run.error = "Agent patch apply stopped by user."
            run.finished_at = datetime.utcnow()
            run.updated_at = run.finished_at
            for item in run.plan:
                if item.status in {"queued", "running"}:
                    item.status = "skipped"
                    item.detail = "Stopped by user."
            _append_agent_event(run, "cancel", "Patch apply stopped", "User stopped the patch apply step.", "cancelled")
        return
    except Exception as exc:  # noqa: BLE001 - async task should surface any failure in the UI.
        run.status = "failed"
        run.error = str(exc)
        run.finished_at = datetime.utcnow()
        run.updated_at = run.finished_at
        _update_plan_item(run, "apply", "failed", str(exc)[:500])
        _append_agent_event(run, "error", "Patch apply failed", str(exc)[:1000], "failed")
        _append_agent_message(run, "error", str(exc)[:1000])
    finally:
        AGENT_TASKS.pop(run_id, None)


def _initial_agent_plan() -> list[AgentPlanItem]:
    return [
        AgentPlanItem(id="inspect", title="Review workspace and task scope", status="queued", detail="Find candidate text files."),
        AgentPlanItem(id="context", title="Pack relevant files into context", status="queued", detail="Fit files, attachments, and prompt into the model window."),
        AgentPlanItem(id="model", title="Ask the local model for a plan", status="queued", detail="Generate a plan with the selected endpoint."),
        AgentPlanItem(id="review", title="Prepare a review snapshot", status="queued", detail="Read Git status and diff without changing files."),
        AgentPlanItem(id="approval", title="Wait for approval", status="queued", detail="Pause before file changes."),
    ]


def _append_agent_event(
    run: AgentRunStatusResponse,
    event_type: str,
    title: str,
    detail: str | None = None,
    status: str = "info",
    metadata: dict[str, object] | None = None,
) -> None:
    run.events.append(
        AgentRunEvent(
            id=f"{run.id}-event-{len(run.events) + 1}",
            index=len(run.events) + 1,
            timestamp=datetime.utcnow(),
            type=event_type,
            title=title,
            detail=detail,
            status=status,
            metadata=dict(metadata or {}),
        )
    )
    if len(run.events) > 120:
        run.events = run.events[-120:]
    run.updated_at = datetime.utcnow()


def _append_agent_message(
    run: AgentRunStatusResponse,
    message_type: str,
    content: str,
    metadata: dict[str, object] | None = None,
) -> None:
    run.messages.append(
        AgentRunMessage(
            id=f"{run.id}-message-{len(run.messages) + 1}",
            timestamp=datetime.utcnow(),
            type=message_type,
            content=content,
            metadata=dict(metadata or {}),
        )
    )
    if len(run.messages) > 80:
        run.messages = run.messages[-80:]
    run.updated_at = datetime.utcnow()


def _ensure_plan_item(run: AgentRunStatusResponse, item: AgentPlanItem) -> None:
    for index, existing in enumerate(run.plan):
        if existing.id == item.id:
            run.plan[index] = item
            run.updated_at = datetime.utcnow()
            return
    run.plan.append(item)
    run.updated_at = datetime.utcnow()


def _update_plan_item(run: AgentRunStatusResponse, item_id: str, status: str, detail: str | None = None) -> None:
    for item in run.plan:
        if item.id == item_id:
            item.status = status
            if detail is not None:
                item.detail = detail
            run.updated_at = datetime.utcnow()
            return


def _trim_agent_runs() -> None:
    if len(AGENT_RUNS) <= AGENT_RUN_LIMIT:
        return
    active_statuses = {"queued", "running", "waiting_for_approval", "generating_patch", "applying_patch", "reviewing"}
    removable = sorted(
        (run for run in AGENT_RUNS.values() if run.status not in active_statuses),
        key=lambda item: item.created_at,
    )
    for run in removable[: max(0, len(AGENT_RUNS) - AGENT_RUN_LIMIT)]:
        AGENT_RUNS.pop(run.id, None)
        AGENT_TASKS.pop(run.id, None)


def _build_workspace_review(workspace: Path, internal_review: AgentWorkspaceReviewResponse | None = None) -> AgentWorkspaceReviewResponse:
    repo_check = _git(workspace, "rev-parse", "--show-toplevel")
    if repo_check.returncode != 0:
        if internal_review and internal_review.files:
            return internal_review.model_copy(
                update={
                    "workspace_path": str(workspace),
                    "is_git_repo": False,
                    "error": None,
                }
            )
        return AgentWorkspaceReviewResponse(
            workspace_path=str(workspace),
            is_git_repo=False,
            summary="This workspace is not a Git repository yet.",
            error=(repo_check.stderr or repo_check.stdout or "git rev-parse failed").strip()[:500],
        )

    status = _git(workspace, "status", "--porcelain=v1")
    unstaged_stats = _git(workspace, "diff", "--numstat")
    staged_stats = _git(workspace, "diff", "--cached", "--numstat")
    unstaged_diff = _git(workspace, "diff", "--no-ext-diff", "--color=never", "--unified=3")
    staged_diff = _git(workspace, "diff", "--cached", "--no-ext-diff", "--color=never", "--unified=3")

    status_lines = [line for line in status.stdout.splitlines() if line.strip()] if status.returncode == 0 else []
    file_map: dict[str, AgentDiffFile] = {}

    for line in status_lines:
        if len(line) < 4:
            continue
        path = line[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        file_map[path] = AgentDiffFile(path=path, status=line[:2].strip() or "modified")

    for line in [*unstaged_stats.stdout.splitlines(), *staged_stats.stdout.splitlines()]:
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        additions_raw, deletions_raw, path = parts[0], parts[1], parts[2]
        target = file_map.get(path) or AgentDiffFile(path=path, status="modified")
        if additions_raw == "-" or deletions_raw == "-":
            target.binary = True
        else:
            target.additions += int(additions_raw or 0)
            target.deletions += int(deletions_raw or 0)
        file_map[path] = target

    if internal_review and internal_review.files:
        for internal_file in internal_review.files:
            existing = file_map.get(internal_file.path)
            if existing:
                if existing.additions == 0 and existing.deletions == 0:
                    existing.additions = internal_file.additions
                    existing.deletions = internal_file.deletions
                existing.binary = existing.binary or internal_file.binary
                file_map[internal_file.path] = existing
            else:
                file_map[internal_file.path] = internal_file

    files = sorted(file_map.values(), key=lambda item: item.path.lower())
    insertions = sum(item.additions for item in files)
    deletions = sum(item.deletions for item in files)
    diff = "\n\n".join(
        chunk
        for chunk in [
            staged_diff.stdout.strip(),
            unstaged_diff.stdout.strip(),
            internal_review.diff.strip() if internal_review and internal_review.diff else "",
        ]
        if chunk
    )
    if len(diff) > 80_000:
        diff = f"{diff[:80_000]}\n\n[diff truncated at 80k characters]"

    summary = (
        "No local Git changes."
        if not files
        else f"{len(files)} changed file{'s' if len(files) != 1 else ''}, +{insertions} -{deletions}"
    )
    return AgentWorkspaceReviewResponse(
        workspace_path=str(workspace),
        is_git_repo=True,
        summary=summary,
        files=files,
        diff=diff,
        status_lines=status_lines,
        insertions=insertions,
        deletions=deletions,
        error=None if status.returncode == 0 else status.stderr.strip()[:500],
    )


def _git(workspace: Path, *args: str) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(workspace), *args],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(
            args=["git", "-C", str(workspace), *args],
            returncode=1,
            stdout="",
            stderr=str(exc),
        )


def _resolve_workspace(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        raise BadRequestError("Agent Lab needs an absolute workspace path. Use Open folder from the desktop app.")
    try:
        resolved = path.resolve()
    except OSError as exc:
        raise BadRequestError(f"Could not resolve workspace path: {exc}") from exc
    if not resolved.exists() or not resolved.is_dir():
        raise BadRequestError("Workspace path does not exist or is not a directory.")
    return resolved


def _collect_workspace_context(
    workspace: Path,
    prompt: str,
    file_budget_chars: int,
) -> tuple[list[AgentWorkspaceFile], list[tuple[str, str]], str | None]:
    scanned: list[AgentWorkspaceFile] = []
    candidates: list[tuple[int, Path, int]] = []
    prompt_terms = {term.lower() for term in re.findall(r"[A-Za-z0-9_\-.]{3,}", prompt)}

    for root, dirs, files in os.walk(workspace):
        dirs[:] = [dirname for dirname in dirs if dirname not in IGNORED_DIRS]
        for filename in files:
            if len(scanned) >= 500:
                break
            path = Path(root) / filename
            if path.suffix.lower() not in TEXT_EXTENSIONS:
                continue
            try:
                size = path.stat().st_size
                relative = path.relative_to(workspace).as_posix()
            except OSError:
                continue
            except ValueError:
                continue
            file_row = AgentWorkspaceFile(path=relative, size_bytes=size)
            scanned.append(file_row)
            if size > 240_000:
                file_row.reason = "Skipped: file is too large for first-pass context."
                continue
            score = 0
            lower_relative = relative.lower()
            for term in prompt_terms:
                if term in lower_relative:
                    score += 5
            if path.name.lower() in {"readme.md", "package.json", "pyproject.toml", "requirements.txt", "vite.config.ts"}:
                score += 4
            if path.suffix.lower() in {".ts", ".tsx", ".py", ".js", ".jsx"}:
                score += 2
            candidates.append((score, path, size))
        if len(scanned) >= 500:
            break

    candidates.sort(key=lambda item: (-item[0], item[2], item[1].as_posix()))
    snippets: list[tuple[str, str]] = []
    used_chars = 0
    indexed = {item.path: item for item in scanned}

    for _score, path, size in candidates:
        if used_chars >= file_budget_chars:
            break
        relative = path.relative_to(workspace).as_posix()
        remaining = max(file_budget_chars - used_chars, 0)
        if remaining < 800:
            break
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        snippet = text[: min(len(text), remaining, 18_000)]
        used_chars += len(snippet)
        snippets.append((relative, snippet))
        if relative in indexed:
            indexed[relative].included = True
            indexed[relative].reason = f"Included in context, {len(snippet)} chars"

    warning = None
    if not snippets:
        warning = "No text files were included. The agent can still plan, but it has no code context yet."
    elif used_chars >= file_budget_chars:
        warning = "File context budget reached; raise File context KB for broader analysis."
    return scanned, snippets, warning


def _build_agent_prompt(
    workspace: Path,
    payload: AgentRunRequest,
    snippets: list[tuple[str, str]],
    context_budget_tokens: int,
) -> str:
    files = "\n\n".join(f"--- FILE: {path}\n{text}" for path, text in snippets)
    attachments = _format_agent_attachments(payload)
    return (
        f"Workspace: {workspace}\n"
        f"Approval mode: {payload.settings.approval_mode}\n"
        f"Auto compact: {payload.settings.auto_compact}\n"
        f"Keep last messages: {payload.settings.keep_last_messages}\n"
        f"Context budget estimate: {context_budget_tokens} tokens\n"
        f"Patch max output tokens for future edit mode: {payload.settings.patch_max_tokens}\n\n"
        f"User task:\n{payload.prompt}\n\n"
        "User attachments:\n"
        f"{attachments}\n\n"
        "Workspace context:\n"
        f"{files if files else '[no files included]'}\n\n"
        "Return sections:\n"
        "1. Understanding\n"
        "2. Relevant files\n"
        "3. Plan\n"
        "4. Risks / questions\n"
        "5. Checks to run\n"
        "6. Next patch strategy\n"
    )


def _summarize_plan_response(content: str) -> str:
    text = re.sub(r"\s+", " ", content).strip()
    if not text:
        return "Plan generated. Review it, then approve the patch step when ready."
    headings = re.split(r"(?:^|\s)(?:#{1,6}\s*)?(?:\d+\.\s*)?(?:Understanding|Plan|Next patch strategy|Relevant files)[:\s-]+", text, flags=re.IGNORECASE)
    candidate = next((part.strip() for part in headings if len(part.strip()) > 40), text)
    if len(candidate) > 360:
        candidate = f"{candidate[:360].rstrip()}..."
    return f"Plan generated. {candidate}"


def _build_patch_prompt(
    workspace: Path,
    run: AgentRunStatusResponse,
    snippets: list[tuple[str, str]],
) -> str:
    plan = run.result.content if run.result else ""
    files = "\n\n".join(f"--- FILE: {path}\n{text}" for path, text in snippets)
    return (
        f"Workspace root: {workspace}\n\n"
        f"User task:\n{run.prompt}\n\n"
        f"Approved planning output:\n{plan}\n\n"
        "Current workspace context:\n"
        f"{files if files else '[no text files included]'}\n\n"
        "Generate the actual patch now. Return JSON only with this exact shape:\n"
        "{\n"
        '  "summary": "short human summary",\n'
        '  "operations": [\n'
        '    {"action": "write", "path": "relative/path.ext", "content": "complete UTF-8 final file content"}\n'
        "  ]\n"
        "}\n"
        "Rules:\n"
        "- Use only relative paths inside the workspace.\n"
        "- Use write for both create and modify; include the complete final file content.\n"
        "- Use delete only when the user explicitly asked to remove a file.\n"
        "- For a single-file HTML game, prefer index.html.\n"
        "- If there are no existing text files, create the target file anyway.\n"
        "- Do not ask clarifying questions in the write phase; make a conservative useful implementation.\n"
        "- Do not include markdown fences, comments outside JSON, or partial diffs.\n"
    )


def _build_patch_retry_prompt(workspace: Path, run: AgentRunStatusResponse, previous_response: str) -> str:
    clipped_previous = previous_response.strip()
    if len(clipped_previous) > 12_000:
        clipped_previous = f"{clipped_previous[:12_000]}\n\n[previous response truncated]"
    return (
        f"Workspace root: {workspace}\n\n"
        f"User task:\n{run.prompt}\n\n"
        "Your previous response did not contain usable file operations. Convert the approved task into a concrete patch now.\n"
        "This is not a planning turn. Do not describe what you would do. Produce the file content now.\n"
        "Return only valid JSON with no markdown, no prose, and no planning text. The first character must be '{':\n"
        "{\n"
        '  "summary": "short summary",\n'
        '  "operations": [\n'
        '    {"action": "write", "path": "index.html", "content": "complete final UTF-8 file content"}\n'
        "  ]\n"
        "}\n\n"
        "If the task asks for an HTML app or game, create index.html with complete HTML, CSS, and JavaScript in the content string.\n\n"
        "Previous unusable response:\n"
        f"{clipped_previous}\n"
    )


def _extract_patch_payload(content: str) -> dict[str, object]:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()

    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char not in {"{", "["}:
            continue
        try:
            payload, _end = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
        if isinstance(payload, list):
            return {"summary": "Patch operations returned as a list.", "operations": payload}

    html_start = re.search(r"(?is)(<!doctype html|<html[\s>])", text)
    if html_start:
        html = text[html_start.start() :].strip()
        return {
            "summary": "Created index.html from the model response.",
            "operations": [{"action": "write", "path": "index.html", "content": html}],
        }

    code_fence = re.search(r"```(?:html|javascript|js|python|py|css|ts|tsx)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
    if code_fence:
        body = code_fence.group(1).strip()
        path = "index.html" if "<html" in body.lower() or "<canvas" in body.lower() else "generated.txt"
        return {
            "summary": f"Created {path} from a fenced code response.",
            "operations": [{"action": "write", "path": path, "content": body}],
        }

    raise BadRequestError("The patch response was not valid JSON and did not contain a recoverable file body.")


def _recover_patch_payload(run: AgentRunStatusResponse, content: str) -> dict[str, object] | None:
    text = content.strip()
    if not text:
        return None

    html_start = re.search(r"(?is)(<!doctype html|<html[\s>])", text)
    if html_start:
        return {
            "summary": "Recovered index.html from the model response.",
            "operations": [{"action": "write", "path": "index.html", "content": text[html_start.start() :].strip()}],
        }

    if _looks_like_single_file_html_task(run.prompt):
        return {
            "summary": "Created a safe single-file HTML fallback because the local model returned no file operations.",
            "operations": [
                {
                    "action": "write",
                    "path": "index.html",
                    "content": _build_single_file_html_fallback(run.prompt),
                }
            ],
        }

    return None


def _looks_like_single_file_html_task(prompt: str) -> bool:
    text = prompt.lower()
    wants_web_file = any(token in text for token in ("html", "web", "browser", "canvas", "site", "page", "game"))
    wants_creation = any(token in text for token in ("build", "create", "make", "write", "generate", "сдел", "созда", "напиши"))
    return wants_web_file and wants_creation


def _build_single_file_html_fallback(prompt: str) -> str:
    title = _html_escape(_derive_fallback_title(prompt))
    task_json = (
        json.dumps(prompt[:800])
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )
    if not any(token in prompt.lower() for token in ("flight", "aircraft", "plane", "fly", "самолет", "самол", "полет", "полёт", "лети")):
        return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #070705; color: #f4eee4; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 32px; background: radial-gradient(circle at 50% 18%, rgba(195,155,106,.22), transparent 34%), linear-gradient(145deg, #11100e, #040403); }
    section { width: min(920px, 100%); border: 1px solid rgba(195,155,106,.26); border-radius: 20px; background: rgba(20,19,16,.72); box-shadow: 0 30px 90px rgba(0,0,0,.48); backdrop-filter: blur(18px); padding: clamp(24px, 5vw, 56px); }
    .eyebrow { color: #c39b6a; letter-spacing: .24em; text-transform: uppercase; font-size: 12px; }
    h1 { margin: 12px 0; font-size: clamp(34px, 7vw, 76px); line-height: .96; max-width: 820px; }
    p { color: rgba(244,238,228,.72); font-size: 18px; line-height: 1.7; max-width: 760px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 28px; }
    .card { border: 1px solid rgba(255,255,255,.10); border-radius: 14px; background: rgba(255,255,255,.035); padding: 18px; }
    .card strong { display: block; margin-bottom: 8px; }
    button { margin-top: 28px; border: 0; border-radius: 999px; background: #c39b6a; color: #11100e; padding: 14px 20px; font-weight: 800; cursor: pointer; }
    button:hover { filter: brightness(1.08); }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="eyebrow">Quokka generated</div>
      <h1>__TITLE__</h1>
      <p id="summary"></p>
      <div class="grid">
        <div class="card"><strong>Local first</strong><span>Everything is contained in this single HTML file.</span></div>
        <div class="card"><strong>Editable</strong><span>Use this as a clean starting point and iterate with Agent Lab.</span></div>
        <div class="card"><strong>Responsive</strong><span>The layout adapts from desktop to mobile without extra assets.</span></div>
      </div>
      <button id="action">Start</button>
    </section>
  </main>
  <script>
    const task = __TASK_JSON__;
    document.getElementById("summary").textContent = task || "A local single-file web experience generated by Quokka.";
    document.getElementById("action").addEventListener("click", () => {
      document.body.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.18)" }, { filter: "brightness(1)" }], { duration: 520 });
    });
  </script>
</body>
</html>
""".replace("__TITLE__", title).replace("__TASK_JSON__", task_json)
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>__TITLE__</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; overflow: hidden; background: #050504; color: #f4eee4; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    canvas { width: 100vw; height: 100vh; display: block; background: radial-gradient(circle at 50% 20%, #1f2a2d 0, #090907 55%, #020202 100%); }
    .hud { position: fixed; inset: 18px; pointer-events: none; display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
    .panel { min-width: 220px; border: 1px solid rgba(190, 150, 105, .32); background: rgba(16, 15, 13, .68); box-shadow: 0 24px 80px rgba(0,0,0,.45); backdrop-filter: blur(18px); border-radius: 14px; padding: 14px 16px; }
    .eyebrow { color: #c39b6a; letter-spacing: .22em; font-size: 11px; text-transform: uppercase; }
    h1 { margin: 8px 0 10px; font-size: 20px; line-height: 1.15; }
    .metric { display: grid; grid-template-columns: 1fr auto; gap: 14px; color: #d8d2c9; font-size: 14px; padding: 4px 0; }
    .hint { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); color: #d8d2c9; border: 1px solid rgba(255,255,255,.12); background: rgba(18,18,16,.62); border-radius: 999px; padding: 10px 16px; backdrop-filter: blur(16px); }
  </style>
</head>
<body>
  <canvas id="scene"></canvas>
  <div class="hud">
    <section class="panel">
      <div class="eyebrow">Quokka Flight</div>
      <h1>__TITLE__</h1>
      <div class="metric"><span>Speed</span><strong id="speed">0</strong></div>
      <div class="metric"><span>Altitude</span><strong id="altitude">0</strong></div>
      <div class="metric"><span>Heading</span><strong id="heading">0</strong></div>
    </section>
    <section class="panel">
      <div class="eyebrow">Controls</div>
      <div class="metric"><span>Mouse</span><strong>Look</strong></div>
      <div class="metric"><span>W / S</span><strong>Pitch</strong></div>
      <div class="metric"><span>A / D</span><strong>Roll</strong></div>
      <div class="metric"><span>Shift / Ctrl</span><strong>Throttle</strong></div>
    </section>
  </div>
  <div class="hint">Click to capture mouse. Space resets the flight.</div>
  <script>
    const requestedTask = __TASK_JSON__;
    const canvas = document.getElementById("scene");
    const ctx = canvas.getContext("2d");
    const keys = new Set();
    const state = { pitch: 0, yaw: 0, roll: 0, throttle: 0.45, speed: 160, altitude: 900, t: 0 };
    const speedEl = document.getElementById("speed");
    const altitudeEl = document.getElementById("altitude");
    const headingEl = document.getElementById("heading");

    function resize() {
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      canvas.width = Math.floor(innerWidth * dpr);
      canvas.height = Math.floor(innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function reset() {
      Object.assign(state, { pitch: 0, yaw: 0, roll: 0, throttle: 0.45, speed: 160, altitude: 900, t: 0 });
    }

    function update(dt) {
      if (keys.has("KeyW") || keys.has("ArrowUp")) state.pitch -= dt * 0.9;
      if (keys.has("KeyS") || keys.has("ArrowDown")) state.pitch += dt * 0.9;
      if (keys.has("KeyA") || keys.has("ArrowLeft")) state.roll -= dt * 1.4;
      if (keys.has("KeyD") || keys.has("ArrowRight")) state.roll += dt * 1.4;
      if (keys.has("ShiftLeft") || keys.has("ShiftRight")) state.throttle += dt * 0.35;
      if (keys.has("ControlLeft") || keys.has("ControlRight")) state.throttle -= dt * 0.35;
      if (keys.has("Space")) reset();
      state.throttle = Math.max(0, Math.min(1, state.throttle));
      state.roll *= Math.pow(0.42, dt);
      state.pitch *= Math.pow(0.55, dt);
      state.yaw += state.roll * dt * 0.55;
      state.speed += ((90 + state.throttle * 340) - state.speed) * dt * 0.8;
      state.altitude += (Math.sin(-state.pitch) * state.speed - 18) * dt;
      if (state.altitude < 30) { state.altitude = 30; state.speed *= 0.94; }
      state.t += dt;
    }

    function line(x1, y1, x2, y2, color, width = 1) {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    function draw() {
      const w = innerWidth, h = innerHeight;
      ctx.clearRect(0, 0, w, h);
      const horizon = h * 0.52 + Math.sin(state.pitch) * h * 0.45;
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#172328"); sky.addColorStop(Math.max(0, Math.min(1, horizon / h)), "#48555b"); sky.addColorStop(1, "#12110d");
      ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, horizon);
      ctx.rotate(state.roll * 0.55);
      line(-w, 0, w, 0, "rgba(244,238,228,.52)", 2);
      ctx.strokeStyle = "rgba(195,155,106,.24)";
      for (let i = 1; i < 34; i++) {
        const y = Math.pow(i / 34, 1.7) * h * 0.9;
        const wave = ((state.t * state.speed * 0.045) % 42);
        line(-w, y + wave, w, y + wave, "rgba(195,155,106,.18)", 1);
      }
      for (let x = -18; x <= 18; x++) {
        const skew = x * 48 + Math.sin(state.yaw + x) * 80;
        line(skew, 0, skew * 3, h, "rgba(244,238,228,.10)", 1);
      }
      ctx.restore();
      line(w / 2 - 26, h / 2, w / 2 + 26, h / 2, "rgba(244,238,228,.82)", 2);
      line(w / 2, h / 2 - 26, w / 2, h / 2 + 26, "rgba(244,238,228,.82)", 2);
      speedEl.textContent = Math.round(state.speed) + " kt";
      altitudeEl.textContent = Math.round(state.altitude) + " ft";
      headingEl.textContent = ((state.yaw * 57.3) % 360 + 360 | 0) + " deg";
    }

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      update(dt);
      draw();
      requestAnimationFrame(frame);
    }

    addEventListener("resize", resize);
    addEventListener("keydown", event => keys.add(event.code));
    addEventListener("keyup", event => keys.delete(event.code));
    canvas.addEventListener("click", () => canvas.requestPointerLock?.());
    addEventListener("mousemove", event => {
      if (document.pointerLockElement !== canvas) return;
      state.yaw += event.movementX * 0.0018;
      state.pitch += event.movementY * 0.0014;
    });
    resize();
    requestAnimationFrame(frame);
  </script>
</body>
</html>
""".replace("__TITLE__", title).replace("__TASK_JSON__", task_json)


def _derive_fallback_title(prompt: str) -> str:
    cleaned = re.sub(r"\s+", " ", prompt).strip()
    if not cleaned:
        return "Local Web App"
    cleaned = re.sub(r"^(build|create|make|write|generate)\s+(a|an|the)?\s*", "", cleaned, flags=re.IGNORECASE)
    if len(cleaned) > 72:
        cleaned = f"{cleaned[:72].rstrip()}..."
    return cleaned[:1].upper() + cleaned[1:]


def _html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _patch_operations_from_payload(patch_payload: dict[str, object], run: AgentRunStatusResponse | None = None) -> list[object]:
    operations = (
        patch_payload.get("operations")
        or patch_payload.get("file_operations")
        or patch_payload.get("files")
        or patch_payload.get("changes")
        or patch_payload.get("edits")
        or patch_payload.get("patch")
    )
    if isinstance(operations, dict):
        operations = [
            {"action": "write", "path": path, "content": content}
            for path, content in operations.items()
            if isinstance(path, str)
        ]
    if not operations and any(key in patch_payload for key in ("path", "file", "filename", "name")):
        operations = [patch_payload]
    if not operations and any(key in patch_payload for key in ("content", "html", "code", "text", "body", "source")):
        content = (
            patch_payload.get("content")
            or patch_payload.get("html")
            or patch_payload.get("code")
            or patch_payload.get("text")
            or patch_payload.get("body")
            or patch_payload.get("source")
        )
        default_path = "index.html" if run and _looks_like_single_file_html_task(run.prompt) else "generated.txt"
        operations = [{"action": "write", "path": default_path, "content": content}]
    if not isinstance(operations, list) or not operations:
        raise BadRequestError("The patch response did not include any file operations.")
    normalized: list[object] = []
    for raw_operation in operations:
        if not isinstance(raw_operation, dict):
            normalized.append(raw_operation)
            continue
        operation = dict(raw_operation)
        action = str(operation.get("action") or operation.get("op") or "write").strip().lower()
        if action in {"add", "create", "create_file", "modify", "replace", "update", "upsert"}:
            action = "write"
        operation["action"] = action
        if "path" not in operation:
            for key in ("file", "filename", "name", "target"):
                if key in operation:
                    operation["path"] = operation[key]
                    break
        if "content" not in operation:
            for key in ("html", "code", "text", "body", "source", "contents"):
                if key in operation:
                    operation["content"] = operation[key]
                    break
        if "path" not in operation and run and _looks_like_single_file_html_task(run.prompt):
            operation["path"] = "index.html"
        normalized.append(operation)
    return normalized


def _resolve_patch_path(workspace: Path, raw_path: object) -> tuple[str, Path]:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise BadRequestError("Patch operation is missing a relative path.")
    normalized_raw = raw_path.replace("\\", "/").strip()
    if normalized_raw.startswith("/") or re.match(r"^[A-Za-z]:", normalized_raw):
        raise BadRequestError(f"Patch path must be relative: {raw_path}")
    normalized = normalized_raw
    candidate = Path(normalized)
    if candidate.is_absolute():
        raise BadRequestError(f"Patch path must be relative: {raw_path}")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise BadRequestError(f"Patch path cannot contain '.', empty segments, or '..': {raw_path}")
    if any(part.lower() in PROTECTED_WRITE_DIRS for part in candidate.parts):
        raise BadRequestError(f"Patch path targets a protected directory: {raw_path}")

    workspace_resolved = workspace.resolve()
    target = (workspace_resolved / candidate).resolve(strict=False)
    try:
        target.relative_to(workspace_resolved)
    except ValueError as exc:
        raise BadRequestError(f"Patch path escapes the workspace: {raw_path}") from exc

    existing_parent = target.parent
    while not existing_parent.exists() and existing_parent != workspace_resolved:
        existing_parent = existing_parent.parent
    try:
        existing_parent.resolve().relative_to(workspace_resolved)
    except ValueError as exc:
        raise BadRequestError(f"Patch parent escapes the workspace: {raw_path}") from exc
    if existing_parent.is_symlink():
        raise BadRequestError(f"Patch parent is a symlink, refusing to write: {raw_path}")
    if target.exists() and target.is_symlink():
        raise BadRequestError(f"Patch target is a symlink, refusing to write: {raw_path}")
    if target.exists() and target.is_dir():
        raise BadRequestError(f"Patch target is a directory, refusing to overwrite: {raw_path}")
    return candidate.as_posix(), target


def _read_text_for_patch(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise BadRequestError(f"Could not read existing file {path.name}: {exc}") from exc
    if b"\x00" in data:
        raise BadRequestError(f"Refusing to patch binary file: {path.name}")
    return data.decode("utf-8", errors="replace")


def _count_patch_lines(diff_lines: list[str]) -> tuple[int, int]:
    additions = 0
    deletions = 0
    for line in diff_lines:
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            additions += 1
        elif line.startswith("-"):
            deletions += 1
    return additions, deletions


def _apply_patch_operations(workspace: Path, operations: list[object], *, apply_changes: bool = True) -> AgentWorkspaceReviewResponse:
    if len(operations) > MAX_PATCH_OPERATIONS:
        raise BadRequestError(f"Patch contains too many operations ({len(operations)} > {MAX_PATCH_OPERATIONS}).")

    files: list[AgentDiffFile] = []
    diff_chunks: list[str] = []
    total_chars = 0

    for raw_operation in operations:
        if not isinstance(raw_operation, dict):
            raise BadRequestError("Every patch operation must be an object.")
        action = str(raw_operation.get("action", "write")).strip().lower()
        if action in {"create", "modify", "replace", "update"}:
            action = "write"
        if action not in {"write", "delete"}:
            raise BadRequestError(f"Unsupported patch action: {action}")

        raw_path = (
            raw_operation.get("path")
            or raw_operation.get("file")
            or raw_operation.get("filename")
            or raw_operation.get("name")
        )
        relative, target = _resolve_patch_path(workspace, raw_path)
        before = _read_text_for_patch(target)
        after = ""
        status = "modified" if target.exists() else "added"

        if action == "delete":
            if not target.exists():
                raise BadRequestError(f"Cannot delete missing file: {relative}")
            if apply_changes:
                target.unlink()
            status = "deleted"
        else:
            content = (
                raw_operation.get("content")
                if "content" in raw_operation
                else raw_operation.get("text", raw_operation.get("body", raw_operation.get("source")))
            )
            if not isinstance(content, str):
                raise BadRequestError(f"Write operation for {relative} is missing string content.")
            if "\x00" in content:
                raise BadRequestError(f"Refusing to write binary-looking content: {relative}")
            if len(content) > MAX_PATCH_FILE_CHARS:
                raise BadRequestError(f"Patch file is too large: {relative}")
            total_chars += len(content)
            if total_chars > MAX_PATCH_TOTAL_CHARS:
                raise BadRequestError("Patch output is too large.")
            after = content
            if apply_changes:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(after, encoding="utf-8", newline="")

        diff_lines = list(
            difflib.unified_diff(
                before.splitlines(),
                after.splitlines(),
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
                lineterm="",
            )
        )
        additions, deletions = _count_patch_lines(diff_lines)
        files.append(AgentDiffFile(path=relative, status=status, additions=additions, deletions=deletions))
        if diff_lines:
            diff_chunks.append("\n".join(diff_lines))

    insertions = sum(file.additions for file in files)
    deletions = sum(file.deletions for file in files)
    diff = "\n\n".join(diff_chunks)
    if len(diff) > 80_000:
        diff = f"{diff[:80_000]}\n\n[diff truncated at 80k characters]"
    summary = f"{len(files)} changed file{'s' if len(files) != 1 else ''}, +{insertions} -{deletions}"
    return AgentWorkspaceReviewResponse(
        workspace_path=str(workspace),
        is_git_repo=False,
        summary=summary,
        files=files,
        diff=diff,
        status_lines=[f"{file.status} {file.path}" for file in files],
        insertions=insertions,
        deletions=deletions,
    )


def _fit_snippets_to_prompt_budget(
    workspace: Path,
    payload: AgentRunRequest,
    snippets: list[tuple[str, str]],
    prompt_budget_tokens: int,
) -> tuple[list[tuple[str, str]], str | None]:
    fitted = list(snippets)
    changed = False

    def current_tokens() -> int:
        return _estimate_tokens(_build_agent_prompt(workspace, payload, fitted, prompt_budget_tokens))

    while fitted and current_tokens() > prompt_budget_tokens:
        path, text = fitted[-1]
        if len(text) > 2_000:
            next_length = max(1_200, int(len(text) * 0.55))
            if next_length >= len(text):
                fitted.pop()
            else:
                fitted[-1] = (path, text[:next_length])
        else:
            fitted.pop()
        changed = True

    if current_tokens() > prompt_budget_tokens:
        return [], (
            "Workspace context was removed because the request still exceeded the selected model context. "
            "Ask about a smaller folder/file area or lower Agent tokens."
        )
    if changed:
        return fitted, (
            f"Workspace context was automatically trimmed to fit ~{prompt_budget_tokens} prompt tokens. "
            "Open Agent settings if you want a smaller/faster or larger/slower context budget."
        )
    return fitted, None


def _sync_included_file_flags(inspected: list[AgentWorkspaceFile], snippets: list[tuple[str, str]]) -> None:
    included = {path: len(text) for path, text in snippets}
    for item in inspected:
        if item.path in included:
            item.included = True
            item.reason = f"Included in fitted context, {included[item.path]} chars"
        elif item.included:
            item.included = False
            item.reason = "Trimmed out to fit the selected model context window."


def _format_agent_attachments(payload: AgentRunRequest) -> str:
    if not payload.attachments:
        return "[no attachments]"
    sections: list[str] = []
    for attachment in payload.attachments[:12]:
        header = f"--- ATTACHMENT: {attachment.name} ({attachment.mime_type})"
        if attachment.text:
            sections.append(f"{header}\n{attachment.text[:120_000]}")
        elif attachment.data_url:
            sections.append(
                f"{header}\n"
                "[binary attachment included in the desktop task. If this is an image or PDF, describe limitations clearly "
                "unless the active endpoint supports visual/file input through text references.]"
            )
        else:
            sections.append(f"{header}\n[empty attachment]")
    return "\n\n".join(sections)


async def _agent_with_openai_compatible(
    model: ModelConfig,
    prompt: str,
    max_tokens: int,
    payload: AgentRunRequest,
    system_message: str = SYSTEM_MESSAGE,
    run: AgentRunStatusResponse | None = None,
) -> tuple[str, str | None, str | None]:
    profile = model.get_active_profile()
    request_payload = {
        "model": str(model.metadata.get("served_model", model.name)),
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
        "temperature": profile.temperature if profile else 0.2,
        "top_p": profile.top_p if profile else 0.95,
        "max_tokens": max_tokens,
        "stream": run is not None,
    }
    async with httpx.AsyncClient(timeout=payload.settings.agent_max_tokens / 8 + 180) as client:
        if not run:
            response = await client.post(urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions"), json=request_payload)
            if not response.is_success:
                raise BadRequestError(f"Agent request failed with HTTP {response.status_code}: {response.text[:500]}")
            data = response.json()
            choice = data["choices"][0]
            message = choice["message"]
            explicit_thinking = message.get("reasoning_content") or message.get("reasoning") or message.get("thinking")
            return str(message.get("content", "")), choice.get("finish_reason"), str(explicit_thinking) if explicit_thinking else None

        run.live_thinking = ""
        run.live_content = ""
        run.updated_at = datetime.utcnow()
        
        content_parts = []
        thinking_parts = []
        finish_reason = None
        
        async with client.stream("POST", urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions"), json=request_payload) as response:
            if not response.is_success:
                error_text = await response.aread()
                raise BadRequestError(f"Agent stream request failed with HTTP {response.status_code}: {error_text.decode('utf-8')[:500]}")
            
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_str = line[5:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                    choice = chunk.get("choices", [{}])[0]
                    delta = choice.get("delta", {})
                    
                    thinking_delta = delta.get("reasoning_content") or delta.get("reasoning") or delta.get("thinking")
                    content_delta = delta.get("content")
                    
                    if thinking_delta:
                        thinking_parts.append(str(thinking_delta))
                        run.live_thinking = "".join(thinking_parts)
                    if content_delta:
                        content_parts.append(str(content_delta))
                        run.live_content = "".join(content_parts)
                            
                    run.updated_at = datetime.utcnow()
                        
                    if choice.get("finish_reason"):
                        finish_reason = choice.get("finish_reason")
                except json.JSONDecodeError:
                    continue
                    
        return "".join(content_parts), finish_reason, "".join(thinking_parts) if thinking_parts else None


async def _agent_with_ollama(
    model: ModelConfig,
    prompt: str,
    max_tokens: int,
    payload: AgentRunRequest,
    system_message: str = SYSTEM_MESSAGE,
    run: AgentRunStatusResponse | None = None,
) -> tuple[str, str | None, str | None]:
    profile = model.get_active_profile()
    request_payload = {
        "model": str(model.metadata.get("ollama_model", model.name)),
        "messages": [
            {"role": "system", "content": system_message},
            {"role": "user", "content": prompt},
        ],
        "stream": run is not None,
        "options": {
            "temperature": profile.temperature if profile else 0.2,
            "top_p": profile.top_p if profile else 0.95,
            "num_predict": max_tokens,
        },
    }
    async with httpx.AsyncClient(timeout=payload.settings.agent_max_tokens / 8 + 180) as client:
        if not run:
            response = await client.post(urljoin(model.endpoint.rstrip("/") + "/", "api/chat"), json=request_payload)
            if not response.is_success:
                raise BadRequestError(f"Ollama agent request failed with HTTP {response.status_code}: {response.text[:500]}")
            data = response.json()
            message = data["message"]
            explicit_thinking = message.get("thinking") or message.get("reasoning_content") or message.get("reasoning")
            return str(message.get("content", "")), data.get("done_reason"), str(explicit_thinking) if explicit_thinking else None

        run.live_thinking = ""
        run.live_content = ""
        run.updated_at = datetime.utcnow()
        
        content_parts = []
        thinking_parts = []
        finish_reason = None
        
        async with client.stream("POST", urljoin(model.endpoint.rstrip("/") + "/", "api/chat"), json=request_payload) as response:
            if not response.is_success:
                error_text = await response.aread()
                raise BadRequestError(f"Ollama agent stream request failed with HTTP {response.status_code}: {error_text.decode('utf-8')[:500]}")
                
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                    message = chunk.get("message", {})
                    
                    thinking_delta = message.get("thinking") or message.get("reasoning_content") or message.get("reasoning")
                    content_delta = message.get("content")
                    
                    if thinking_delta:
                        thinking_parts.append(str(thinking_delta))
                        run.live_thinking = "".join(thinking_parts)
                    if content_delta:
                        content_parts.append(str(content_delta))
                        run.live_content = "".join(content_parts)
                            
                    run.updated_at = datetime.utcnow()
                        
                    if chunk.get("done"):
                        finish_reason = chunk.get("done_reason", "stop")
                except json.JSONDecodeError:
                    continue
                    
        return "".join(content_parts), finish_reason, "".join(thinking_parts) if thinking_parts else None


def _split_hidden_reasoning(content: str) -> tuple[str, str]:
    thinking_parts = re.findall(r"<think>(.*?)</think>", content, flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"<think>.*?</think>\s*", "", content, flags=re.IGNORECASE | re.DOTALL)
    lower = cleaned.lower()
    if "</think>" in lower:
        thinking_parts.append(cleaned[: lower.rfind("</think>")])
        cleaned = cleaned[lower.rfind("</think>") + len("</think>") :]
    thinking = "\n\n".join(part.strip() for part in thinking_parts if part.strip())
    return cleaned.strip(), thinking.strip()


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, int(len(re.findall(r"\S+", text)) * 1.35))
