from __future__ import annotations

import os
import signal
import subprocess
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TextIO

import psutil

from app.schemas.config import ModelConfig, ProfileConfig
from app.services.log_service import LogService
from app.utils.command_builder import build_command, build_environment, resolve_working_dir


@dataclass
class ProcessRecord:
    model_id: str
    process: subprocess.Popen[str]
    log_handle: TextIO
    log_path: Path
    expected_stop: bool
    started_at: datetime


@dataclass
class ProcessExitEvent:
    model_id: str
    return_code: int
    expected_stop: bool
    happened_at: datetime


class ProcessService:
    def __init__(self, log_service: LogService) -> None:
        self._log_service = log_service
        self._records: dict[str, ProcessRecord] = {}
        self._lock = threading.RLock()

    def is_running(self, model_id: str) -> bool:
        with self._lock:
            record = self._records.get(model_id)
            return bool(record and record.process.poll() is None)

    def start(self, model: ModelConfig, profile: ProfileConfig | None) -> tuple[int, str]:
        with self._lock:
            if self.is_running(model.id):
                raise RuntimeError(f"Model '{model.id}' is already running.")

            command = build_command(model, profile)
            if not command:
                raise RuntimeError(f"Model '{model.id}' does not define a launch command.")

            log_path, log_handle = self._log_service.open_log_handle(model.id, model.log_path)
            env = build_environment(model)
            cwd = resolve_working_dir(model)

            kwargs: dict[str, object] = {
                "cwd": cwd,
                "env": env,
                "stdout": log_handle,
                "stderr": subprocess.STDOUT,
                "text": True,
                "shell": model.launch.shell,
            }
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
                    subprocess,
                    "CREATE_NO_WINDOW",
                    0,
                )
            else:
                kwargs["start_new_session"] = True

            process = subprocess.Popen(command, **kwargs)  # noqa: S603
            self._records[model.id] = ProcessRecord(
                model_id=model.id,
                process=process,
                log_handle=log_handle,
                log_path=log_path,
                expected_stop=False,
                started_at=datetime.utcnow(),
            )
            return process.pid, str(log_path)

    def stop(self, model_id: str, grace_seconds: int = 8) -> int | None:
        with self._lock:
            record = self._records.get(model_id)
            if not record:
                return None
            record.expected_stop = True
            process = record.process

        if process.poll() is None:
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        capture_output=True,
                        text=True,
                        timeout=grace_seconds,
                        check=False,
                    )
                else:
                    os.killpg(os.getpgid(process.pid), signal.SIGTERM)
                process.wait(timeout=grace_seconds)
            except subprocess.TimeoutExpired:
                self._force_kill(process.pid)
                process.wait(timeout=5)
            except ProcessLookupError:
                pass

        with self._lock:
            self._finalize_record(model_id)
        return process.returncode

    def shutdown_all(self) -> None:
        for model_id in list(self._records.keys()):
            self.stop(model_id)

    def collect_exits(self) -> list[ProcessExitEvent]:
        exited: list[ProcessExitEvent] = []
        with self._lock:
            for model_id, record in list(self._records.items()):
                return_code = record.process.poll()
                if return_code is None:
                    continue
                exited.append(
                    ProcessExitEvent(
                        model_id=model_id,
                        return_code=return_code,
                        expected_stop=record.expected_stop,
                        happened_at=datetime.utcnow(),
                    )
                )
                self._finalize_record(model_id)
        return exited

    def _finalize_record(self, model_id: str) -> None:
        record = self._records.pop(model_id, None)
        if not record:
            return
        try:
            record.log_handle.flush()
            record.log_handle.close()
        except ValueError:
            pass

    @staticmethod
    def _force_kill(pid: int) -> None:
        try:
            process = psutil.Process(pid)
        except psutil.NoSuchProcess:
            return

        for child in process.children(recursive=True):
            try:
                child.kill()
            except psutil.Error:
                continue
        try:
            process.kill()
        except psutil.Error:
            return
