from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.schemas.api import ApiMessage, MetricHistoryPoint, SystemMetricsResponse
from app.services.model_service import ModelService

router = APIRouter(prefix="/system", tags=["system"])


@router.get("/metrics", response_model=SystemMetricsResponse)
def get_system_metrics(model_service: ModelService = Depends(get_model_service)) -> SystemMetricsResponse:
    return model_service.get_system_metrics()


@router.get("/metrics/history", response_model=list[MetricHistoryPoint])
def get_metrics_history(minutes: int = 60, model_service: ModelService = Depends(get_model_service)) -> list[MetricHistoryPoint]:
    return model_service.get_metrics_history(minutes)


@router.get("/health", response_model=ApiMessage)
def get_system_health(model_service: ModelService = Depends(get_model_service)) -> ApiMessage:
    running = model_service.active_model_count()
    return ApiMessage(message=f"Quokka backend is online. Active models: {running}")
