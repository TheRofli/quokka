from enum import StrEnum


class ProviderType(StrEnum):
    WSL_LLAMA_CPP = "wsl_llama_cpp"
    WINDOWS_LLAMA_CPP = "windows_llama_cpp"
    OLLAMA = "ollama"
    OPENAI_COMPATIBLE = "openai_compatible"


class ModelStatus(StrEnum):
    STOPPED = "stopped"
    STARTING = "starting"
    RUNNING = "running"
    WARMING = "warming"
    STOPPING = "stopping"
    UNHEALTHY = "unhealthy"
    CRASHED = "crashed"
    ERROR = "error"
