from __future__ import annotations

import json
import platform
import re
import sqlite3
import subprocess
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import psutil

from app.domain.enums import ProviderType
from app.schemas.api import (
    CpuCacheMetrics,
    CpuCoreMetrics,
    DiskPartitionMetrics,
    GpuDeviceMetrics,
    MemoryBreakdown,
    MetricHistoryPoint,
    ModelResourceUsage,
    NetworkInterfaceMetrics,
    ProcessMetric,
    SystemMetricsResponse,
)
from app.schemas.config import ModelConfig


BYTES_IN_GB = 1024**3
BYTES_IN_MB = 1024**2
MODEL_PROCESS_HINTS = ("llama", "llama-server", "ollama", "gguf", "qwen", "devstral", "gemma")
LOCAL_ENDPOINT_HOSTS = {"", "localhost", "127.0.0.1", "0.0.0.0", "::1", "::"}


class MetricsService:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_history_db()

        psutil.cpu_percent(interval=None)
        psutil.cpu_percent(interval=None, percpu=True)
        self._previous_disk_io = psutil.disk_io_counters()
        self._previous_net_io = psutil.net_io_counters()
        self._previous_sample_at = datetime.utcnow()
        self._process_lock = threading.Lock()
        self._process_refreshing = False
        self._process_cache_at = datetime.min
        self._top_process_cache: list[ProcessMetric] = []
        self._model_process_cache: list[ProcessMetric] = []
        self._model_resource_lock = threading.Lock()
        self._model_cpu_samples: dict[int, tuple[datetime, float]] = {}
        self._model_io_samples: dict[int, tuple[datetime, int, int]] = {}
        self._wsl_io_samples: dict[str, tuple[datetime, int, int]] = {}
        self._gpu_process_cache_at = datetime.min
        self._gpu_process_cache: dict[int, float] = {}
        self._wsl_process_cache_at = datetime.min
        self._wsl_process_cache: list[dict[str, Any]] = []
        self._wsl_gpu_process_cache_at = datetime.min
        self._wsl_gpu_process_cache: dict[int, float] = {}

    def get_system_metrics(self, active_models: int) -> SystemMetricsResponse:
        now = datetime.utcnow()
        elapsed = max((now - self._previous_sample_at).total_seconds(), 0.001)
        memory = psutil.virtual_memory()
        cpu_freq = psutil.cpu_freq()
        gpu_devices = self._read_gpu_metrics()
        disk_read_mb_s, disk_write_mb_s = self._read_disk_rates(elapsed)
        network_rx_mbps, network_tx_mbps = self._read_network_rates(elapsed)
        top_processes, model_processes = self._get_process_snapshots()

        gpu_usage = None
        gpu_memory_used = None
        gpu_memory_free = None
        gpu_memory_total = None
        gpu_temperature = None

        if gpu_devices:
            gpu_usage = round(sum(device.usage_percent or 0 for device in gpu_devices) / len(gpu_devices), 1)
            gpu_memory_used = round(sum(device.memory_used_mb or 0 for device in gpu_devices), 1)
            gpu_memory_free = round(sum(device.memory_free_mb or 0 for device in gpu_devices), 1)
            gpu_memory_total = round(sum(device.memory_total_mb or 0 for device in gpu_devices), 1)
            gpu_temperature = round(sum(device.temperature_c or 0 for device in gpu_devices) / len(gpu_devices), 1)

        cpu_physical = psutil.cpu_count(logical=False)
        cpu_logical = psutil.cpu_count(logical=True)
        cpu_usage = round(psutil.cpu_percent(interval=None), 1)
        ram_usage = round(memory.percent, 1)

        history_point = MetricHistoryPoint(
            timestamp=now,
            cpu_usage_percent=cpu_usage,
            ram_usage_percent=ram_usage,
            gpu_usage_percent=gpu_usage,
            gpu_memory_used_mb=gpu_memory_used,
            disk_read_mb_s=disk_read_mb_s,
            disk_write_mb_s=disk_write_mb_s,
            network_rx_mbps=network_rx_mbps,
            network_tx_mbps=network_tx_mbps,
        )
        self._record_history(history_point)

        return SystemMetricsResponse(
            timestamp=now,
            cpu_usage_percent=cpu_usage,
            cpu_physical_cores=cpu_physical,
            cpu_logical_cores=cpu_logical,
            cpu_hyper_threading_enabled=(
                cpu_physical is not None and cpu_logical is not None and cpu_logical > cpu_physical
            ),
            cpu_frequency_mhz=round(cpu_freq.current, 1) if cpu_freq else None,
            cpu_temperature_c=self._read_cpu_temperature(),
            cpu_cores=self._read_cpu_cores(),
            cpu_cache=self._read_cpu_cache(),
            ram_used_gb=round(memory.used / BYTES_IN_GB, 2),
            ram_total_gb=round(memory.total / BYTES_IN_GB, 2),
            ram_usage_percent=ram_usage,
            memory=self._read_memory_breakdown(memory),
            gpu_usage_percent=gpu_usage,
            gpu_memory_used_mb=gpu_memory_used,
            gpu_memory_free_mb=gpu_memory_free,
            gpu_memory_total_mb=gpu_memory_total,
            gpu_temperature_c=gpu_temperature,
            gpu_devices=gpu_devices,
            disk_read_mb_s=disk_read_mb_s,
            disk_write_mb_s=disk_write_mb_s,
            disk_partitions=self._read_disk_partitions(),
            network_rx_mbps=network_rx_mbps,
            network_tx_mbps=network_tx_mbps,
            active_tcp_connections=self._read_active_tcp_connections(),
            network_interfaces=self._read_network_interfaces(),
            top_processes=top_processes,
            model_processes=model_processes,
            history=self.get_history(minutes=5),
            active_models=active_models,
        )

    def get_model_resource_usage(self, model: ModelConfig, runtime_pid: int | None) -> ModelResourceUsage:
        now = datetime.utcnow()
        if model.provider == ProviderType.WSL_LLAMA_CPP:
            wsl_usage = self._read_wsl_model_resource_usage(model, now)
            if wsl_usage is not None:
                return wsl_usage

        attribution = "unavailable"
        confidence = "none"
        note = "No local process is visible for this model yet."
        pid = runtime_pid if runtime_pid and psutil.pid_exists(runtime_pid) else None
        root_pids: list[int] = []

        if pid:
            root_pids.append(pid)
            attribution = "managed_pid"
            confidence = "high"
            note = None
            if model.provider == ProviderType.WSL_LLAMA_CPP:
                attribution = "wsl_wrapper"
                confidence = "medium"
                note = (
                    "Quokka can see the Windows WSL wrapper process. Linux-side llama.cpp CPU/RAM and "
                    "VRAM attribution are best effort."
                )

            endpoint_pid = self._find_pid_by_endpoint(model.endpoint)
            if endpoint_pid and endpoint_pid not in root_pids:
                root_pids.append(endpoint_pid)
        else:
            pid = self._find_pid_by_endpoint(model.endpoint)
            if pid:
                root_pids.append(pid)
                attribution = "port_detected"
                confidence = "medium"
                note = f"Matched the local listener for {model.endpoint}."
                if model.provider == ProviderType.OLLAMA:
                    attribution = "ollama_estimated"
                    confidence = "low"
                    note = (
                        "Ollama runs as a shared server process, so this may include other loaded Ollama models."
                    )
            elif model.provider == ProviderType.OPENAI_COMPATIBLE:
                note = "No local OpenAI-compatible listener process was visible for this endpoint."
            elif model.provider == ProviderType.OLLAMA:
                note = "The Ollama server process is not visible or is not listening locally."

        if not root_pids:
            return ModelResourceUsage(attribution=attribution, confidence=confidence, note=note, updated_at=now)

        processes_by_pid: dict[int, psutil.Process] = {}
        for root_pid in root_pids:
            for process in self._collect_process_tree(root_pid):
                processes_by_pid[process.pid] = process
        processes = list(processes_by_pid.values())
        if not processes:
            return ModelResourceUsage(
                attribution=attribution,
                confidence="none",
                note="The matched process exited before it could be sampled.",
                updated_at=now,
            )

        pids: list[int] = []
        cpu_percent = 0.0
        ram_bytes = 0
        memory_percent = 0.0
        disk_read_mb_s = 0.0
        disk_write_mb_s = 0.0

        for process in processes:
            try:
                pids.append(process.pid)
                cpu_times = process.cpu_times()
                cpu_percent += self._process_cpu_rate(process.pid, cpu_times.user + cpu_times.system, now)
                memory = process.memory_info()
                ram_bytes += memory.rss
                memory_percent += process.memory_percent()
                try:
                    io_counters = process.io_counters()
                    read_rate, write_rate = self._process_io_rates(
                        process.pid,
                        io_counters.read_bytes,
                        io_counters.write_bytes,
                        now,
                    )
                    disk_read_mb_s += read_rate
                    disk_write_mb_s += write_rate
                except (AttributeError, psutil.AccessDenied, OSError):
                    continue
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                continue

        if not pids:
            return ModelResourceUsage(
                attribution=attribution,
                confidence="none",
                note="The matched process could not be sampled because access was denied.",
                updated_at=now,
            )

        gpu_memory_by_pid = self._read_gpu_process_memory()
        vram_mb = sum(gpu_memory_by_pid.get(pid_value, 0.0) for pid_value in pids) or None

        return ModelResourceUsage(
            attribution=attribution,
            confidence=confidence,
            cpu_percent=round(cpu_percent, 1),
            ram_mb=round(ram_bytes / BYTES_IN_MB, 1),
            memory_percent=round(memory_percent, 2),
            vram_mb=round(vram_mb, 1) if vram_mb is not None else None,
            gpu_percent=None,
            disk_read_mb_s=round(disk_read_mb_s, 2),
            disk_write_mb_s=round(disk_write_mb_s, 2),
            process_count=len(pids),
            pids=sorted(pids),
            note=note,
            updated_at=now,
        )

    def _read_wsl_model_resource_usage(self, model: ModelConfig, now: datetime) -> ModelResourceUsage | None:
        port = self._model_port(model)
        if port is None:
            return None

        distro = str(model.metadata.get("wsl_distro", "Ubuntu"))
        processes = [process for process in self._read_wsl_llama_processes(distro) if process.get("port") == port]
        if not processes:
            return None

        gpu_memory_by_pid = self._read_wsl_gpu_process_memory(distro)
        cpu_percent = 0.0
        ram_mb = 0.0
        vram_mb = 0.0
        read_mb_s = 0.0
        write_mb_s = 0.0
        pids: list[int] = []

        for process in processes:
            pid = int(process["pid"])
            pids.append(pid)
            cpu_percent += float(process.get("cpu_percent") or 0)
            ram_mb += float(process.get("rss_kb") or 0) / 1024
            vram_mb += gpu_memory_by_pid.get(pid, 0.0)
            read_rate, write_rate = self._wsl_process_io_rates(
                f"{distro}:{pid}",
                int(process.get("read_bytes") or 0),
                int(process.get("write_bytes") or 0),
                now,
            )
            read_mb_s += read_rate
            write_mb_s += write_rate

        note = f"Matched llama.cpp inside WSL distro '{distro}' by --port {port}."
        if vram_mb <= 0 and len(self._read_wsl_llama_processes(distro)) == len(processes):
            gpu_devices = self._read_gpu_metrics()
            vram_mb = sum(device.memory_used_mb or 0 for device in gpu_devices)
            if vram_mb > 0:
                note = (
                    f"{note} WSL does not expose per-process VRAM here, so total GPU memory is assigned "
                    "because this is the only visible llama.cpp server."
                )

        return ModelResourceUsage(
            attribution="wsl_linux_process",
            confidence="high" if gpu_memory_by_pid else "medium",
            cpu_percent=round(cpu_percent, 1),
            ram_mb=round(ram_mb, 1),
            memory_percent=None,
            vram_mb=round(vram_mb, 1) if vram_mb > 0 else None,
            gpu_percent=None,
            disk_read_mb_s=round(read_mb_s, 2),
            disk_write_mb_s=round(write_mb_s, 2),
            process_count=len(pids),
            pids=sorted(pids),
            note=note,
            updated_at=now,
        )

    def _read_wsl_llama_processes(self, distro: str) -> list[dict[str, Any]]:
        with self._model_resource_lock:
            if (datetime.utcnow() - self._wsl_process_cache_at).total_seconds() < 2:
                return [dict(process) for process in self._wsl_process_cache]

        script = r"""
for pid in $(pgrep -f '[l]lama-server'); do
  exe=$(basename "$(readlink -f "/proc/$pid/exe" 2>/dev/null)" 2>/dev/null)
  [ "$exe" = "llama-server" ] || continue
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  port=$(printf '%s\n' "$cmd" | sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' | tail -n 1)
  [ -z "$port" ] && continue
  pcpu=$(ps -p "$pid" -o pcpu= 2>/dev/null | tr -d ' ')
  rss=$(ps -p "$pid" -o rss= 2>/dev/null | tr -d ' ')
  read_bytes=$(awk '/read_bytes:/ {print $2}' "/proc/$pid/io" 2>/dev/null)
  write_bytes=$(awk '/write_bytes:/ {print $2}' "/proc/$pid/io" 2>/dev/null)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$port" "${pcpu:-0}" "${rss:-0}" "${read_bytes:-0}" "${write_bytes:-0}"
done
"""
        try:
            result = subprocess.run(
                ["wsl", "-d", distro, "-e", "sh", "-lc", script],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            return []

        processes: list[dict[str, Any]] = []
        for line in result.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) != 6:
                continue
            try:
                processes.append(
                    {
                        "pid": int(parts[0]),
                        "port": int(parts[1]),
                        "cpu_percent": float(parts[2]),
                        "rss_kb": int(float(parts[3])),
                        "read_bytes": int(parts[4]),
                        "write_bytes": int(parts[5]),
                    }
                )
            except ValueError:
                continue

        with self._model_resource_lock:
            self._wsl_process_cache_at = datetime.utcnow()
            self._wsl_process_cache = [dict(process) for process in processes]
        return processes

    def _read_wsl_gpu_process_memory(self, distro: str) -> dict[int, float]:
        with self._model_resource_lock:
            if (datetime.utcnow() - self._wsl_gpu_process_cache_at).total_seconds() < 2:
                return dict(self._wsl_gpu_process_cache)

        query = [
            "wsl",
            "-d",
            distro,
            "-e",
            "nvidia-smi",
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ]
        try:
            result = subprocess.run(query, capture_output=True, text=True, timeout=3, check=False)  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError, OSError):
            return {}

        by_pid: dict[int, float] = {}
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            memory_mb = self._optional_float(parts[1])
            if memory_mb is not None:
                by_pid[pid] = memory_mb

        with self._model_resource_lock:
            self._wsl_gpu_process_cache_at = datetime.utcnow()
            self._wsl_gpu_process_cache = by_pid
        return by_pid

    def get_history(self, minutes: int = 60) -> list[MetricHistoryPoint]:
        minutes = max(1, min(minutes, 24 * 60))
        since = datetime.utcnow() - timedelta(minutes=minutes)
        with sqlite3.connect(self.db_path) as connection:
            rows = connection.execute(
                """
                SELECT timestamp, cpu_usage_percent, ram_usage_percent, gpu_usage_percent,
                       gpu_memory_used_mb, disk_read_mb_s, disk_write_mb_s, network_rx_mbps, network_tx_mbps
                FROM metrics_history
                WHERE timestamp >= ?
                ORDER BY timestamp ASC
                """,
                (since.isoformat(),),
            ).fetchall()

        return [
            MetricHistoryPoint(
                timestamp=datetime.fromisoformat(row[0]),
                cpu_usage_percent=row[1],
                ram_usage_percent=row[2],
                gpu_usage_percent=row[3],
                gpu_memory_used_mb=row[4],
                disk_read_mb_s=row[5],
                disk_write_mb_s=row[6],
                network_rx_mbps=row[7],
                network_tx_mbps=row[8],
            )
            for row in rows
        ]

    def _init_history_db(self) -> None:
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS metrics_history (
                    timestamp TEXT PRIMARY KEY,
                    cpu_usage_percent REAL NOT NULL,
                    ram_usage_percent REAL NOT NULL,
                    gpu_usage_percent REAL,
                    gpu_memory_used_mb REAL,
                    disk_read_mb_s REAL NOT NULL,
                    disk_write_mb_s REAL NOT NULL,
                    network_rx_mbps REAL NOT NULL,
                    network_tx_mbps REAL NOT NULL
                )
                """
            )
            connection.commit()

    def _record_history(self, point: MetricHistoryPoint) -> None:
        cutoff = datetime.utcnow() - timedelta(days=7)
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO metrics_history (
                    timestamp, cpu_usage_percent, ram_usage_percent, gpu_usage_percent,
                    gpu_memory_used_mb, disk_read_mb_s, disk_write_mb_s, network_rx_mbps, network_tx_mbps
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    point.timestamp.isoformat(),
                    point.cpu_usage_percent,
                    point.ram_usage_percent,
                    point.gpu_usage_percent,
                    point.gpu_memory_used_mb,
                    point.disk_read_mb_s,
                    point.disk_write_mb_s,
                    point.network_rx_mbps,
                    point.network_tx_mbps,
                ),
            )
            connection.execute("DELETE FROM metrics_history WHERE timestamp < ?", (cutoff.isoformat(),))
            connection.commit()

    def _read_cpu_cores(self) -> list[CpuCoreMetrics]:
        usages = psutil.cpu_percent(interval=None, percpu=True)
        frequencies = psutil.cpu_freq(percpu=True)
        cores: list[CpuCoreMetrics] = []
        for index, usage in enumerate(usages):
            frequency = None
            if frequencies and index < len(frequencies):
                frequency = round(frequencies[index].current, 1)
            cores.append(CpuCoreMetrics(index=index, usage_percent=round(usage, 1), frequency_mhz=frequency))
        return cores

    def _read_cpu_temperature(self) -> float | None:
        if not hasattr(psutil, "sensors_temperatures"):
            return None
        try:
            sensors = psutil.sensors_temperatures(fahrenheit=False)
        except (AttributeError, OSError):
            return None

        candidates: list[float] = []
        for name, entries in sensors.items():
            if not any(token in name.lower() for token in ("cpu", "core", "k10temp", "zenpower")):
                continue
            for entry in entries:
                if entry.current is not None:
                    candidates.append(float(entry.current))
        if not candidates:
            return None
        return round(max(candidates), 1)

    def _read_cpu_cache(self) -> CpuCacheMetrics:
        if platform.system() != "Linux":
            return CpuCacheMetrics()

        try:
            result = subprocess.run(["lscpu", "-J"], capture_output=True, text=True, timeout=2, check=True)  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError, json.JSONDecodeError):
            return CpuCacheMetrics()

        try:
            rows = json.loads(result.stdout).get("lscpu", [])
        except json.JSONDecodeError:
            return CpuCacheMetrics()

        cache: dict[str, str] = {}
        labels = {
            "L1d cache:": "l1d",
            "L1i cache:": "l1i",
            "L2 cache:": "l2",
            "L3 cache:": "l3",
        }
        for row in rows:
            field = row.get("field")
            if field in labels:
                cache[labels[field]] = row.get("data")
        return CpuCacheMetrics(**cache)

    def _read_memory_breakdown(self, memory: Any) -> MemoryBreakdown:
        def gb(name: str) -> float | None:
            value = getattr(memory, name, None)
            if value is None:
                return None
            return round(value / BYTES_IN_GB, 2)

        return MemoryBreakdown(
            total_gb=round(memory.total / BYTES_IN_GB, 2),
            used_gb=round(memory.used / BYTES_IN_GB, 2),
            available_gb=round(memory.available / BYTES_IN_GB, 2),
            free_gb=round(memory.free / BYTES_IN_GB, 2),
            buffers_gb=gb("buffers"),
            cached_gb=gb("cached"),
            shared_gb=gb("shared"),
            slab_gb=gb("slab"),
            usage_percent=round(memory.percent, 1),
        )

    def _read_gpu_metrics(self) -> list[GpuDeviceMetrics]:
        query = [
            "nvidia-smi",
            "--query-gpu=index,name,utilization.gpu,memory.used,memory.free,memory.total,temperature.gpu,fan.speed,power.draw,power.limit",
            "--format=csv,noheader,nounits",
        ]

        try:
            result = subprocess.run(query, capture_output=True, text=True, timeout=2, check=True)  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError):
            return []

        devices: list[GpuDeviceMetrics] = []
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) != 10:
                continue
            devices.append(
                GpuDeviceMetrics(
                    index=int(parts[0]),
                    name=parts[1],
                    usage_percent=self._optional_float(parts[2]),
                    memory_used_mb=self._optional_float(parts[3]),
                    memory_free_mb=self._optional_float(parts[4]),
                    memory_total_mb=self._optional_float(parts[5]),
                    temperature_c=self._optional_float(parts[6]),
                    fan_speed_percent=self._optional_float(parts[7]),
                    power_draw_w=self._optional_float(parts[8]),
                    power_limit_w=self._optional_float(parts[9]),
                )
            )
        return devices

    def _read_gpu_process_memory(self) -> dict[int, float]:
        with self._model_resource_lock:
            if (datetime.utcnow() - self._gpu_process_cache_at).total_seconds() < 2:
                return dict(self._gpu_process_cache)

        query = [
            "nvidia-smi",
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ]

        try:
            result = subprocess.run(query, capture_output=True, text=True, timeout=2, check=True)  # noqa: S603
        except (FileNotFoundError, subprocess.SubprocessError):
            with self._model_resource_lock:
                self._gpu_process_cache_at = datetime.utcnow()
                self._gpu_process_cache = {}
            return {}

        by_pid: dict[int, float] = {}
        for line in result.stdout.splitlines():
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 2:
                continue
            try:
                pid = int(parts[0])
            except ValueError:
                continue
            memory_mb = self._optional_float(parts[1])
            if memory_mb is not None:
                by_pid[pid] = memory_mb

        with self._model_resource_lock:
            self._gpu_process_cache_at = datetime.utcnow()
            self._gpu_process_cache = by_pid
        return by_pid

    def _read_disk_rates(self, elapsed: float) -> tuple[float, float]:
        current = psutil.disk_io_counters()
        if current is None or self._previous_disk_io is None:
            return 0.0, 0.0
        read_mb_s = max(0.0, (current.read_bytes - self._previous_disk_io.read_bytes) / BYTES_IN_MB / elapsed)
        write_mb_s = max(0.0, (current.write_bytes - self._previous_disk_io.write_bytes) / BYTES_IN_MB / elapsed)
        self._previous_disk_io = current
        return round(read_mb_s, 2), round(write_mb_s, 2)

    def _read_disk_partitions(self) -> list[DiskPartitionMetrics]:
        partitions: list[DiskPartitionMetrics] = []
        for partition in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(partition.mountpoint)
            except (OSError, PermissionError):
                continue
            partitions.append(
                DiskPartitionMetrics(
                    device=partition.device,
                    mountpoint=partition.mountpoint,
                    fstype=partition.fstype,
                    total_gb=round(usage.total / BYTES_IN_GB, 2),
                    used_gb=round(usage.used / BYTES_IN_GB, 2),
                    free_gb=round(usage.free / BYTES_IN_GB, 2),
                    usage_percent=round(usage.percent, 1),
                )
            )
        return partitions

    def _read_network_rates(self, elapsed: float) -> tuple[float, float]:
        current = psutil.net_io_counters()
        if current is None or self._previous_net_io is None:
            return 0.0, 0.0
        rx_mbps = max(0.0, (current.bytes_recv - self._previous_net_io.bytes_recv) * 8 / 1_000_000 / elapsed)
        tx_mbps = max(0.0, (current.bytes_sent - self._previous_net_io.bytes_sent) * 8 / 1_000_000 / elapsed)
        self._previous_net_io = current
        self._previous_sample_at = datetime.utcnow()
        return round(rx_mbps, 2), round(tx_mbps, 2)

    def _read_active_tcp_connections(self) -> int:
        try:
            connections = psutil.net_connections(kind="tcp")
        except (psutil.AccessDenied, OSError):
            return 0
        return sum(1 for connection in connections if connection.status == psutil.CONN_ESTABLISHED)

    def _read_network_interfaces(self) -> list[NetworkInterfaceMetrics]:
        addresses = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
        interfaces: list[NetworkInterfaceMetrics] = []

        for name, stat in stats.items():
            readable_addresses = []
            for address in addresses.get(name, []):
                family_name = getattr(address.family, "name", str(address.family))
                if family_name in {"AF_INET", "AF_INET6"}:
                    readable_addresses.append(address.address)
            interfaces.append(
                NetworkInterfaceMetrics(
                    name=name,
                    is_up=stat.isup,
                    speed_mbps=stat.speed if stat.speed > 0 else None,
                    addresses=readable_addresses,
                )
            )
        return interfaces

    def _find_pid_by_endpoint(self, endpoint: str) -> int | None:
        try:
            parsed = urlparse(endpoint)
        except ValueError:
            return None

        host = (parsed.hostname or "").lower()
        port = parsed.port
        if port is None:
            return None
        if host not in LOCAL_ENDPOINT_HOSTS and not host.startswith("127."):
            return None

        try:
            connections = psutil.net_connections(kind="tcp")
        except (psutil.AccessDenied, OSError):
            return None

        for connection in connections:
            local_address = connection.laddr
            local_port = getattr(local_address, "port", None)
            local_host = (getattr(local_address, "ip", "") or "").lower()
            if connection.pid and connection.status == psutil.CONN_LISTEN and local_port == port:
                if not local_host or local_host in LOCAL_ENDPOINT_HOSTS or local_host.startswith("127."):
                    return connection.pid
        return None

    def _collect_process_tree(self, root_pid: int) -> list[psutil.Process]:
        try:
            root = psutil.Process(root_pid)
            children = root.children(recursive=True)
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            return []
        return [root, *children]

    def _process_cpu_rate(self, pid: int, cpu_seconds: float, now: datetime) -> float:
        with self._model_resource_lock:
            previous = self._model_cpu_samples.get(pid)
            self._model_cpu_samples[pid] = (now, cpu_seconds)

        if not previous:
            return 0.0
        previous_at, previous_cpu_seconds = previous
        elapsed = max((now - previous_at).total_seconds(), 0.001)
        delta_cpu = max(0.0, cpu_seconds - previous_cpu_seconds)
        return (delta_cpu / elapsed) * 100

    def _process_io_rates(self, pid: int, read_bytes: int, write_bytes: int, now: datetime) -> tuple[float, float]:
        with self._model_resource_lock:
            previous = self._model_io_samples.get(pid)
            self._model_io_samples[pid] = (now, read_bytes, write_bytes)

        if not previous:
            return 0.0, 0.0
        previous_at, previous_read_bytes, previous_write_bytes = previous
        elapsed = max((now - previous_at).total_seconds(), 0.001)
        read_rate = max(0.0, (read_bytes - previous_read_bytes) / BYTES_IN_MB / elapsed)
        write_rate = max(0.0, (write_bytes - previous_write_bytes) / BYTES_IN_MB / elapsed)
        return read_rate, write_rate

    def _wsl_process_io_rates(self, key: str, read_bytes: int, write_bytes: int, now: datetime) -> tuple[float, float]:
        with self._model_resource_lock:
            previous = self._wsl_io_samples.get(key)
            self._wsl_io_samples[key] = (now, read_bytes, write_bytes)

        if not previous:
            return 0.0, 0.0
        previous_at, previous_read_bytes, previous_write_bytes = previous
        elapsed = max((now - previous_at).total_seconds(), 0.001)
        read_rate = max(0.0, (read_bytes - previous_read_bytes) / BYTES_IN_MB / elapsed)
        write_rate = max(0.0, (write_bytes - previous_write_bytes) / BYTES_IN_MB / elapsed)
        return read_rate, write_rate

    def _model_port(self, model: ModelConfig) -> int | None:
        metadata_port = model.metadata.get("port")
        if isinstance(metadata_port, int):
            return metadata_port
        if isinstance(metadata_port, str) and metadata_port.isdigit():
            return int(metadata_port)

        try:
            parsed = urlparse(model.endpoint)
        except ValueError:
            return None
        if parsed.port is not None:
            return parsed.port

        for command_part in model.launch.command:
            match = re.search(r"--port\s+(\d+)", command_part)
            if match:
                return int(match.group(1))
        return None

    def _get_process_snapshots(self) -> tuple[list[ProcessMetric], list[ProcessMetric]]:
        with self._process_lock:
            should_refresh = (datetime.utcnow() - self._process_cache_at).total_seconds() > 15
            if should_refresh and not self._process_refreshing:
                self._process_refreshing = True
                threading.Thread(target=self._refresh_process_cache, daemon=True).start()
            return list(self._top_process_cache), list(self._model_process_cache)

    def _refresh_process_cache(self) -> None:
        try:
            top_processes, model_processes = self._read_process_snapshots()
            with self._process_lock:
                self._top_process_cache = top_processes
                self._model_process_cache = model_processes
                self._process_cache_at = datetime.utcnow()
        finally:
            with self._process_lock:
                self._process_refreshing = False

    def _read_process_snapshots(self) -> tuple[list[ProcessMetric], list[ProcessMetric]]:
        processes: list[ProcessMetric] = []
        model_processes: list[ProcessMetric] = []
        for process in psutil.process_iter(["pid", "name", "memory_percent", "memory_info", "status", "cmdline"]):
            try:
                info = process.info
                command = " ".join(info.get("cmdline") or [])
                name = info.get("name") or f"pid-{info['pid']}"
                haystack = f"{name} {command}".lower()
                memory_info = info.get("memory_info")
                metric = ProcessMetric(
                    pid=info["pid"],
                    name=name,
                    cpu_percent=round(process.cpu_percent(interval=None), 1),
                    memory_percent=round(float(info.get("memory_percent") or 0), 2),
                    memory_mb=round((memory_info.rss if memory_info else 0) / BYTES_IN_MB, 1),
                    status=info.get("status"),
                    command=command[:240] if command else None,
                )
                processes.append(metric)
                if any(hint in haystack for hint in MODEL_PROCESS_HINTS):
                    model_processes.append(metric)
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                continue

        return (
            sorted(processes, key=lambda item: (item.cpu_percent, item.memory_percent), reverse=True)[:10],
            sorted(model_processes, key=lambda item: (item.cpu_percent, item.memory_percent), reverse=True)[:10],
        )

    @staticmethod
    def _optional_float(value: str) -> float | None:
        normalized = value.strip()
        if not normalized or normalized.upper() in {"N/A", "[N/A]", "NOT SUPPORTED"}:
            return None
        try:
            return round(float(normalized), 1)
        except ValueError:
            return None
