# Changelog

## v0.2.0 - Local model operator release

- Added a smoother install/update path with `quokka`, `quokka update`, and the compatibility `quokka-update` command.
- Added Health Doctor fix actions for common local setup issues: port changes, Windows llama.cpp runtime, `llama-server.exe`, and GGUF path repair.
- Added bulk GGUF import so a folder such as `D:\Models` can be scanned and imported without adding every file manually.
- Added LLM Tests profile diff preview before saving a benchmark recommendation as an active launch profile.
- Added a release helper at `scripts/release.ps1` that runs backend/frontend checks before tagging a version.
