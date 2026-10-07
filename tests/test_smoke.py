from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_library_empty():
    res = client.get("/api/library")
    assert res.status_code == 200
    assert res.json() == []


def test_index_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "歌詞播放器" in res.text
