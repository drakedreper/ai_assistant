from __future__ import annotations

import json
import re
from typing import Any

from openai import OpenAI

from .config import OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL


SYSTEM_PROMPT = """You are an expert CV / resume editor for Sigurd G. Tenfjord.

Goals:
- Keep content truthful; never invent employers, degrees, dates, or certifications.
- Prefer concise, achievement-oriented bullet points.
- Preserve the existing Markdown structure unless asked to restructure.
- When applying edits, return the FULL updated Markdown CV.
- Speak briefly and clearly to the user about what you changed.

Response format (strict):
1) A short natural-language reply to the user (2–6 sentences).
2) Then a fenced markdown block containing the complete updated CV:

```markdown
...full cv...
```

If the user only asks a question and does not want edits, omit the fenced markdown block.
"""


def ai_available() -> bool:
    return bool(OPENAI_API_KEY)


def _client() -> OpenAI:
    return OpenAI(api_key=OPENAI_API_KEY, base_url=OPENAI_BASE_URL)


def chat_edit(message: str, current_md: str, history: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Return assistant reply and optional updated markdown."""
    if not ai_available():
        return _offline_assist(message, current_md)

    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for item in (history or [])[-12:]:
        if item.get("role") in {"user", "assistant"} and item.get("content"):
            messages.append({"role": item["role"], "content": item["content"]})

    messages.append(
        {
            "role": "user",
            "content": (
                "Current CV Markdown:\n\n"
                f"```markdown\n{current_md}\n```\n\n"
                f"User request:\n{message}"
            ),
        }
    )

    completion = _client().chat.completions.create(
        model=OPENAI_MODEL,
        messages=messages,
        temperature=0.3,
    )
    reply = completion.choices[0].message.content or ""
    updated = _extract_markdown_block(reply)
    visible = _strip_markdown_block(reply).strip() or "Done."
    return {
        "reply": visible,
        "updated_markdown": updated,
        "provider": "openai",
        "model": OPENAI_MODEL,
    }


def _extract_markdown_block(text: str) -> str | None:
    match = re.search(r"```(?:markdown|md)\s*\n(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if match:
        return match.group(1).strip() + "\n"
    # Fallback: any triple-backtick block that looks like a CV
    match = re.search(r"```\s*\n(# .+?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip() + "\n"
    return None


def _strip_markdown_block(text: str) -> str:
    return re.sub(r"```(?:markdown|md)?\s*\n.*?```", "", text, flags=re.DOTALL | re.IGNORECASE)


def _offline_assist(message: str, current_md: str) -> dict[str, Any]:
    """Useful local heuristics when no API key is configured."""
    lower = message.lower().strip()

    if any(k in lower for k in ("summary", "profile", "about", "headline")):
        tip = (
            "No API key configured, so I can't rewrite automatically. "
            "For a stronger profile, lead with role + domain (e.g. Dynamics 365 / Microsoft Cloud), "
            "then one line on outcomes you create for clients."
        )
        return {"reply": tip, "updated_markdown": None, "provider": "offline", "model": None}

    cert_match = re.search(
        r"(?:add|include)\s+(?:cert(?:ification)?\s+)?(.+)$",
        message,
        re.IGNORECASE,
    )
    if cert_match and "## Certifications" in current_md:
        cert = cert_match.group(1).strip().rstrip(".")
        if cert:
            updated = current_md
            block = f"- {cert}\n"
            if block.strip() not in current_md:
                updated = current_md.replace(
                    "## Certifications\n\n",
                    f"## Certifications\n\n{block}",
                    1,
                )
            return {
                "reply": f"Added certification locally (offline mode): {cert}. Set OPENAI_API_KEY for richer edits.",
                "updated_markdown": updated,
                "provider": "offline",
                "model": None,
            }

    if "tailor" in lower or "job" in lower or "role" in lower:
        return {
            "reply": (
                "Offline mode: paste the job description and set OPENAI_API_KEY to tailor the CV. "
                "Meanwhile, prioritize Dynamics 365 / CX / AI certs and consulting impact bullets near the top."
            ),
            "updated_markdown": None,
            "provider": "offline",
            "model": None,
        }

    checklist = {
        "has_summary": bool(re.search(r"^>", current_md, re.M)),
        "sections": re.findall(r"^## (.+)$", current_md, re.M),
        "experience_roles": len(re.findall(r"^### ", current_md, re.M)),
        "word_count": len(current_md.split()),
    }
    return {
        "reply": (
            "AI is offline (no OPENAI_API_KEY). I can still version, import, export, and apply simple local edits.\n\n"
            f"Quick CV scan: {json.dumps(checklist)}\n\n"
            "Add an API key in `.env`, then ask things like: "
            "“Tighten the Vivicta bullets”, “Add Azure AI Engineer cert”, or “Tailor for a D365 CE role”."
        ),
        "updated_markdown": None,
        "provider": "offline",
        "model": None,
    }
