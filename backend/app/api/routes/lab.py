from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.dependencies import get_model_service
from app.domain.enums import ModelStatus, ProviderType
from app.schemas.api import LabModelConnection, ModelView
from app.services.model_service import ModelService

router = APIRouter(prefix="/lab", tags=["lab"])


@router.get("/models", response_model=list[LabModelConnection])
def list_lab_models(
    ready_only: bool = Query(default=True, description="Return only models that are ready for Quokka Lab inference."),
    model_service: ModelService = Depends(get_model_service),
) -> list[LabModelConnection]:
    """Small stable model-discovery contract for the standalone Quokka Lab app."""

    connections = [_to_lab_connection(model) for model in model_service.list_models()]
    if ready_only:
        return [connection for connection in connections if connection.ready]
    return connections


def _to_lab_connection(model: ModelView) -> LabModelConnection:
    status = model.runtime.status
    health_ok = model.runtime.health_ok
    ready = status == ModelStatus.RUNNING and health_ok is not False
    endpoint = model.endpoint.rstrip("/")
    notes: list[str] = []

    if model.provider == ProviderType.OLLAMA:
        api_format = "ollama"
        model_name = str(model.metadata.get("ollama_model", model.name))
        chat_url = f"{endpoint}/api/chat"
    else:
        api_format = "openai_compatible"
        model_name = str(model.metadata.get("served_model", model.name))
        chat_url = f"{endpoint}/v1/chat/completions"

    if not ready:
        notes.append(f"Model is {status.value}; start it in Quokka before using it in Quokka Lab.")
    if health_ok is False:
        notes.append("Last health check failed, so Quokka Lab should treat this endpoint as unavailable.")

    return LabModelConnection(
        id=model.id,
        name=model.name,
        provider=model.provider,
        modality=model.modality,
        endpoint=endpoint,
        status=status,
        ready=ready,
        health_ok=health_ok,
        model_name=model_name,
        api_format=api_format,
        chat_url=chat_url,
        context_size=model.active_profile.context_size if model.active_profile else None,
        prompt_tokens_per_second=model.metadata.get("prompt_tokens_per_second")
        if isinstance(model.metadata.get("prompt_tokens_per_second"), (int, float))
        else None,
        decode_tokens_per_second=model.metadata.get("decode_tokens_per_second")
        if isinstance(model.metadata.get("decode_tokens_per_second"), (int, float))
        else None,
        notes=notes,
    )
