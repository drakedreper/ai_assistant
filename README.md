# AI CV Assistant

Local-first workspace for creating, versioning, and updating **Sigurd G. Tenfjord**'s CV with an AI editing assistant.

## What you get

- Markdown source of truth + styled HTML preview/export
- Automatic version archive on every save / AI edit / import / restore
- Chat assistant that can rewrite sections, add certs, or tailor for a role
- Import for older CV drafts (`.md` / `.html`)

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env   # optional: add OPENAI_API_KEY
./scripts/run.sh
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

Without an API key the app still works for editing, versioning, import/export, and a few offline heuristics. With `OPENAI_API_KEY` set, the assistant uses the configured OpenAI-compatible model.

## Your drafts

This environment did not receive the local files you mentioned:

- `Sigurd-Tenfjord-CV-draft.html`
- `Sigurd-Tenfjord-CV-draft.md`
- older CV copies from another folder

A **seed draft** was created from public LinkedIn profile data at:

- `data/cv/Sigurd-Tenfjord-CV-draft.md`

Import your real drafts via the UI (**Import CV**) or copy them into `data/cv/` / use the import API.

## Layout

```
backend/app/     FastAPI API (CV, versions, chat, import/export)
frontend/static/ Single-page workspace UI
data/cv/         Current CV + archive/
data/uploads/    Original imported files
```

## Useful API routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cv` | Current markdown + HTML |
| PUT | `/api/cv` | Save + archive version |
| GET | `/api/versions` | Version history |
| POST | `/api/versions/restore` | Restore a version |
| POST | `/api/chat` | Ask the assistant |
| POST | `/api/import` | Upload `.md` / `.html` |
| GET | `/api/export/html` | Download HTML |
| GET | `/api/export/markdown` | Download Markdown |
