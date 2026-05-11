from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import zipfile

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends

from app.api.dependencies import get_model_service
from app.core.settings import get_settings
from app.schemas.api import (
    ApiMessage,
    AppUpdateResponse,
    LlamaCppInstallRequest,
    LlamaCppRuntimeStatus,
    MetricHistoryPoint,
    SystemMetricsResponse,
)
from app.services.model_service import ModelService

router = APIRouter(prefix="/system", tags=["system"])
APP_VERSION = "0.2.0"
LLAMA_CPP_RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"

_llama_runtime_lock = threading.RLock()
_llama_runtime_status = LlamaCppRuntimeStatus(updated_at=datetime.utcnow())


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


def _runtime_root() -> Path:
    root = get_settings().data_dir / "runtimes" / "llama.cpp"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _find_installed_llama_server() -> str | None:
    root = _runtime_root()
    matches = sorted(
        root.rglob("llama-server.exe"),
        key=lambda item: item.stat().st_mtime if item.exists() else 0,
        reverse=True,
    )
    return str(matches[0]) if matches else None


def _set_llama_runtime_status(**updates: object) -> LlamaCppRuntimeStatus:
    global _llama_runtime_status
    with _llama_runtime_lock:
        _llama_runtime_status = _llama_runtime_status.model_copy(update={**updates, "updated_at": datetime.utcnow()})
        return _llama_runtime_status.model_copy(deep=True)


def _llama_runtime_snapshot() -> LlamaCppRuntimeStatus:
    with _llama_runtime_lock:
        if _llama_runtime_status.status in {"idle", "failed"}:
            installed = _find_installed_llama_server()
            if installed:
                return _set_llama_runtime_status(
                    status="installed",
                    install_dir=str(Path(installed).parent),
                    llama_server_path=installed,
                    progress_percent=100.0,
                    message="Quokka found an installed llama.cpp runtime.",
                    error=None,
                )
        return _llama_runtime_status.model_copy(deep=True)


def _asset_name(asset: dict) -> str:
    return str(asset.get("name") or "")


def _asset_url(asset: dict) -> str:
    return str(asset.get("browser_download_url") or "")


def _select_llama_assets(payload: dict, variant: str) -> tuple[str, list[dict]]:
    tag = str(payload.get("tag_name") or "latest")
    assets = [item for item in payload.get("assets", []) if isinstance(item, dict)]

    def is_zip(asset: dict) -> bool:
        return _asset_name(asset).lower().endswith(".zip") and bool(_asset_url(asset))

    if variant == "cuda":
        server = next(
            (
                asset
                for asset in assets
                if is_zip(asset)
                and "bin-win-cuda" in _asset_name(asset).lower()
                and not _asset_name(asset).lower().startswith("cudart")
            ),
            None,
        )
        cudart = next(
            (
                asset
                for asset in assets
                if is_zip(asset)
                and _asset_name(asset).lower().startswith("cudart")
                and "win-cuda" in _asset_name(asset).lower()
            ),
            None,
        )
        selected = [asset for asset in (server, cudart) if asset]
        if server:
            return tag, selected

    cpu = next(
        (
            asset
            for asset in assets
            if is_zip(asset)
            and "bin-win" in _asset_name(asset).lower()
            and "cpu" in _asset_name(asset).lower()
            and not _asset_name(asset).lower().startswith("cudart")
        ),
        None,
    )
    if cpu:
        return tag, [cpu]
    raise RuntimeError("Could not find a Windows x64 llama.cpp ZIP asset in the latest official release.")


def _safe_extract_zip(zip_path: Path, target_dir: Path) -> None:
    target_root = target_dir.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            destination = (target_dir / member.filename).resolve()
            if not str(destination).lower().startswith(str(target_root).lower()):
                continue
            archive.extract(member, target_dir)


