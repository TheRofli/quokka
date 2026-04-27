from __future__ import annotations

import asyncio
import logging

from app.services.model_service import ModelService

logger = logging.getLogger(__name__)


class RuntimeSupervisor:
    def __init__(self, model_service: ModelService, interval_seconds: int = 5) -> None:
        self._model_service = model_service
        self._interval_seconds = interval_seconds
        self._stop_event = asyncio.Event()

    async def run(self) -> None:
        logger.info("Runtime supervisor started with %ss interval.", self._interval_seconds)
        while not self._stop_event.is_set():
            try:
                self._model_service.sync_runtime_catalog()
                exits = self._model_service.process_service.collect_exits()
                if exits:
                    self._model_service.handle_process_exits(exits)
                    await self._model_service.auto_restart_crashed_models()
                await self._model_service.check_all_health()
            except Exception:  # noqa: BLE001
                logger.exception("Runtime supervisor tick failed")

            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval_seconds)
            except asyncio.TimeoutError:
                continue
        logger.info("Runtime supervisor stopped.")

    async def stop(self) -> None:
        self._stop_event.set()
