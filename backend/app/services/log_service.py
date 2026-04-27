from __future__ import annotations

from collections import deque
from datetime import datetime
from pathlib import Path
from typing import TextIO

from app.utils.command_builder import normalize_log_path


class LogService:
    def __init__(self, logs_dir: Path) -> None:
        self.logs_dir = logs_dir
        self.logs_dir.mkdir(parents=True, exist_ok=True)

    def get_log_path(self, model_id: str, configured_path: str | None = None) -> Path:
        path = normalize_log_path(configured_path, self.logs_dir, model_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def open_log_handle(self, model_id: str, configured_path: str | None = None) -> tuple[Path, TextIO]:
        path = self.get_log_path(model_id, configured_path)
        handle = path.open("a", encoding="utf-8", buffering=1)
        return path, handle

    def append_event(self, model_id: str, message: str, configured_path: str | None = None) -> Path:
        path = self.get_log_path(model_id, configured_path)
        timestamp = datetime.utcnow().isoformat(timespec="seconds")
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{timestamp} | {message}\n")
        return path

    def clear(self, model_id: str, configured_path: str | None = None) -> Path:
        path = self.get_log_path(model_id, configured_path)
        path.write_text("", encoding="utf-8")
        return self.append_event(model_id, "Logs cleared from Quokka UI.", configured_path)

    def read_tail(self, model_id: str, configured_path: str | None = None, limit: int = 200) -> tuple[Path, list[str]]:
        path = self.get_log_path(model_id, configured_path)
        if not path.exists():
            return path, []

        with path.open("r", encoding="utf-8", errors="replace") as handle:
            lines = list(deque(handle, maxlen=limit))
        return path, [line.rstrip("\n") for line in lines]
