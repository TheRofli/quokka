from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from app.api.routes import autopilot, chat, config, lab, library, models, profiles, system
from app.core.logging import configure_logging
from app.core.settings import get_settings
from app.services.config_service import ConfigService
from app.services.health_service import HealthService
from app.services.log_service import LogService
from app.services.metrics_service import MetricsService
from app.services.model_service import ModelService
from app.services.process_service import ProcessService
from app.services.supervisor import RuntimeSupervisor


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.logs_dir)

    config_service = ConfigService(settings.config_path)
    log_service = LogService(settings.logs_dir)
    health_service = HealthService()
    metrics_service = MetricsService(settings.metrics_db_path)
    process_service = ProcessService(log_service)
    model_service = ModelService(
        config_service=config_service,
        process_service=process_service,
        health_service=health_service,
        log_service=log_service,
        metrics_service=metrics_service,
    )
    supervisor = RuntimeSupervisor(model_service, settings.supervisor_poll_seconds)
    supervisor_task = asyncio.create_task(supervisor.run())

    app.state.model_service = model_service
    app.state.supervisor = supervisor

    try:
        yield
    finally:
        await supervisor.stop()
        supervisor_task.cancel()
        await asyncio.gather(supervisor_task, return_exceptions=True)
        process_service.shutdown_all()
        await health_service.close()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Quokka",
        version="0.2.0",
        summary="Local AI model control center",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(system.router, prefix=settings.api_prefix)
    app.include_router(models.router, prefix=settings.api_prefix)
    app.include_router(profiles.router, prefix=settings.api_prefix)
    app.include_router(config.router, prefix=settings.api_prefix)
    app.include_router(chat.router, prefix=settings.api_prefix)
    app.include_router(lab.router, prefix=settings.api_prefix)
    app.include_router(library.router, prefix=settings.api_prefix)
    app.include_router(autopilot.router, prefix=settings.api_prefix)

    frontend_dist = settings.frontend_dist
    if frontend_dist.exists():
        assets_dir = frontend_dist / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

        @app.middleware("http")
        async def disable_frontend_cache(request, call_next):
            response: Response = await call_next(request)
            if request.url.path == "/" or request.url.path.startswith("/assets/"):
                response.headers["Cache-Control"] = "no-store, max-age=0"
                response.headers["Pragma"] = "no-cache"
            return response

        @app.get("/", include_in_schema=False)
        def serve_index():
            return FileResponse(frontend_dist / "index.html")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa_fallback(full_path: str):
            if full_path.startswith(f"{settings.api_prefix.strip('/')}/"):
                raise HTTPException(status_code=404, detail="API route not found")

            requested = frontend_dist / full_path
            if requested.exists() and requested.is_file():
                return FileResponse(requested)
            return FileResponse(frontend_dist / "index.html")
    else:

        @app.get("/", include_in_schema=False)
        def root():
            return {
                "name": "Quokka",
                "message": "Frontend bundle not found. Run the Vite app in frontend/ for development.",
            }

    return app


app = create_app()
