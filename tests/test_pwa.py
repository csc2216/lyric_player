"""PWA files are served and the service worker caches everything the app needs offline."""

import json
import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

STATIC = Path(__file__).resolve().parent.parent / "static"
client = TestClient(app, base_url="http://localhost:8765")


def shell_list() -> list[str]:
    sw = (STATIC / "sw.js").read_text(encoding="utf-8")
    block = sw[sw.index("const SHELL = [") : sw.index("];", sw.index("const SHELL = ["))]
    return re.findall(r'"([^"]+)"', block)


def test_service_worker_caches_every_module():
    shell = set(shell_list())
    modules = {f"/js/{p.name}" for p in (STATIC / "js").glob("*.js")}
    assert modules - shell == set(), "add new modules to SHELL in static/sw.js"
    assert {"/", "/index.html", "/style.css", "/manifest.json"} <= shell


def test_shell_files_exist_and_are_served():
    for path in shell_list():
        res = client.get(path)
        assert res.status_code == 200, path


def test_manifest():
    manifest = json.loads((STATIC / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["display"] == "standalone"
    assert manifest["start_url"] == "/"
    sizes = {i["sizes"] for i in manifest["icons"]}
    assert {"192x192", "512x512"} <= sizes
    assert any(i.get("purpose") == "maskable" for i in manifest["icons"])
    for icon in manifest["icons"]:
        assert (STATIC / icon["src"].lstrip("/")).is_file()


def test_index_links_pwa_bits():
    html = client.get("/").text
    for needle in ['rel="manifest"', 'rel="apple-touch-icon"', "apple-mobile-web-app-capable", "viewport-fit=cover"]:
        assert needle in html


def test_service_worker_served_as_javascript_at_root():
    res = client.get("/sw.js")
    assert res.status_code == 200
    assert "javascript" in res.headers["content-type"]
