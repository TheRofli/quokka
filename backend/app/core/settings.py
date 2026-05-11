from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path

from pydantic import BaseModel


class AppSettings(BaseModel):
    project_root: Path
    config_path: Path
    logs_dir: Path
    data_dir: Path
    metrics_db_path: Path
    frontend_dist: Path
    api_prefix: str = "/api"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    cors_origin_regex: str | None = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
    supervisor_poll_seconds: int = 5


@lru_cache
def get_settings() -> AppSettings:
    project_root = Path(os.environ.get("QUOKKA_PROJECT_ROOT", Path(__file__).resolve().parents[3]))
    backend_root = project_root / "backend"
    config_path = Path(os.environ.get("QUOKKA_CONFIG_PATH", backend_root / "config" / "quokka.yaml"))
    logs_dir = Path(os.environ.get("QUOKKA_LOGS_DIR", backend_root / "logs"))
    data_dir = Path(os.environ.get("QUOKKA_DATA_DIR", backend_root / "data"))
    metrics_db_path = Path(os.environ.get("QUOKKA_METRICS_DB_PATH", data_dir / "metrics.sqlite3"))
    frontend_dist = Path(os.environ.get("QUOKKA_FRONTEND_DIST", project_root / "frontend" / "dist"))
    return AppSettings(
        project_root=project_root,
        config_path=config_path,
        logs_dir=logs_dir,
        data_dir=data_dir,
        metrics_db_path=metrics_db_path,
        frontend_dist=frontend_dist,
    )
