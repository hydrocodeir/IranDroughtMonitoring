import json
import os
import time
from collections.abc import Callable
import logging

from redis import Redis

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
_DEFAULT_TTL = 900
logger = logging.getLogger(__name__)


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
        logger.info("Redis cache enabled", extra={"redis_url": REDIS_URL})
        return client
    except Exception:
        logger.warning("Redis unavailable; falling back to in-memory cache")
        return None


redis_client = _build_redis_client()


def get_cache(key: str):
    if redis_client is not None:
        try:
            value = redis_client.get(key)
            if value:
                return json.loads(value)
        except Exception:
            logger.exception("Redis get failed", extra={"cache_key": key})
    return _memory_cache.get(key)


def set_cache(key: str, data, ttl: int = _DEFAULT_TTL):
    if redis_client is not None:
        try:
            redis_client.setex(key, ttl, json.dumps(data))
            return
        except Exception:
            logger.exception("Redis set failed", extra={"cache_key": key, "ttl": ttl})
    _memory_cache.set(key, data, ttl)


def get_or_set_cache(key: str, builder: Callable[[], object], ttl: int = _DEFAULT_TTL):
    cached = get_cache(key)
    if cached is not None:
        return cached
    data = builder()
    set_cache(key, data, ttl)
    return data


def clear_cache(prefix: str | None = None) -> int:
    """Clear in-memory and redis cache entries.

    Returns approximate number of deleted redis keys (in-memory deletions are full clear).
    """
    deleted = 0
    if prefix:
        _memory_cache._store = {k: v for k, v in _memory_cache._store.items() if not k.startswith(prefix)}
    else:
        _memory_cache._store.clear()

    if redis_client is None:
        return deleted

    try:
        pattern = f"{prefix}*" if prefix else "*"
        pipe = redis_client.pipeline()
        for key in redis_client.scan_iter(match=pattern, count=500):
            pipe.delete(key)
            deleted += 1
        pipe.execute()
    except Exception:
        logger.exception("Redis cache clear failed", extra={"prefix": prefix})
    return deleted
