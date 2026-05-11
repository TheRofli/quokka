from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re
import threading
import uuid
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, Query

from app.api.dependencies import get_model_service
from app.core.settings import get_settings
from app.schemas.api import (
    ModelDownloadRequest,
    ModelDownloadStatus,
    ModelLibraryEntry,
    ModelLibraryFile,
    ModelLibrarySearchResponse,
    ResolveModelReferenceRequest,
)
from app.services.model_library_service import (
    HuggingFaceReference,
    build_huggingface_resolve_url,
    model_name_from_filename,
    parse_huggingface_reference,
)
from app.services.model_service import ModelService

router = APIRouter(prefix="/library", tags=["library"])

_downloads: dict[str, ModelDownloadStatus] = {}
_cancelled: set[str] = set()
_lock = threading.RLock()


FEATURED_QUERIES: list[ModelLibraryEntry] = [
    ModelLibraryEntry(
        id="gemma-windows-starter",
        name="Gemma GGUF",
        repo_id="search:gemma gguf",
        description="Good first Windows llama.cpp search. Pick Q4_K_M/Q5_K_M if VRAM is limited.",
        tags=["starter", "chat", "gguf"],
    ),
    ModelLibraryEntry(
        id="qwen-coder-local",
        name="Qwen coder GGUF",
        repo_id="search:qwen coder gguf",
        description="Coding-focused local models. Useful when Quokka Lab is connected to Quokka.",
        tags=["coding", "gguf"],
    ),
    ModelLibraryEntry(
        id="devstral-local",
        name="Devstral GGUF",
        repo_id="search:devstral gguf",
        description="Agent/coding style models. Choose a quant that fits your GPU memory.",
        tags=["agent", "coding", "gguf"],
    ),
]


def _models_dir() -> Path:
    settings = get_settings()
    target = settings.data_dir / "models"
    target.mkdir(parents=True, exist_ok=True)
    return target


def _safe_file_name(value: str) -> str:
    name = Path(value).name or "model.gguf"
    return re.sub(r"[^a-zA-Z0-9._+\\-()\\[\\] ]+", "_", name)


def _quant_from_filename(filename: str) -> str | None:
    match = re.search(r"\b(Q[0-9][A-Z0-9_]+)\b", filename.upper())
    return match.group(1) if match else None


def _download_url_from_request(payload: ModelDownloadRequest) -> tuple[str, str]:
    if payload.url:
        reference = parse_huggingface_reference(payload.url)
        if "huggingface.co" in payload.url and reference.filename:
            return build_huggingface_resolve_url(reference), reference.filename
        if payload.url.lower().endswith(".gguf"):
            return payload.url, _safe_file_name(reference.filename or payload.url)
    if payload.repo_id and payload.filename:
        reference = HuggingFaceReference(repo_id=payload.repo_id, filename=payload.filename, revision=payload.revision)
        return build_huggingface_resolve_url(reference), payload.filename
    raise ValueError("Choose a GGUF file or paste a Hugging Face .gguf URL.")


def _snapshot(download_id: str) -> ModelDownloadStatus:
    with _lock:
        return _downloads[download_id].model_copy(deep=True)


def _set_status(download_id: str, **updates) -> None:
    with _lock:
        current = _downloads[download_id]
        next_status = current.model_copy(update={**updates, "updated_at": datetime.utcnow()})
        _downloads[download_id] = next_status


def _download_worker(download_id: str) -> None:
    status = _snapshot(download_id)
    try:
        _set_status(download_id, status="downloading")
        target = Path(status.target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + ".part")
        with httpx.stream("GET", status.url, follow_redirects=True, timeout=None) as response:
            response.raise_for_status()
            total = int(response.headers.get("content-length") or 0) or None
            bytes_downloaded = 0
            with temp.open("wb") as handle:
                for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                    if download_id in _cancelled:
                        _set_status(download_id, status="cancelled", error="Download cancelled.")
                        try:
                            temp.unlink(missing_ok=True)
                        except OSError:
                            pass
                        return
                    if not chunk:
                        continue
                    handle.write(chunk)
                    bytes_downloaded += len(chunk)
                    progress = (bytes_downloaded / total * 100) if total else 0.0
                    _set_status(download_id, bytes_downloaded=bytes_downloaded, total_bytes=total, progress_percent=round(progress, 2))
        temp.replace(target)
        _set_status(download_id, status="completed", progress_percent=100.0)
    except Exception as exc:  # noqa: BLE001
        _set_status(download_id, status="failed", error=str(exc))


