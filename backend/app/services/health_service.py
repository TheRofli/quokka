from __future__ import annotations

from datetime import datetime
from time import perf_counter
from urllib.parse import urljoin

import httpx

from app.schemas.api import HealthCheckResponse
from app.schemas.config import ModelConfig


class HealthService:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient()

    async def close(self) -> None:
        await self._client.aclose()

    async def check_model(self, model: ModelConfig) -> HealthCheckResponse:
        timeout = float(model.settings.request_timeout_seconds)
        started = perf_counter()

        targets = self._build_targets(model)
        last_error = "No health targets configured."
        last_status_code: int | None = None

        for url in targets:
            try:
                response = await self._client.get(url, timeout=timeout)
                latency_ms = (perf_counter() - started) * 1000
                if response.is_success:
                    detail = "Healthy"
                    ok = True
                    if model.provider.value == "ollama":
                        detail = await self._validate_ollama_model(response, model)
                        ok = detail == "Healthy"
                    return HealthCheckResponse(
                        model_id=model.id,
                        ok=ok,
                        status_code=response.status_code,
                        detail=detail,
                        latency_ms=round(latency_ms, 2),
                        checked_at=datetime.utcnow(),
                    )

                last_error = f"{url} returned HTTP {response.status_code}"
                last_status_code = response.status_code
            except httpx.HTTPError as exc:
                last_error = str(exc)

        latency_ms = (perf_counter() - started) * 1000
        return HealthCheckResponse(
            model_id=model.id,
            ok=False,
            status_code=last_status_code,
            detail=last_error,
            latency_ms=round(latency_ms, 2),
            checked_at=datetime.utcnow(),
        )

    async def _validate_ollama_model(self, response: httpx.Response, model: ModelConfig) -> str:
        target_name = str(model.metadata.get("ollama_model", model.name))
        try:
            payload = response.json()
        except ValueError:
            return "Healthy"

        loaded_models = payload.get("models", [])
        target_base = target_name.split(":")[0]
        if any(str(item.get("name", "")).split(":")[0] == target_base for item in loaded_models):
            return "Healthy"
        return f"Ollama endpoint is up but model '{target_name}' is not loaded."

    def _build_targets(self, model: ModelConfig) -> list[str]:
        if model.health_url:
            return [model.health_url]

        base = model.endpoint.rstrip("/") + "/"
        if model.provider.value == "ollama":
            return [urljoin(base, "api/ps")]
        return [urljoin(base, "health"), urljoin(base, "v1/models")]
