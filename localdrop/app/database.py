import sqlite3
from typing import Optional
from localdrop.app.config import settings

def get_db():
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                original_name TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                mime_type TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                uploader_device TEXT NOT NULL,
                is_vcard INTEGER DEFAULT 0
            )
        """)
        conn.commit()

def insert_file(file_id: str, original_name: str, size_bytes: int, mime_type: str, uploaded_at: str, uploader_device: str, is_vcard: bool = False):
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO files (id, original_name, size_bytes, mime_type, uploaded_at, uploader_device, is_vcard)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (file_id, original_name, size_bytes, mime_type, uploaded_at, uploader_device, 1 if is_vcard else 0)
        )
        conn.commit()

def list_files() -> list[dict]:
    with get_db() as conn:
        cursor = conn.execute("SELECT * FROM files ORDER BY uploaded_at DESC")
        rows = cursor.fetchall()
        return [dict(row) for row in rows]

def get_file_metadata(file_id: str) -> Optional[dict]:
    with get_db() as conn:
        cursor = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,))
        row = cursor.fetchone()
        return dict(row) if row else None

def delete_file_metadata(file_id: str) -> bool:
    with get_db() as conn:
        cursor = conn.execute("DELETE FROM files WHERE id = ?", (file_id,))
        conn.commit()
        return cursor.rowcount > 0

def get_total_storage_used() -> int:
    with get_db() as conn:
        cursor = conn.execute("SELECT COALESCE(SUM(size_bytes), 0) FROM files")
        return cursor.fetchone()[0]
