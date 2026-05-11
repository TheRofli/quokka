from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.services.model_library_service import (
    build_huggingface_resolve_url,
    parse_huggingface_reference,
    validate_gguf_file,
)


class ModelLibraryHelperTests(unittest.TestCase):
    def test_parse_huggingface_blob_url(self) -> None:
        reference = parse_huggingface_reference(
            "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/blob/main/gemma-3-4b-it-Q4_K_M.gguf"
        )

        self.assertEqual(reference.repo_id, "unsloth/gemma-3-4b-it-GGUF")
        self.assertEqual(reference.filename, "gemma-3-4b-it-Q4_K_M.gguf")
        self.assertEqual(reference.revision, "main")
        self.assertEqual(
            build_huggingface_resolve_url(reference),
            "https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf",
        )

    def test_validate_gguf_rejects_wrong_extension(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model.safetensors"
            path.write_bytes(b"GGUF")

            result = validate_gguf_file(path)

        self.assertFalse(result.ok)
        self.assertIn("GGUF", result.summary)

    def test_validate_gguf_rejects_wrong_header(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model.gguf"
            path.write_bytes(b"NOPE")

            result = validate_gguf_file(path)

        self.assertFalse(result.ok)
        self.assertIn("not look like a GGUF", result.summary)

    def test_validate_gguf_accepts_header(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model.gguf"
            path.write_bytes(b"GGUF\x03\x00\x00\x00")

            result = validate_gguf_file(path)

        self.assertTrue(result.ok)


if __name__ == "__main__":
    unittest.main()
