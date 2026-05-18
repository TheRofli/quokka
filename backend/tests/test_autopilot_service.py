from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.domain.enums import ProviderType
from app.services.autopilot_service import AutopilotService, choose_hardware_class, score_readiness


class AutopilotServiceTests(unittest.TestCase):
    def test_score_readiness_penalizes_failures_and_warnings(self) -> None:
        result = score_readiness(pass_count=3, warn_count=1, fail_count=1)

        self.assertEqual(result, 55)

    def test_choose_hardware_class_uses_vram_first(self) -> None:
        self.assertEqual(choose_hardware_class(vram_gb=12.0, ram_gb=80.0), "mid_gpu")
        self.assertEqual(choose_hardware_class(vram_gb=4.0, ram_gb=32.0), "low_gpu")
        self.assertEqual(choose_hardware_class(vram_gb=None, ram_gb=32.0), "cpu_or_unknown")

    def test_action_log_persists_entries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            service = AutopilotService(data_dir=Path(temp_dir))
            entry = service.append_action(
                action="switch_runtime",
                status="completed",
                summary="Switched model to WSL runtime.",
                details=["Converted D:\\Models\\a.gguf to /mnt/d/Models/a.gguf."],
                undo_hint="Use Switch to Windows from Health Doctor.",
                confidence="high",
            )

            entries = service.list_actions()

        self.assertEqual(entries[0].id, entry.id)
        self.assertEqual(entries[0].confidence, "high")
        self.assertIn("WSL", entries[0].summary)

    def test_starter_plan_prefers_windows_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            service = AutopilotService(data_dir=Path(temp_dir))
            plan = service.create_starter_plan(runtime=ProviderType.WINDOWS_LLAMA_CPP, use_case="chat")

        self.assertEqual(plan.create_model.provider, ProviderType.WINDOWS_LLAMA_CPP)
        self.assertIn(".gguf", plan.filename.lower())


if __name__ == "__main__":
    unittest.main()
