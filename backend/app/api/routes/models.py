from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.dependencies import get_model_service
from app.schemas.api import (
    ApiMessage,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkRunStatus,
    CreateModelRequest,
    DiscoveredModelArtifact,
    HealthCheckResponse,
    LogResponse,
    ModelView,
    RenameModelRequest,
)
from app.schemas.config import ModelSettings
from app.services.model_service import ModelService

router = APIRouter(prefix="/models", tags=["models"])


@router.get("", response_model=list[ModelView])
def list_models(model_service: ModelService = Depends(get_model_service)) -> list[ModelView]:
    return model_service.list_models()


@router.post("", response_model=ModelView)
def create_model(payload: CreateModelRequest, model_service: ModelService = Depends(get_model_service)) -> ModelView:
    return model_service.create_model(payload)


@router.get("/discover", response_model=list[DiscoveredModelArtifact])
def discover_models(
    query: str | None = None,
    limit: int = Query(default=80, ge=1, le=250),
    model_service: ModelService = Depends(get_model_service),
) -> list[DiscoveredModelArtifact]:
    return model_service.discover_model_artifacts(query=query, limit=limit)


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


@router.delete("/{model_id}", response_model=ApiMessage)
def delete_model(
    model_id: str,
    delete_file: bool = Query(default=False),
    model_service: ModelService = Depends(get_model_service),
) -> ApiMessage:
    model_service.delete_model(model_id, delete_file=delete_file)
    return ApiMessage(message=f"Model '{model_id}' deleted.")


@router.patch("/{model_id}/name", response_model=ModelView)
def rename_model(
    model_id: str,
    payload: RenameModelRequest,
    model_service: ModelService = Depends(get_model_service),
) -> ModelView:
    return model_service.rename_model(model_id, payload)


@router.patch("/{model_id}/settings", response_model=ModelView)
def update_model_settings(
    model_id: str,
    payload: ModelSettings,
    model_service: ModelService = Depends(get_model_service),
) -> ModelView:
    return model_service.update_model_settings(model_id, payload)


@router.get("/{model_id}/logs", response_model=LogResponse)
def get_logs(
    model_id: str,
    limit: int = Query(default=200, ge=20, le=2000),
    model_service: ModelService = Depends(get_model_service),
) -> LogResponse:
    return model_service.read_logs(model_id, limit)


@router.delete("/{model_id}/logs", response_model=LogResponse)
def clear_logs(model_id: str, model_service: ModelService = Depends(get_model_service)) -> LogResponse:
    return model_service.clear_logs(model_id)


@router.get("/{model_id}/health", response_model=HealthCheckResponse)
async def get_model_health(model_id: str, model_service: ModelService = Depends(get_model_service)) -> HealthCheckResponse:
    return await model_service.check_health(model_id)


@router.post("/{model_id}/benchmark", response_model=BenchmarkRunResponse)
async def run_benchmark(
    model_id: str,
    payload: BenchmarkRunRequest,
    model_service: ModelService = Depends(get_model_service),
) -> BenchmarkRunResponse:
    return await model_service.run_benchmark(model_id, payload)


@router.post("/{model_id}/benchmark/runs", response_model=BenchmarkRunStatus)
async def start_benchmark_run(
    model_id: str,
    payload: BenchmarkRunRequest,
    model_service: ModelService = Depends(get_model_service),
) -> BenchmarkRunStatus:
    return await model_service.start_benchmark_run(model_id, payload)


@router.get("/{model_id}/benchmark/runs/{run_id}", response_model=BenchmarkRunStatus)
def get_benchmark_run(
    model_id: str,
    run_id: str,
    model_service: ModelService = Depends(get_model_service),
) -> BenchmarkRunStatus:
    return model_service.get_benchmark_run(model_id, run_id)


@router.post("/{model_id}/benchmark/runs/{run_id}/cancel", response_model=BenchmarkRunStatus)
def cancel_benchmark_run(
    model_id: str,
    run_id: str,
    model_service: ModelService = Depends(get_model_service),
) -> BenchmarkRunStatus:
    return model_service.cancel_benchmark_run(model_id, run_id)
