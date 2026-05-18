from __future__ import annotations

import time
from urllib.parse import urljoin

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
def get_readiness(
    model_service: ModelService = Depends(get_model_service),
    autopilot_service: AutopilotService = Depends(get_autopilot_service),
) -> AutopilotReadinessResponse:
    metrics = model_service.get_system_metrics()
    runtime = model_service.get_runtime_setup_check()
    first_gpu = metrics.gpu_devices[0] if metrics.gpu_devices else None
    gpu_memory_total_mb = (
        metrics.gpu_memory_total_mb
        if metrics.gpu_memory_total_mb is not None
        else (first_gpu.memory_total_mb if first_gpu else None)
    )

    return autopilot_service.build_readiness(
        vram_gb=(gpu_memory_total_mb / 1024) if gpu_memory_total_mb is not None else None,
        ram_gb=metrics.ram_total_gb,
        runtime_installed=bool(runtime.llama_server_candidates or runtime.path_has_llama_server),
        models_dir=runtime.models_dir,
    )


@router.post("/plan/starter", response_model=AutopilotStarterPlanResponse)
def create_starter_plan(
    payload: AutopilotStarterPlanRequest,
    autopilot_service: AutopilotService = Depends(get_autopilot_service),
) -> AutopilotStarterPlanResponse:
    return autopilot_service.create_starter_plan(
        runtime=payload.runtime or ProviderType.WINDOWS_LLAMA_CPP,
        use_case=payload.use_case,
    )


@router.get("/actions", response_model=list[AutopilotActionLogEntry])
def list_actions(
    autopilot_service: AutopilotService = Depends(get_autopilot_service),
) -> list[AutopilotActionLogEntry]:
    return autopilot_service.list_actions()


@router.post("/actions", response_model=AutopilotActionLogEntry)
def append_action(
    payload: AutopilotActionLogRequest,
    autopilot_service: AutopilotService = Depends(get_autopilot_service),
) -> AutopilotActionLogEntry:
    return autopilot_service.append_action(
        action=payload.action,
        status=payload.status,
        summary=payload.summary,
        details=payload.details,
        undo_hint=payload.undo_hint,
        confidence=payload.confidence,
    )


@router.post("/smoke-test/{model_id}", response_model=AutopilotSmokeTestResponse)
async def smoke_test_model(
    model_id: str,
    model_service: ModelService = Depends(get_model_service),
    autopilot_service: AutopilotService = Depends(get_autopilot_service),
) -> AutopilotSmokeTestResponse:
    try:
        model = model_service.config_service.get_model(model_id)
        if model.provider == ProviderType.OLLAMA:
            payload = {
                "model": str(model.metadata.get("ollama_model", model.name)),
                "messages": [
                    {"role": "user", "content": "Reply with one short sentence: Quokka smoke test passed."}
                ],
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 32},
            }
            url = urljoin(model.endpoint.rstrip("/") + "/", "api/chat")
        else:
            payload = {
                "model": str(model.metadata.get("served_model", model.name)),
                "messages": [{"role": "user", "content": "Reply with exactly: pong"}],
                "temperature": 0,
                "max_tokens": 8,
                "stream": False,
            }
            url = urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions")

        started = time.perf_counter()
        timeout = httpx.Timeout(model.settings.request_timeout_seconds, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload)
        if not response.is_success:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:500]}")

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        data = response.json()
        if model.provider == ProviderType.OLLAMA:
            message = data.get("message") if isinstance(data, dict) else None
            content = message.get("content") if isinstance(message, dict) else None
            if not str(content or "").strip():
                raise RuntimeError("Smoke test response did not include message.content.")
        else:
            choices = data.get("choices") if isinstance(data, dict) else None
            first_choice = choices[0] if isinstance(choices, list) and choices else None
            message = first_choice.get("message") if isinstance(first_choice, dict) else None
            content = message.get("content") if isinstance(message, dict) else None
            if not str(content or "").strip():
                raise RuntimeError("Smoke test response did not include choices[0].message.content.")

        usage = data.get("usage") if isinstance(data, dict) else None
        prompt_tokens = usage.get("prompt_tokens") if isinstance(usage, dict) else None
        completion_tokens = usage.get("completion_tokens") if isinstance(usage, dict) else None
        tokens_per_second = None
        if isinstance(completion_tokens, int) and latency_ms > 0:
            tokens_per_second = round(completion_tokens / (latency_ms / 1000), 2)

        return AutopilotSmokeTestResponse(
            model_id=model_id,
            ok=True,
            summary="Smoke test passed.",
            latency_ms=latency_ms,
            tokens_per_second=tokens_per_second,
            prompt_tokens=prompt_tokens if isinstance(prompt_tokens, int) else None,
            completion_tokens=completion_tokens if isinstance(completion_tokens, int) else None,
        )
    except Exception as exc:  # noqa: BLE001 - endpoint failures should be returned as smoke-test results.
        return autopilot_service.smoke_test_error(model_id, str(exc))
