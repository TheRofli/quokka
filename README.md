# Quokka

Quokka is a local AI model manager for supervising local LLM and VLM endpoints across:

- `llama.cpp` servers launched in WSL
- Ollama models
- generic OpenAI-compatible local endpoints

It ships as a modular FastAPI backend, a React/Vite control room UI, and an optional Electron desktop wrapper with a Windows tray icon.

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
- lucide-react
- framer-motion

Desktop:

- Electron
- Windows tray icon / notification area
- backend launcher and health wait loop
- hide-on-close window behavior

## Features

- live dashboard for GPU, VRAM, temperature, CPU, RAM, and active model count
- central model grid with status badges and lifecycle actions
- bottom quick selector for fast context switching
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
|   |   `-- quokka.yaml
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

## Default Models

The bundled config includes:

- Qwen3 Coder Next Backup on `8080`
- Qwen3.5 35B A3B Local on `8081`
- Devstral Small 2 Smart on `8082`
- Qwen3.5 9B Fast on `8083`
- Qwen3 14B Mid on `8084`
- Gemma 3 4B Vision via Ollama

## Configuration

The main runtime config lives in `backend/config/quokka.yaml`.

For the bundled `llama.cpp` entries, the launch commands expect environment variables such as:

- `QWEN3_CODER_NEXT_BACKUP_MODEL_PATH`
- `QWEN3_5_35B_A3B_MODEL_PATH`
- `DEVSTRAL_SMALL_2_SMART_MODEL_PATH`
- `QWEN3_5_9B_FAST_MODEL_PATH`
- `QWEN3_14B_MID_MODEL_PATH`

You can either export those paths before starting the backend or edit the YAML launch commands directly.

## Backend API

The backend exposes:

- `GET /api/system/metrics`
- `GET /api/system/health`
- `GET /api/models`
- `GET /api/models/{model_id}`
- `POST /api/models/{model_id}/start`
- `POST /api/models/{model_id}/stop`
- `POST /api/models/{model_id}/restart`
- `GET /api/models/{model_id}/logs`
- `GET /api/models/{model_id}/health`
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

## Notes

- GPU metrics use `nvidia-smi` when available. If it is missing, Quokka falls back gracefully.
- WSL-backed models are treated as managed subprocesses and monitored for unexpected exits.
- Ollama models are started by warm-loading them and stopped by sending `keep_alive: 0`.
- Logs are written to `backend/logs` in dev mode and to the app user-data logs folder in packaged desktop mode.
