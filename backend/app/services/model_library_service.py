from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote, urlparse


@dataclass(frozen=True)
class HuggingFaceReference:
    repo_id: str
    filename: str | None = None
    revision: str = "main"


@dataclass(frozen=True)
class ValidationResult:
    ok: bool
    summary: str


def parse_huggingface_reference(value: str) -> HuggingFaceReference:
    raw = value.strip().strip("\"'")
    if not raw:
        raise ValueError("Paste a Hugging Face model URL, repo id, or direct GGUF URL.")

    parsed = urlparse(raw)
    if parsed.scheme and parsed.netloc and "huggingface.co" not in parsed.netloc.lower():
        if raw.lower().endswith(".gguf"):
            file_name = unquote(Path(parsed.path).name)
            return HuggingFaceReference(repo_id=parsed.netloc, filename=file_name)
        raise ValueError("Only Hugging Face URLs or direct .gguf download URLs are supported.")

    if "huggingface.co" in parsed.netloc.lower():
        parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
    else:
        parts = [part for part in raw.strip("/").split("/") if part]

    marker = next((item for item in ("blob", "resolve") if item in parts), None)
    if marker:
        marker_index = parts.index(marker)
        repo_id = "/".join(parts[:marker_index])
        revision = parts[marker_index + 1] if len(parts) > marker_index + 1 else "main"
        filename = "/".join(parts[marker_index + 2 :]) or None
    else:
        repo_id = "/".join(parts[:2]) if len(parts) >= 2 else (parts[0] if parts else "")
        filename = "/".join(parts[2:]) if len(parts) > 2 else None

    if not repo_id:
        raise ValueError("Could not parse the Hugging Face repo id.")
    return HuggingFaceReference(repo_id=repo_id, filename=filename, revision=revision or "main")


def build_huggingface_resolve_url(reference: HuggingFaceReference) -> str:
    if not reference.filename:
        raise ValueError("A GGUF filename is required for download.")
    filename = "/".join(quote(part) for part in reference.filename.split("/"))
    return f"https://huggingface.co/{reference.repo_id}/resolve/{reference.revision}/{filename}"


def validate_gguf_file(path: Path) -> ValidationResult:
    if path.suffix.lower() != ".gguf":
        return ValidationResult(False, "Quokka can launch llama.cpp models only when the file is GGUF.")
    if not path.exists():
        return ValidationResult(False, f"GGUF file was not found at {path}.")
    if not path.is_file():
        return ValidationResult(False, f"{path} is not a file.")
    try:
        with path.open("rb") as handle:
            header = handle.read(4)
    except OSError as exc:
        return ValidationResult(False, f"Could not read GGUF header: {exc}")
    if header != b"GGUF":
        return ValidationResult(False, "This file does not look like a GGUF model. Pick a .gguf export from Hugging Face.")
    return ValidationResult(True, "GGUF header looks valid.")


def model_name_from_filename(filename: str) -> str:
    stem = Path(filename).name.rsplit(".", 1)[0]
    return stem.replace("_", " ").replace("-", " ").strip() or "Downloaded GGUF Model"
