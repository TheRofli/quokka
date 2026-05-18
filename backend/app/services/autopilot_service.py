from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path

from app.domain.enums import ProviderType
from app.schemas.api import (
    AutopilotActionLogEntry,
    AutopilotReadinessItem,
    AutopilotReadinessResponse,
    AutopilotSmokeTestResponse,
    AutopilotStarterPlanResponse,
    CreateModelRequest,
)


STARTER_MODELS = {
    "chat": {
        "name": "Gemma 3 4B Starter",
        "repo_id": "unsloth/gemma-3-4b-it-GGUF",
        "filename": "gemma-3-4b-it-Q4_K_M.gguf",
        "download_url": (
            "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/"
            "gemma-3-4b-it-Q4_K_M.gguf"
        ),
        "why": "Small enough for first-run Windows testing and useful for general chat.",
        "quantization": "Q4_K_M",
    },
    "coding": {
        "name": "Qwen Coder Starter",
        "repo_id": "unsloth/Qwen2.5-Coder-7B-Instruct-GGUF",
        "filename": "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
        "download_url": (
            "https://huggingface.co/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/"
            "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"
        ),
        "why": "Good starter coding model when VRAM is limited.",
        "quantization": "Q4_K_M",
    },
    "small_fast": {
        "name": "Small Fast Starter",
        "repo_id": "unsloth/gemma-3-1b-it-GGUF",
        "filename": "gemma-3-1b-it-Q4_K_M.gguf",
        "download_url": (
            "https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/resolve/main/"
            "gemma-3-1b-it-Q4_K_M.gguf"
        ),
        "why": "Fastest low-risk starter for weak GPUs or CPU-only machines.",
        "quantization": "Q4_K_M",
    },
}


def score_readiness(pass_count: int, warn_count: int, fail_count: int) -> int:
    score = 100 - warn_count * 15 - fail_count * 30
    if pass_count == 0 and fail_count:
        score -= 15
    return max(0, min(100, score))


def choose_hardware_class(vram_gb: float | None, ram_gb: float | None) -> str:
    del ram_gb
    if vram_gb is None:
        return "cpu_or_unknown"
    if vram_gb >= 16:
        return "high_gpu"
    if vram_gb >= 8:
        return "mid_gpu"
    if vram_gb >= 4:
        return "low_gpu"
    return "cpu_or_unknown"


class AutopilotService:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.log_path = self.data_dir / "autopilot-actions.json"

    def list_actions(self) -> list[AutopilotActionLogEntry]:
        if not self.log_path.exists():
            return []
        payload = json.loads(self.log_path.read_text(encoding="utf-8"))
        return [AutopilotActionLogEntry.model_validate(item) for item in payload]

    def append_action(
        self,
        *,
        action: str,
        status: str,
        summary: str,
        details: list[str],
        undo_hint: str | None,
        confidence: str,
    ) -> AutopilotActionLogEntry:
        entry = AutopilotActionLogEntry(
            id=f"auto-{uuid.uuid4().hex[:10]}",
            timestamp=datetime.now(UTC),
            action=action,
            status=status,
            summary=summary,
            details=details,
            undo_hint=undo_hint,
            confidence=confidence,
        )
        entries = [entry, *self.list_actions()]
        payload = [item.model_dump(mode="json") for item in entries[:100]]
        self.log_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return entry

    def create_starter_plan(
        self,
        *,
        runtime: ProviderType,
        use_case: str,
    ) -> AutopilotStarterPlanResponse:
        starter = STARTER_MODELS.get(use_case, STARTER_MODELS["chat"])
        create_model = CreateModelRequest(
            provider=runtime,
            name=starter["name"],
            model_path="",
            context_size=8192,
            batch_size=512,
            ubatch_size=128,
            quantization=starter["quantization"],
            description=f"First-run starter model selected by Quokka Autopilot. {starter['why']}",
        )
        return AutopilotStarterPlanResponse(
            name=starter["name"],
            repo_id=starter["repo_id"],
            filename=starter["filename"],
            download_url=starter["download_url"],
            size_bytes=None,
            quantization=starter["quantization"],
            why=starter["why"],
            create_model=create_model,
        )

    def build_readiness(
        self,
        *,
        vram_gb: float | None,
        ram_gb: float | None,
        runtime_installed: bool,
        models_dir: str,
    ) -> AutopilotReadinessResponse:
        hardware_class = choose_hardware_class(vram_gb=vram_gb, ram_gb=ram_gb)
        items = [
            AutopilotReadinessItem(
                id="runtime",
                label="Windows llama.cpp",
                status="pass" if runtime_installed else "warn",
                detail=(
                    "llama-server.exe is ready."
                    if runtime_installed
                    else "Quokka can install Windows llama.cpp before downloading a model."
                ),
                fix_action=None if runtime_installed else "install_llama_cpp",
            ),
            AutopilotReadinessItem(
                id="models-dir",
                label="Model folder",
                status="pass",
                detail=models_dir,
            ),
        ]
        pass_count = sum(1 for item in items if item.status == "pass")
        warn_count = sum(1 for item in items if item.status == "warn")
        fail_count = sum(1 for item in items if item.status == "fail")
        bottlenecks = []
        if hardware_class == "cpu_or_unknown":
            bottlenecks.append("GPU/VRAM telemetry is missing or too low for confident GPU fit.")

        return AutopilotReadinessResponse(
            score_percent=score_readiness(pass_count, warn_count, fail_count),
            summary=(
                "Quokka can set up a starter local model."
                if fail_count == 0
                else "Quokka found setup issues to fix first."
            ),
            hardware_class=hardware_class,
            recommended_runtime=ProviderType.WINDOWS_LLAMA_CPP,
            recommended_profile="Balanced starter",
            bottlenecks=bottlenecks,
            items=items,
        )

    def smoke_test_error(self, model_id: str, error: str) -> AutopilotSmokeTestResponse:
        return AutopilotSmokeTestResponse(
            model_id=model_id,
            ok=False,
            summary="Smoke test failed.",
            error=error,
        )
