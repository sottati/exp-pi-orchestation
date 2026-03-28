import pytest
from fastapi.testclient import TestClient


def get_client():
    from main import app
    return TestClient(app)


def test_health():
    client = get_client()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
