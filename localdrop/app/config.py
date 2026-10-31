import os
from pathlib import Path
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"

# Ensure directories exist
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

class Settings(BaseModel):
    max_file_size_bytes: int = 100 * 1024 * 1024  # 100 MiB
    max_total_storage_bytes: int = 1024 * 1024 * 1024  # 1 GiB
    pairing_code_lifespan_seconds: int = 300  # 5 minutes
    session_lifespan_seconds: int = 1800  # 30 minutes
    max_pairing_attempts: int = 5
    pairing_lockout_seconds: int = 60
    
    port: int = 8000
    host: str = "127.0.0.1"
    advertise_ip: str = "127.0.0.1"
    sharing_active: bool = True
    
    db_path: Path = DATA_DIR / "localdrop.sqlite3"
    uploads_dir: Path = UPLOADS_DIR

settings = Settings()
