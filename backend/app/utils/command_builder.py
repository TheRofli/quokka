from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from app.schemas.config import ModelConfig, ProfileConfig

VALUE_FLAGS = {
    "--n-gpu-layers",
    "--parallel",
    "--cache-ram",
    "--repeat-penalty",
    "--threads",
    "--threads-batch",
    "--api-default-completion-max-tokens",
    "--flash-attn",
    "--override-tensor",
    "--reasoning-format",
}
BOOLEAN_FLAGS = {"--jinja", "--no-mmap", "--mlock"}
MANAGED_FLAGS = VALUE_FLAGS | BOOLEAN_FLAGS


_PLACEHOLDER_PATTERN = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _format_template(value: str, context: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in context:
            return match.group(0)
        return str(context[key])

    return _PLACEHOLDER_PATTERN.sub(replace, value)


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


def _without_managed_flags(args: list[str]) -> list[str]:
    cleaned: list[str] = []
    skip_next = False
    for item in args:
        if skip_next:
            skip_next = False
            continue
        if item in VALUE_FLAGS:
            skip_next = True
            continue
        if item in BOOLEAN_FLAGS:
            continue
        cleaned.append(item)
    return cleaned


def _read_arg(args: list[str], flag: str) -> str | None:
    try:
        index = args.index(flag)
    except ValueError:
        return None
    if index + 1 >= len(args):
        return None
    return args[index + 1]


def _has_arg(args: list[str], flag: str) -> bool:
    return flag in args


def _append_value(args: list[str], flag: str, value: object | None) -> None:
    if value is None or value == "":
        return
    args.extend([flag, str(value)])


def _build_extra_args(profile: ProfileConfig) -> str:
    raw_args = profile.extra_args
    args = _without_managed_flags(raw_args)
    _append_value(args, "--n-gpu-layers", profile.n_gpu_layers if profile.n_gpu_layers is not None else _read_arg(raw_args, "--n-gpu-layers"))
    _append_value(args, "--parallel", profile.parallel if profile.parallel is not None else _read_arg(raw_args, "--parallel"))
    _append_value(args, "--cache-ram", profile.cache_ram if profile.cache_ram is not None else _read_arg(raw_args, "--cache-ram"))
    _append_value(args, "--repeat-penalty", profile.repeat_penalty if profile.repeat_penalty is not None else _read_arg(raw_args, "--repeat-penalty"))
    _append_value(args, "--threads", profile.threads if profile.threads is not None else _read_arg(raw_args, "--threads"))
    _append_value(args, "--threads-batch", profile.threads_batch if profile.threads_batch is not None else _read_arg(raw_args, "--threads-batch"))
    _append_value(
        args,
        "--api-default-completion-max-tokens",
        profile.api_default_completion_max_tokens
        if profile.api_default_completion_max_tokens is not None
        else _read_arg(raw_args, "--api-default-completion-max-tokens"),
    )
    flash_attn_value = _read_arg(raw_args, "--flash-attn")
    if profile.flash_attn is not None:
        args.extend(["--flash-attn", "on" if profile.flash_attn else "off"])
    elif flash_attn_value is not None:
        args.extend(["--flash-attn", flash_attn_value])
    if profile.jinja or _has_arg(raw_args, "--jinja"):
        args.append("--jinja")
    if profile.no_mmap or _has_arg(raw_args, "--no-mmap"):
        args.append("--no-mmap")
    if profile.mlock or _has_arg(raw_args, "--mlock"):
        args.append("--mlock")
    _append_value(args, "--override-tensor", profile.override_tensor or _read_arg(raw_args, "--override-tensor"))
    _append_value(args, "--reasoning-format", profile.reasoning_format or _read_arg(raw_args, "--reasoning-format"))
    return " ".join(args)


def _template_context(model: ModelConfig, profile: ProfileConfig | None) -> dict[str, Any]:
    profile = profile or ProfileConfig(id="default", name="Default")
    context: dict[str, Any] = {
        "model_id": model.id,
        "model_name": model.name,
        "model_path": profile.model_path or model.metadata.get("model_path", ""),
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
        "n_gpu_layers": profile.n_gpu_layers or "",
        "parallel": profile.parallel or "",
        "cache_ram": profile.cache_ram if profile.cache_ram is not None else "",
        "repeat_penalty": profile.repeat_penalty or "",
        "threads": profile.threads or "",
        "threads_batch": profile.threads_batch or "",
        "api_default_completion_max_tokens": profile.api_default_completion_max_tokens or "",
        "cache_type_k": profile.cache_type_k or "",
        "cache_type_v": profile.cache_type_v or "",
        "cache_args": _build_cache_args(profile),
        "extra_args": _build_extra_args(profile),
    }
    for key, value in model.metadata.items():
        context[str(key)] = value
    return context


def build_command(model: ModelConfig, profile: ProfileConfig | None) -> list[str]:
    context = _template_context(model, profile)

    built: list[str] = []
    for part in model.launch.command:
        templated = _format_template(part, context)
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
