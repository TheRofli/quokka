from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.dependencies import get_model_service
from app.schemas.api import HealthCheckResponse, LogResponse, ModelView
from app.services.model_service import ModelService

router = APIRouter(prefix="/models", tags=["models"])


@router.get("", response_model=list[ModelView])
def list_models(model_service: ModelService = Depends(get_model_service)) -> list[ModelView]:
    return model_service.list_models()


@router.get("/{model_id}", response_model=ModelView)
def get_model(model_id: str, model_service: ModelService = Depends(get_model_service)) -> ModelView:
    return model_service.get_model_view(model_id)


@router.post("/{model_id}/start", response_model=ModelView)
async def start_model(model_id: str, model_service: ModelService = Depends(get_model_service)) -> ModelView:
    return await model_service.start_model(model_id)


@router.post("/{model_id}/stop", response_model=ModelView)
async def stop_model(model_id: str, model_service: ModelService = Depends(get_model_service)) -> ModelView:
    return await model_service.stop_model(model_id)


@router.post("/{model_id}/restart", response_model=ModelView)
async def restart_model(model_id: str, model_service: ModelService = Depends(get_model_service)) -> ModelView:
    return await model_service.restart_model(model_id)


@router.get("/{model_id}/logs", response_model=LogResponse)
def get_logs(
    model_id: str,
    limit: int = Query(default=200, ge=20, le=2000),
    model_service: ModelService = Depends(get_model_service),
) -> LogResponse:
    return model_service.read_logs(model_id, limit)


@router.get("/{model_id}/health", response_model=HealthCheckResponse)
async def get_model_health(model_id: str, model_service: ModelService = Depends(get_model_service)) -> HealthCheckResponse:
    return await model_service.check_health(model_id)

