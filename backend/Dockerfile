FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gdal-bin libgdal-dev libproj-dev proj-data proj-bin build-essential \
    && rm -rf /var/lib/apt/lists/*

# Use uv-managed virtual environment instead of raw pip installs
ENV PIP_DEFAULT_TIMEOUT=300 \
    PIP_RETRIES=10 \
    UV_HTTP_TIMEOUT=300
RUN pip install --no-cache-dir uv
COPY backend/requirements.txt /app/requirements.txt
RUN uv venv /opt/venv \
    && . /opt/venv/bin/activate \
    && uv pip install -r /app/requirements.txt

COPY backend /app/backend
COPY data /app/data

RUN useradd -m -u 10001 appuser \
    && chown -R appuser:appuser /app /opt/venv

USER appuser
ENV PYTHONPATH=/app/backend
ENV PATH="/opt/venv/bin:${PATH}"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
