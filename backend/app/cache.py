import json
import os
from redis import Redis


REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
redis_client = Redis.from_url(REDIS_URL, decode_responses=True)


def get_cache(key: str):
    value = redis_client.get(key)
    if value:
        return json.loads(value)
    return None


def set_cache(key: str, data, ttl: int = 900):
    redis_client.setex(key, ttl, json.dumps(data))
