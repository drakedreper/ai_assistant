from __future__ import annotations

import os
from pathlib import Path

import pytest

# Isolate all test IO before importing the app package modules that bind paths.
TEST_DATA = Path("/tmp/cv-assistant-test-data")
os.environ["CV_ASSISTANT_DATA_DIR"] = str(TEST_DATA)


@pytest.fixture(autouse=True)
def _isolated_data(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data_dir = tmp_path / "data"
    monkeypatch.setenv("CV_ASSISTANT_DATA_DIR", str(data_dir))

    # Rebind config paths for this test.
    from app import config, store

    config.DATA_DIR = data_dir
    config.CV_DIR = data_dir / "cv"
    config.ARCHIVE_DIR = config.CV_DIR / "archive"
    config.UPLOAD_DIR = data_dir / "uploads"
    config.DB_PATH = data_dir / "assistant.db"
    config.CURRENT_MD = config.CV_DIR / "Sigurd-Tenfjord-CV-draft.md"
    config.CURRENT_HTML = config.CV_DIR / "Sigurd-Tenfjord-CV-draft.html"

    for path in (config.CV_DIR, config.ARCHIVE_DIR, config.UPLOAD_DIR):
        path.mkdir(parents=True, exist_ok=True)

    seed = """# Sigurd G. Tenfjord

## Experience

### Senior Consultant — Vivicta

## Certifications

- Microsoft Certified: Azure AI Fundamentals
"""
    config.CURRENT_MD.write_text(seed, encoding="utf-8")
    store.init_db()
    store.write_current(seed, label="test-seed", source="test", note="fixture")
    yield


from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def test_health() -> None:
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["ok"] is True


def test_get_cv() -> None:
    res = client.get("/api/cv")
    assert res.status_code == 200
    body = res.json()
    assert "Sigurd" in body["markdown"]
    assert "<html" in body["html"]


def test_save_and_version() -> None:
    before = client.get("/api/versions").json()["versions"]
    md = client.get("/api/cv").json()["markdown"] + "\n\n## Notes\n\n- Test note\n"
    res = client.put("/api/cv", json={"markdown": md, "label": "test-save", "note": "unit"})
    assert res.status_code == 200
    after = client.get("/api/versions").json()["versions"]
    assert len(after) >= len(before) + 1
    assert after[0]["label"] == "test-save"


def test_offline_chat_add_cert() -> None:
    res = client.post(
        "/api/chat",
        json={"message": "Add certification Microsoft Certified: Something New", "apply": True},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["provider"] == "offline"
    assert "Microsoft Certified: Something New" in body["markdown"]


def test_import_markdown() -> None:
    files = {"file": ("old-cv.md", b"# Old CV\n\nHello from archive.\n", "text/markdown")}
    res = client.post("/api/import", files=files)
    assert res.status_code == 200
    assert "Hello from archive" in res.json()["markdown"]
