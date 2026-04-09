import json
import os
import time
from collections.abc import Callable

from redis import Redis

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
_DEFAULT_TTL = 900


class InMemoryTTLCache:
    def __init__(self):
        self._store: dict[str, tuple[float, object]] = {}

    def get(self, key: str):
        item = self._store.get(key)
        if not item:
            return None
        expires_at, value = item
        if expires_at < time.time():
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value, ttl: int = _DEFAULT_TTL):
        self._store[key] = (time.time() + max(ttl, 1), value)


_memory_cache = InMemoryTTLCache()


def _build_redis_client() -> Redis | None:
    try:
        client = Redis.from_url(REDIS_URL, decode_responses=True)
        client.ping()
        return client
    except Exception:
        return None


redis_client = _build_redis_client()


def get_cache(key: str):
    if redis_client is not None:
        try:
            value = redis_client.get(key)
            if value:
                return json.loads(value)
        except Exception:
            pass
    return _memory_cache.get(key)


def set_cache(key: str, data, ttl: int = _DEFAULT_TTL):
    if redis_client is not None:
        try:
            redis_client.setex(key, ttl, json.dumps(data))
            return
        except Exception:
            pass
    _memory_cache.set(key, data, ttl)


def get_or_set_cache(key: str, builder: Callable[[], object], ttl: int = _DEFAULT_TTL):
    cached = get_cache(key)
    if cached is not None:
        return cached
    data = builder()
    set_cache(key, data, ttl)
    return data