def _entry_from_hf_model(payload: dict) -> ModelLibraryEntry:
    repo_id = str(payload.get("modelId") or payload.get("id") or "")
    siblings = payload.get("siblings") if isinstance(payload.get("siblings"), list) else []
    files: list[ModelLibraryFile] = []
    for sibling in siblings:
        if not isinstance(sibling, dict):
            continue
        filename = str(sibling.get("rfilename") or sibling.get("filename") or "")
        if not filename.lower().endswith(".gguf"):
            continue
        files.append(
            ModelLibraryFile(
                filename=filename,
                size_bytes=sibling.get("size") if isinstance(sibling.get("size"), int) else None,
                quantization=_quant_from_filename(filename),
                download_url=build_huggingface_resolve_url(HuggingFaceReference(repo_id=repo_id, filename=filename)),
            )
        )
    return ModelLibraryEntry(
        id=repo_id,
        name=repo_id.split("/")[-1] if repo_id else "Unknown model",
        repo_id=repo_id,
        description=str(payload.get("description") or "")[:280] or None,
        tags=[str(item) for item in payload.get("tags", [])[:8]] if isinstance(payload.get("tags"), list) else [],
        likes=payload.get("likes") if isinstance(payload.get("likes"), int) else None,
        downloads=payload.get("downloads") if isinstance(payload.get("downloads"), int) else None,
        files=files[:8],
    )


@router.get("/featured", response_model=list[ModelLibraryEntry])
def featured_models() -> list[ModelLibraryEntry]:
    return FEATURED_QUERIES


@router.get("/search", response_model=ModelLibrarySearchResponse)
def search_models(query: str = Query(default="gemma gguf", min_length=1, max_length=120)) -> ModelLibrarySearchResponse:
    entries: list[ModelLibraryEntry] = []
    with httpx.Client(timeout=8.0, follow_redirects=True) as client:
        response = client.get("https://huggingface.co/api/models", params={"search": query, "limit": 12, "full": "true"})
        response.raise_for_status()
        payload = response.json()
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, dict):
            continue
        entry = _entry_from_hf_model(item)
        if entry.files or "gguf" in " ".join(entry.tags).lower() or "gguf" in entry.repo_id.lower():
            entries.append(entry)
    return ModelLibrarySearchResponse(query=query, entries=entries[:24])


@router.post("/resolve", response_model=ModelLibraryEntry)
def resolve_reference(payload: ResolveModelReferenceRequest) -> ModelLibraryEntry:
    raw = payload.reference.strip()
    parsed = urlparse(raw)
    if parsed.scheme and "huggingface.co" not in parsed.netloc.lower() and raw.lower().endswith(".gguf"):
        filename = _safe_file_name(parsed.path)
        return ModelLibraryEntry(
            id=parsed.netloc,
            name=model_name_from_filename(filename),
            repo_id=parsed.netloc,
            description="Resolved from a direct GGUF download URL.",
            tags=["manual", "gguf"],
            files=[
                ModelLibraryFile(
                    filename=filename,
                    quantization=_quant_from_filename(filename),
                    download_url=raw,
                )
            ],
        )
    reference = parse_huggingface_reference(payload.reference)
    if reference.filename:
        file = ModelLibraryFile(
            filename=reference.filename,
            quantization=_quant_from_filename(reference.filename),
            download_url=build_huggingface_resolve_url(reference),
        )
        return ModelLibraryEntry(
            id=reference.repo_id,
            name=reference.repo_id.split("/")[-1],
            repo_id=reference.repo_id,
            description="Resolved from pasted Hugging Face URL.",
            tags=["manual", "gguf"],
            files=[file],
        )

    with httpx.Client(timeout=8.0, follow_redirects=True) as client:
        response = client.get(f"https://huggingface.co/api/models/{reference.repo_id}")
        response.raise_for_status()
        model_payload = response.json()
    return _entry_from_hf_model(model_payload)


@router.post("/downloads", response_model=ModelDownloadStatus)
def start_download(
    payload: ModelDownloadRequest,
    background_tasks: BackgroundTasks,
    model_service: ModelService = Depends(get_model_service),
) -> ModelDownloadStatus:
    url, filename = _download_url_from_request(payload)
    file_name = _safe_file_name(filename)
    target_root = Path(payload.target_dir).expanduser() if payload.target_dir else _models_dir()
    target_path = target_root / file_name
    download_id = f"dl-{uuid.uuid4().hex[:10]}"
    now = datetime.utcnow()
    status = ModelDownloadStatus(
        id=download_id,
        status="queued",
        label=payload.name or model_name_from_filename(file_name),
        url=url,
        file_name=file_name,
        target_path=str(target_path),
        created_at=now,
        updated_at=now,
    )
    with _lock:
        _downloads[download_id] = status
    background_tasks.add_task(_download_worker, download_id)
    model_service.get_runtime_setup_check()
    return status


@router.get("/downloads", response_model=list[ModelDownloadStatus])
def list_downloads() -> list[ModelDownloadStatus]:
    with _lock:
        return sorted((item.model_copy(deep=True) for item in _downloads.values()), key=lambda item: item.created_at, reverse=True)


@router.get("/downloads/{download_id}", response_model=ModelDownloadStatus)
def get_download(download_id: str) -> ModelDownloadStatus:
    return _snapshot(download_id)


@router.post("/downloads/{download_id}/cancel", response_model=ModelDownloadStatus)
def cancel_download(download_id: str) -> ModelDownloadStatus:
    _cancelled.add(download_id)
    current = _snapshot(download_id)
    if current.status in {"queued", "downloading"}:
        _set_status(download_id, status="cancelled", error="Download cancelled.")
    return _snapshot(download_id)
