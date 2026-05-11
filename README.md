# Quokka

Quokka is a local AI model manager for supervising local LLM and VLM endpoints across:

- `llama.cpp` servers launched in WSL
- Ollama models
- generic OpenAI-compatible local endpoints

It ships as a modular FastAPI backend, a React/Vite control room UI, and an optional Electron desktop wrapper with a Windows tray icon.

## Install From GitHub

Windows source install, no `.exe` required:

```powershell
irm https://raw.githubusercontent.com/TheRofli/Quokka/main/install.ps1 | iex
```

After the installer finishes, open a new terminal and run:

```powershell
quokka
```

To update Quokka after new commits are pushed:

```powershell
quokka update
quokka
```

If Quokka was installed before the `quokka update` command existed, run the installer command above one more time. It will update the existing checkout and create the new launcher command.

The installer clones the repo into `%LOCALAPPDATA%\Quokka\app`, prepares the Python/Node dependencies, creates a local `backend/config/quokka.yaml` from `quokka.example.yaml`, adds `%LOCALAPPDATA%\Quokka\bin` to the user `PATH`, and creates the `quokka`, `quokka update`, and compatibility `quokka-update` commands.

Useful update options:

- `quokka update -Launch` updates and opens Quokka after the rebuild.
- `quokka update -NoBuild` only pulls the latest git changes. Use this only when code/dependencies did not change.
- `quokka-update -Launch` updates and opens Quokka after the rebuild.
- `quokka-update -NoBuild` only pulls the latest git changes. Use this only when code/dependencies did not change.

Requirements:

- Git for Windows
- Node.js LTS
- Python 3.11+

## Model Library

Quokka includes a `Model Library` page for friend-friendly local setup:

- search Hugging Face for GGUF repositories;
- paste a Hugging Face model URL or direct `.gguf` file URL;
- download models into Quokka's local models folder or a folder you choose;
- add a completed download to the Local Panel as a Windows `llama.cpp` runtime.

For Windows-only users, WSL is optional, not required. Open `Settings -> Windows Runtime` or `Add Model -> Windows setup` and use `Install CPU` / `Install CUDA` to let Quokka download the latest official Windows `llama.cpp` build from `ggml-org/llama.cpp`, extract it into Quokka's data folder, and auto-fill `llama-server.exe`.

## Quokka Lab Integration

Quokka is now the local model control app. The coding-agent workspace lives in the separate Quokka Lab app.

When a model is started in Quokka, Quokka Lab can discover it through:

```text
GET http://127.0.0.1:8000/api/lab/models
```

By default this returns only ready/running inference endpoints. Use this during polling in Quokka Lab:

```powershell
curl http://127.0.0.1:8000/api/lab/models
```

Use `?ready_only=false` to show stopped/unhealthy models too:

```text
GET http://127.0.0.1:8000/api/lab/models?ready_only=false
```

Each item includes the Quokka model id, display name, provider, endpoint, runtime status, `api_format`, `model_name`, and `chat_url`. Quokka Lab should use `chat_url` plus `model_name` to send local inference requests.

## Product Helpers

Quokka includes a few friend-friendly helpers on top of raw model control:

- First Run Wizard: appears when no models are configured and points users to Add Model, LLM Tests, and the Quokka Lab bridge.
- Model Health Doctor: `GET /api/models/{model_id}/doctor` checks the model path, runtime type, port, HTTP health, and recent runtime error.
- Benchmark profile apply: `POST /api/models/{model_id}/apply-benchmark-profile` saves benchmark launch params as a new profile and can activate it.
- Chat profiles: Balanced, Fast Answer, Coding, Deep Reasoning, and Strict JSON adjust sampling and system instructions without manual slider work.

## Stack

Backend:

- Python 3.11+
- FastAPI
- Uvicorn
- Pydantic
- psutil
- httpx
- PyYAML

Frontend:

- React
- TypeScript
- Vite
- TailwindCSS
- shadcn-style component structure
- Chart.js / react-chartjs-2
- lucide-react
- framer-motion

Desktop:

- Electron
- Windows tray icon / notification area
- backend launcher and health wait loop
- hide-on-close window behavior

## Features

