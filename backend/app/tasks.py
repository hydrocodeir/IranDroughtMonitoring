from .celery_app import celery_app
from .database import SessionLocal
from .models import TimeSeries
from .utils import mann_kendall_and_sen


@celery_app.task

def compute_kpi_task(region_id: int, index_name: str):
    db = SessionLocal()
    try:
        series = (
            db.query(TimeSeries)
            .filter(TimeSeries.region_id == region_id)
            .order_by(TimeSeries.date)
            .all()
        )
        values = [float(getattr(s, index_name)) for s in series]
        if not values:
            return {"error": "no data"}
        trend = mann_kendall_and_sen(values)
        return {
            "region_id": region_id,
            "index": index_name,
            "min": min(values),
            "max": max(values),
            "mean": sum(values) / len(values),
            "trend": trend,
        }
    finally:
        db.close()
