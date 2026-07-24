from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, store
from .config import (
    CURRENT_HTML,
    CURRENT_MD,
    FRONTEND_DIR,
    OPENAI_BASE_URL,
    OPENAI_MODEL,
    UPLOAD_DIR,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.init_db()
    store.ensure_seed_version()
    yield


app = FastAPI(title="AI CV Assistant", version="0.1.0", lifespan=lifespan)


class SaveRequest(BaseModel):
    markdown: str
    label: str = "manual-save"
    note: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    apply: bool = True
    label: str = "ai-edit"


class RestoreRequest(BaseModel):
    version_id: int


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "ai_enabled": ai.ai_available(),
        "model": OPENAI_MODEL if ai.ai_available() else None,
        "base_url": OPENAI_BASE_URL if ai.ai_available() else None,
    }


@app.get("/api/cv")
def get_cv() -> dict:
    md = store.read_current_md()
    return {
        "markdown": md,
        "html": store.md_to_html(md),
        "paths": {
            "markdown": str(CURRENT_MD.name),
            "html": str(CURRENT_HTML.name),
        },
    }


@app.put("/api/cv")
def save_cv(payload: SaveRequest) -> dict:
    version = store.write_current(
        payload.markdown,
        label=payload.label,
        source="manual",
        note=payload.note,
    )
    return {"ok": True, "version": version, "html": store.md_to_html(payload.markdown)}


@app.get("/api/versions")
def versions() -> dict:
    return {"versions": store.list_versions()}


@app.get("/api/versions/{version_id}")
def version_detail(version_id: int) -> dict:
    version = store.get_version(version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    return version


@app.post("/api/versions/restore")
def restore(payload: RestoreRequest) -> dict:
    try:
        version = store.restore_version(payload.version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    md = store.read_current_md()
    return {"ok": True, "version": version, "markdown": md, "html": store.md_to_html(md)}


@app.get("/api/chat")
def chat_history() -> dict:
    return {"messages": store.list_chat()}


@app.delete("/api/chat")
def chat_clear() -> dict:
    store.clear_chat()
    return {"ok": True}


@app.post("/api/chat")
def chat(payload: ChatRequest) -> dict:
    current = store.read_current_md()
    history = [
        {"role": m["role"], "content": m["content"]}
        for m in store.list_chat()
        if m["role"] in {"user", "assistant"}
    ]
    store.add_chat_message("user", payload.message)
    result = ai.chat_edit(payload.message, current, history)
    meta = {
        "provider": result.get("provider"),
        "model": result.get("model"),
        "applied": False,
    }
    version = None
    updated = result.get("updated_markdown")
    if payload.apply and updated and updated.strip() and updated.strip() != current.strip():
        version = store.write_current(
            updated,
            label=payload.label,
            source="ai",
            note=payload.message[:240],
        )
        meta["applied"] = True
        meta["version_id"] = version["id"]
        current = updated

    assistant = store.add_chat_message("assistant", result["reply"], meta)
    return {
        "message": assistant,
        "reply": result["reply"],
        "updated_markdown": updated,
        "applied": meta["applied"],
        "version": version,
        "markdown": current,
        "html": store.md_to_html(current),
        "provider": result.get("provider"),
        "model": result.get("model"),
        "ai_enabled": ai.ai_available(),
    }


@app.post("/api/import")
async def import_file(file: UploadFile = File(...), label: str | None = None) -> dict:
    name = file.filename or "upload"
    raw = await file.read()
    text = raw.decode("utf-8", errors="replace")
    suffix = Path(name).suffix.lower()

    dest = UPLOAD_DIR / name
    dest.write_bytes(raw)

    if suffix in {".md", ".markdown", ".txt"}:
        md = text
        source = "import-md"
    elif suffix in {".html", ".htm"}:
        plain = store.extract_plain_text_from_html(text)
        md = (
            f"# Imported from {name}\n\n"
            "_Converted from HTML (structure simplified). Review and refine._\n\n"
            f"{plain}\n"
        )
        source = "import-html"
    else:
        raise HTTPException(status_code=400, detail="Supported: .md, .markdown, .txt, .html, .htm")

    version = store.write_current(
        md,
        label=label or f"import-{Path(name).stem}",
        source=source,
        note=f"Imported from {name}",
    )
    return {
        "ok": True,
        "version": version,
        "markdown": md,
        "html": store.md_to_html(md),
        "original_saved_as": str(dest.name),
    }


@app.get("/api/export/markdown")
def export_md() -> FileResponse:
    return FileResponse(CURRENT_MD, filename=CURRENT_MD.name, media_type="text/markdown")


@app.get("/api/export/html")
def export_html() -> FileResponse:
    if not CURRENT_HTML.exists():
        CURRENT_HTML.write_text(store.md_to_html(store.read_current_md()), encoding="utf-8")
    return FileResponse(CURRENT_HTML, filename=CURRENT_HTML.name, media_type="text/html")


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        return HTMLResponse("<h1>AI CV Assistant</h1><p>Frontend missing.</p>", status_code=500)
    return HTMLResponse(index_path.read_text(encoding="utf-8"))