- live dashboard for GPU, VRAM, temperature, CPU, RAM, and active model count
- extended CPU, GPU, memory, disk, network, and process telemetry
- SQLite-backed metric history for trend charts
- central model grid with status badges and lifecycle actions
- right-side inspection panel with details, logs, profiles, settings, and raw config editing
- subprocess management for local `llama.cpp` processes
- Ollama warm/unload flow through the Ollama API
- health probes for local inference endpoints
- crash detection through a background runtime supervisor
- persistent YAML config
- per-model log files
- Electron tray menu with open, logs, restart backend, and quit actions

## Project Layout

```text
Quokka/
|-- backend/
|   |-- app/
|   |   |-- api/
|   |   |-- core/
|   |   |-- domain/
|   |   |-- schemas/
|   |   |-- services/
|   |   `-- utils/
|   |-- config/
|   |   |-- quokka.example.yaml
|   |   `-- quokka.yaml        # local only, ignored by git
|   |-- logs/
|   `-- requirements.txt
|-- desktop/
|   |-- scripts/
|   |-- src/
|   |-- resources/
|   `-- package.json
|-- frontend/
|   |-- src/
|   |-- package.json
|   `-- vite.config.ts
`-- README.md
```

## Configuration

The main runtime config lives in `backend/config/quokka.yaml`. That file is local-only and ignored by git because it contains machine-specific model paths, WSL distro names, ports, and launch commands.

Fresh installs create `quokka.yaml` from `backend/config/quokka.example.yaml`, which starts with an empty model list. Add local GGUF/Ollama/OpenAI-compatible endpoints from the Quokka UI.

## Backend API

The backend exposes:

- `GET /api/system/metrics`
- `GET /api/system/metrics/history?minutes=60`
- `GET /api/system/health`
- `GET /api/models`
- `GET /api/models/{model_id}`
- `POST /api/models/{model_id}/start`
- `POST /api/models/{model_id}/stop`
- `POST /api/models/{model_id}/restart`
- `GET /api/models/{model_id}/logs`
- `GET /api/models/{model_id}/health`
- `GET /api/models/{model_id}/doctor`
- `POST /api/models/{model_id}/apply-benchmark-profile`
- `GET /api/lab/models`
- `GET /api/models/{model_id}/profiles`
- `POST /api/models/{model_id}/profiles`
- `PUT /api/models/{model_id}/profiles/{profile_id}`
- `DELETE /api/models/{model_id}/profiles/{profile_id}`
- `POST /api/models/{model_id}/profiles/{profile_id}/activate`
- `GET /api/config`
- `PUT /api/config`

## Run In Browser

### 1. Backend

From the repo root:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Frontend

In a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

The Vite dev server runs on `http://127.0.0.1:5173` and proxies `/api` requests to the backend.

## Run As Desktop App

Build the frontend once:

```powershell
cd frontend
npm install
npm run build
```

Run the Electron wrapper:

```powershell
cd ..\desktop
npm install
npm run dev
```

The desktop wrapper:

- starts the FastAPI backend if `http://127.0.0.1:8000` is not already healthy
- opens Quokka in an app window
- creates a tray icon in the Windows notification area
- hides the window on close instead of quitting
- quits from the tray menu

## Build Desktop Installer

For a proper `.exe` installer, first build the backend sidecar:

```powershell
cd desktop
.\scripts\build-backend-sidecar.ps1
```

Then build the Windows installer:

```powershell
npm run build
```

Output goes to `desktop/release/`.

Shortcut build:

```powershell
.\scripts\build-windows-installer.ps1
```

The NSIS installer creates Desktop and Start Menu shortcuts named `Quokka`. For in-app update notices, publish the generated installer in a GitHub Release such as `v0.2.0`; Quokka checks the latest release and shows an Update button when the release version is newer than the local config version.

You can publish a release with:

```powershell
$env:GITHUB_TOKEN = "github_pat_..."
.\scripts\publish-github-release.ps1 -Version 0.2.0 -RebuildInstaller
```

Installer users will open the release installer from the in-app Update button. Source installs still use `quokka update`.

## Notes

- GPU metrics use `nvidia-smi` when available. If it is missing, Quokka falls back gracefully.
- Metric history is stored in `backend/data/metrics.sqlite3` by default and is ignored by git.
- WSL-backed models are treated as managed subprocesses and monitored for unexpected exits.
- Ollama models are started by warm-loading them and stopped by sending `keep_alive: 0`.
- Logs are written to `backend/logs` in dev mode and to the app user-data logs folder in packaged desktop mode.
