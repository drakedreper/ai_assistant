from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import markdown

from . import config


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                label TEXT NOT NULL,
                source TEXT NOT NULL,
                note TEXT,
                md_path TEXT NOT NULL,
                html_path TEXT,
                md_sha TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                meta_json TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )


def md_to_html(md_text: str, title: str = "Sigurd G. Tenfjord — CV") -> str:
    body = markdown.markdown(
        md_text,
        extensions=["tables", "fenced_code", "smarty", "sane_lists"],
    )
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    :root {{
      --ink: #14212b;
      --muted: #5a6b76;
      --line: #d7e0e6;
      --paper: #f7f4ef;
      --accent: #0f6e6a;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: var(--ink);
      background: var(--paper);
      font-family: "Source Serif 4", "Iowan Old Style", Georgia, serif;
      line-height: 1.55;
    }}
    .page {{
      max-width: 820px;
      margin: 0 auto;
      padding: 48px 28px 72px;
    }}
    h1 {{
      font-family: "Fraunces", Georgia, serif;
      font-weight: 600;
      font-size: 2.4rem;
      letter-spacing: -0.02em;
      margin: 0 0 0.35rem;
    }}
    h2 {{
      font-family: "Fraunces", Georgia, serif;
      font-size: 1.25rem;
      margin: 2rem 0 0.75rem;
      padding-bottom: 0.35rem;
      border-bottom: 1px solid var(--line);
      color: var(--accent);
    }}
    h3 {{
      font-size: 1.05rem;
      margin: 1.25rem 0 0.25rem;
    }}
    p, li {{ font-size: 0.98rem; }}
    blockquote {{
      margin: 1rem 0;
      padding: 0.2rem 0 0.2rem 1rem;
      border-left: 3px solid var(--accent);
      color: var(--muted);
      font-style: italic;
    }}
    a {{ color: var(--accent); }}
    table {{
      width: 100%;
      border-collapse: collapse;
      margin: 0.75rem 0 1.25rem;
      font-size: 0.95rem;
    }}
    th, td {{
      text-align: left;
      padding: 0.4rem 0.55rem;
      border-bottom: 1px solid var(--line);
    }}
    hr {{
      border: 0;
      border-top: 1px solid var(--line);
      margin: 1.5rem 0;
    }}
    strong {{ font-weight: 650; }}
    @media print {{
      body {{ background: white; }}
      .page {{ padding: 0; max-width: none; }}
    }}
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap" rel="stylesheet" />
</head>
<body>
  <article class="page">
{body}
  </article>
</body>
</html>
"""


def read_current_md() -> str:
    if not config.CURRENT_MD.exists():
        config.CURRENT_MD.write_text("# Curriculum Vitae\n\n_Empty draft._\n", encoding="utf-8")
    return config.CURRENT_MD.read_text(encoding="utf-8")


def write_current(md_text: str, *, label: str, source: str, note: str | None = None) -> dict[str, Any]:
    md_text = md_text.replace("\r\n", "\n").strip() + "\n"
    sha = hashlib.sha256(md_text.encode("utf-8")).hexdigest()[:16]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safe_label = re.sub(r"[^a-zA-Z0-9_-]+", "-", label).strip("-").lower() or "snapshot"
    md_name = f"{stamp}-{safe_label}.md"
    html_name = f"{stamp}-{safe_label}.html"
    md_path = config.ARCHIVE_DIR / md_name
    html_path = config.ARCHIVE_DIR / html_name

    html = md_to_html(md_text)
    config.CURRENT_MD.write_text(md_text, encoding="utf-8")
    config.CURRENT_HTML.write_text(html, encoding="utf-8")
    md_path.write_text(md_text, encoding="utf-8")
    html_path.write_text(html, encoding="utf-8")

    created = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO versions (created_at, label, source, note, md_path, html_path, md_sha)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (created, label, source, note, str(md_path), str(html_path), sha),
        )
        version_id = cur.lastrowid

    return {
        "id": version_id,
        "created_at": created,
        "label": label,
        "source": source,
        "note": note,
        "md_sha": sha,
        "md_path": str(md_path.relative_to(config.ARCHIVE_DIR.parent.parent)),
        "html_path": str(html_path.relative_to(config.ARCHIVE_DIR.parent.parent)),
    }


def ensure_seed_version() -> None:
    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM versions").fetchone()["c"]
    if count:
        # Keep current HTML in sync even if DB already has history.
        md = read_current_md()
        config.CURRENT_HTML.write_text(md_to_html(md), encoding="utf-8")
        return
    write_current(
        read_current_md(),
        label="seed-linkedin-draft",
        source="seed",
        note="Initial draft seeded from public LinkedIn profile for Sigurd G. Tenfjord.",
    )


def list_versions(limit: int = 100) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, label, source, note, md_path, html_path, md_sha
            FROM versions
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["md_path"] = _rel(item["md_path"])
        item["html_path"] = _rel(item["html_path"]) if item["html_path"] else None
        out.append(item)
    return out


def get_version(version_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM versions WHERE id = ?",
            (version_id,),
        ).fetchone()
    if not row:
        return None
    item = dict(row)
    md_path = Path(item["md_path"])
    markdown_text = md_path.read_text(encoding="utf-8") if md_path.exists() else ""
    item["markdown"] = markdown_text
    item["html"] = md_to_html(markdown_text) if markdown_text else ""
    item["md_path"] = _rel(item["md_path"])
    item["html_path"] = _rel(item["html_path"]) if item["html_path"] else None
    return item


def restore_version(version_id: int) -> dict[str, Any]:
    version = get_version(version_id)
    if not version:
        raise ValueError(f"Version {version_id} not found")
    return write_current(
        version["markdown"],
        label=f"restore-v{version_id}",
        source="restore",
        note=f"Restored from version {version_id} ({version['label']})",
    )


def add_chat_message(role: str, content: str, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    created = utc_now()
    meta_json = json.dumps(meta or {})
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO chat_messages (created_at, role, content, meta_json) VALUES (?, ?, ?, ?)",
            (created, role, content, meta_json),
        )
        msg_id = cur.lastrowid
    return {"id": msg_id, "created_at": created, "role": role, "content": content, "meta": meta or {}}


def list_chat(limit: int = 100) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, role, content, meta_json
            FROM chat_messages
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    out = []
    for row in rows:
        out.append(
            {
                "id": row["id"],
                "created_at": row["created_at"],
                "role": row["role"],
                "content": row["content"],
                "meta": json.loads(row["meta_json"] or "{}"),
            }
        )
    return out


def clear_chat() -> None:
    with connect() as conn:
        conn.execute("DELETE FROM chat_messages")


def _rel(path: str) -> str:
    try:
        return str(Path(path).resolve().relative_to(config.DB_PATH.parent.resolve()))
    except Exception:
        return path


def extract_plain_text_from_html(html: str) -> str:
    text = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style.*?>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
