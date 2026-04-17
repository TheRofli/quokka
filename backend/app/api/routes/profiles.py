from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.schemas.api import ApiMessage
from app.schemas.config import ProfileConfig
from app.services.model_service import ModelService

router = APIRouter(prefix="/models/{model_id}/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileConfig])
def list_profiles(model_id: str, model_service: ModelService = Depends(get_model_service)) -> list[ProfileConfig]:
    return model_service.list_profiles(model_id)


@router.post("", response_model=ProfileConfig)
def create_profile(
    model_id: str,
    payload: ProfileConfig,
    model_service: ModelService = Depends(get_model_service),
) -> ProfileConfig:
    return model_service.create_profile(model_id, payload)


@router.put("/{profile_id}", response_model=ProfileConfig)
def update_profile(
    model_id: str,
    profile_id: str,
    payload: ProfileConfig,
    model_service: ModelService = Depends(get_model_service),
) -> ProfileConfig:
    return model_service.update_profile(model_id, profile_id, payload)


@router.delete("/{profile_id}", response_model=ApiMessage)
def delete_profile(
    model_id: str,
    profile_id: str,
    model_service: ModelService = Depends(get_model_service),
) -> ApiMessage:
    model_service.delete_profile(model_id, profile_id)
    return ApiMessage(message=f"Profile '{profile_id}' deleted.")


@router.post("/{profile_id}/activate", response_model=ProfileConfig)
def activate_profile(
    model_id: str,
    profile_id: str,
    model_service: ModelService = Depends(get_model_service),
) -> ProfileConfig:
    return model_service.activate_profile(model_id, profile_id)

