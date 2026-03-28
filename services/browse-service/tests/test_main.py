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


def test_interact_success():
    client = get_client()
    mock_result = {
        "result": "Successfully logged in and navigated to reports.",
        "final_url": "https://example.com/reports",
    }
    with patch("main.interact_task", new=AsyncMock(return_value=mock_result)):
        response = client.post("/interact", json={
            "url": "https://example.com",
            "task": "Log in and go to reports",
        })
    assert response.status_code == 200
    data = response.json()
    assert data["result"] == "Successfully logged in and navigated to reports."
    assert data["final_url"] == "https://example.com/reports"


def test_interact_propagates_error():
    client = get_client()
    with patch("main.interact_task", new=AsyncMock(side_effect=RuntimeError("browser-use failed"))):
        response = client.post("/interact", json={
            "url": "https://example.com",
            "task": "do something",
        })
    assert response.status_code == 500
    assert "browser-use failed" in response.json()["error"]
