from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.schemas.config import AppConfig
from app.services.model_service import ModelService

router = APIRouter(prefix="/config", tags=["config"])


@router.get("", response_model=AppConfig)
def read_config(model_service: ModelService = Depends(get_model_service)) -> AppConfig:
    return model_service.get_config()


@router.put("", response_model=AppConfig)
def write_config(payload: AppConfig, model_service: ModelService = Depends(get_model_service)) -> AppConfig:
    return model_service.update_config(payload)
