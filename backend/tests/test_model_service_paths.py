from __future__ import annotations

import unittest

from app.services.model_service import ModelService


class ModelServicePathTests(unittest.TestCase):
    def test_windows_path_string_converts_to_wsl_mount_path(self) -> None:
        result = ModelService._windows_path_string_to_wsl(r'D:\Models\gemma\model.gguf')

        self.assertEqual(result, "/mnt/d/Models/gemma/model.gguf")

    def test_wsl_mount_path_string_converts_to_windows_path(self) -> None:
        result = ModelService._wsl_path_string_to_windows("/mnt/d/Models/gemma/model.gguf")

        self.assertEqual(result, r"D:\Models\gemma\model.gguf")

    def test_non_drive_path_is_left_as_linux_path(self) -> None:
        result = ModelService._windows_path_string_to_wsl("~/llm/models/model.gguf")

        self.assertEqual(result, "~/llm/models/model.gguf")


if __name__ == "__main__":
    unittest.main()