def _download_asset(client: httpx.Client, asset: dict, target: Path, asset_index: int, asset_count: int) -> None:
    name = _asset_name(asset)
    url = _asset_url(asset)
    with client.stream("GET", url, follow_redirects=True, timeout=None) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length") or asset.get("size") or 0) or None
        downloaded = 0
        with target.open("wb") as handle:
            for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                handle.write(chunk)
                downloaded += len(chunk)
                local_progress = (downloaded / total) if total else 0.0
                overall = ((asset_index + local_progress) / max(asset_count, 1)) * 70.0
                _set_llama_runtime_status(
                    status="downloading",
                    progress_percent=round(overall, 2),
                    message=f"Downloading {name}...",
                )


def _install_llama_cpp_runtime(variant: str, force: bool) -> None:
    try:
        existing = _find_installed_llama_server()
        if existing and not force:
            _set_llama_runtime_status(
                status="installed",
                variant=variant,
                install_dir=str(Path(existing).parent),
                llama_server_path=existing,
                progress_percent=100.0,
                message="llama.cpp is already installed for Quokka.",
                error=None,
            )
            return

        _set_llama_runtime_status(status="downloading", variant=variant, progress_percent=2.0, message="Resolving latest llama.cpp release...", error=None)
        with httpx.Client(timeout=20.0, headers={"User-Agent": "Quokka"}) as client:
            release = client.get(LLAMA_CPP_RELEASES_API, follow_redirects=True)
            release.raise_for_status()
            tag, assets = _select_llama_assets(release.json(), variant)
            safe_tag = re.sub(r"[^A-Za-z0-9._-]+", "-", tag or "latest")
            install_dir = _runtime_root() / f"{safe_tag}-{variant}"
            if force and install_dir.exists():
                shutil.rmtree(install_dir, ignore_errors=True)
            install_dir.mkdir(parents=True, exist_ok=True)

            with tempfile.TemporaryDirectory(prefix="quokka-llama-cpp-") as temp_root_raw:
                temp_root = Path(temp_root_raw)
                for index, asset in enumerate(assets):
                    zip_path = temp_root / _asset_name(asset)
                    _download_asset(client, asset, zip_path, index, len(assets))
                    _set_llama_runtime_status(status="extracting", progress_percent=72.0, message=f"Extracting {_asset_name(asset)}...")
                    _safe_extract_zip(zip_path, install_dir)

        llama_server = next(install_dir.rglob("llama-server.exe"), None)
        if not llama_server:
            raise RuntimeError("Downloaded llama.cpp, but llama-server.exe was not found inside the archive.")

        _set_llama_runtime_status(
            status="installed",
            variant=variant,
            version=tag,
            install_dir=str(install_dir),
            llama_server_path=str(llama_server),
            progress_percent=100.0,
            message="llama.cpp runtime is installed. Add Model can use this llama-server.exe automatically.",
            error=None,
        )
    except Exception as exc:  # noqa: BLE001
        _set_llama_runtime_status(status="failed", progress_percent=0.0, message="llama.cpp runtime install failed.", error=str(exc))


@router.get("/runtime/llama-cpp", response_model=LlamaCppRuntimeStatus)
def get_llama_cpp_runtime_status() -> LlamaCppRuntimeStatus:
    return _llama_runtime_snapshot()


@router.post("/runtime/llama-cpp/install", response_model=LlamaCppRuntimeStatus)
def install_llama_cpp_runtime(payload: LlamaCppInstallRequest, background_tasks: BackgroundTasks) -> LlamaCppRuntimeStatus:
    current = _llama_runtime_snapshot()
    if current.status in {"queued", "downloading", "extracting"} and not payload.force:
        return current
    _set_llama_runtime_status(
        status="queued",
        variant=payload.variant,
        progress_percent=0.0,
        message="llama.cpp install queued.",
        error=None,
    )
    background_tasks.add_task(_install_llama_cpp_runtime, payload.variant, payload.force)
    return _llama_runtime_snapshot()


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
