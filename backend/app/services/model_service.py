from __future__ import annotations

import asyncio
import csv
import json
import logging
import os
import socket
import subprocess
import re
import shlex
import shutil
import threading
import sys
import tempfile
import time
import uuid
from datetime import datetime
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from app.core.errors import BadRequestError, ConflictError, NotFoundError
from app.core.settings import get_settings
from app.domain.enums import ModelStatus, ProviderType
from app.domain.runtime import RuntimeState
from app.schemas.api import (
    ApplyBenchmarkProfileRequest,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkRunStatus,
    BenchmarkEvent,
    BenchmarkRecommendation,
    BenchmarkStageResult,
    BulkImportError,
    BulkImportModelsRequest,
    BulkImportModelsResponse,
    CreateModelRequest,
    DiscoveredModelArtifact,
    HealthCheckResponse,
    LogResponse,
    ModelArtifactInfo,
    ModelDoctorCheck,
    ModelDoctorFixRequest,
    ModelDoctorResponse,
    ModelView,
    RuntimeSetupCheck,
    RuntimeSetupCheckResponse,
    RuntimeStateResponse,
    RenameModelRequest,
    TestLaunchResponse,
)
from app.schemas.config import AppConfig, LaunchConfig, ModelConfig, ModelSettings, ProfileConfig
from app.services.config_service import ConfigService
from app.services.health_service import HealthService
from app.services.log_service import LogService
from app.services.metrics_service import MetricsService
from app.services.model_library_service import validate_gguf_file
from app.services.process_service import ProcessExitEvent, ProcessService
from app.utils.command_builder import build_command

logger = logging.getLogger(__name__)
LLAMA_CPP_PROVIDERS = {ProviderType.WSL_LLAMA_CPP, ProviderType.WINDOWS_LLAMA_CPP}


