from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import httpx

from app.core.errors import BadRequestError, ConflictError, NotFoundError
from app.domain.enums import ModelStatus, ProviderType
from app.domain.runtime import RuntimeState
from app.schemas.api import HealthCheckResponse, LogResponse, ModelView, RuntimeStateResponse
from app.schemas.config import AppConfig, ModelConfig, ProfileConfig
from app.services.config_service import ConfigService
from app.services.health_service import HealthService
from app.services.log_service import LogService
from app.services.metrics_service import MetricsService
from app.services.process_service import ProcessExitEvent, ProcessService

logger = logging.getLogger(__name__)


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

    def list_models(self) -> list[ModelView]:
        self.sync_runtime_catalog()
        return [self._compose_model_view(model) for model in self.config_service.list_models()]

    def get_model_view(self, model_id: str) -> ModelView:
        self.sync_runtime_catalog()
        model = self.config_service.get_model(model_id)
        return self._compose_model_view(model)

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
                pid, log_path = self.process_service.start(model, profile)
                runtime.pid = pid
                self.log_service.append_event(model.id, f"Process started with pid={pid}", model.log_path)
                runtime.details["log_path"] = log_path
            elif model.launch.command:
                runtime.status = ModelStatus.STARTING
                runtime.managed = False
                await self._run_one_shot_command(model.launch.command)
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
            ),
            supported_actions=supported_actions,
        )

    def _runtime(self, model_id: str) -> RuntimeState:
        runtime = self.runtime_states.get(model_id)
        if runtime is None:
            raise NotFoundError(f"Runtime state for model '{model_id}' is unavailable.")
        return runtime

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
