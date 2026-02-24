import os
from celery import Celery

celery_app = Celery(
    "drought_tasks",
    broker=os.getenv("CELERY_BROKER_URL", "redis://redis:6379/1"),
    backend=os.getenv("CELERY_RESULT_BACKEND", "redis://redis:6379/2"),
)
celery_app.conf.task_routes = {"app.tasks.*": {"queue": "drought"}}
