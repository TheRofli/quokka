from __future__ import annotations

from fastapi import Request

from app.services.model_service import ModelService


def get_model_service(request: Request) -> ModelService:
    return request.app.state.model_service

