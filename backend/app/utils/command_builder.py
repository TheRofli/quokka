from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from app.schemas.config import ModelConfig, ProfileConfig


class _SafeFormatMap(dict[str, Any]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def _build_cache_args(profile: ProfileConfig) -> str:
    args: list[str] = []
    if profile.cache_type_k:
        args.extend(["--cache-type-k", profile.cache_type_k])
    if profile.cache_type_v:
        args.extend(["--cache-type-v", profile.cache_type_v])
    if profile.cache_prompt:
        args.append("--prompt-cache-all")
    if profile.cache_reuse is not None:
        args.extend(["--cache-reuse", str(profile.cache_reuse)])
    return " ".join(args)


def _template_context(model: ModelConfig, profile: ProfileConfig | None) -> dict[str, Any]:
    profile = profile or ProfileConfig(id="default", name="Default")
    context: dict[str, Any] = {
        "model_id": model.id,
        "model_name": model.name,
        "endpoint": model.endpoint,
        "port": model.metadata.get("port", ""),
        "host": model.metadata.get("host", ""),
        "context_size": profile.context_size,
        "batch_size": profile.batch_size,
        "ubatch_size": profile.ubatch_size,
        "temperature": profile.temperature,
        "top_p": profile.top_p,
        "top_k": profile.top_k,
        "min_p": profile.min_p,
        "cache_type_k": profile.cache_type_k or "",
        "cache_type_v": profile.cache_type_v or "",
        "cache_args": _build_cache_args(profile),
        "extra_args": " ".join(profile.extra_args),
    }
    for key, value in model.metadata.items():
        context[str(key)] = value
    return context


def build_command(model: ModelConfig, profile: ProfileConfig | None) -> list[str]:
    context = _template_context(model, profile)
    formatter = _SafeFormatMap(context)

    built: list[str] = []
    for part in model.launch.command:
        templated = part.format_map(formatter)
        built.append(os.path.expandvars(templated))
    return built


def build_environment(model: ModelConfig) -> dict[str, str]:
    merged = os.environ.copy()
    for key, value in model.launch.environment.items():
        merged[key] = os.path.expandvars(value)
    return merged


def resolve_working_dir(model: ModelConfig) -> str | None:
    if not model.launch.working_dir:
        return None
    working_dir = os.path.expandvars(model.launch.working_dir)
    if os.name == "nt" and working_dir.startswith("/"):
        return None
    return working_dir


def normalize_log_path(log_path: str | None, fallback_dir: Path, model_id: str) -> Path:
    if log_path:
        path = Path(os.path.expandvars(log_path))
        if path.is_absolute():
            return path
        return fallback_dir.parent.parent / path
    return fallback_dir / f"{model_id}.log"
