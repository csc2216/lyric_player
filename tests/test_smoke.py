from fastapi.testclient import TestClient

from app.api.routes import get_library
from app.main import app
from app.services.library import Library

client = TestClient(app)


def test_library_empty(tmp_path):
    app.dependency_overrides[get_library] = lambda: Library(tmp_path)
    try:
        res = client.get("/api/library")
    finally:
        app.dependency_overrides.clear()
    assert res.status_code == 200
    assert res.json() == []


def test_index_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "歌詞播放器" in res.text
