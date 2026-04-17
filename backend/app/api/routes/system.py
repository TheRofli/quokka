from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.schemas.api import ApiMessage, SystemMetricsResponse
from app.services.model_service import ModelService

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/metrics", response_model=SystemMetricsResponse)
def get_system_metrics(model_service: ModelService = Depends(get_model_service)) -> SystemMetricsResponse:
    return model_service.get_system_metrics()


@router.get("/health", response_model=ApiMessage)
def get_system_health(model_service: ModelService = Depends(get_model_service)) -> ApiMessage:
    running = model_service.active_model_count()
    return ApiMessage(message=f"Quokka backend is online. Active models: {running}")

