from __future__ import annotations

import json
import threading
from pathlib import Path

import yaml

from app.core.errors import BadRequestError, NotFoundError
from app.schemas.config import AppConfig, ModelConfig, ProfileConfig


class ConfigService:
    def __init__(self, config_path: Path) -> None:
        self._config_path = config_path
        self._lock = threading.RLock()
        self._config = self._load()

    def _load(self) -> AppConfig:
        if not self._config_path.exists():
            example_path = self._config_path.with_name("quokka.example.yaml")
            self._config_path.parent.mkdir(parents=True, exist_ok=True)
            if example_path.exists():
                self._config_path.write_text(example_path.read_text(encoding="utf-8"), encoding="utf-8")
            else:
                self._config_path.write_text(
                    "app_name: Quokka\nversion: 0.2.0\nrefresh_interval_seconds: 5\nmodels: []\n",
                    encoding="utf-8",
                )

        raw = self._config_path.read_text(encoding="utf-8")
        payload = yaml.safe_load(raw) if self._config_path.suffix in {".yaml", ".yml"} else json.loads(raw)
        return AppConfig.model_validate(payload or {})

    def _save(self) -> None:
        serialized = self._config.model_dump(mode="json")
        self._config_path.parent.mkdir(parents=True, exist_ok=True)

        if self._config_path.suffix in {".yaml", ".yml"}:
            self._config_path.write_text(
                yaml.safe_dump(serialized, sort_keys=False, allow_unicode=True),
                encoding="utf-8",
            )
        else:
            self._config_path.write_text(json.dumps(serialized, indent=2), encoding="utf-8")

    def get_config(self) -> AppConfig:
        with self._lock:
            return self._config.model_copy(deep=True)

    def replace_config(self, config: AppConfig) -> AppConfig:
        with self._lock:
            self._config = config.model_copy(deep=True)
            self._save()
            return self._config.model_copy(deep=True)

    def list_models(self) -> list[ModelConfig]:
        with self._lock:
            return [model.model_copy(deep=True) for model in self._config.models]

    def get_model(self, model_id: str) -> ModelConfig:
        with self._lock:
            for model in self._config.models:
                if model.id == model_id:
                    return model.model_copy(deep=True)
        raise NotFoundError(f"Model '{model_id}' was not found.")

    def _replace_model(self, updated: ModelConfig) -> None:
        for index, model in enumerate(self._config.models):
            if model.id == updated.id:
                self._config.models[index] = updated
                return
        raise NotFoundError(f"Model '{updated.id}' was not found.")

    def update_model(self, updated: ModelConfig) -> ModelConfig:
        with self._lock:
            self._replace_model(updated)
            self._save()
            return updated.model_copy(deep=True)

    def create_model(self, model: ModelConfig) -> ModelConfig:
        with self._lock:
            if any(existing.id == model.id for existing in self._config.models):
                raise BadRequestError(f"Model '{model.id}' already exists.")
            self._config.models.append(model)
            self._save()
            return model.model_copy(deep=True)

    def delete_model(self, model_id: str) -> None:
        with self._lock:
            remaining = [model for model in self._config.models if model.id != model_id]
            if len(remaining) == len(self._config.models):
                raise NotFoundError(f"Model '{model_id}' was not found.")
            self._config.models = remaining
            self._save()

    def list_profiles(self, model_id: str) -> list[ProfileConfig]:
        model = self.get_model(model_id)
        return [profile.model_copy(deep=True) for profile in model.profiles]

    def create_profile(self, model_id: str, profile: ProfileConfig) -> ProfileConfig:
        with self._lock:
            model = self.get_model(model_id)
            if any(existing.id == profile.id for existing in model.profiles):
                raise BadRequestError(f"Profile '{profile.id}' already exists for model '{model_id}'.")
            model.profiles.append(profile)
            if not model.active_profile_id:
                model.active_profile_id = profile.id
            self._replace_model(model)
            self._save()
            return profile.model_copy(deep=True)

    def update_profile(self, model_id: str, profile_id: str, profile: ProfileConfig) -> ProfileConfig:
        with self._lock:
            model = self.get_model(model_id)
            replaced = False
            for index, existing in enumerate(model.profiles):
                if existing.id == profile_id:
                    model.profiles[index] = profile
                    replaced = True
                    break
            if not replaced:
                raise NotFoundError(f"Profile '{profile_id}' was not found for model '{model_id}'.")
            if model.active_profile_id == profile_id:
                model.active_profile_id = profile.id
            self._replace_model(model)
            self._save()
            return profile.model_copy(deep=True)

    def delete_profile(self, model_id: str, profile_id: str) -> None:
        with self._lock:
            model = self.get_model(model_id)
            remaining = [profile for profile in model.profiles if profile.id != profile_id]
            if len(remaining) == len(model.profiles):
                raise NotFoundError(f"Profile '{profile_id}' was not found for model '{model_id}'.")
            model.profiles = remaining
            if model.active_profile_id == profile_id:
                model.active_profile_id = remaining[0].id if remaining else None
            self._replace_model(model)
            self._save()

    def activate_profile(self, model_id: str, profile_id: str) -> ProfileConfig:
        with self._lock:
            model = self.get_model(model_id)
            profile = next((item for item in model.profiles if item.id == profile_id), None)
            if profile is None:
                raise NotFoundError(f"Profile '{profile_id}' was not found for model '{model_id}'.")
            model.active_profile_id = profile.id
            self._replace_model(model)
            self._save()
            return profile.model_copy(deep=True)
