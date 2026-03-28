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


from unittest.mock import AsyncMock, patch


def test_browse_success():
    client = get_client()
    mock_result = {
        "markdown": "# Hello World\nSome content here.",
        "title": "Hello World",
        "url": "https://example.com",
    }
    with patch("main.crawl_url", new=AsyncMock(return_value=mock_result)):
        response = client.post("/browse", json={"url": "https://example.com"})
    assert response.status_code == 200
    data = response.json()
    assert data["markdown"] == "# Hello World\nSome content here."
    assert data["title"] == "Hello World"
    assert data["url"] == "https://example.com"


def test_browse_with_wait_for():
    client = get_client()
    mock_result = {"markdown": "content", "title": "Page", "url": "https://example.com"}
    with patch("main.crawl_url", new=AsyncMock(return_value=mock_result)):
        response = client.post("/browse", json={"url": "https://example.com", "wait_for": "#main"})
    assert response.status_code == 200


def test_browse_propagates_error():
    client = get_client()
    with patch("main.crawl_url", new=AsyncMock(side_effect=RuntimeError("Crawl failed"))):
        response = client.post("/browse", json={"url": "https://example.com"})
    assert response.status_code == 500
    assert "Crawl failed" in response.json()["error"]
