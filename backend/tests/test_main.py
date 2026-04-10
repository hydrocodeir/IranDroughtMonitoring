from fastapi.testclient import TestClient

import app.main as main
from app.main import app, parse_month, rounded_bbox_key


client = TestClient(app)


def test_parse_month_valid_and_invalid():
    assert parse_month("2024-03").strftime("%Y-%m-%d") == "2024-03-01"
    assert parse_month("bad") is None


def test_rounded_bbox_key():
    assert rounded_bbox_key("1.12345,2.34567,3.98765,4.54321") == "1.123,2.346,3.988,4.543"


def test_standardized_http_error_shape():
    original = main.list_datasets
    try:
        def _boom():
            raise RuntimeError("boom")

        main.list_datasets = _boom
        response = client.get("/datasets")
    finally:
        main.list_datasets = original

    assert response.status_code == 503
    payload = response.json()
    assert "error" in payload
    assert payload["error"]["code"] == "dataset_registry_unavailable"
    assert payload["error"]["path"] == "/datasets"
