from pathlib import Path
import os
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.getenv("CV_ASSISTANT_DATA_DIR", str(ROOT / "data"))).resolve()
CV_DIR = DATA_DIR / "cv"
ARCHIVE_DIR = CV_DIR / "archive"
UPLOAD_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "assistant.db"
FRONTEND_DIR = ROOT / "frontend" / "static"

CURRENT_MD = CV_DIR / "Sigurd-Tenfjord-CV-draft.md"
CURRENT_HTML = CV_DIR / "Sigurd-Tenfjord-CV-draft.html"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

for path in (CV_DIR, ARCHIVE_DIR, UPLOAD_DIR):
    path.mkdir(parents=True, exist_ok=True)
