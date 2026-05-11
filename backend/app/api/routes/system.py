from __future__ import annotations

from datetime import datetime
import re
import subprocess

import httpx
from fastapi import APIRouter, Depends

from app.api.dependencies import get_model_service
from app.core.settings import get_settings
from app.schemas.api import ApiMessage, AppUpdateResponse, MetricHistoryPoint, SystemMetricsResponse
from app.services.model_service import ModelService

router = APIRouter(prefix="/system", tags=["system"])
APP_VERSION = "0.2.0"


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


def _version_tuple(value: str | None) -> tuple[int, ...]:
    if not value:
        return (0,)
    normalized = value.strip().lstrip("v")
    parts = [int(part) for part in re.findall(r"\d+", normalized)[:3]]
    return tuple(parts or [0])


@router.get("/update", response_model=AppUpdateResponse)
def get_update_status(model_service: ModelService = Depends(get_model_service)) -> AppUpdateResponse:
    settings = get_settings()
    config = model_service.get_config()
    current = APP_VERSION or config.version or "0.2.0"
    source_install = (settings.project_root / ".git").exists()
    checked_at = datetime.utcnow()
    if source_install:
        try:
            head = subprocess.check_output(
                ["git", "-C", str(settings.project_root), "rev-parse", "HEAD"],
                text=True,
                timeout=4,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            ).strip()
            remote = subprocess.check_output(
                ["git", "-C", str(settings.project_root), "ls-remote", "origin", "refs/heads/main"],
                text=True,
                timeout=6,
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
            ).strip().split()[0]
            update_available = bool(head and remote and head != remote)
            return AppUpdateResponse(
                current_version=f"{current}+{head[:7]}",
                latest_version=remote[:7],
                update_available=update_available,
                release_url="https://github.com/TheRofli/Quokka/commits/main",
                source_install=True,
                checked_at=checked_at,
                message="New source update available." if update_available else "Source checkout is up to date.",
            )
        except Exception:
            pass

    try:
        with httpx.Client(timeout=4.0, follow_redirects=True) as client:
            response = client.get("https://api.github.com/repos/TheRofli/Quokka/releases/latest")
            response.raise_for_status()
            payload = response.json()
        latest = str(payload.get("tag_name") or "").lstrip("v") or None
        assets = payload.get("assets") if isinstance(payload.get("assets"), list) else []
        installer_url = next(
            (
                str(asset.get("browser_download_url"))
                for asset in assets
                if isinstance(asset, dict) and str(asset.get("name", "")).lower().endswith((".exe", ".msi"))
            ),
            None,
        )
        release_url = str(payload.get("html_url") or "https://github.com/TheRofli/Quokka/releases/latest")
        update_available = _version_tuple(latest) > _version_tuple(current)
        message = "Update available." if update_available else "Quokka is up to date."
        return AppUpdateResponse(
            current_version=current,
            latest_version=latest,
            update_available=update_available,
            release_url=release_url,
            installer_url=installer_url,
            source_install=source_install,
            checked_at=checked_at,
            message=message,
        )
    except Exception as exc:  # noqa: BLE001
        return AppUpdateResponse(
            current_version=current,
            latest_version=None,
            update_available=False,
            source_install=source_install,
            checked_at=checked_at,
            message=f"Could not check GitHub releases: {exc}",
        )
