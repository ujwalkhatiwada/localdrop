import uuid
import shutil
from pathlib import Path
from fastapi import UploadFile, HTTPException, status
from localdrop.app.config import settings
from localdrop.app.database import get_total_storage_used

CHUNK_SIZE = 64 * 1024  # 64 KiB chunks for bounded stream copying

def save_uploaded_file(file: UploadFile) -> tuple[str, int]:
    """
    Saves an uploaded file using bounded chunk copying to a temporary file,
    verifying per-file and total-storage limits on the fly.
    Atomically renames the file into place once finalized.
    Cleans up immediately on any quota breach or failure.
    """
    current_storage = get_total_storage_used()
    temp_id = f"tmp_{uuid.uuid4().hex}"
    temp_path = settings.uploads_dir / temp_id

    bytes_written = 0
    try:
        with open(temp_path, "wb") as buffer:
            while True:
                chunk = file.file.read(CHUNK_SIZE)
                if not chunk:
                    break
                bytes_written += len(chunk)

                # Check per-file quota
                if bytes_written > settings.max_file_size_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"File exceeds maximum allowed size of {settings.max_file_size_bytes // (1024*1024)} MiB"
                    )

                # Check total storage quota
                if current_storage + bytes_written > settings.max_total_storage_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
                        detail="Host total storage quota reached. Upload aborted."
                    )

                buffer.write(chunk)

        # Atomic finalization
        final_id = f"file_{uuid.uuid4().hex}"
        final_path = settings.uploads_dir / final_id
        temp_path.rename(final_path)

        return final_id, bytes_written

    except Exception:
        # Guarantee cleanup of partial file
        if temp_path.exists():
            temp_path.unlink()
        raise