class ModelService:
    def __init__(
        self,
        config_service: ConfigService,
        process_service: ProcessService,
        health_service: HealthService,
        log_service: LogService,
        metrics_service: MetricsService,
    ) -> None:
        self.config_service = config_service
        self.process_service = process_service
        self.health_service = health_service
        self.log_service = log_service
        self.metrics_service = metrics_service
        self.runtime_states: dict[str, RuntimeState] = {}
        self.benchmark_runs: dict[str, BenchmarkRunStatus] = {}
        self.benchmark_tasks: dict[str, asyncio.Task[None]] = {}
        self._benchmark_cancelled: set[str] = set()
        self._benchmark_lock = threading.Lock()
        self.sync_runtime_catalog()

    def sync_runtime_catalog(self) -> None:
        configured_ids = {model.id for model in self.config_service.list_models()}
        for model_id in configured_ids:
            self.runtime_states.setdefault(model_id, RuntimeState())
        for model_id in list(self.runtime_states.keys()):
            if model_id not in configured_ids:
                self.runtime_states.pop(model_id, None)

    def active_model_count(self) -> int:
        active_statuses = {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING}
        return sum(1 for state in self.runtime_states.values() if state.status in active_statuses)

    def get_system_metrics(self):
        return self.metrics_service.get_system_metrics(self.active_model_count())

    def get_metrics_history(self, minutes: int = 60):
        return self.metrics_service.get_history(minutes)

    def get_runtime_setup_check(self) -> RuntimeSetupCheckResponse:
        candidates = self._discover_windows_llama_server_candidates()
        models_dir = self._models_download_dir()
        checks: list[RuntimeSetupCheck] = [
            RuntimeSetupCheck(
                id="models-dir",
                label="Model download folder",
                status="pass",
                detail=str(models_dir),
            )
        ]

        path_has_llama = bool(shutil.which("llama-server.exe") or shutil.which("llama-server"))
        if candidates:
            checks.append(
                RuntimeSetupCheck(
                    id="llama-server",
                    label="llama-server.exe",
                    status="pass",
                    detail=f"Found {len(candidates)} candidate{'s' if len(candidates) != 1 else ''}.",
                )
            )
        else:
            checks.append(
                RuntimeSetupCheck(
                    id="llama-server",
                    label="llama-server.exe",
                    status="warn",
                    detail="Quokka did not find llama-server.exe yet. Add it to PATH or pick it in Add Model.",
                )
            )

        return RuntimeSetupCheckResponse(
            os=sys.platform,
            models_dir=str(models_dir),
            llama_server_candidates=candidates,
            path_has_llama_server=path_has_llama,
            checks=checks,
        )

    def test_model_launch(self, payload: CreateModelRequest) -> TestLaunchResponse:
        checks: list[RuntimeSetupCheck] = []
        ok = True

        if payload.provider != ProviderType.WINDOWS_LLAMA_CPP:
            checks.append(
                RuntimeSetupCheck(
                    id="runtime",
                    label="Runtime",
                    status="info",
                    detail="Test launch v1 focuses on Windows llama.cpp. WSL models are still validated on Start.",
                )
            )
            return TestLaunchResponse(ok=True, summary="WSL launch will be validated when the model starts.", checks=checks)

        model_path = Path(os.path.expandvars(payload.model_path.strip().strip("\"'"))).expanduser()
        validation = validate_gguf_file(model_path)
        checks.append(
            RuntimeSetupCheck(
                id="gguf",
                label="GGUF model",
                status="pass" if validation.ok else "fail",
                detail=validation.summary,
            )
        )
        ok = ok and validation.ok

        llama_server_path = payload.llama_server_path or self._detect_windows_llama_server_path()
        resolved_server = self._resolve_windows_executable(llama_server_path)
        if resolved_server:
            checks.append(
                RuntimeSetupCheck(
                    id="llama-server",
                    label="llama-server.exe",
                    status="pass",
                    detail=resolved_server,
                )
            )
        else:
            checks.append(
                RuntimeSetupCheck(
                    id="llama-server",
                    label="llama-server.exe",
                    status="fail",
                    detail="llama-server.exe was not found. Pick the executable or install llama.cpp for Windows.",
                )
            )
            ok = False

        if resolved_server:
            try:
                result = subprocess.run(
                    [resolved_server, "--help"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
                    check=False,
                )
                checks.append(
                    RuntimeSetupCheck(
                        id="llama-help",
                        label="llama.cpp executable",
                        status="pass" if result.returncode == 0 else "warn",
                        detail="Executable responded to --help." if result.returncode == 0 else "Executable exists but --help returned a non-zero exit code.",
                    )
                )
            except Exception as exc:  # noqa: BLE001
                checks.append(
                    RuntimeSetupCheck(
                        id="llama-help",
                        label="llama.cpp executable",
                        status="warn",
                        detail=f"Could not run --help: {exc}",
                    )
                )

        checks.append(
            RuntimeSetupCheck(
                id="architecture",
                label="Model architecture",
                status="info",
                detail="Architecture support is confirmed on first Start. If llama.cpp cannot load this GGUF, Quokka will show the exact log error.",
            )
        )
        summary = "Launch preflight passed. Quokka can add this Windows llama.cpp model." if ok else "Launch preflight found issues to fix before Start."
        return TestLaunchResponse(ok=ok, summary=summary, checks=checks, llama_server_path=resolved_server or llama_server_path)

    def list_models(self) -> list[ModelView]:
        self.sync_runtime_catalog()
        return [self._compose_model_view(model) for model in self.config_service.list_models()]

    def get_model_view(self, model_id: str) -> ModelView:
        self.sync_runtime_catalog()
        model = self.config_service.get_model(model_id)
        return self._compose_model_view(model)

    def diagnose_model(self, model_id: str) -> ModelDoctorResponse:
        self.sync_runtime_catalog()
        model = self.config_service.get_model(model_id)
        runtime = self.runtime_states.setdefault(model.id, RuntimeState())
        profile = model.get_active_profile()
        model_path = str((profile.model_path if profile and profile.model_path else model.metadata.get("model_path", "")) or "")
        checks: list[ModelDoctorCheck] = []
        actions: list[str] = []

        def add_check(check_id: str, label: str, status: str, detail: str, action: str | None = None) -> None:
            checks.append(ModelDoctorCheck(id=check_id, label=label, status=status, detail=detail, action=action))
            if action and status in {"warn", "fail"}:
                actions.append(action)

        if model_path:
            if self._path_exists_for_provider(model.provider, model_path):
                add_check("model-file", "Model file", "pass", model_path)
            else:
                add_check("model-file", "Model file", "fail", f"Quokka cannot see {model_path}", "Fix the model path or scan the drive again.")
        else:
            add_check("model-file", "Model file", "fail", "No model_path is configured.", "Open Add Model and choose a GGUF file.")

        if model.provider == ProviderType.WINDOWS_LLAMA_CPP:
            server_path = str(model.metadata.get("llama_server_path", "") or "")
            if server_path:
                status = "pass" if Path(server_path).exists() else "warn"
                add_check(
                    "llama-server",
                    "llama-server.exe",
                    status,
                    server_path if status == "pass" else f"{server_path} was not found; PATH fallback may still work.",
                    "Choose llama-server.exe in Add Model or add it to PATH." if status == "warn" else None,
                )
            else:
                add_check("llama-server", "llama-server.exe", "info", "No explicit executable path. Quokka will use PATH.")
        elif model.provider == ProviderType.WSL_LLAMA_CPP:
            if re.match(r"^[a-zA-Z]:[\\/]", model_path):
                add_check(
                    "runtime",
                    "Runtime",
                    "fail",
                    "This model is configured for WSL but still points to a Windows path.",
                    "Switch to WSL runtime to convert the path to /mnt/<drive>/...",
                )
            else:
                add_check("runtime", "Runtime", "info", "This model starts through WSL llama.cpp.")
        else:
            add_check("runtime", "Runtime", "info", f"Provider: {model.provider.value}")

        parsed = urlparse(model.endpoint)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port
        if port:
            if self._is_tcp_port_open(host, port):
                add_check("port", "Endpoint port", "pass", f"{host}:{port} is accepting TCP connections.")
            elif runtime.status in {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING}:
                add_check("port", "Endpoint port", "warn", f"{host}:{port} is not responding yet.", "Wait for model loading or check logs.")
            else:
                add_check("port", "Endpoint port", "info", f"{host}:{port} is closed while the model is {runtime.status.value}.")
        else:
            add_check("port", "Endpoint port", "fail", f"Could not parse a port from {model.endpoint}.", "Fix the model endpoint.")

        if runtime.health_ok is True:
            add_check("health", "HTTP health", "pass", f"Ready in {runtime.health_latency_ms or 0:.0f} ms.")
        elif runtime.status in {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING}:
            detail = runtime.last_error or "HTTP health is not ready."
            add_check("health", "HTTP health", "warn", detail, "Open logs or run Health after loading finishes.")
        else:
            add_check("health", "HTTP health", "info", "Health checks run after the model starts.")

        if runtime.last_error:
            add_check("last-error", "Last runtime error", "warn", runtime.last_error, "Open Logs and Health Doctor before retrying.")

        fail_count = sum(1 for item in checks if item.status == "fail")
        warn_count = sum(1 for item in checks if item.status == "warn")
        if fail_count:
            status = "blocked"
            summary = f"{fail_count} blocking issue{'s' if fail_count != 1 else ''} found."
        elif warn_count:
            status = "attention"
            summary = f"{warn_count} item{'s' if warn_count != 1 else ''} need attention."
        else:
            status = "ready"
            summary = "This model looks ready."

        return ModelDoctorResponse(
            model_id=model.id,
            status=status,
            summary=summary,
            checks=checks,
            recommended_actions=list(dict.fromkeys(actions)),
        )

    def apply_model_doctor_fix(self, model_id: str, payload: ModelDoctorFixRequest) -> ModelView:
        model = self.config_service.get_model(model_id)
        profile = model.get_active_profile()
        next_provider = model.provider
        next_model_path = str((profile.model_path if profile and profile.model_path else model.metadata.get("model_path", "")) or "")
        next_llama_server_path = str(model.metadata.get("llama_server_path", "") or "")
        parsed = urlparse(model.endpoint)
        next_host = parsed.hostname or str(model.metadata.get("host", "") or "127.0.0.1")
        next_port = parsed.port or int(model.metadata.get("port", 8080) or 8080)

        if payload.action == "change_port":
            try:
                next_port = int(payload.value or 0)
            except (TypeError, ValueError) as exc:
                raise BadRequestError("Port must be a number between 1 and 65535.") from exc
            if next_port < 1 or next_port > 65535:
                raise BadRequestError("Port must be between 1 and 65535.")
        elif payload.action == "switch_windows_runtime":
            next_provider = ProviderType.WINDOWS_LLAMA_CPP
            if self._is_wsl_mnt_path(next_model_path):
                next_model_path = self._wsl_path_string_to_windows(next_model_path)
        elif payload.action == "switch_wsl_runtime":
            candidate_path = str(payload.value or "").strip().strip("\"'")
            if candidate_path:
                next_model_path = candidate_path
            next_provider = ProviderType.WSL_LLAMA_CPP
            next_llama_server_path = ""
            if re.match(r"^[a-zA-Z]:[\\/]", next_model_path):
                next_model_path = self._windows_path_string_to_wsl(next_model_path)
            if not (next_model_path.startswith("/") or next_model_path.startswith("~/")):
                raise BadRequestError("WSL runtime needs a Linux path like /mnt/d/Models/model.gguf or ~/llm/models/model.gguf.")
        elif payload.action == "set_llama_server_path":
            next_llama_server_path = str(payload.value or "").strip().strip("\"'")
            if not next_llama_server_path:
                raise BadRequestError("llama-server.exe path is required.")
            if not Path(next_llama_server_path).exists():
                raise BadRequestError(f"llama-server.exe was not found at {next_llama_server_path}.")
            next_provider = ProviderType.WINDOWS_LLAMA_CPP
        elif payload.action == "set_model_path":
            next_model_path = str(payload.value or "").strip().strip("\"'")
            if not next_model_path:
                raise BadRequestError("Model path is required.")
            next_provider = ProviderType.WINDOWS_LLAMA_CPP if re.match(r"^[a-zA-Z]:[\\/]", next_model_path) else next_provider
            next_provider = ProviderType.WSL_LLAMA_CPP if next_model_path.startswith("/") or next_model_path.startswith("~/") else next_provider
            if next_provider == ProviderType.WINDOWS_LLAMA_CPP and not Path(next_model_path).exists():
                raise BadRequestError(f"Model file was not found at {next_model_path}.")
        else:
            raise BadRequestError(f"Unsupported doctor fix action: {payload.action}")

        if next_provider not in LLAMA_CPP_PROVIDERS:
            raise BadRequestError("Doctor fixes currently support local llama.cpp runtimes.")
        if not next_model_path:
            raise BadRequestError("Cannot rebuild launch command because model_path is empty.")

        rebuild = self._create_request_from_model(
            model,
            provider=next_provider,
            model_path=next_model_path,
            llama_server_path=next_llama_server_path,
            host=next_host,
            port=next_port,
        )
        model.provider = next_provider
        model.endpoint = f"http://{next_host}:{next_port}"
        model.health_url = f"{model.endpoint}/health"
        model.launch = self._build_local_llama_launch(rebuild)
        model.metadata.update(
            {
                "host": next_host,
                "port": next_port,
                "model_path": next_model_path,
                "llama_server_path": rebuild.llama_server_path or "",
                "wsl_distro": rebuild.wsl_distro,
                "engine": "llama.cpp",
            }
        )
        if profile and profile.model_path:
            for item in model.profiles:
                if item.id == profile.id:
                    item.model_path = next_model_path
                    break
        updated = self.config_service.update_model(model)
        self.sync_runtime_catalog()
        return self._compose_model_view(updated)

    def apply_benchmark_profile(self, model_id: str, payload: ApplyBenchmarkProfileRequest) -> ProfileConfig:
        model = self.config_service.get_model(model_id)
        base = model.get_active_profile()
        if base is None:
            raise BadRequestError("Cannot create a benchmark profile because this model has no active profile.")

        profile = base.model_copy(deep=True)
        profile.id = self._unique_profile_id(model, payload.name or "benchmark-recommended")
        profile.name = payload.name or f"Benchmark recommended {datetime.now().strftime('%Y-%m-%d %H:%M')}"

        allowed_fields = set(ProfileConfig.model_fields.keys()) - {"id", "name"}
        for key, value in payload.launch_params.items():
            if key in allowed_fields and value is not None:
                setattr(profile, key, value)

        if profile.ubatch_size > profile.batch_size:
            profile.ubatch_size = profile.batch_size

        created = self.config_service.create_profile(model_id, profile)
        if payload.activate:
            created = self.config_service.activate_profile(model_id, created.id)
        return created

    @staticmethod
    def _path_exists_for_provider(provider: ProviderType, path: str) -> bool:
        if provider == ProviderType.WINDOWS_LLAMA_CPP:
            return Path(path).exists()
        if provider == ProviderType.WSL_LLAMA_CPP:
            return bool(path.startswith("/") or path.startswith("~/"))
        return bool(path)

    @staticmethod
    def _is_tcp_port_open(host: str, port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.25):
                return True
        except OSError:
            return False

    @staticmethod
    def _unique_profile_id(model: ModelConfig, name: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "benchmark-profile"
        existing = {profile.id for profile in model.profiles}
        candidate = slug
        index = 2
        while candidate in existing:
            candidate = f"{slug}-{index}"
            index += 1
        return candidate

    def discover_model_artifacts(self, query: str | None = None, limit: int = 80) -> list[DiscoveredModelArtifact]:
        limit = max(1, min(limit, 250))
        query_normalized = (query or "").strip().lower()
        existing_paths = self._configured_model_paths()
        discovered: list[DiscoveredModelArtifact] = []
        seen: set[str] = set()
        query_text = (query or "").strip().strip("\"'")
        is_windows_path_query = bool(re.match(r"^[a-zA-Z]:[\\/]", query_text) or query_text.startswith("\\\\"))
        is_wsl_path_query = bool(query_text.startswith("/") or query_text.startswith("~/"))

        if is_windows_path_query:
            candidates = self._discover_windows_models(limit, query)
        elif is_wsl_path_query:
            candidates = self._discover_wsl_models("Ubuntu", limit)
        else:
            candidates = [*self._discover_wsl_models("Ubuntu", limit), *self._discover_windows_models(limit, query)]

        for artifact in candidates:
            key = artifact.launch_path.lower()
            if key in seen or key in existing_paths or artifact.file_name.lower() in existing_paths:
                continue
            seen.add(key)
            searchable = " ".join(
                item
                for item in [artifact.file_name, artifact.family or "", artifact.quantization or "", artifact.path]
                if item
            ).lower()
            if query_normalized and query_normalized not in searchable:
                continue
            discovered.append(artifact)
            if len(discovered) >= limit:
                break

        return discovered

    def bulk_import_models(self, payload: BulkImportModelsRequest) -> BulkImportModelsResponse:
        artifacts = self.discover_model_artifacts(query=payload.query, limit=payload.limit)
        created: list[ModelView] = []
        errors: list[BulkImportError] = []
        used_ports = self._used_ports()
        next_port = max(1, min(payload.start_port, 65535))

        for artifact in artifacts:
            while next_port in used_ports and next_port < 65535:
                next_port += 1
            if next_port > 65535:
                errors.append(BulkImportError(path=artifact.path, message="No free port was available."))
                continue

            provider = payload.provider or artifact.provider
            request = CreateModelRequest(
                provider=provider,
                name=artifact.suggested_name,
                model_path=artifact.launch_path,
                llama_server_path=payload.llama_server_path,
                port=next_port,
                host=payload.host,
                family=artifact.family,
                size_label=artifact.size_label,
                quantization=artifact.quantization,
                context_size=payload.context_size,
                batch_size=payload.batch_size,
                ubatch_size=payload.ubatch_size,
            )
            try:
                created.append(self.create_model(request))
                used_ports.add(next_port)
                next_port += 1
            except Exception as exc:  # noqa: BLE001 - bulk import should keep moving and report per-file failures.
                errors.append(BulkImportError(path=artifact.path, message=str(exc)))

        return BulkImportModelsResponse(scanned=len(artifacts), created=created, skipped=[], errors=errors)

    def create_model(self, payload: CreateModelRequest) -> ModelView:
        if payload.provider not in LLAMA_CPP_PROVIDERS:
            raise BadRequestError("Automatic model creation supports local llama.cpp models. Use Ollama/OpenAI-compatible entries from config for external endpoints.")
        if payload.provider == ProviderType.WINDOWS_LLAMA_CPP:
            validation = validate_gguf_file(Path(os.path.expandvars(payload.model_path.strip().strip("\"'"))).expanduser())
            if not validation.ok:
                raise BadRequestError(validation.summary)

        model_id = self._unique_model_id(self._slugify(payload.name))
        endpoint = f"http://{payload.host}:{payload.port}"
        file_name = self._file_name_from_path(payload.model_path)
        family = payload.family or self._family_from_filename(file_name)
        quantization = payload.quantization or self._quantization_from_filename(file_name)
        size_label = payload.size_label or self._size_from_filename(file_name)
        llama_server_path = (
            payload.llama_server_path or self._detect_windows_llama_server_path()
            if payload.provider == ProviderType.WINDOWS_LLAMA_CPP
            else ""
        )
        profile = ProfileConfig(
            id="balanced",
            name="Balanced",
            model_path=None,
            context_size=payload.context_size,
            batch_size=payload.batch_size,
            ubatch_size=payload.ubatch_size,
            temperature=payload.temperature,
            top_p=payload.top_p,
            top_k=payload.top_k,
            min_p=payload.min_p,
            cache_prompt=False,
            cache_reuse=None,
            cache_type_k=payload.cache_type_k,
            cache_type_v=payload.cache_type_v,
            extra_args=payload.extra_args,
        )
        model = ModelConfig(
            id=model_id,
            name=payload.name,
            provider=payload.provider,
            modality=payload.modality,
            description=payload.description or f"Local llama.cpp model from {file_name}.",
            endpoint=endpoint,
            health_url=f"{endpoint}/health",
            metadata={
                "family": family or payload.name,
                "size": size_label or "custom",
                "host": payload.host,
                "port": payload.port,
                "engine": "llama.cpp",
                "model_path": payload.model_path,
                "quantization": quantization or "custom",
                "llama_server_path": llama_server_path,
                "wsl_distro": payload.wsl_distro,
                "tags": ["local", "imported"],
            },
            launch=self._build_local_llama_launch(payload),
            profiles=[profile],
            active_profile_id=profile.id,
            settings=ModelSettings(),
            log_path=f"backend/logs/{model_id}.log",
        )
        created = self.config_service.create_model(model)
        self.sync_runtime_catalog()
        return self._compose_model_view(created)

    def _create_request_from_model(
        self,
        model: ModelConfig,
        *,
        provider: ProviderType | None = None,
        model_path: str | None = None,
        llama_server_path: str | None = None,
        host: str | None = None,
        port: int | None = None,
    ) -> CreateModelRequest:
        profile = model.get_active_profile()
        parsed = urlparse(model.endpoint)
        resolved_provider = provider or model.provider
        resolved_path = model_path or str((profile.model_path if profile and profile.model_path else model.metadata.get("model_path", "")) or "")
        resolved_host = host or parsed.hostname or str(model.metadata.get("host", "") or "127.0.0.1")
        resolved_port = port or parsed.port or int(model.metadata.get("port", 8080) or 8080)
        return CreateModelRequest(
            provider=resolved_provider,
            name=model.name,
            model_path=resolved_path,
            llama_server_path=llama_server_path if llama_server_path is not None else str(model.metadata.get("llama_server_path", "") or "") or None,
            port=resolved_port,
            host=resolved_host,
            modality=model.modality,
            family=str(model.metadata.get("family", "") or "") or None,
            size_label=str(model.metadata.get("size", "") or "") or None,
            quantization=str(model.metadata.get("quantization", "") or "") or None,
            wsl_distro=str(model.metadata.get("wsl_distro", "") or "Ubuntu"),
            description=model.description,
            context_size=profile.context_size if profile else 8192,
            batch_size=profile.batch_size if profile else 512,
            ubatch_size=profile.ubatch_size if profile else 128,
            temperature=profile.temperature if profile else 0.15,
            top_p=profile.top_p if profile else 0.9,
            top_k=profile.top_k if profile else 30,
            min_p=profile.min_p if profile else 0.02,
            cache_type_k=profile.cache_type_k if profile else "q4_0",
            cache_type_v=profile.cache_type_v if profile else "q4_0",
            extra_args=list(profile.extra_args) if profile else [
                "--jinja",
                "--n-gpu-layers",
                "999",
                "--flash-attn",
                "on",
                "--parallel",
                "1",
                "--cache-ram",
                "0",
                "--no-mmap",
            ],
        )

    def _build_local_llama_launch(self, payload: CreateModelRequest) -> LaunchConfig:
        if payload.provider == ProviderType.WSL_LLAMA_CPP:
            return LaunchConfig(
                managed=True,
                command=[
                    "wsl",
                    "-d",
                    payload.wsl_distro,
                    "-e",
                    "sh",
                    "-lc",
                    (
                        "cd ~/llm/llama.cpp && GGML_CUDA_GRAPH_OPT=1 ./build/bin/llama-server "
                        "-m {model_path} --host {host} --port {port} --ctx-size {context_size} "
                        "--batch-size {batch_size} --ubatch-size {ubatch_size} --temp {temperature} "
                        "--top-p {top_p} --top-k {top_k} --min-p {min_p} {cache_args} {extra_args}"
                    ),
                ],
                stop_command=[
                    "wsl",
                    "-d",
                    payload.wsl_distro,
                    "-e",
                    "sh",
                    "-lc",
                    f"pkill -f '[l]lama-server.*--port {payload.port}' || true",
                ],
                working_dir=None,
                environment={"LLAMA_LOG_COLORS": "0"},
                shell=False,
                ready_timeout_seconds=120,
            )

        llama_server_path = payload.llama_server_path or self._detect_windows_llama_server_path()
        working_dir = None
        try:
            executable_path = Path(llama_server_path)
            if executable_path.is_absolute() and executable_path.exists():
                working_dir = str(executable_path.parent)
        except OSError:
            working_dir = None

        return LaunchConfig(
            managed=True,
            command=[
                (
                    '"{llama_server_path}" -m "{model_path}" --host {host} --port {port} '
                    "--ctx-size {context_size} --batch-size {batch_size} --ubatch-size {ubatch_size} "
                    "--temp {temperature} --top-p {top_p} --top-k {top_k} --min-p {min_p} "
                    "{cache_args} {extra_args}"
                )
            ],
            stop_command=None,
            working_dir=working_dir,
            environment={"LLAMA_LOG_COLORS": "0"},
            shell=True,
            ready_timeout_seconds=120,
        )

    async def start_model(self, model_id: str) -> ModelView:
        model = self.config_service.get_model(model_id)
        runtime = self._runtime(model.id)

        if not model.settings.allow_start_stop:
            raise BadRequestError(f"Model '{model.name}' is read-only and cannot be started from Quokka.")

        if runtime.status in {ModelStatus.STARTING, ModelStatus.RUNNING, ModelStatus.WARMING}:
            raise ConflictError(f"Model '{model.name}' is already active.")

        profile = model.get_active_profile()
        runtime.last_error = None
        runtime.exit_code = None
        runtime.started_at = datetime.utcnow()
        runtime.stopped_at = None

        try:
            if model.provider == ProviderType.OLLAMA:
                runtime.status = ModelStatus.WARMING
                runtime.managed = False
                await self._warm_ollama_model(model)
            elif model.launch.managed:
                runtime.status = ModelStatus.STARTING
                runtime.managed = True
                runtime.details["launch_profile"] = profile.name if profile else "Default"
                runtime.details["launch_command"] = " ".join(build_command(model, profile))
                if profile:
                    runtime.details["launch_params"] = profile.model_dump_json()
                if model.provider == ProviderType.WINDOWS_LLAMA_CPP:
                    self._validate_windows_llama_cpp_launch(model)
                pid, log_path = self.process_service.start(model, profile)
                runtime.pid = pid
                self.log_service.append_event(model.id, f"Process started with pid={pid}", model.log_path)
                runtime.details["log_path"] = log_path
            elif model.launch.command:
                runtime.status = ModelStatus.STARTING
                runtime.managed = False
                runtime.details["launch_profile"] = profile.name if profile else "Default"
                runtime.details["launch_command"] = " ".join(build_command(model, profile))
                if profile:
                    runtime.details["launch_params"] = profile.model_dump_json()
                await self._run_one_shot_command(build_command(model, profile))
            else:
                raise BadRequestError(
                    f"Model '{model.name}' has no managed launch command. Add one in the config to enable Start."
                )
        except Exception as exc:  # noqa: BLE001
            runtime.status = ModelStatus.ERROR
            runtime.last_error = str(exc)
            self.log_service.append_event(model.id, f"Start failed: {exc}", model.log_path)
            logger.exception("Failed to start model %s", model.id)
            raise BadRequestError(str(exc)) from exc

        if model.provider == ProviderType.OLLAMA:
            await self.check_health(model_id)
        return self.get_model_view(model_id)

    async def stop_model(self, model_id: str) -> ModelView:
        model = self.config_service.get_model(model_id)
        runtime = self._runtime(model.id)

        if not model.settings.allow_start_stop:
            raise BadRequestError(f"Model '{model.name}' is read-only and cannot be stopped from Quokka.")

        runtime.status = ModelStatus.STOPPING
        runtime.last_error = None

        try:
            if model.provider == ProviderType.OLLAMA:
                await self._stop_ollama_model(model)
            elif self.process_service.is_running(model.id):
                self.process_service.stop(model.id)
            elif model.launch.stop_command:
                await self._run_one_shot_command(model.launch.stop_command)
            else:
                runtime.status = ModelStatus.STOPPED
                runtime.pid = None
                runtime.managed = model.launch.managed
                runtime.stopped_at = datetime.utcnow()
                self.log_service.append_event(model.id, "Stop requested while model was already idle.", model.log_path)
                return self.get_model_view(model.id)
        except Exception as exc:  # noqa: BLE001
            runtime.status = ModelStatus.ERROR
            runtime.last_error = str(exc)
            self.log_service.append_event(model.id, f"Stop failed: {exc}", model.log_path)
            raise BadRequestError(str(exc)) from exc

        runtime.status = ModelStatus.STOPPED
        runtime.pid = None
        runtime.managed = model.launch.managed
        runtime.stopped_at = datetime.utcnow()
        self.log_service.append_event(model.id, "Model stopped.", model.log_path)
        return self.get_model_view(model_id)

    async def restart_model(self, model_id: str) -> ModelView:
        await self.stop_model(model_id)
        return await self.start_model(model_id)

    async def check_health(self, model_id: str) -> HealthCheckResponse:
        model = self.config_service.get_model(model_id)
        runtime = self._runtime(model.id)

        if not model.settings.health_enabled:
            response = HealthCheckResponse(
                model_id=model.id,
                ok=True,
                detail="Health checks disabled",
                checked_at=datetime.utcnow(),
            )
            runtime.last_health_check = response.checked_at
            runtime.health_ok = True
            runtime.health_latency_ms = 0.0
            return response

        response = await self.health_service.check_model(model)
        runtime.last_health_check = response.checked_at
        runtime.health_ok = response.ok
        runtime.health_latency_ms = response.latency_ms

        if response.ok:
            if runtime.status != ModelStatus.STOPPING:
                runtime.status = ModelStatus.RUNNING
            runtime.last_transition_reason = response.detail
        else:
            if model.provider == ProviderType.OLLAMA and "not loaded" in response.detail.lower():
                runtime.status = ModelStatus.STOPPED
                runtime.pid = None
                runtime.managed = False
                runtime.last_error = None
                runtime.last_transition_reason = response.detail
                return response

            grace_deadline = None
            if runtime.started_at:
                grace_deadline = (datetime.utcnow() - runtime.started_at).total_seconds()

            within_startup_grace = (
                runtime.status == ModelStatus.STARTING
                and grace_deadline is not None
                and grace_deadline < model.settings.startup_grace_seconds
            )

            if runtime.status == ModelStatus.STOPPED and not self.process_service.is_running(model.id):
                runtime.last_transition_reason = response.detail
                runtime.last_error = None
                return response

            if runtime.status in {ModelStatus.STARTING, ModelStatus.RUNNING, ModelStatus.WARMING} and not within_startup_grace:
                runtime.status = ModelStatus.UNHEALTHY
            runtime.last_error = response.detail
            runtime.last_transition_reason = response.detail
        return response

    async def check_all_health(self) -> None:
        checks = [self.check_health(model.id) for model in self.config_service.list_models()]
        if checks:
            await asyncio.gather(*checks, return_exceptions=True)

    async def start_benchmark_run(self, model_id: str, payload: BenchmarkRunRequest) -> BenchmarkRunStatus:
        model = self.config_service.get_model(model_id)
        profile = model.get_active_profile()
        started_at = datetime.utcnow()
        run_id = f"bench-{started_at.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        artifact = self._extract_artifact_info(model)
        workflow_mode, suite, optimize_for = self._benchmark_contract(payload)
        run = BenchmarkRunStatus(
            id=run_id,
            model_id=model.id,
            model_name=model.name,
            mode=payload.mode,
            workflow_mode=workflow_mode,
            suite=suite,
            optimize_for=optimize_for,
            status="queued",
            progress_percent=1,
            current_stage="Queued",
            started_at=started_at,
            summary="Benchmark queued.",
            endpoint=model.endpoint,
            model_file=artifact.file_name,
            quantization=artifact.quantization,
            launch_params=profile.model_dump(mode="json") if profile else {},
            terminal_lines=[
                "[INIT] queued benchmark run",
                f"[SCAN] workflow={workflow_mode} suite={suite} optimize_for={optimize_for}",
            ],
        )
        self._store_benchmark_run(run)
        self._benchmark_event(run_id, "queued", "Benchmark run created.")
        self.benchmark_tasks[run_id] = asyncio.create_task(self._run_benchmark_job(run_id, model_id, payload))
        return self.get_benchmark_run(model_id, run_id)

    def get_benchmark_run(self, model_id: str, run_id: str) -> BenchmarkRunStatus:
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None or run.model_id != model_id:
                raise NotFoundError(f"Benchmark run '{run_id}' was not found.")
            return run.model_copy(deep=True)

    def cancel_benchmark_run(self, model_id: str, run_id: str) -> BenchmarkRunStatus:
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None or run.model_id != model_id:
                raise NotFoundError(f"Benchmark run '{run_id}' was not found.")
            run.cancel_requested = True
            run.status = "cancelling"
            run.summary = "Cancellation requested."
            self._benchmark_cancelled.add(run_id)
            task = self.benchmark_tasks.get(run_id)
        if task and not task.done():
            task.cancel()
        self._benchmark_event(run_id, "cancel", "Cancellation requested by user.", level="warning")
        self._benchmark_terminal_line(run_id, "[WARN] cancellation requested")
        return self.get_benchmark_run(model_id, run_id)

    def _store_benchmark_run(self, run: BenchmarkRunStatus) -> None:
        with self._benchmark_lock:
            self.benchmark_runs[run.id] = run
            if len(self.benchmark_runs) > 24:
                old_ids = sorted(self.benchmark_runs, key=lambda key: self.benchmark_runs[key].started_at)[:-24]
                for old_id in old_ids:
                    self.benchmark_runs.pop(old_id, None)
                    self.benchmark_tasks.pop(old_id, None)

    @staticmethod
    def _benchmark_contract(payload: BenchmarkRunRequest) -> tuple[str, str, str]:
        legacy_workflow = {
            "quick": "single",
            "full": "single",
            "autotune": "smart_auto",
        }
        legacy_suite = {
            "quick": "quick",
            "full": "full",
            "autotune": "coding",
        }
        workflow_mode = payload.workflow_mode or legacy_workflow.get(payload.mode, "single")
        suite = payload.suite or legacy_suite.get(payload.mode, "quick")
        return workflow_mode, suite, payload.optimize_for or "balanced"

    @staticmethod
    def _benchmark_repetition_count(payload: BenchmarkRunRequest) -> int:
        if payload.workflow_mode or payload.suite:
            return max(1, min(payload.repeats_per_config, 20))
        return max(1, min(payload.repetitions, 20))

    @staticmethod
    def _numeric_stage_values(stages: list[BenchmarkStageResult], field: str) -> list[float]:
        values: list[float] = []
        for stage in stages:
            value = getattr(stage, field, None)
            if isinstance(value, (int, float)) and value > 0:
                values.append(float(value))
        return values

    def _build_benchmark_summary_cards(
        self,
        stages: list[BenchmarkStageResult],
        metrics_after: dict[str, Any],
        stable: bool,
        score_percent: float | None,
    ) -> list[dict[str, Any]]:
        decode_values = self._numeric_stage_values(stages, "tokens_per_second")
        prefill_values = self._numeric_stage_values(stages, "prompt_tokens_per_second")
        ttft_values = self._numeric_stage_values(stages, "ttft_ms")
        generated_tokens = sum(stage.generated_tokens_estimate or 0 for stage in stages)
        return [
            {"id": "decode", "label": "TOKENS/SEC", "value": round(max(decode_values), 2) if decode_values else None, "unit": "tok/s"},
            {"id": "ttft", "label": "FIRST TOKEN", "value": round(min(ttft_values), 0) if ttft_values else None, "unit": "ms"},
            {"id": "prefill", "label": "PREFILL", "value": round(max(prefill_values), 1) if prefill_values else None, "unit": "tok/s"},
            {"id": "tokens", "label": "TOKENS", "value": generated_tokens, "unit": ""},
            {"id": "score", "label": "SCORE", "value": score_percent, "unit": "%"},
            {"id": "stable", "label": "STABLE", "value": stable, "unit": ""},
            {"id": "gpu", "label": "GPU", "value": metrics_after.get("gpu_usage_percent"), "unit": "%"},
            {"id": "cpu", "label": "CPU", "value": metrics_after.get("cpu_usage_percent"), "unit": "%"},
            {"id": "ram", "label": "RAM", "value": metrics_after.get("ram_usage_percent"), "unit": "%"},
        ]

    @staticmethod
    def _candidate_score(row: dict[str, Any], optimize_for: str) -> float:
        decode = float(row.get("decode_tokens_per_second") or 0)
        prefill = float(row.get("prefill_tokens_per_second") or 0)
        ttft = float(row.get("ttft_ms") or 0)
        if optimize_for == "lowest_ttft":
            return -ttft if ttft > 0 else -999999
        if optimize_for == "long_context":
            return prefill
        if optimize_for in {"coding", "balanced"}:
            ttft_penalty = (ttft / 1000) if ttft > 0 else 0
            return (decode * 0.65) + (prefill * 0.35) - ttft_penalty
        return decode

    def _best_candidate_row(self, rows: list[dict[str, Any]], optimize_for: str) -> dict[str, Any] | None:
        ok_rows = [row for row in rows if row.get("probe_ok")]
        if not ok_rows:
            return None
        return max(ok_rows, key=lambda row: self._candidate_score(row, optimize_for))

    def _build_benchmark_leaderboard(
        self,
        stages: list[BenchmarkStageResult],
        candidate_groups: list[dict[str, Any]],
        optimize_for: str,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for group in candidate_groups:
            for candidate in group.get("candidates", []):
                if not isinstance(candidate, dict) or not candidate.get("probe_ok"):
                    continue
                rows.append(
                    {
                        "id": f"{group.get('id', 'candidate')}:{candidate.get('label')}",
                        "label": candidate.get("label"),
                        "group": group.get("title") or group.get("id"),
                        "score": round(self._candidate_score(candidate, optimize_for), 3),
                        "decode_tokens_per_second": candidate.get("decode_tokens_per_second"),
                        "prefill_tokens_per_second": candidate.get("prefill_tokens_per_second"),
                        "ttft_ms": candidate.get("ttft_ms"),
                        "command": candidate.get("command"),
                        "selected": False,
                    }
                )
        if not rows:
            for stage in stages:
                if stage.tokens_per_second is None and stage.prompt_tokens_per_second is None and stage.ttft_ms is None:
                    continue
                row = {
                    "id": stage.name,
                    "label": stage.name,
                    "group": "stage",
                    "score": round(
                        self._candidate_score(
                            {
                                "decode_tokens_per_second": stage.tokens_per_second,
                                "prefill_tokens_per_second": stage.prompt_tokens_per_second,
                                "ttft_ms": stage.ttft_ms,
                            },
                            optimize_for,
                        ),
                        3,
                    ),
                    "decode_tokens_per_second": stage.tokens_per_second,
                    "prefill_tokens_per_second": stage.prompt_tokens_per_second,
                    "ttft_ms": stage.ttft_ms,
                    "selected": False,
                }
                rows.append(row)
        rows.sort(key=lambda row: float(row.get("score") or 0), reverse=True)
        for index, row in enumerate(rows[:12], start=1):
            row["rank"] = index
            row["selected"] = index == 1
        return rows[:12]

    def _build_candidate_groups_from_rows(self, rows: list[dict[str, Any]], optimize_for: str) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        for row in rows:
            group_id = str(row.get("group_id") or row.get("change") or "candidate")
            group = grouped.setdefault(
                group_id,
                {
                    "id": group_id,
                    "title": row.get("group_title") or group_id.replace("_", " "),
                    "selected": None,
                    "candidates": [],
                },
            )
            candidate = {
                "index": row.get("index"),
                "label": row.get("label"),
                "change": row.get("change"),
                "probe_ok": row.get("probe_ok"),
                "probe_error": row.get("probe_error"),
                "decode_tokens_per_second": row.get("decode_tokens_per_second"),
                "prefill_tokens_per_second": row.get("prefill_tokens_per_second"),
                "ttft_ms": row.get("ttft_ms"),
                "generated_tokens_estimate": row.get("generated_tokens_estimate"),
                "command": row.get("command"),
                "score": round(self._candidate_score(row, optimize_for), 3) if row.get("probe_ok") else None,
            }
            group["candidates"].append(candidate)

        for group in grouped.values():
            best = self._best_candidate_row(group["candidates"], optimize_for)
            if best:
                group["selected"] = best.get("label")
                for candidate in group["candidates"]:
                    candidate["selected"] = candidate.get("label") == best.get("label")
        return list(grouped.values())

    def _build_benchmark_compare_snapshot(self, run_id: str, model: ModelConfig, payload: BenchmarkRunRequest) -> bool:
        requested = set(payload.compare_run_ids)
        with self._benchmark_lock:
            completed = [
                run.model_copy(deep=True)
                for run in self.benchmark_runs.values()
                if run.id != run_id
                and run.model_id == model.id
                and run.status == "completed"
                and (not requested or run.id in requested)
            ]
        completed.sort(key=lambda run: run.finished_at or run.started_at, reverse=True)
        compared = completed[:6]
        rows: list[dict[str, Any]] = []
        for item in compared:
            decode_values = self._numeric_stage_values(item.stages, "tokens_per_second")
            ttft_values = self._numeric_stage_values(item.stages, "ttft_ms")
            prefill_values = self._numeric_stage_values(item.stages, "prompt_tokens_per_second")
            rows.append(
                {
                    "id": item.id,
                    "label": f"{item.workflow_mode}/{item.suite}",
                    "finished_at": item.finished_at.isoformat() if item.finished_at else None,
                    "score_percent": item.score_percent,
                    "verdict": item.verdict,
                    "decode_tokens_per_second": round(max(decode_values), 2) if decode_values else None,
                    "prefill_tokens_per_second": round(max(prefill_values), 1) if prefill_values else None,
                    "ttft_ms": round(min(ttft_values), 0) if ttft_values else None,
                    "stable": item.stable,
                }
            )
        if not rows:
            self._benchmark_terminal_line(run_id, "[WARN] no completed historical runs found")
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name="compare history",
                    ok=False,
                    duration_ms=0.0,
                    error="No completed benchmark runs were available for this model.",
                ),
                95,
            )
            return False
        for index, row in enumerate(rows, start=1):
            decode = row.get("decode_tokens_per_second")
            ttft = row.get("ttft_ms")
            self._benchmark_terminal_line(run_id, f"[STEP {index}] {row['label']} decode={decode or '--'} tok/s ttft={ttft or '--'} ms")
        rows.sort(key=lambda row: self._candidate_score(row, payload.optimize_for), reverse=True)
        if rows:
            rows[0]["selected"] = True
        self._update_benchmark_run(
            run_id,
            candidate_groups=[{"id": "history", "title": "Saved benchmark runs", "selected": rows[0]["id"], "candidates": rows}],
            leaderboard=rows,
            selected_values=rows[0] if rows else {},
        )
        self._add_benchmark_stage(
            run_id,
            BenchmarkStageResult(
                name="compare history",
                ok=True,
                duration_ms=0.0,
                response_text=json.dumps({"runs": rows}, ensure_ascii=False, indent=2),
            ),
            95,
        )
        return True

    def _update_benchmark_run(self, run_id: str, **updates: object) -> None:
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None:
                return
            for key, value in updates.items():
                setattr(run, key, value)

    def _benchmark_terminal_line(self, run_id: str, line: str) -> None:
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None:
                return
            run.terminal_lines.append(line)
            run.terminal_lines = run.terminal_lines[-360:]

    def _benchmark_event(self, run_id: str, stage: str, message: str, level: str = "info") -> None:
        timestamp = datetime.utcnow()
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None:
                return
            run.events.append(BenchmarkEvent(timestamp=timestamp, level=level, stage=stage, message=message))
            run.events = run.events[-240:]
            prefix = level.upper().ljust(5)
            run.run_log_lines.append(f"[{prefix}] {stage}: {message}")
            run.run_log_lines = run.run_log_lines[-520:]

    def _add_benchmark_stage(self, run_id: str, stage: BenchmarkStageResult, progress: float) -> None:
        with self._benchmark_lock:
            run = self.benchmark_runs.get(run_id)
            if run is None:
                return
            run.stages.append(stage)
            run.progress_percent = max(run.progress_percent, min(progress, 99))
            run.current_stage = stage.name
        tone = "completed" if stage.ok else "failed"
        self._benchmark_event(run_id, stage.name, f"Stage {tone}: {stage.error or 'ok'}", "info" if stage.ok else "warning")
        if stage.tokens_per_second is not None or stage.ttft_ms is not None or stage.prompt_tokens_per_second is not None:
            chunks: list[str] = []
            if stage.tokens_per_second is not None:
                chunks.append(f"{stage.tokens_per_second:.2f} tok/s")
            if stage.ttft_ms is not None:
                chunks.append(f"TTFT {stage.ttft_ms:.0f} ms")
            if stage.prompt_tokens_per_second is not None:
                chunks.append(f"prefill {stage.prompt_tokens_per_second:.1f} tok/s")
            self._benchmark_terminal_line(run_id, f"[PERF] {stage.name}: {', '.join(chunks)}")
        elif stage.ok:
            self._benchmark_terminal_line(run_id, f"[OK  ] {stage.name}")
        else:
            self._benchmark_terminal_line(run_id, f"[WARN] {stage.name}: {stage.error or 'failed'}")

    def _is_benchmark_cancelled(self, run_id: str) -> bool:
        with self._benchmark_lock:
            return run_id in self._benchmark_cancelled or bool(self.benchmark_runs.get(run_id, None) and self.benchmark_runs[run_id].cancel_requested)

    async def _run_benchmark_job(self, run_id: str, model_id: str, payload: BenchmarkRunRequest) -> None:
        monitor_task: asyncio.Task[None] | None = None
        model: ModelConfig | None = None
        workflow_mode, suite, optimize_for = self._benchmark_contract(payload)
        repeat_count = self._benchmark_repetition_count(payload)
        runs_autotune = workflow_mode in {"smart_auto", "exhaustive"} or payload.mode == "autotune"
        extended_suite = suite in {"full", "stress", "coding", "long_reasoning", "mixed", "vision"}
        runs_extended = runs_autotune or extended_suite or payload.mode in {"full", "autotune"}
        try:
            self._update_benchmark_run(run_id, status="running", current_stage="Hardware snapshot", progress_percent=3, summary="Collecting hardware snapshot.")
            self._benchmark_terminal_line(run_id, "[INIT] loading model telemetry...")
            model = self.config_service.get_model(model_id)
            profile = model.get_active_profile()
            monitor_task = asyncio.create_task(self._benchmark_metric_monitor(run_id))
            metrics_before = self.get_system_metrics().model_dump(mode="json")
            nvidia_smi = await self._capture_nvidia_smi()
            self._update_benchmark_run(run_id, metrics_before=metrics_before, metrics_current=metrics_before, nvidia_smi=nvidia_smi)
            self._benchmark_event(run_id, "hardware", "Captured GPU/CPU/RAM baseline.")
            self._benchmark_terminal_line(run_id, "[GPU ] captured VRAM/GPU baseline")
            self._benchmark_terminal_line(run_id, "[CPU ] prepared benchmark worker")

            if workflow_mode == "compare":
                self._benchmark_terminal_line(run_id, "[SCAN] loading saved benchmark runs...")
                compared = self._build_benchmark_compare_snapshot(run_id, model, payload)
                self._finish_benchmark_run(
                    run_id,
                    model,
                    payload,
                    stable=compared,
                    summary="Compare report ready." if compared else "Compare needs at least one completed historical run.",
                )
                return

            await self._maybe_start_model_for_benchmark(run_id, model)
            checks = await self._wait_for_benchmark_server(run_id, model, payload)
            self._update_benchmark_run(run_id, server_checks=checks)
            server_reachable = self._checks_indicate_model_ready(checks)
            self._benchmark_terminal_line(run_id, "[OK  ] model endpoint ready" if server_reachable else "[WAIT] server reachable, model still loading")
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name="server readiness",
                    ok=server_reachable,
                    duration_ms=0.0,
                    error=None if server_reachable else "No HTTP endpoint became ready before startup wait expired.",
                    response_text=json.dumps(checks, ensure_ascii=False, indent=2),
                ),
                18,
            )
            self._add_benchmark_stage(run_id, await self._benchmark_environment_stage(model), 22)
            self._add_benchmark_stage(run_id, await self._benchmark_wsl_diagnostics_stage(model), 24)
            self._add_benchmark_stage(run_id, self._benchmark_profile_diagnostics_stage(model, profile), 28)
            self._add_benchmark_stage(run_id, self._benchmark_autotune_manifest_stage(model, profile), 30)

            if not server_reachable:
                self._finish_benchmark_run(run_id, model, payload, stable=False, summary="Unstable: local server did not become reachable.")
                return

            await self._run_live_chat_stage(run_id, model, "short coding prompt", "Write a Python hello world program and explain it in one short paragraph.", min(payload.max_tokens, 256), payload.timeout_seconds, 38)

            if runs_extended:
                long_context = "\n".join(f"Function {index}: def transform_{index}(value): return value + {index}" for index in range(1, 2001))
                await self._run_live_chat_stage(
                    run_id,
                    model,
                    "prefill / long prompt",
                    f"Analyze this code inventory, identify repeated patterns, and summarize refactor opportunities:\n\n{long_context}",
                    min(payload.max_tokens, 512),
                    payload.timeout_seconds,
                    48,
                )
                await self._run_live_chat_stage(
                    run_id,
                    model,
                    "decode / long generation",
                    "Write a compact implementation plan for a local coding assistant with tests, logging, failure recovery, and UI states.",
                    min(max(payload.max_tokens, 768), 1536),
                    payload.timeout_seconds,
                    58,
                )
                self._add_benchmark_stage(run_id, await self._benchmark_code_quality_stage(model, payload.timeout_seconds), 66)
                self._add_benchmark_stage(run_id, await self._benchmark_code_execution_stage(model, payload.timeout_seconds), 70)

                repeat_ok = True
                for index in range(repeat_count):
                    self._raise_if_cancelled(run_id)
                    result = await self._benchmark_chat_stage(
                        model,
                        f"repeat request {index + 1}",
                        "Return a single JSON object with keys status and note.",
                        min(payload.max_tokens, 96),
                        payload.timeout_seconds,
                        keep_response=False,
                    )
                    repeat_ok = repeat_ok and result.ok
                    self._add_benchmark_stage(run_id, result, 70 + ((index + 1) / repeat_count) * 8)

                self._add_benchmark_stage(
                    run_id,
                    BenchmarkStageResult(name="repeat summary", ok=repeat_ok, duration_ms=0.0, error=None if repeat_ok else "One or more repeat requests failed."),
                    79,
                )

                agent_prompts = [
                    "Explain what this JavaScript does: const total = items.reduce((sum, item) => sum + item.price, 0);",
                    "Find and fix the bug: def divide(a, b): return a / b",
                    "Rewrite this function to be clearer: def f(xs): return [x for x in xs if x and x > 3]",
                    "Write two pytest tests for a function that slugifies a title.",
                    "Suggest a small refactor for a FastAPI route that mixes validation and IO.",
                ]
                for index, prompt in enumerate(agent_prompts, start=1):
                    self._raise_if_cancelled(run_id)
                    result = await self._benchmark_chat_stage(model, f"agent workflow {index}", prompt, min(payload.max_tokens, 256), payload.timeout_seconds)
                    self._add_benchmark_stage(run_id, result, 79 + (index / len(agent_prompts)) * 10)

                self._add_benchmark_stage(run_id, self._benchmark_thinking_summary_stage(run_id), 91)

                if runs_autotune:
                    self._benchmark_terminal_line(run_id, "[SCAN] reading parameter ranges...")
                    await self._run_autotune_config_sweep(run_id, model, profile, payload, start_progress=91, end_progress=97)

                parallel_started = time.perf_counter()
                parallel_results = await asyncio.gather(
                    self._benchmark_chat_stage(model, "parallel request A", "Write one Python function that reverses a string.", min(payload.max_tokens, 128), payload.timeout_seconds, keep_response=False),
                    self._benchmark_chat_stage(model, "parallel request B", "Write one TypeScript function that clamps a number.", min(payload.max_tokens, 128), payload.timeout_seconds, keep_response=False),
                    return_exceptions=True,
                )
                parallel_ok = True
                parallel_errors: list[str] = []
                for item in parallel_results:
                    if isinstance(item, BenchmarkStageResult):
                        self._add_benchmark_stage(run_id, item, 94)
                        parallel_ok = parallel_ok and item.ok
                        if item.error:
                            parallel_errors.append(item.error)
                    else:
                        parallel_ok = False
                        parallel_errors.append(str(item))
                self._add_benchmark_stage(
                    run_id,
                    BenchmarkStageResult(
                        name="parallel summary",
                        ok=parallel_ok,
                        duration_ms=round((time.perf_counter() - parallel_started) * 1000, 2),
                        error="; ".join(parallel_errors[:3]) if parallel_errors else None,
                    ),
                    97,
                )

            with self._benchmark_lock:
                stages = list(self.benchmark_runs[run_id].stages)
            stable = all(stage.ok for stage in stages)
            self._finish_benchmark_run(
                run_id,
                model,
                payload,
                stable=stable,
                summary="Stable: all benchmark stages completed." if stable else "Unstable: at least one benchmark stage failed.",
            )
        except asyncio.CancelledError:
            self._update_benchmark_run(
                run_id,
                status="cancelled",
                finished_at=datetime.utcnow(),
                current_stage="Cancelled",
                summary="Benchmark cancelled.",
                progress_percent=100,
            )
            self._benchmark_event(run_id, "cancelled", "Benchmark cancelled.", level="warning")
        except Exception as exc:  # noqa: BLE001
            self._update_benchmark_run(
                run_id,
                status="failed",
                finished_at=datetime.utcnow(),
                current_stage="Failed",
                summary=f"Benchmark failed: {exc}",
                progress_percent=100,
            )
            self._benchmark_event(run_id, "failed", str(exc), level="error")
            logger.exception("Benchmark job failed: %s", run_id)
        finally:
            if payload.stop_after and model is not None:
                await self._stop_model_after_benchmark(run_id, model)
            if monitor_task:
                monitor_task.cancel()
            self._benchmark_cancelled.discard(run_id)

    async def _run_live_chat_stage(
        self,
        run_id: str,
        model: ModelConfig,
        name: str,
        prompt: str,
        max_tokens: int,
        timeout_seconds: float,
        progress: float,
    ) -> None:
        self._raise_if_cancelled(run_id)
        self._update_benchmark_run(run_id, current_stage=name, summary=f"Running {name}.")
        self._benchmark_event(run_id, name, f"Sending prompt with max_tokens={max_tokens}.")
        result = await self._benchmark_chat_stage(model, name, prompt, max_tokens, timeout_seconds)
        self._add_benchmark_stage(run_id, result, progress)

    async def _benchmark_metric_monitor(self, run_id: str) -> None:
        while True:
            await asyncio.sleep(2)
            if self._is_benchmark_cancelled(run_id):
                return
            try:
                metrics = self.get_system_metrics().model_dump(mode="json")
                self._update_benchmark_run(run_id, metrics_current=metrics)
            except Exception:
                logger.debug("Benchmark metric monitor failed", exc_info=True)

    async def _maybe_start_model_for_benchmark(self, run_id: str, model: ModelConfig) -> bool:
        runtime = self._runtime(model.id)
        if runtime.status in {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING}:
            self._benchmark_event(run_id, "startup", f"Model runtime is already {runtime.status.value}.")
            return False
        if not model.settings.allow_start_stop:
            self._benchmark_event(run_id, "startup", "Model is external/read-only; waiting for existing endpoint.", level="warning")
            return False
        self._update_benchmark_run(run_id, current_stage="Starting model", progress_percent=8, summary="Starting model before diagnostics.")
        self._benchmark_event(run_id, "startup", "Starting model from Quokka before benchmark.")
        await self.start_model(model.id)
        return True

    async def _stop_model_after_benchmark(self, run_id: str, model: ModelConfig) -> None:
        if not model.settings.allow_start_stop:
            self._benchmark_event(run_id, "cleanup", "Stop-after-test skipped: model is external/read-only.", level="warning")
            return
        runtime = self._runtime(model.id)
        if runtime.status not in {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING, ModelStatus.UNHEALTHY}:
            self._benchmark_event(run_id, "cleanup", f"Stop-after-test skipped: runtime is {runtime.status.value}.")
            return
        try:
            self._benchmark_event(run_id, "cleanup", "Stopping model after benchmark as requested.")
            await self.stop_model(model.id)
        except Exception as exc:  # noqa: BLE001
            self._benchmark_event(run_id, "cleanup", f"Stop-after-test failed: {exc}", level="warning")

    async def _run_autotune_config_sweep(
        self,
        run_id: str,
        model: ModelConfig,
        base_profile: ProfileConfig | None,
        payload: BenchmarkRunRequest,
        start_progress: float,
        end_progress: float,
    ) -> None:
        started = time.perf_counter()
        if model.provider not in LLAMA_CPP_PROVIDERS or not model.launch.managed or not model.settings.allow_start_stop:
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name="autotune restart sweep",
                    ok=False,
                    duration_ms=0.0,
                    error="Restart-per-config sweep requires a managed local llama.cpp model.",
                ),
                start_progress,
            )
            return

        if base_profile is None:
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name="autotune restart sweep",
                    ok=False,
                    duration_ms=0.0,
                    error="No active launch profile is available to clone for auto-tune.",
                ),
                start_progress,
            )
            return

        candidates = self._build_autotune_candidates(base_profile, payload)
        if not candidates:
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name="autotune restart sweep",
                    ok=False,
                    duration_ms=0.0,
                    error="No auto-tune candidates were generated.",
                ),
                start_progress,
            )
            return

        self._benchmark_event(
            run_id,
            "autotune",
            f"Starting restart-per-config sweep with {len(candidates)} candidates. Each candidate is started, health-checked, probed, and compared.",
        )
        rows: list[dict[str, Any]] = []
        total = len(candidates)
        progress_span = max(end_progress - start_progress, 1)
        current_group_id = ""
        step_index = 0

        for index, candidate in enumerate(candidates, start=1):
            self._raise_if_cancelled(run_id)
            label = str(candidate["label"])
            profile = candidate["profile"]
            group_id = str(candidate.get("group_id") or candidate.get("change") or "candidate")
            group_title = str(candidate.get("group_title") or group_id.replace("_", " "))
            if group_id != current_group_id:
                step_index += 1
                current_group_id = group_id
                self._benchmark_terminal_line(run_id, f"[STEP {step_index}] testing {group_title}")
            candidate_started = time.perf_counter()
            candidate_progress = start_progress + ((index - 1) / total) * progress_span
            self._update_benchmark_run(
                run_id,
                current_stage=f"Auto-tune {index}/{total}: {label}",
                progress_percent=candidate_progress,
                summary=f"Restarting llama-server with candidate {index}/{total}: {label}.",
            )
            self._benchmark_event(run_id, "autotune", f"Candidate {index}/{total}: {label}")

            metrics_before = self.get_system_metrics().model_dump(mode="json")
            command = " ".join(build_command(model, profile))
            row: dict[str, Any] = {
                "index": index,
                "label": label,
                "change": candidate["change"],
                "group_id": group_id,
                "group_title": group_title,
                "profile": profile.model_dump(mode="json"),
                "command": command[:4000],
                "metrics_before": metrics_before,
            }
            probe: BenchmarkStageResult | None = None
            checks: dict[str, bool] = {}
            ready = False

            try:
                await self._stop_model_for_autotune_candidate(run_id, model, reason=f"before candidate {index}")
                await self._start_model_with_benchmark_profile(run_id, model, profile)
                checks = await self._wait_for_autotune_candidate_server(
                    run_id,
                    model,
                    payload,
                    start_progress + ((index - 0.75) / total) * progress_span,
                    start_progress + ((index - 0.35) / total) * progress_span,
                )
                ready = self._checks_indicate_model_ready(checks)
                row["checks"] = checks
                if ready:
                    probe = await self._benchmark_chat_stage(
                        model,
                        f"autotune probe {index}",
                        "Return one compact JSON object with keys autotune_probe and note. Keep it short.",
                        min(payload.max_tokens, 192),
                        min(payload.timeout_seconds, 300),
                        keep_response=False,
                    )
                    row.update(
                        {
                            "ttft_ms": probe.ttft_ms,
                            "prefill_tokens_per_second": probe.prompt_tokens_per_second,
                            "decode_tokens_per_second": probe.tokens_per_second,
                            "generated_tokens_estimate": probe.generated_tokens_estimate,
                            "probe_ok": probe.ok,
                            "probe_error": probe.error,
                        }
                    )
                else:
                    row["probe_ok"] = False
                    row["probe_error"] = "Candidate server did not become ready."
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                row["probe_ok"] = False
                row["probe_error"] = str(exc)
                self._benchmark_event(run_id, "autotune", f"Candidate failed: {exc}", level="warning")
            finally:
                row["metrics_after"] = self.get_system_metrics().model_dump(mode="json")
                rows.append(row)
                self._update_benchmark_run(
                    run_id,
                    candidate_groups=self._build_candidate_groups_from_rows(rows, payload.optimize_for),
                    leaderboard=self._build_benchmark_leaderboard([], self._build_candidate_groups_from_rows(rows, payload.optimize_for), payload.optimize_for),
                )
                decode = row.get("decode_tokens_per_second")
                ttft = row.get("ttft_ms")
                marker = "ok" if row.get("probe_ok") else "failed"
                self._benchmark_terminal_line(
                    run_id,
                    f"  {label} -> {decode if decode is not None else '--'} tok/s, TTFT {ttft if ttft is not None else '--'} ms ({marker})",
                )
                if index < total:
                    await self._stop_model_for_autotune_candidate(run_id, model, reason=f"after candidate {index}")

            stage_ok = bool(ready and probe and probe.ok)
            stage_error = None if stage_ok else str(row.get("probe_error") or "Candidate probe failed.")
            self._add_benchmark_stage(
                run_id,
                BenchmarkStageResult(
                    name=f"autotune {index:02d} / {total}: {label}",
                    ok=stage_ok,
                    duration_ms=round((time.perf_counter() - candidate_started) * 1000, 2),
                    ttft_ms=probe.ttft_ms if probe else None,
                    generated_tokens_estimate=probe.generated_tokens_estimate if probe else None,
                    tokens_per_second=probe.tokens_per_second if probe else None,
                    prompt_tokens_estimate=probe.prompt_tokens_estimate if probe else None,
                    prompt_tokens_per_second=probe.prompt_tokens_per_second if probe else None,
                    error=stage_error,
                    response_text=json.dumps(row, ensure_ascii=False, indent=2),
                ),
                start_progress + (index / total) * progress_span,
            )

        ok_rows = [row for row in rows if row.get("probe_ok")]
        best_decode = max(ok_rows, key=lambda item: float(item.get("decode_tokens_per_second") or 0), default=None)
        best_prefill = max(ok_rows, key=lambda item: float(item.get("prefill_tokens_per_second") or 0), default=None)
        selected = self._best_candidate_row(rows, payload.optimize_for)
        candidate_groups = self._build_candidate_groups_from_rows(rows, payload.optimize_for)
        leaderboard = self._build_benchmark_leaderboard([], candidate_groups, payload.optimize_for)
        if selected:
            selected_values = {
                "label": selected.get("label"),
                "change": selected.get("change"),
                "group": selected.get("group_title"),
                "decode_tokens_per_second": selected.get("decode_tokens_per_second"),
                "prefill_tokens_per_second": selected.get("prefill_tokens_per_second"),
                "ttft_ms": selected.get("ttft_ms"),
                "profile": selected.get("profile"),
                "command": selected.get("command"),
            }
            self._update_benchmark_run(
                run_id,
                selected_values=selected_values,
                final_recommended_launch=selected.get("command"),
                candidate_groups=candidate_groups,
                leaderboard=leaderboard,
            )
            self._benchmark_terminal_line(run_id, f"[BEST] {selected.get('label')} <- selected")
        summary_payload = {
            "candidate_count": len(rows),
            "successful_candidates": len(ok_rows),
            "failed_candidates": len(rows) - len(ok_rows),
            "best_decode": best_decode,
            "best_prefill": best_prefill,
            "selected": selected,
            "rows": rows,
            "note": "Each row changed one launch variable from the active profile where possible. Restart-per-config testing is slow by design because llama.cpp only applies these values at server startup.",
        }
        self._add_benchmark_stage(
            run_id,
            BenchmarkStageResult(
                name="autotune comparison table",
                ok=bool(ok_rows),
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                tokens_per_second=float(best_decode.get("decode_tokens_per_second")) if best_decode and best_decode.get("decode_tokens_per_second") else None,
                prompt_tokens_per_second=float(best_prefill.get("prefill_tokens_per_second")) if best_prefill and best_prefill.get("prefill_tokens_per_second") else None,
                error=None if ok_rows else "No auto-tune candidate completed successfully.",
                response_text=json.dumps(summary_payload, ensure_ascii=False, indent=2),
            ),
            end_progress,
        )

    async def _start_model_with_benchmark_profile(self, run_id: str, model: ModelConfig, profile: ProfileConfig) -> None:
        runtime = self._runtime(model.id)
        if self.process_service.is_running(model.id):
            raise ConflictError(f"Model '{model.name}' is already running before candidate start.")

        runtime.status = ModelStatus.STARTING
        runtime.managed = True
        runtime.pid = None
        runtime.last_error = None
        runtime.exit_code = None
        runtime.started_at = datetime.utcnow()
        runtime.stopped_at = None
        runtime.details["launch_profile"] = profile.name
        runtime.details["launch_command"] = " ".join(build_command(model, profile))
        runtime.details["launch_params"] = profile.model_dump_json()
        runtime.details["benchmark_temporary_profile"] = True

        try:
            if model.provider == ProviderType.WINDOWS_LLAMA_CPP:
                self._validate_windows_llama_cpp_launch(model)
            pid, log_path = self.process_service.start(model, profile)
            runtime.pid = pid
            runtime.details["log_path"] = log_path
            self.log_service.append_event(model.id, f"Auto-tune candidate started with pid={pid}: {profile.name}", model.log_path)
        except Exception as exc:  # noqa: BLE001
            runtime.status = ModelStatus.ERROR
            runtime.last_error = str(exc)
            self.log_service.append_event(model.id, f"Auto-tune candidate start failed: {exc}", model.log_path)
            raise

    async def _stop_model_for_autotune_candidate(self, run_id: str, model: ModelConfig, reason: str) -> None:
        runtime = self._runtime(model.id)
        if runtime.status not in {ModelStatus.RUNNING, ModelStatus.STARTING, ModelStatus.WARMING, ModelStatus.UNHEALTHY, ModelStatus.ERROR} and not self.process_service.is_running(model.id):
            return
        try:
            self._benchmark_event(run_id, "autotune", f"Stopping model {reason}.")
            await self.stop_model(model.id)
        except Exception as exc:  # noqa: BLE001
            self._benchmark_event(run_id, "autotune", f"Stop {reason} failed: {exc}", level="warning")
            if self.process_service.is_running(model.id):
                self.process_service.stop(model.id)

    async def _wait_for_autotune_candidate_server(
        self,
        run_id: str,
        model: ModelConfig,
        payload: BenchmarkRunRequest,
        progress_start: float,
        progress_end: float,
    ) -> dict[str, bool]:
        deadline = time.monotonic() + payload.startup_wait_seconds
        last_checks: dict[str, bool] = {}
        last_signature = ""
        progress_span = max(progress_end - progress_start, 0.5)
        while time.monotonic() < deadline:
            self._raise_if_cancelled(run_id)
            checks = await self._benchmark_server_checks(model, payload.timeout_seconds)
            last_checks = checks
            signature = json.dumps(checks, sort_keys=True)
            if signature != last_signature:
                self._benchmark_event(run_id, "autotune wait", f"Readiness checks: {checks}")
                last_signature = signature
            elapsed = max(payload.startup_wait_seconds - (deadline - time.monotonic()), 0)
            progress = progress_start + (elapsed / max(payload.startup_wait_seconds, 1)) * progress_span
            self._update_benchmark_run(
                run_id,
                current_stage="Auto-tune waiting for llama-server",
                progress_percent=min(progress, progress_end),
                summary="Waiting for candidate llama-server HTTP endpoints.",
                server_checks=checks,
            )
            if self._checks_indicate_model_ready(checks):
                return checks
            await asyncio.sleep(3)
        return last_checks

    def _build_autotune_candidates(self, base_profile: ProfileConfig, payload: BenchmarkRunRequest) -> list[dict[str, Any]]:
        workflow_mode, _suite, _optimize_for = self._benchmark_contract(payload)
        legacy_limit = payload.autotune_max_configs if not payload.workflow_mode and not payload.suite else payload.max_tests
        max_configs = max(1, min(legacy_limit, 240))
        if workflow_mode == "exhaustive":
            max_configs = max(legacy_limit, payload.autotune_max_configs, payload.max_tests)
            max_configs = max(1, min(max_configs, 240))

        values_128_to_4096 = [128, 256, 512, 768, 1024, *range(1280, 4097, 256)]
        ctx_values = payload.ctx_values or [4096, 8192, 12288, 16384, 20480, 24576, 32768]
        batch_values = payload.batch_values or values_128_to_4096
        ubatch_values = payload.ubatch_values or values_128_to_4096
        thread_values = payload.threads_values or [4, 6, 8, 10, 12, 14, 16]
        threads_batch_values = payload.threads_batch_values or thread_values
        gpu_layer_values = [999, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0]
        cache_modes = payload.cache_type_modes or ["q4_0/q4_0", "q8_0/q8_0", "f16/f16"]
        cache_pairs: list[tuple[str, str]] = []
        for item in cache_modes:
            if "/" in item:
                cache_k, cache_v = item.split("/", 1)
            else:
                cache_k = cache_v = item
            cache_pairs.append((cache_k.strip(), cache_v.strip()))
        flash_modes = payload.flash_attn_modes or ["off", "on"]
        override_splits: list[tuple[str, str | None]] = [
            ("override none", None),
            ("override all experts CPU", r"\.ffn_.*_exps\.weight=CPU"),
            ("override last 12 layers CPU", r"blk\.(3[6-9]|4[0-8])\.ffn_.*=CPU"),
            ("override last 24 layers CPU", r"blk\.(2[4-9]|[3-4][0-9])\.ffn_.*=CPU"),
            ("override last 36 layers CPU", r"blk\.(1[2-9]|[2-4][0-9])\.ffn_.*=CPU"),
        ]

        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()

        def add(label: str, change: str, group_id: str, group_title: str, **updates: object) -> None:
            if len(candidates) >= max_configs:
                return
            profile = base_profile.model_copy(deep=True)
            profile.id = f"autotune-{len(candidates) + 1:03d}"
            profile.name = f"Auto-tune {label}"
            for key, value in updates.items():
                setattr(profile, key, value)
            if profile.ubatch_size > profile.batch_size:
                profile.ubatch_size = profile.batch_size
            signature = self._autotune_profile_signature(profile)
            if signature in seen:
                return
            seen.add(signature)
            candidates.append({"label": label, "change": change, "group_id": group_id, "group_title": group_title, "profile": profile})

        add("baseline", "no change", "smoke", "smoke baseline")
        for value in ctx_values:
            add(f"ctx {value}", "context_size", "ctx_size", "ctx_size", context_size=value)
        for value in batch_values:
            add(f"batch {value}", "batch_size", "batch", "batch / prompt throughput", batch_size=value)
        for value in ubatch_values:
            if value <= base_profile.batch_size:
                add(f"ubatch {value}", "ubatch_size", "ubatch", "ubatch / VRAM pressure", ubatch_size=value)
        for value in thread_values:
            add(f"threads {value}", "threads", "threads", "CPU threads", threads=value)
        for value in threads_batch_values:
            add(f"threads-batch {value}", "threads_batch", "threads_batch", "batch CPU threads", threads_batch=value)
        for value in gpu_layer_values:
            add(f"ngl {value}", "n_gpu_layers", "gpu_layers", "GPU layer split", n_gpu_layers=value)
        for cache_k, cache_v in cache_pairs:
            add(f"cache {cache_k}/{cache_v}", "cache_type_k/cache_type_v", "kv_cache", "KV cache", cache_type_k=cache_k, cache_type_v=cache_v)
        for mode in flash_modes:
            normalized = mode.lower().strip()
            if normalized in {"true", "on", "1", "yes"}:
                value: bool | None = True
                label = "flash on"
            elif normalized in {"false", "off", "0", "no"}:
                value = False
                label = "flash off"
            else:
                value = None
                label = "flash auto"
            add(label, "flash_attn", "flash_attn", "flash attention", flash_attn=value)
        for value in (1, 2):
            add(f"parallel {value}", "parallel", "parallel", "parallel slots", parallel=value)
        for label, override in override_splits:
            add(label, "override_tensor", "override_tensor", "MoE override tensor", override_tensor=override)
        return candidates

    @staticmethod
    def _autotune_profile_signature(profile: ProfileConfig) -> str:
        payload = profile.model_dump(mode="json")
        payload.pop("id", None)
        payload.pop("name", None)
        return json.dumps(payload, sort_keys=True, ensure_ascii=False)

    @staticmethod
    def _checks_indicate_ready(checks: dict[str, bool]) -> bool:
        return (
            checks.get("chat_endpoint", False)
            or checks.get("v1_models", False)
            or checks.get("slots", False)
            or checks.get("health", False)
            or checks.get("ollama_tags", False)
            or checks.get("root", False)
            or checks.get("tcp", False)
        )

    @staticmethod
    def _checks_indicate_model_ready(checks: dict[str, bool]) -> bool:
        return (
            checks.get("chat_endpoint", False)
            or checks.get("v1_models", False)
            or checks.get("slots", False)
            or checks.get("health", False)
            or checks.get("ollama_tags", False)
        )

    async def _wait_for_benchmark_server(
        self,
        run_id: str,
        model: ModelConfig,
        payload: BenchmarkRunRequest,
    ) -> dict[str, bool]:
        deadline = time.monotonic() + payload.startup_wait_seconds
        last_checks: dict[str, bool] = {}
        last_signature = ""
        while time.monotonic() < deadline:
            self._raise_if_cancelled(run_id)
            checks = await self._benchmark_server_checks(model, payload.timeout_seconds)
            last_checks = checks
            ready = self._checks_indicate_model_ready(checks)
            signature = json.dumps(checks, sort_keys=True)
            if signature != last_signature:
                self._benchmark_event(run_id, "server wait", f"Readiness checks: {checks}")
                last_signature = signature
            elapsed = max(payload.startup_wait_seconds - (deadline - time.monotonic()), 0)
            progress = min(18, 8 + (elapsed / max(payload.startup_wait_seconds, 1)) * 10)
            self._update_benchmark_run(
                run_id,
                current_stage="Waiting for llama-server",
                progress_percent=progress,
                summary="Waiting for llama-server HTTP endpoints to become ready.",
                server_checks=checks,
            )
            if ready:
                return checks
            await asyncio.sleep(3)
        return last_checks

    def _raise_if_cancelled(self, run_id: str) -> None:
        if self._is_benchmark_cancelled(run_id):
            raise asyncio.CancelledError()

    def _finish_benchmark_run(self, run_id: str, model: ModelConfig, payload: BenchmarkRunRequest, stable: bool, summary: str) -> None:
        metrics_after = self.get_system_metrics().model_dump(mode="json")
        workflow_mode, suite, optimize_for = self._benchmark_contract(payload)
        with self._benchmark_lock:
            run = self.benchmark_runs[run_id]
            stages = list(run.stages)
            server_checks = dict(run.server_checks)
            metrics_before = dict(run.metrics_before)
            nvidia_smi = run.nvidia_smi
            terminal_lines = list(run.terminal_lines)
            run_log_lines = list(run.run_log_lines)
            candidate_groups = list(run.candidate_groups)
            selected_values = dict(run.selected_values)
            leaderboard = list(run.leaderboard)
            final_recommended_launch = run.final_recommended_launch
        recommendations = self._build_benchmark_recommendations(model, stages, server_checks, metrics_before, metrics_after)
        score_percent, verdict = self._score_benchmark(stages, stable)
        if not leaderboard:
            leaderboard = self._build_benchmark_leaderboard(stages, candidate_groups, optimize_for)
        if not selected_values and leaderboard:
            selected_values = dict(leaderboard[0])
        profile = model.get_active_profile()
        if not final_recommended_launch:
            if selected_values.get("command"):
                final_recommended_launch = str(selected_values["command"])
            elif profile:
                final_recommended_launch = " ".join(build_command(model, profile))
        summary_cards = self._build_benchmark_summary_cards(stages, metrics_after, stable, score_percent)
        response = BenchmarkRunResponse(
            id=run_id,
            model_id=model.id,
            model_name=model.name,
            mode=payload.mode,
            workflow_mode=workflow_mode,
            suite=suite,
            optimize_for=optimize_for,
            started_at=self.benchmark_runs[run_id].started_at,
            finished_at=datetime.utcnow(),
            stable=stable,
            score_percent=score_percent,
            verdict=verdict,
            summary=summary,
            endpoint=model.endpoint,
            model_file=self._extract_artifact_info(model).file_name,
            quantization=self._extract_artifact_info(model).quantization,
            launch_params=model.get_active_profile().model_dump(mode="json") if model.get_active_profile() else {},
            server_checks=server_checks,
            nvidia_smi=nvidia_smi,
            metrics_before=metrics_before,
            metrics_after=metrics_after,
            stages=stages,
            recommendations=recommendations,
            terminal_lines=terminal_lines,
            run_log_lines=run_log_lines,
            candidate_groups=candidate_groups,
            selected_values=selected_values,
            leaderboard=leaderboard,
            final_recommended_launch=final_recommended_launch,
            summary_cards=summary_cards,
        )
        report_path = self._write_benchmark_report(response)
        self._benchmark_terminal_line(run_id, "[OK  ] report ready")
        self._update_benchmark_run(
            run_id,
            status="completed",
            finished_at=response.finished_at,
            stable=stable,
            score_percent=score_percent,
            verdict=verdict,
            summary=summary,
            current_stage="Report ready",
            progress_percent=100,
            metrics_after=metrics_after,
            recommendations=recommendations,
            report_path=str(report_path),
            terminal_lines=response.terminal_lines + ["[OK  ] report ready"],
            run_log_lines=response.run_log_lines,
            candidate_groups=response.candidate_groups,
            selected_values=response.selected_values,
            leaderboard=response.leaderboard,
            artifacts=response.artifacts,
            final_recommended_launch=response.final_recommended_launch,
            summary_cards=response.summary_cards,
        )
        self.log_service.append_event(model.id, f"Benchmark {run_id} finished: {summary}", model.log_path)

    async def run_benchmark(self, model_id: str, payload: BenchmarkRunRequest) -> BenchmarkRunResponse:
        model = self.config_service.get_model(model_id)
        profile = model.get_active_profile()
        started_at = datetime.utcnow()
        run_id = f"bench-{started_at.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        metrics_before = self.get_system_metrics().model_dump(mode="json")
        nvidia_smi = await self._capture_nvidia_smi()
        server_checks = await self._benchmark_server_checks(model, payload.timeout_seconds)
        server_reachable = self._checks_indicate_model_ready(server_checks)
        stages: list[BenchmarkStageResult] = [
            BenchmarkStageResult(
                name="server checks",
                ok=server_reachable,
                duration_ms=0.0,
                error=None if server_reachable else "No local server check responded successfully.",
            )
        ]
        stages.append(await self._benchmark_wsl_diagnostics_stage(model))
        stages.append(self._benchmark_profile_diagnostics_stage(model, profile))
        if not server_reachable:
            stages.append(
                BenchmarkStageResult(
                    name="chat probes",
                    ok=False,
                    duration_ms=0.0,
                    error="No reachable local endpoint was found, so load tests were skipped.",
                )
            )
            metrics_after = self.get_system_metrics().model_dump(mode="json")
            finished_at = datetime.utcnow()
            artifact = self._extract_artifact_info(model)
            response = BenchmarkRunResponse(
                id=run_id,
                model_id=model.id,
                model_name=model.name,
                mode=payload.mode,
                started_at=started_at,
                finished_at=finished_at,
                stable=False,
                summary="Unstable: local server is not reachable.",
                endpoint=model.endpoint,
                model_file=artifact.file_name,
                quantization=artifact.quantization,
                launch_params=profile.model_dump(mode="json") if profile else {},
                server_checks=server_checks,
                nvidia_smi=nvidia_smi,
                metrics_before=metrics_before,
                metrics_after=metrics_after,
                stages=stages,
            )
            report_path = self._write_benchmark_report(response)
            response.report_path = str(report_path)
            self.log_service.append_event(model.id, f"Benchmark {run_id} finished: {response.summary}", model.log_path)
            return response

        test_plan = [
            ("short coding prompt", "Write a Python hello world program and explain it in one short paragraph.", min(payload.max_tokens, 256)),
        ]
        if payload.mode == "full":
            long_context = "\n".join(
                f"Function {index}: def transform_{index}(value): return value + {index}"
                for index in range(1, 180)
            )
            test_plan.extend(
                [
                    (
                        "long prompt",
                        f"Analyze this code inventory, find repeated patterns, and summarize refactor opportunities:\n\n{long_context}",
                        min(payload.max_tokens, 384),
                    ),
                    (
                        "long generation",
                        "Write a compact implementation plan for a local coding assistant with tests, logging, and failure recovery.",
                        min(max(payload.max_tokens, 512), 1024),
                    ),
                ]
            )

        for name, prompt, max_tokens in test_plan:
            stages.append(await self._benchmark_chat_stage(model, name, prompt, max_tokens, payload.timeout_seconds))

        if payload.mode == "full":
            stages.append(await self._benchmark_code_quality_stage(model, payload.timeout_seconds))
            repeat_ok = True
            repeat_errors: list[str] = []
            repeat_started = time.perf_counter()
            for index in range(payload.repetitions):
                result = await self._benchmark_chat_stage(
                    model,
                    f"repeat request {index + 1}",
                    "Return a single JSON object with keys status and note.",
                    min(payload.max_tokens, 96),
                    payload.timeout_seconds,
                    keep_response=False,
                )
                stages.append(result)
                repeat_ok = repeat_ok and result.ok
                if result.error:
                    repeat_errors.append(result.error)
            stages.append(
                BenchmarkStageResult(
                    name="repeat summary",
                    ok=repeat_ok,
                    duration_ms=round((time.perf_counter() - repeat_started) * 1000, 2),
                    error="; ".join(repeat_errors[:3]) if repeat_errors else None,
                )
            )

            agent_prompts = [
                "Explain what this JavaScript does: const total = items.reduce((sum, item) => sum + item.price, 0);",
                "Find and fix the bug: def divide(a, b): return a / b",
                "Rewrite this function to be clearer: def f(xs): return [x for x in xs if x and x > 3]",
                "Write two pytest tests for a function that slugifies a title.",
                "Suggest a small refactor for a FastAPI route that mixes validation and IO.",
            ]
            for index, prompt in enumerate(agent_prompts, start=1):
                stages.append(
                    await self._benchmark_chat_stage(
                        model,
                        f"agent workflow {index}",
                        prompt,
                        min(payload.max_tokens, 256),
                        payload.timeout_seconds,
                    )
                )

            parallel_started = time.perf_counter()
            parallel_results = await asyncio.gather(
                self._benchmark_chat_stage(
                    model,
                    "parallel request A",
                    "Write one Python function that reverses a string.",
                    min(payload.max_tokens, 128),
                    payload.timeout_seconds,
                    keep_response=False,
                ),
                self._benchmark_chat_stage(
                    model,
                    "parallel request B",
                    "Write one TypeScript function that clamps a number.",
                    min(payload.max_tokens, 128),
                    payload.timeout_seconds,
                    keep_response=False,
                ),
                return_exceptions=True,
            )
            parallel_ok = True
            parallel_errors: list[str] = []
            for item in parallel_results:
                if isinstance(item, BenchmarkStageResult):
                    stages.append(item)
                    parallel_ok = parallel_ok and item.ok
                    if item.error:
                        parallel_errors.append(item.error)
                else:
                    parallel_ok = False
                    parallel_errors.append(str(item))
            stages.append(
                BenchmarkStageResult(
                    name="parallel summary",
                    ok=parallel_ok,
                    duration_ms=round((time.perf_counter() - parallel_started) * 1000, 2),
                    error="; ".join(parallel_errors[:3]) if parallel_errors else None,
                )
            )

        metrics_after = self.get_system_metrics().model_dump(mode="json")
        finished_at = datetime.utcnow()
        stable = all(stage.ok for stage in stages)
        artifact = self._extract_artifact_info(model)
        response = BenchmarkRunResponse(
            id=run_id,
            model_id=model.id,
            model_name=model.name,
            mode=payload.mode,
            started_at=started_at,
            finished_at=finished_at,
            stable=stable,
            summary="Stable: all benchmark stages completed." if stable else "Unstable: at least one benchmark stage failed.",
            endpoint=model.endpoint,
            model_file=artifact.file_name,
            quantization=artifact.quantization,
            launch_params=profile.model_dump(mode="json") if profile else {},
            server_checks=server_checks,
            nvidia_smi=nvidia_smi,
            metrics_before=metrics_before,
            metrics_after=metrics_after,
            stages=stages,
        )
        report_path = self._write_benchmark_report(response)
        response.report_path = str(report_path)
        self.log_service.append_event(model.id, f"Benchmark {run_id} finished: {response.summary}", model.log_path)
        return response

    def handle_process_exits(self, exits: list[ProcessExitEvent]) -> None:
        for event in exits:
            runtime = self._runtime(event.model_id)
            runtime.pid = None
            runtime.managed = True
            runtime.exit_code = event.return_code
            runtime.stopped_at = event.happened_at
            if event.expected_stop:
                runtime.status = ModelStatus.STOPPED
                runtime.last_transition_reason = "Process exited cleanly."
            else:
                runtime.status = ModelStatus.CRASHED
                runtime.crash_count += 1
                runtime.last_error = f"Process exited unexpectedly with code {event.return_code}."
                runtime.last_transition_reason = "Crash detected by supervisor."
            model = self.config_service.get_model(event.model_id)
            self.log_service.append_event(event.model_id, runtime.last_transition_reason or "Process exit", model.log_path)

    async def auto_restart_crashed_models(self) -> None:
        self.sync_runtime_catalog()
        for model in self.config_service.list_models():
            runtime = self._runtime(model.id)
            if runtime.status != ModelStatus.CRASHED or not model.settings.auto_restart:
                continue
            self.log_service.append_event(model.id, "Auto restart after crash is enabled; restarting model.", model.log_path)
            try:
                await self.start_model(model.id)
            except Exception as exc:  # noqa: BLE001
                runtime.status = ModelStatus.ERROR
                runtime.last_error = f"Auto restart failed: {exc}"
                self.log_service.append_event(model.id, runtime.last_error, model.log_path)

    def read_logs(self, model_id: str, limit: int | None = None) -> LogResponse:
        model = self.config_service.get_model(model_id)
        line_limit = limit or model.settings.log_tail_lines
        path, lines = self.log_service.read_tail(model.id, model.log_path, line_limit)
        return LogResponse(model_id=model.id, path=str(path), lines=lines)

    def get_config(self) -> AppConfig:
        return self.config_service.get_config()

    def update_config(self, payload: AppConfig) -> AppConfig:
        updated = self.config_service.replace_config(payload)
        self.sync_runtime_catalog()
        return updated

    def list_profiles(self, model_id: str) -> list[ProfileConfig]:
        return self.config_service.list_profiles(model_id)

    def create_profile(self, model_id: str, payload: ProfileConfig) -> ProfileConfig:
        return self.config_service.create_profile(model_id, payload)

    def update_profile(self, model_id: str, profile_id: str, payload: ProfileConfig) -> ProfileConfig:
        return self.config_service.update_profile(model_id, profile_id, payload)

    def delete_profile(self, model_id: str, profile_id: str) -> None:
        self.config_service.delete_profile(model_id, profile_id)

    def activate_profile(self, model_id: str, profile_id: str) -> ProfileConfig:
        return self.config_service.activate_profile(model_id, profile_id)

    def update_model_settings(self, model_id: str, payload: ModelSettings) -> ModelView:
        model = self.config_service.get_model(model_id)
        model.settings = payload
        self.config_service.update_model(model)
        return self.get_model_view(model_id)

    def rename_model(self, model_id: str, payload: RenameModelRequest) -> ModelView:
        model = self.config_service.get_model(model_id)
        model.name = payload.name.strip()
        self.config_service.update_model(model)
        return self.get_model_view(model_id)

    def clear_logs(self, model_id: str) -> LogResponse:
        model = self.config_service.get_model(model_id)
        self.log_service.clear(model.id, model.log_path)
        return self.read_logs(model_id)

    def delete_model(self, model_id: str, delete_file: bool = False) -> None:
        if self.process_service.is_running(model_id):
            raise BadRequestError("Stop the model before deleting it from Quokka.")
        model = self.config_service.get_model(model_id)
        if delete_file:
            self._delete_model_artifact_file(model)
        self.config_service.delete_model(model_id)
        self.runtime_states.pop(model_id, None)

    def _compose_model_view(self, model: ModelConfig) -> ModelView:
        runtime = self._runtime(model.id)
        log_path = self.log_service.get_log_path(model.id, model.log_path)
        supported_actions = ["logs", "health", "profiles"]
        if model.settings.allow_start_stop:
            supported_actions.extend(["start", "stop", "restart"])

        return ModelView(
            id=model.id,
            name=model.name,
            provider=model.provider,
            modality=model.modality,
            description=model.description,
            endpoint=model.endpoint,
            health_url=model.health_url,
            metadata=model.metadata,
            launch=model.launch,
            profiles=model.profiles,
            active_profile_id=model.active_profile_id,
            active_profile=model.get_active_profile(),
            settings=model.settings,
            log_path=str(log_path),
            runtime=RuntimeStateResponse(
                status=runtime.status,
                pid=runtime.pid,
                managed=runtime.managed,
                started_at=runtime.started_at,
                stopped_at=runtime.stopped_at,
                exit_code=runtime.exit_code,
                last_error=runtime.last_error,
                last_health_check=runtime.last_health_check,
                health_ok=runtime.health_ok,
                health_latency_ms=runtime.health_latency_ms,
                crash_count=runtime.crash_count,
                last_transition_reason=runtime.last_transition_reason,
                details=runtime.details,
                resource_usage=self.metrics_service.get_model_resource_usage(model, runtime.pid),
            ),
            artifact=self._extract_artifact_info(model),
            supported_actions=supported_actions,
        )

    def _runtime(self, model_id: str) -> RuntimeState:
        runtime = self.runtime_states.get(model_id)
        if runtime is None:
            raise NotFoundError(f"Runtime state for model '{model_id}' is unavailable.")
        return runtime

    async def _capture_nvidia_smi(self) -> str | None:
        def run() -> str | None:
            try:
                result = subprocess.run(
                    ["nvidia-smi"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=8,
                    check=False,
                )
            except (FileNotFoundError, subprocess.SubprocessError, OSError):
                return None
            output = result.stdout.strip() or result.stderr.strip()
            return output[:20_000] if output else None

        return await asyncio.to_thread(run)

    async def _benchmark_server_checks(self, model: ModelConfig, timeout_seconds: float) -> dict[str, bool]:
        checks: dict[str, bool] = {}
        timeout = httpx.Timeout(min(timeout_seconds, 20), connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            checks["tcp"] = await asyncio.to_thread(self._tcp_endpoint_check, model.endpoint)
            health_url = model.health_url or urljoin(model.endpoint.rstrip("/") + "/", "health")
            checks["root"] = await self._http_check(client, "GET", model.endpoint.rstrip("/") + "/")
            checks["health"] = await self._http_check(client, "GET", health_url)

            if model.provider == ProviderType.OLLAMA:
                checks["ollama_tags"] = await self._http_check(client, "GET", urljoin(model.endpoint.rstrip("/") + "/", "api/tags"))
                checks["chat_endpoint"] = await self._http_check(
                    client,
                    "POST",
                    urljoin(model.endpoint.rstrip("/") + "/", "api/chat"),
                    {
                        "model": str(model.metadata.get("ollama_model", model.name)),
                        "messages": [{"role": "user", "content": "ping"}],
                        "stream": False,
                        "options": {"num_predict": 1},
                    },
                )
            else:
                checks["slots"] = await self._http_check(client, "GET", urljoin(model.endpoint.rstrip("/") + "/", "slots"))
                checks["v1_models"] = await self._http_check(client, "GET", urljoin(model.endpoint.rstrip("/") + "/", "v1/models"))
                checks["chat_endpoint"] = await self._http_check(
                    client,
                    "POST",
                    urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions"),
                    {
                        "model": str(model.metadata.get("served_model", model.name)),
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 1,
                        "n_predict": 1,
                        "stream": False,
                    },
                )
        return checks

    @staticmethod
    def _tcp_endpoint_check(endpoint: str) -> bool:
        parsed = urlparse(endpoint)
        host = parsed.hostname or "127.0.0.1"
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            with socket.create_connection((host, port), timeout=2):
                return True
        except OSError:
            return False

    async def _http_check(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        json_payload: dict[str, object] | None = None,
    ) -> bool:
        try:
            response = await client.request(method, url, json=json_payload)
            return response.is_success
        except httpx.HTTPError:
            return False

    async def _benchmark_wsl_diagnostics_stage(self, model: ModelConfig) -> BenchmarkStageResult:
        started = time.perf_counter()
        if model.provider != ProviderType.WSL_LLAMA_CPP:
            return BenchmarkStageResult(
                name="wsl diagnostics",
                ok=True,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                response_text="Model is not a WSL llama.cpp entry, so WSL-specific checks were skipped.",
            )

        distro = str(model.metadata.get("wsl_distro", "Ubuntu") or "Ubuntu")
        command = (
            "printf '--- /proc/meminfo ---\\n'; "
            "grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree|Cached|Buffers|Dirty|Writeback' /proc/meminfo 2>/dev/null; "
            "printf '\\n--- vmstat 1 3 ---\\n'; "
            "vmstat 1 3 2>/dev/null || true; "
            "printf '\\n--- .wslconfig ---\\n'; "
            "cat /mnt/c/Users/$USER/.wslconfig 2>/dev/null || cat /mnt/c/Users/kanal/.wslconfig 2>/dev/null || true"
        )

        def run() -> tuple[bool, str]:
            try:
                result = subprocess.run(
                    ["wsl", "-d", distro, "-e", "sh", "-lc", command],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=12,
                    check=False,
                )
            except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
                return False, str(exc)
            output = (result.stdout or result.stderr or "").strip()
            return result.returncode == 0, output[:16_000]

        ok, output = await asyncio.to_thread(run)
        return BenchmarkStageResult(
            name="wsl diagnostics",
            ok=ok,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
            error=None if ok else "Could not capture WSL memory diagnostics.",
            response_text=output or "No WSL diagnostics output.",
        )

    async def _benchmark_environment_stage(self, model: ModelConfig) -> BenchmarkStageResult:
        started = time.perf_counter()
        artifact = self._extract_artifact_info(model)
        if model.provider != ProviderType.WSL_LLAMA_CPP:
            payload = {
                "provider": model.provider.value,
                "endpoint": model.endpoint,
                "model_file": artifact.file_name,
                "note": "Non-WSL model; llama.cpp git/model file diagnostics skipped.",
            }
            return BenchmarkStageResult(
                name="environment baseline",
                ok=True,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                response_text=json.dumps(payload, ensure_ascii=False, indent=2),
            )

        distro = str(model.metadata.get("wsl_distro", "Ubuntu") or "Ubuntu")
        model_path = artifact.path or str(model.metadata.get("model_path", "") or "")
        quoted_model_path = shlex.quote(model_path) if model_path else "''"
        command = (
            "printf '=== date ===\\n'; date -Is; "
            "printf '\\n=== uname ===\\n'; uname -a; "
            "printf '\\n=== lscpu ===\\n'; lscpu 2>/dev/null | head -80 || true; "
            "printf '\\n=== llama.cpp git ===\\n'; cd ~/llm/llama.cpp 2>/dev/null && git rev-parse HEAD && git log -1 --oneline || true; "
            "printf '\\n=== model file ===\\n'; "
            f"ls -lh {quoted_model_path} 2>/dev/null || true; "
            "printf '\\n=== model sha256 head ===\\n'; "
            f"sha256sum {quoted_model_path} 2>/dev/null | head -1 || true; "
            "printf '\\n=== nvidia-smi query ===\\n'; "
            "nvidia-smi --query-gpu=name,driver_version,cuda_version,utilization.gpu,memory.used,memory.free,power.draw,temperature.gpu --format=csv 2>/dev/null || nvidia-smi 2>/dev/null || true"
        )

        def run() -> tuple[bool, str]:
            try:
                result = subprocess.run(
                    ["wsl", "-d", distro, "-e", "sh", "-lc", command],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=25,
                    check=False,
                )
            except (FileNotFoundError, subprocess.SubprocessError, OSError) as exc:
                return False, str(exc)
            output = (result.stdout or result.stderr or "").strip()
            return result.returncode == 0, output[:24_000]

        ok, output = await asyncio.to_thread(run)
        return BenchmarkStageResult(
            name="environment baseline",
            ok=ok,
            duration_ms=round((time.perf_counter() - started) * 1000, 2),
            error=None if ok else "Could not capture llama.cpp / hardware baseline.",
            response_text=output or "No environment output.",
        )

    def _benchmark_profile_diagnostics_stage(self, model: ModelConfig, profile: ProfileConfig | None) -> BenchmarkStageResult:
        profile = profile or model.get_active_profile()
        artifact = self._extract_artifact_info(model)
        payload = {
            "model_file": artifact.file_name,
            "quantization": artifact.quantization,
            "context_size": profile.context_size if profile else None,
            "batch_size": profile.batch_size if profile else None,
            "ubatch_size": profile.ubatch_size if profile else None,
            "n_gpu_layers": profile.n_gpu_layers if profile else None,
            "threads": profile.threads if profile else None,
            "threads_batch": profile.threads_batch if profile else None,
            "cache_type_k": profile.cache_type_k if profile else None,
            "cache_type_v": profile.cache_type_v if profile else None,
            "override_tensor": profile.override_tensor if profile else None,
            "reasoning_format": profile.reasoning_format if profile else None,
            "moe_note": (
                "For MoE offload tuning, compare baseline, all experts on CPU, last 24 layers on CPU, "
                "and last 36 layers on CPU. Decode speed is usually the key signal."
            ),
        }
        return BenchmarkStageResult(
            name="profile and MoE diagnostics",
            ok=True,
            duration_ms=0.0,
            response_text=json.dumps(payload, ensure_ascii=False, indent=2),
        )

    def _benchmark_autotune_manifest_stage(self, model: ModelConfig, profile: ProfileConfig | None) -> BenchmarkStageResult:
        values_128_to_4096 = [128, 256, 512, 768, 1024, *range(1280, 4097, 256)]
        ctx_values = [4096, 8192, 12288, 16384, 20480, 24576, 32768]
        threads_values = [4, 6, 8, 10, 12, 14, 16]
        payload = {
            "purpose": "Detailed auto-tune matrix. Real parameter comparison requires restart-per-config because llama.cpp launch params are not mutable after startup.",
            "active_profile": profile.name if profile else None,
            "model": model.name,
            "one_variable_rule": True,
            "batch_size_values": list(values_128_to_4096),
            "ubatch_size_values": list(values_128_to_4096),
            "ctx_size_values": ctx_values,
            "threads_values": threads_values,
            "threads_batch_values": threads_values,
            "n_gpu_layers_values": [999, 80, 72, 64, 56, 48, 40, 32, 24, 16, 8, 0],
            "cache_type_pairs": ["q4_0/q4_0", "q8_0/q8_0", "f16/f16"],
            "flash_attn_values": ["off", "auto", "on"],
            "parallel_values": [1, 2],
            "moe_override_tensor_splits": [
                {"name": "none", "arg": None},
                {"name": "all_experts_cpu", "arg": r"\.ffn_.*_exps\.weight=CPU"},
                {"name": "last_12_layers_cpu", "arg": r"blk\.(3[6-9]|4[0-8])\.ffn_.*=CPU"},
                {"name": "last_24_layers_cpu", "arg": r"blk\.(2[4-9]|[3-4][0-9])\.ffn_.*=CPU"},
                {"name": "last_36_layers_cpu", "arg": r"blk\.(1[2-9]|[2-4][0-9])\.ffn_.*=CPU"},
            ],
            "record_for_each_run": [
                "TTFT",
                "prefill tokens/sec",
                "decode tokens/sec",
                "VRAM before/during/after",
                "RAM delta",
                "swap state",
                "crash yes/no",
                "generated answer sample",
            ],
            "next_runner": "Quokka should duplicate the active profile, change one variable, restart llama-server, run quick probes, then restore the original profile.",
        }
        return BenchmarkStageResult(
            name="auto-tune matrix",
            ok=True,
            duration_ms=0.0,
            response_text=json.dumps(payload, ensure_ascii=False, indent=2),
        )

    async def _benchmark_code_quality_stage(
        self,
        model: ModelConfig,
        timeout_seconds: float,
    ) -> BenchmarkStageResult:
        prompt = (
            "Return only one Python code block. Write a function add_even_numbers(values) that returns the sum "
            "of even integers in a list. Do not include prose."
        )
        result = await self._benchmark_chat_stage(model, "code quality syntax smoke", prompt, 192, timeout_seconds)
        if not result.ok or not result.response_text:
            return result
        code = self._extract_first_code_block(result.response_text)
        try:
            compile(code, "<quokka-benchmark>", "exec")
        except SyntaxError as exc:
            result.ok = False
            result.error = f"Generated Python has a syntax error: {exc.msg} at line {exc.lineno}."
        return result

    async def _benchmark_code_execution_stage(
        self,
        model: ModelConfig,
        timeout_seconds: float,
    ) -> BenchmarkStageResult:
        result = await self._benchmark_chat_stage(
            model,
            "code execution validator",
            "Write Python code only, no markdown, that prints FizzBuzz from 1 to 15.",
            256,
            timeout_seconds,
        )
        if not result.ok or not result.response_text:
            return result

        code = self._extract_first_code_block(result.response_text)
        started = time.perf_counter()
        temp_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".py", encoding="utf-8", delete=False) as handle:
                handle.write(code)
                temp_path = Path(handle.name)
            run_result = subprocess.run(
                [sys.executable, str(temp_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=10,
                check=False,
            )
            stdout = run_result.stdout.strip()
            stderr = run_result.stderr.strip()
            ok = run_result.returncode == 0 and "FizzBuzz" in stdout and "14" in stdout
            result.ok = ok
            result.duration_ms = round(result.duration_ms + ((time.perf_counter() - started) * 1000), 2)
            result.error = None if ok else f"Generated code did not pass execution check. rc={run_result.returncode}, stderr={stderr[:300]}"
            result.response_text = (
                f"=== CODE ===\n{code[:6000]}\n\n=== STDOUT ===\n{stdout[:4000]}\n\n=== STDERR ===\n{stderr[:2000]}"
            )
        except Exception as exc:  # noqa: BLE001
            result.ok = False
            result.error = f"Code execution validator failed: {exc}"
        finally:
            if temp_path:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
        return result

    def _benchmark_thinking_summary_stage(self, run_id: str) -> BenchmarkStageResult:
        with self._benchmark_lock:
            stages = list(self.benchmark_runs.get(run_id).stages if self.benchmark_runs.get(run_id) else [])
        thinking_total = sum(stage.thinking_tokens_estimate or 0 for stage in stages)
        answer_total = sum(stage.answer_tokens_estimate or 0 for stage in stages)
        total = thinking_total + answer_total
        ratio = round((thinking_total / total) * 100, 2) if total else 0.0
        payload = {
            "thinking_tokens_estimate": thinking_total,
            "answer_tokens_estimate": answer_total,
            "thinking_ratio_percent": ratio,
            "note": "High thinking ratio is normal for reasoning models, but it can make short chat feel slower. Compare reasoning on/off profiles if your llama.cpp build supports it.",
        }
        return BenchmarkStageResult(
            name="thinking summary",
            ok=True,
            duration_ms=0.0,
            thinking_tokens_estimate=thinking_total,
            answer_tokens_estimate=answer_total,
            thinking_ratio_percent=ratio,
            response_text=json.dumps(payload, ensure_ascii=False, indent=2),
        )

    @staticmethod
    def _extract_first_code_block(text: str) -> str:
        match = re.search(r"```(?:python)?\s*(.*?)```", text, flags=re.IGNORECASE | re.DOTALL)
        return (match.group(1) if match else text).strip()

    async def _benchmark_chat_stage(
        self,
        model: ModelConfig,
        name: str,
        prompt: str,
        max_tokens: int,
        timeout_seconds: float,
        keep_response: bool = True,
    ) -> BenchmarkStageResult:
        started = time.perf_counter()
        try:
            if model.provider == ProviderType.OLLAMA:
                raw_response_text, ttft_ms = await self._stream_ollama_benchmark(model, prompt, max_tokens, timeout_seconds)
            else:
                raw_response_text, ttft_ms = await self._stream_openai_benchmark(model, prompt, max_tokens, timeout_seconds)
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            answer_text, thinking_text = self._split_benchmark_reasoning(raw_response_text)
            visible_text = answer_text or raw_response_text
            answer_tokens = self._estimate_tokens(answer_text)
            thinking_tokens = self._estimate_tokens(thinking_text)
            generated_tokens = max(answer_tokens + thinking_tokens, self._estimate_tokens(visible_text))
            prompt_tokens = self._estimate_tokens(prompt)
            seconds = max(duration_ms / 1000, 0.001)
            timing = self._extract_latest_llama_timing(model)
            prompt_tps = round(prompt_tokens / seconds, 2)
            decode_tps = round(generated_tokens / seconds, 2)
            if timing:
                prompt_tokens = int(timing.get("prompt_tokens") or prompt_tokens)
                generated_tokens = max(int(timing.get("eval_tokens") or 0), generated_tokens)
                prompt_tps = float(timing.get("prompt_tps") or prompt_tps)
                decode_tps = float(timing.get("eval_tps") or decode_tps)
            response_text = visible_text
            if thinking_text:
                response_text = f"=== THINKING ===\n{thinking_text}\n\n=== ANSWER ===\n{answer_text or '[no visible answer]'}"
            total_visible = answer_tokens + thinking_tokens
            thinking_ratio = round((thinking_tokens / total_visible) * 100, 2) if total_visible else None
            return BenchmarkStageResult(
                name=name,
                ok=True,
                duration_ms=duration_ms,
                ttft_ms=ttft_ms,
                generated_tokens_estimate=generated_tokens,
                tokens_per_second=round(decode_tps, 2),
                prompt_tokens_estimate=prompt_tokens,
                prompt_tokens_per_second=round(prompt_tps, 2),
                thinking_tokens_estimate=thinking_tokens,
                answer_tokens_estimate=answer_tokens,
                thinking_ratio_percent=thinking_ratio,
                response_text=response_text[:12_000] if keep_response else None,
            )
        except Exception as exc:  # noqa: BLE001
            return BenchmarkStageResult(
                name=name,
                ok=False,
                duration_ms=round((time.perf_counter() - started) * 1000, 2),
                error=str(exc)[:1_000],
            )

    async def _stream_openai_benchmark(
        self,
        model: ModelConfig,
        prompt: str,
        max_tokens: int,
        timeout_seconds: float,
    ) -> tuple[str, float | None]:
        request_payload = {
            "model": str(model.metadata.get("served_model", model.name)),
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.15,
            "top_p": 0.9,
            "max_tokens": max_tokens,
            "stream": True,
        }
        started = time.perf_counter()
        first_token_at: float | None = None
        content: list[str] = []
        thinking: list[str] = []
        timeout = httpx.Timeout(timeout_seconds, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = urljoin(model.endpoint.rstrip("/") + "/", "v1/chat/completions")
            async with client.stream("POST", url, json=request_payload) as response:
                if not response.is_success:
                    body = await response.aread()
                    raise RuntimeError(f"HTTP {response.status_code}: {body[:500].decode('utf-8', errors='replace')}")
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    data = line.removeprefix("data: ").strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    reasoning_piece = (
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or delta.get("thinking")
                        or chunk.get("choices", [{}])[0].get("message", {}).get("reasoning_content")
                    )
                    piece = delta.get("content")
                    if piece is None:
                        piece = chunk.get("choices", [{}])[0].get("message", {}).get("content")
                    if reasoning_piece:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        thinking.append(str(reasoning_piece))
                    if piece:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        content.append(str(piece))
        raw_content = "".join(content)
        raw_thinking = "".join(thinking)
        if raw_thinking and "<think>" not in raw_content.lower():
            raw_content = f"<think>{raw_thinking}</think>\n{raw_content}"
        return raw_content, round((first_token_at - started) * 1000, 2) if first_token_at else None

    async def _stream_ollama_benchmark(
        self,
        model: ModelConfig,
        prompt: str,
        max_tokens: int,
        timeout_seconds: float,
    ) -> tuple[str, float | None]:
        request_payload = {
            "model": str(model.metadata.get("ollama_model", model.name)),
            "messages": [{"role": "user", "content": prompt}],
            "stream": True,
            "options": {"temperature": 0.15, "top_p": 0.9, "num_predict": max_tokens},
        }
        started = time.perf_counter()
        first_token_at: float | None = None
        content: list[str] = []
        thinking: list[str] = []
        timeout = httpx.Timeout(timeout_seconds, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = urljoin(model.endpoint.rstrip("/") + "/", "api/chat")
            async with client.stream("POST", url, json=request_payload) as response:
                if not response.is_success:
                    body = await response.aread()
                    raise RuntimeError(f"HTTP {response.status_code}: {body[:500].decode('utf-8', errors='replace')}")
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    reasoning_piece = chunk.get("thinking") or chunk.get("reasoning_content") or chunk.get("reasoning")
                    piece = chunk.get("message", {}).get("content")
                    if reasoning_piece:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        thinking.append(str(reasoning_piece))
                    if piece:
                        if first_token_at is None:
                            first_token_at = time.perf_counter()
                        content.append(str(piece))
                    if chunk.get("done"):
                        break
        raw_content = "".join(content)
        raw_thinking = "".join(thinking)
        if raw_thinking and "<think>" not in raw_content.lower():
            raw_content = f"<think>{raw_thinking}</think>\n{raw_content}"
        return raw_content, round((first_token_at - started) * 1000, 2) if first_token_at else None

    @staticmethod
    def _strip_benchmark_reasoning(content: str) -> str:
        cleaned, _thinking = ModelService._split_benchmark_reasoning(content)
        return cleaned.strip()

    @staticmethod
    def _split_benchmark_reasoning(content: str) -> tuple[str, str]:
        thinking_parts = re.findall(r"<think>(.*?)</think>", content, flags=re.IGNORECASE | re.DOTALL)
        cleaned = re.sub(r"<think>.*?</think>\s*", "", content, flags=re.IGNORECASE | re.DOTALL)
        lower = cleaned.lower()
        if "</think>" in lower:
            thinking_parts.append(cleaned[: lower.rfind("</think>")])
            cleaned = cleaned[lower.rfind("</think>") + len("</think>") :]
        lower = cleaned.lower().lstrip()
        if lower.startswith("<think>"):
            marker_index = cleaned.lower().find("<think>")
            thinking_parts.append(cleaned[marker_index + len("<think>") :])
            cleaned = ""
        for marker in ("**Final Text**", "**Final Output**", "Final Text:", "Final Output:"):
            index = cleaned.rfind(marker)
            if index >= 0:
                cleaned = cleaned[index + len(marker) :]
                break
        thinking = "\n\n".join(part.strip() for part in thinking_parts if part.strip())
        return cleaned.strip(), thinking.strip()

    def _extract_latest_llama_timing(self, model: ModelConfig) -> dict[str, float] | None:
        _path, lines = self.log_service.read_tail(model.id, model.log_path, 260)
        text = "\n".join(lines)
        prompt_matches = re.findall(
            r"prompt eval time\s*=\s*([\d.]+)\s*ms\s*/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second",
            text,
            flags=re.IGNORECASE,
        )
        eval_matches = re.findall(
            r"\beval time\s*=\s*([\d.]+)\s*ms\s*/\s*(\d+)\s*tokens.*?([\d.]+)\s*tokens per second",
            text,
            flags=re.IGNORECASE,
        )
        if not prompt_matches and not eval_matches:
            return None
        timing: dict[str, float] = {}
        if prompt_matches:
            ms, tokens, tps = prompt_matches[-1]
            timing.update({"prompt_ms": float(ms), "prompt_tokens": float(tokens), "prompt_tps": float(tps)})
        if eval_matches:
            ms, tokens, tps = eval_matches[-1]
            timing.update({"eval_ms": float(ms), "eval_tokens": float(tokens), "eval_tps": float(tps)})
        return timing

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        if not text:
            return 0
        words = len(re.findall(r"\S+", text))
        return max(1, int(words * 1.35))

    @staticmethod
    def _score_benchmark(stages: list[BenchmarkStageResult], stable: bool) -> tuple[float, str]:
        if not stages:
            return 0.0, "No result"
        ok_count = sum(1 for stage in stages if stage.ok)
        score = round((ok_count / len(stages)) * 100, 1)
        decode_speeds = [stage.tokens_per_second for stage in stages if stage.tokens_per_second is not None]
        best_decode = max(decode_speeds) if decode_speeds else 0.0
        if not stable or score < 70:
            verdict = "Needs repair"
        elif best_decode >= 25 and score >= 95:
            verdict = "Excellent"
        elif best_decode >= 10 and score >= 90:
            verdict = "Good"
        else:
            verdict = "Stable but slow"
        return score, verdict

    def _write_benchmark_report(self, response: BenchmarkRunResponse) -> Path:
        reports_dir = self.log_service.logs_dir / "benchmarks"
        reports_dir.mkdir(parents=True, exist_ok=True)
        raw_dir = reports_dir / response.id / "raw_responses"
        log_dir = reports_dir / response.id / "logs"
        raw_dir.mkdir(parents=True, exist_ok=True)
        log_dir.mkdir(parents=True, exist_ok=True)
        path = reports_dir / f"{response.id}.json"
        csv_path = reports_dir / f"{response.id}.csv"
        for index, stage in enumerate(response.stages, start=1):
            if not stage.response_text:
                continue
            safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", stage.name).strip("_") or "stage"
            raw_path = raw_dir / f"{index:02d}-{safe_name[:80]}.txt"
            raw_path.write_text(stage.response_text, encoding="utf-8")
        with csv_path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(
                [
                    "stage",
                    "ok",
                    "duration_ms",
                    "ttft_ms",
                    "prefill_tokens_per_second",
                    "decode_tokens_per_second",
                    "tokens_estimate",
                    "thinking_tokens",
                    "answer_tokens",
                    "error",
                ]
            )
            for stage in response.stages:
                writer.writerow(
                    [
                        stage.name,
                        stage.ok,
                        stage.duration_ms,
                        stage.ttft_ms,
                        stage.prompt_tokens_per_second,
                        stage.tokens_per_second,
                        stage.generated_tokens_estimate,
                        stage.thinking_tokens_estimate,
                        stage.answer_tokens_estimate,
                        stage.error,
                    ]
                )
        response.report_path = str(path)
        response.artifacts.update(
            {
                "results_json": str(path),
                "results_csv": str(csv_path),
                "logs": str(log_dir),
                "raw_responses": str(raw_dir),
                "final_recommended_launch": response.final_recommended_launch,
            }
        )
        with path.open("w", encoding="utf-8") as handle:
            json.dump(response.model_dump(mode="json"), handle, ensure_ascii=False, indent=2)
        return path

    def _build_benchmark_recommendations(
        self,
        model: ModelConfig,
        stages: list[BenchmarkStageResult],
        server_checks: dict[str, bool],
        metrics_before: dict[str, Any],
        metrics_after: dict[str, Any],
    ) -> list[BenchmarkRecommendation]:
        recommendations: list[BenchmarkRecommendation] = []
        profile = model.get_active_profile()
        log_text = "\n".join(self.log_service.read_tail(model.id, model.log_path, 240)[1]).lower()

        if not any(server_checks.get(key, False) for key in ("health", "slots", "v1_models", "chat_endpoint")):
            recommendations.append(
                BenchmarkRecommendation(
                    id="startup-readiness",
                    title="Make startup observable and slower to fail",
                    category="Startup",
                    severity="warning",
                    summary="The benchmark could not reach a ready llama-server HTTP endpoint.",
                    rationale="Large GGUF/MoE models can spend many minutes loading tensors before /health or /slots respond.",
                    changes=[
                        "Increase startup_grace_seconds to 600-1200 for this model.",
                        "Use the Logs tab until you see 'server is listening' and 'all slots are idle'.",
                        "Run the benchmark again after the endpoint responds to /health.",
                    ],
                    expected_impact="Avoids false dead-endpoint results while the model is still loading.",
                    confidence="high",
                )
            )

        if "--parallel" in log_text and "expected value" in log_text:
            recommendations.append(
                BenchmarkRecommendation(
                    id="parallel-missing-value",
                    title="Fix --parallel value",
                    category="Launch args",
                    severity="danger",
                    summary="llama.cpp reported that --parallel is missing a value.",
                    rationale="A value flag without its value makes llama-server exit before opening the API.",
                    changes=["Set parallel to 1 in the profile, or remove --parallel from Extra Args."],
                    expected_impact="Allows the server to start instead of crashing during argument parsing.",
                    confidence="high",
                )
            )

        if "--flash-attn" in log_text and "unknown value" in log_text:
            recommendations.append(
                BenchmarkRecommendation(
                    id="flash-attn-value",
                    title="Use explicit flash attention value",
                    category="Launch args",
                    severity="danger",
                    summary="llama.cpp rejected the --flash-attn value.",
                    rationale="Your build expects --flash-attn on/off/auto. If the value is swallowed by the next flag, startup fails.",
                    changes=["Set Flash attention checkbox on, or use auto.", "Remove duplicate --flash-attn from Extra Args."],
                    expected_impact="Prevents llama-server from exiting before model load.",
                    confidence="high",
                )
            )

        if "override-tensor" in log_text and "unknown buffer type" in log_text:
            recommendations.append(
                BenchmarkRecommendation(
                    id="override-tensor-buffer",
                    title="Fix override-tensor buffer name",
                    category="MoE offload",
                    severity="danger",
                    summary="llama.cpp rejected the override-tensor buffer type.",
                    rationale="The log lists available buffer types. This machine exposes CPU and CUDA0, so the pattern must end with one of those names.",
                    changes=[
                        r'Use --override-tensor "\.ffn_.*_exps\.weight=CPU" for expert CPU offload.',
                        "Do not include extra nested quotes inside the profile field unless your shell requires them.",
                    ],
                    expected_impact="Lets MoE expert offload start cleanly for RAM/GPU split testing.",
                    confidence="high",
                )
            )

        if "tensor overrides to cpu are used with mmap enabled" in log_text:
            recommendations.append(
                BenchmarkRecommendation(
                    id="override-no-mmap",
                    title="Pair MoE tensor override with --no-mmap",
                    category="MoE offload",
                    severity="warning",
                    summary="llama.cpp warns that tensor overrides with mmap can perform poorly.",
                    rationale="When expert tensors are moved to CPU/RAM, mmap can add avoidable paging behavior.",
                    changes=["Enable the no-mmap checkbox in the active profile."],
                    expected_impact="Usually improves stability and consistency for CPU expert offload.",
                    confidence="medium",
                )
            )

        decode_speeds = [stage.tokens_per_second for stage in stages if stage.tokens_per_second is not None and stage.generated_tokens_estimate]
        if decode_speeds and max(decode_speeds) < 10:
            recommendations.append(
                BenchmarkRecommendation(
                    id="decode-bottleneck",
                    title="Decode speed looks bandwidth-bound",
                    category="Performance",
                    severity="warning",
                    summary=f"Best observed generation speed is {max(decode_speeds):.2f} tokens/s.",
                    rationale="For MoE models with expert offload, decode is often limited by RAM/PCIe movement rather than GPU compute.",
                    changes=[
                        "Run comparison profiles with threads 8, 12, and 16.",
                        "Compare no override-tensor vs all experts CPU vs last 24/36 layers CPU.",
                        "Keep batch/ubatch stable while changing one variable at a time.",
                    ],
                    expected_impact="Finds the fastest split between VRAM pressure and decode speed.",
                    confidence="medium",
                )
            )

        after_vram = metrics_after.get("gpu_memory_used_mb")
        total_vram = metrics_after.get("gpu_memory_total_mb")
        if isinstance(after_vram, (int, float)) and isinstance(total_vram, (int, float)) and total_vram > 0 and after_vram / total_vram > 0.9:
            recommendations.append(
                BenchmarkRecommendation(
                    id="vram-pressure",
                    title="VRAM pressure is high",
                    category="Memory",
                    severity="warning",
                    summary=f"VRAM after test is about {(after_vram / total_vram) * 100:.1f}% full.",
                    rationale="High VRAM pressure can cause fit failures, slow warmup, or sudden crashes when context grows.",
                    changes=[
                        "Reduce context size for interactive chat.",
                        "Use q4_0 KV cache for K/V on speed profiles.",
                        "Keep a separate quality profile for larger context.",
                    ],
                    expected_impact="Improves stability for normal chat and agent workflows.",
                    confidence="medium",
                )
            )

        if profile and profile.context_size >= 32768:
            recommendations.append(
                BenchmarkRecommendation(
                    id="profile-split",
                    title="Split fast and long-context profiles",
                    category="Profiles",
                    severity="info",
                    summary="This profile uses a large context window.",
                    rationale="A large context is useful, but everyday chat feels better with a smaller fast profile.",
                    changes=[
                        "Create a fast profile around 8192-16384 context.",
                        "Keep this profile as long-context for large file analysis.",
                    ],
                    expected_impact="Makes model switching feel snappier without losing the long-context option.",
                    confidence="medium",
                )
            )

        if not recommendations:
            recommendations.append(
                BenchmarkRecommendation(
                    id="baseline-ok",
                    title="Keep this as a baseline profile",
                    category="Baseline",
                    severity="info",
                    summary="No obvious launch or stability issue was detected from this run.",
                    rationale="The next useful step is comparison testing with one parameter changed at a time.",
                    changes=["Duplicate the active profile before experimenting.", "Run a full benchmark after each meaningful change."],
                    expected_impact="Creates a clean reference point for future tuning.",
                    confidence="medium",
                )
            )

        return recommendations[:8]

    def _delete_model_artifact_file(self, model: ModelConfig) -> None:
        artifact = self._extract_artifact_info(model)
        profile = model.get_active_profile()
        model_path = artifact.path
        if not model_path and profile:
            model_path = profile.model_path
        model_path = model_path or str(model.metadata.get("model_path", "") or "")
        if not model_path:
            raise BadRequestError("Quokka does not know which GGUF file belongs to this model.")
        if not model_path.lower().endswith(".gguf"):
            raise BadRequestError("Only GGUF model files can be deleted from disk.")
        if model.provider != ProviderType.WSL_LLAMA_CPP:
            raise BadRequestError("Disk deletion is currently supported only for WSL llama.cpp models.")

        distro = str(model.metadata.get("wsl_distro", "Ubuntu") or "Ubuntu")
        quoted_path = shlex.quote(model_path)
        command = (
            f"path={quoted_path}; "
            "case \"$path\" in ~/*) path=\"$HOME/${path#~/}\";; esac; "
            "case \"$path\" in "
            "*/llm/models/*.gguf|/home/*/llm/models/*.gguf|/mnt/*/llm/models/*.gguf) "
            "rm -f -- \"$path\" ;; "
            "*) echo 'Refusing to delete outside ~/llm/models'; exit 2 ;; "
            "esac"
        )
        result = subprocess.run(
            ["wsl", "-d", distro, "-e", "sh", "-lc", command],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "Unknown WSL delete error").strip()
            raise BadRequestError(f"Could not delete model file: {detail}")

    async def _run_one_shot_command(self, command: list[str]) -> None:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        if process.returncode != 0:
            error_text = (stderr or stdout).decode("utf-8", errors="replace").strip()
            raise RuntimeError(error_text or f"Command exited with code {process.returncode}")

    async def _warm_ollama_model(self, model: ModelConfig) -> None:
        target_name = str(model.metadata.get("ollama_model", model.name))
        keep_alive = model.settings.keep_alive or "15m"
        async with httpx.AsyncClient(timeout=model.settings.request_timeout_seconds) as client:
            response = await client.post(
                model.endpoint.rstrip("/") + "/api/generate",
                json={"model": target_name, "prompt": " ", "stream": False, "keep_alive": keep_alive},
            )
        if not response.is_success:
            raise RuntimeError(f"Ollama warm-up failed with HTTP {response.status_code}")
        self.log_service.append_event(model.id, f"Ollama warm-up requested for {target_name}.", model.log_path)

    async def _stop_ollama_model(self, model: ModelConfig) -> None:
        target_name = str(model.metadata.get("ollama_model", model.name))
        async with httpx.AsyncClient(timeout=model.settings.request_timeout_seconds) as client:
            response = await client.post(
                model.endpoint.rstrip("/") + "/api/generate",
                json={"model": target_name, "prompt": " ", "stream": False, "keep_alive": 0},
            )
        if not response.is_success:
            raise RuntimeError(f"Ollama unload failed with HTTP {response.status_code}")
        self.log_service.append_event(model.id, f"Ollama unload requested for {target_name}.", model.log_path)

    def _validate_windows_llama_cpp_launch(self, model: ModelConfig) -> None:
        profile = model.get_active_profile()
        model_path = str((profile.model_path if profile and profile.model_path else model.metadata.get("model_path", "")) or "")
        if not model_path:
            raise RuntimeError("Windows llama.cpp model has no GGUF path configured.")

        model_file = Path(os.path.expandvars(model_path)).expanduser()
        if not model_file.exists():
            raise RuntimeError(
                f"GGUF file was not found at '{model_path}'. If it is on another drive, paste the Windows path like D:\\Models\\model.gguf."
            )

        llama_server_path = str(model.metadata.get("llama_server_path", "") or "llama-server.exe")
        expanded = os.path.expandvars(llama_server_path).strip().strip("\"'")
        looks_like_path = "\\" in expanded or "/" in expanded or re.match(r"^[A-Za-z]:", expanded)
        if looks_like_path:
            if not Path(expanded).expanduser().exists():
                raise RuntimeError(
                    f"llama-server.exe was not found at '{llama_server_path}'. Set the correct path in Add Model or LLAMA_SERVER_PATH."
                )
            return

        if shutil.which(expanded) is None:
            raise RuntimeError(
                "llama-server.exe was not found on PATH. Install a Windows llama.cpp build, add it to PATH, "
                "or set the llama-server.exe field when adding the model."
            )

    def _configured_model_paths(self) -> set[str]:
        paths: set[str] = set()
        for model in self.config_service.list_models():
            model_path = model.metadata.get("model_path")
            if model_path:
                model_path_text = str(model_path)
                paths.add(model_path_text.lower())
                paths.add(self._file_name_from_path(model_path_text).lower())
            for profile in model.profiles:
                if profile.model_path:
                    paths.add(profile.model_path.lower())
                    paths.add(self._file_name_from_path(profile.model_path).lower())
        return paths

    def _used_ports(self) -> set[int]:
        ports: set[int] = set()
        for model in self.config_service.list_models():
            parsed = urlparse(model.endpoint)
            if parsed.port:
                ports.add(parsed.port)
            metadata_port = model.metadata.get("port")
            if metadata_port is not None:
                try:
                    ports.add(int(metadata_port))
                except (TypeError, ValueError):
                    continue
        return ports

    def _models_download_dir(self) -> Path:
        settings_dir = self.config_service._config_path.parent.parent if hasattr(self.config_service, "_config_path") else Path.cwd()
        data_dir = settings_dir / "data" / "models"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir

    @staticmethod
    def _resolve_windows_executable(value: str) -> str | None:
        expanded = os.path.expandvars(value or "").strip().strip("\"'")
        if not expanded:
            return None
        looks_like_path = "\\" in expanded or "/" in expanded or re.match(r"^[A-Za-z]:", expanded)
        if looks_like_path:
            path_value = Path(expanded).expanduser()
            return str(path_value) if path_value.exists() else None
        found = shutil.which(expanded)
        return found

    def _discover_windows_llama_server_candidates(self) -> list[str]:
        candidates: list[str] = []
        seen: set[str] = set()

        def add(value: str | Path | None) -> None:
            if not value:
                return
            text = str(value).strip().strip("\"'")
            resolved = self._resolve_windows_executable(text) or text
            try:
                path_value = Path(resolved).expanduser()
                if path_value.exists():
                    key = str(path_value.resolve()).lower()
                    if key not in seen:
                        seen.add(key)
                        candidates.append(str(path_value))
            except OSError:
                return

        add(os.environ.get("LLAMA_SERVER_PATH"))
        add(shutil.which("llama-server.exe"))
        add(shutil.which("llama-server"))

        home = Path.home()
        common = [
            Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "llama.cpp" / "llama-server.exe",
            get_settings().data_dir / "runtimes" / "llama.cpp",
            home / "llm" / "llama.cpp" / "build" / "bin" / "Release" / "llama-server.exe",
            home / "llm" / "llama.cpp" / "build" / "bin" / "llama-server.exe",
            home / "llama.cpp" / "build" / "bin" / "Release" / "llama-server.exe",
            home / "llama.cpp" / "build" / "bin" / "llama-server.exe",
        ]
        for drive in "CDEFG":
            common.extend(
                [
                    Path(f"{drive}:\\llama.cpp\\build\\bin\\Release\\llama-server.exe"),
                    Path(f"{drive}:\\llama.cpp\\build\\bin\\llama-server.exe"),
                    Path(f"{drive}:\\llama\\llama-server.exe"),
                ]
            )
        for candidate in common:
            if candidate.is_dir():
                try:
                    for executable in candidate.rglob("llama-server.exe"):
                        add(executable)
                except OSError:
                    continue
            else:
                add(candidate)
        return candidates

    def _discover_wsl_models(self, distro: str, limit: int) -> list[DiscoveredModelArtifact]:
        roots = "~/llm/models /home/$USER/llm/models /mnt/c/llm/models"
        command = (
            f"for d in {roots}; do "
            "[ -d \"$d\" ] && find \"$d\" -maxdepth 5 -type f -iname '*.gguf' -printf '%p\\t%s\\n'; "
            f"done | head -n {limit}"
        )
        try:
            result = subprocess.run(
                ["wsl", "-d", distro, "-e", "sh", "-lc", command],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=12,
                check=False,
            )
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            return []

        if result.returncode != 0 and not result.stdout:
            return []

        artifacts: list[DiscoveredModelArtifact] = []
        for line in result.stdout.splitlines():
            path, _, size_raw = line.partition("\t")
            if not path.lower().endswith(".gguf"):
                continue
            artifacts.append(self._artifact_from_path("wsl", path, path, int(size_raw) if size_raw.isdigit() else None))
        return artifacts

    def _discover_windows_models(self, limit: int, query: str | None = None) -> list[DiscoveredModelArtifact]:
        roots = self._windows_model_roots(query)
        artifacts: list[DiscoveredModelArtifact] = []
        seen: set[str] = set()

        for root in roots:
            if not root.exists():
                continue
            try:
                if root.is_file():
                    candidates = [root] if root.suffix.lower() == ".gguf" else []
                else:
                    candidates = root.rglob("*.gguf")
                for path in candidates:
                    if not path.is_file():
                        continue
                    resolved = str(path.resolve())
                    key = resolved.lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    artifacts.append(self._artifact_from_path("windows", resolved, resolved, path.stat().st_size))
                    if len(artifacts) >= limit:
                        return artifacts
            except OSError:
                continue
        return artifacts

    def _windows_model_roots(self, query: str | None = None) -> list[Path]:
        roots: list[Path] = []
        query_text = (query or "").strip().strip("\"'")
        if query_text:
            try:
                query_path = Path(os.path.expandvars(query_text)).expanduser()
                if query_path.exists():
                    roots.append(query_path)
            except OSError:
                pass

        env_roots = os.environ.get("QUOKKA_MODEL_ROOTS", "")
        for raw_root in env_roots.split(";"):
            root = raw_root.strip().strip("\"'")
            if root:
                roots.append(Path(os.path.expandvars(root)).expanduser())

        roots.extend(
            [
            Path.home() / "llm" / "models",
            Path.home() / "models",
            Path.home() / "Documents" / "models",
            Path.home() / "Downloads",
            ]
        )

        if os.name == "nt":
            for letter in "DEFGHIJKLMNOPQRSTUVWXYZC":
                drive_root = Path(f"{letter}:/")
                if not drive_root.exists():
                    continue
                roots.extend(
                    [
                        drive_root / "llm" / "models",
                        drive_root / "models",
                        drive_root / "Models",
                        drive_root / "AI" / "models",
                        drive_root / "LLM" / "models",
                        drive_root / "Downloads",
                    ]
                )

        deduped: list[Path] = []
        seen: set[str] = set()
        for root in roots:
            key = str(root).lower()
            if key in seen:
                continue
            seen.add(key)
            deduped.append(root)
        return deduped

    def _artifact_from_path(
        self,
        source: str,
        path: str,
        launch_path: str,
        size_bytes: int | None,
    ) -> DiscoveredModelArtifact:
        file_name = self._file_name_from_path(path)
        family = self._family_from_filename(file_name)
        quantization = self._quantization_from_filename(file_name)
        size_label = self._size_from_filename(file_name)
        suggested_name = " ".join(item for item in [family, quantization] if item) or file_name.removesuffix(".gguf")
        return DiscoveredModelArtifact(
            provider=ProviderType.WSL_LLAMA_CPP if source == "wsl" else ProviderType.WINDOWS_LLAMA_CPP,
            source=source,
            path=path,
            launch_path=launch_path,
            file_name=file_name,
            family=family,
            size_label=size_label,
            quantization=quantization,
            size_bytes=size_bytes,
            suggested_id=self._unique_model_id(self._slugify(suggested_name), reserve=False),
            suggested_name=suggested_name,
        )

    @staticmethod
    def _windows_path_to_wsl(path: Path) -> str:
        resolved = path.resolve()
        drive = resolved.drive.rstrip(":").lower()
        if not drive:
            return resolved.as_posix()
        rest = "/".join(resolved.parts[1:])
        return f"/mnt/{drive}/{rest}"

    @staticmethod
    def _windows_path_string_to_wsl(path: str) -> str:
        raw = path.strip().strip("\"'")
        match = re.match(r"^([a-zA-Z]):[\\/](.*)$", raw)
        if not match:
            return raw.replace("\\", "/")
        drive = match.group(1).lower()
        rest = match.group(2).replace("\\", "/").lstrip("/")
        return f"/mnt/{drive}/{rest}"

    @staticmethod
    def _is_wsl_mnt_path(path: str) -> bool:
        return bool(re.match(r"^/mnt/[a-zA-Z]/", path.strip()))

    @staticmethod
    def _wsl_path_string_to_windows(path: str) -> str:
        raw = path.strip().strip("\"'")
        match = re.match(r"^/mnt/([a-zA-Z])/(.*)$", raw)
        if not match:
            return raw
        drive = match.group(1).upper()
        rest = match.group(2).replace("/", "\\")
        return f"{drive}:\\{rest}"

    @staticmethod
    def _file_name_from_path(path: str) -> str:
        return PureWindowsPath(path).name if "\\" in path or re.match(r"^[A-Za-z]:", path) else PurePosixPath(path).name

    def _detect_windows_llama_server_path(self) -> str:
        env_path = os.environ.get("LLAMA_SERVER_PATH", "").strip().strip("\"'")
        if env_path:
            return env_path

        for executable in ("llama-server.exe", "llama-server"):
            found = shutil.which(executable)
            if found:
                return found

        candidates = self._discover_windows_llama_server_candidates()
        if candidates:
            return candidates[0]
        return "llama-server.exe"

    def _extract_artifact_info(self, model: ModelConfig) -> ModelArtifactInfo:
        if model.provider == ProviderType.OLLAMA:
            target_name = str(model.metadata.get("ollama_model", model.name))
            return ModelArtifactInfo(
                file_name=target_name,
                family=str(model.metadata.get("family", "")) or None,
                quantization=None,
                format="ollama",
                source="metadata",
            )

        profile = model.get_active_profile()
        command = " ".join(build_command(model, profile))
        path = self._extract_model_path(command) or str(model.metadata.get("model_path", "") or "")
        if not path:
            return ModelArtifactInfo(
                family=str(model.metadata.get("family", "")) or None,
                quantization=str(model.metadata.get("quantization", "") or "") or None,
                source="unknown",
            )

        file_name = self._file_name_from_path(path)
        return ModelArtifactInfo(
            file_name=file_name,
            path=path,
            family=str(model.metadata.get("family", "")) or self._family_from_filename(file_name),
            quantization=self._quantization_from_filename(file_name),
            format="gguf" if file_name.lower().endswith(".gguf") else None,
            source="launch_command",
        )

    @staticmethod
    def _extract_model_path(command: str) -> str | None:
        match = re.search(r"(?:^|\s)-m\s+(?:\"([^\"]+\.gguf)\"|'([^']+\.gguf)'|([^\s]+\.gguf))", command)
        if match:
            return next(group for group in match.groups() if group).strip("\"'")
        return None

    @staticmethod
    def _quantization_from_filename(file_name: str) -> str | None:
        stem = file_name.removesuffix(".gguf").removesuffix(".GGUF")
        matches = re.findall(r"(?:UD-)?((?:I?Q\d(?:_[A-Z0-9]+)+|F\d{2}|BF16|FP16))", stem.upper())
        return matches[-1] if matches else None

    @staticmethod
    def _family_from_filename(file_name: str) -> str | None:
        stem = file_name.rsplit(".", 1)[0]
        cleaned = re.sub(r"[-_](?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)+|F\d{2}|BF16|FP16).*$", "", stem, flags=re.IGNORECASE)
        return cleaned.replace("_", " ") or None

    @staticmethod
    def _size_from_filename(file_name: str) -> str | None:
        stem = file_name.rsplit(".", 1)[0]
        match = re.search(r"(\d+(?:\.\d+)?B(?:[-_ ]?A\d+B?)?)", stem, flags=re.IGNORECASE)
        return match.group(1).replace("_", " ") if match else None

    def _slugify(self, value: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
        return slug or "local-model"

    def _unique_model_id(self, base: str, reserve: bool = True) -> str:
        existing = {model.id for model in self.config_service.list_models()}
        if not reserve and base not in existing:
            return base
        candidate = base
        suffix = 2
        while candidate in existing:
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate
