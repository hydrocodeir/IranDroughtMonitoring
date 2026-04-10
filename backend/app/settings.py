from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Iran Drought Monitoring API"
    app_env: str = Field(default="development", alias="APP_ENV")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")

    cors_origins: str = Field(
        default="http://localhost:8080,http://127.0.0.1:8080,http://localhost:3000,http://127.0.0.1:3000,http://drought.werifum.ir",
        alias="CORS_ORIGINS",
    )

    map_limit_default: int = Field(default=2000, alias="MAP_LIMIT_DEFAULT")
    map_limit_max: int = Field(default=10000, alias="MAP_LIMIT_MAX")

    cache_ttl_short_seconds: int = Field(default=300, alias="CACHE_TTL_SHORT_SECONDS")
    cache_ttl_medium_seconds: int = Field(default=900, alias="CACHE_TTL_MEDIUM_SECONDS")
    cache_ttl_long_seconds: int = Field(default=1800, alias="CACHE_TTL_LONG_SECONDS")
    cache_ttl_daily_seconds: int = Field(default=86400, alias="CACHE_TTL_DAILY_SECONDS")

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = AppSettings()
