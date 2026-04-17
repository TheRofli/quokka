from __future__ import annotations

import subprocess
from datetime import datetime

import psutil

from app.schemas.api import GpuDeviceMetrics, SystemMetricsResponse


class MetricsService:
    def __init__(self) -> None:
        psutil.cpu_percent(interval=None)

    def get_system_metrics(self, active_models: int) -> SystemMetricsResponse:
        memory = psutil.virtual_memory()
        gpu_devices = self._read_gpu_metrics()

        gpu_usage = None
        gpu_memory_used = None
        gpu_memory_total = None
        gpu_temperature = None

        if gpu_devices:
            gpu_usage = round(sum(device.usage_percent or 0 for device in gpu_devices) / len(gpu_devices), 1)
            gpu_memory_used = round(sum(device.memory_used_mb or 0 for device in gpu_devices), 1)
            gpu_memory_total = round(sum(device.memory_total_mb or 0 for device in gpu_devices), 1)
            gpu_temperature = round(sum(device.temperature_c or 0 for device in gpu_devices) / len(gpu_devices), 1)

        return SystemMetricsResponse(
            timestamp=datetime.utcnow(),
            cpu_usage_percent=round(psutil.cpu_percent(interval=None), 1),
            ram_used_gb=round(memory.used / 1024**3, 2),
            ram_total_gb=round(memory.total / 1024**3, 2),
            ram_usage_percent=round(memory.percent, 1),
            gpu_usage_percent=gpu_usage,
            gpu_memory_used_mb=gpu_memory_used,
            gpu_memory_total_mb=gpu_memory_total,
            gpu_temperature_c=gpu_temperature,
            gpu_devices=gpu_devices,
            active_models=active_models,
        )

    def _read_gpu_metrics(self) -> list[GpuDeviceMetrics]:
        query = [
            "nvidia-smi",
            "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
            "--format=csv,noheader,nounits",
        ]

        try:
            result = subprocess.run(query, capture_output=True, text=True, timeout=2, check=True)  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError):
            return []

        devices: list[GpuDeviceMetrics] = []
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) != 6:
                continue
            devices.append(
                GpuDeviceMetrics(
                    index=int(parts[0]),
                    name=parts[1],
                    usage_percent=float(parts[2]),
                    memory_used_mb=float(parts[3]),
                    memory_total_mb=float(parts[4]),
                    temperature_c=float(parts[5]),
                )
            )
        return devices
