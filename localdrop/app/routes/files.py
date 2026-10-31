import re
import datetime
from pathlib import Path
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException, status
from fastapi.responses import FileResponse
from localdrop.app.auth import get_current_session, SessionData
from localdrop.app.config import settings
from localdrop.app.database import (
    list_files,
    get_file_metadata,
    insert_file,
    delete_file_metadata,
    get_total_storage_used
)
from localdrop.app.storage import save_uploaded_file

router = APIRouter(prefix="/api/files", tags=["Files"])

@router.get("")
def get_shared_files(session: SessionData = Depends(get_current_session)):
    files = list_files()
    total_used = get_total_storage_used()
    return {
        "files": files,
        "total_storage_used": total_used,
        "max_total_storage": settings.max_total_storage_bytes,
        "max_file_size": settings.max_file_size_bytes
    }

@router.post("")
def upload_file(
    file: UploadFile = File(...),
    session: SessionData = Depends(get_current_session)
):
    original_name = Path(file.filename or "unnamed_file").name
    # Strip dangerous characters
    safe_name = re.sub(r'[\0\r\n\t]', '', original_name).strip() or "unnamed_file"

    file_id, size_bytes = save_uploaded_file(file)

    is_vcard = safe_name.lower().endswith(".vcf") or safe_name.lower().endswith(".vcard")
    uploaded_at = datetime.datetime.now(datetime.timezone.utc).isoformat()

    insert_file(
        file_id=file_id,
        original_name=safe_name,
        size_bytes=size_bytes,
        mime_type=file.content_type or "application/octet-stream",
        uploaded_at=uploaded_at,
        uploader_device=session.device_label,
        is_vcard=is_vcard
    )

    return {
        "success": True,
        "file": {
            "id": file_id,
            "original_name": safe_name,
            "size_bytes": size_bytes,
            "uploaded_at": uploaded_at,
            "is_vcard": is_vcard
        }
    }

@router.get("/{file_id}/download")
def download_file(file_id: str, session: SessionData = Depends(get_current_session)):
    # Validate alphanumeric identifier format to prevent directory traversal
    if not re.match(r"^file_[a-f0-9]+$", file_id):
        raise HTTPException(status_code=400, detail="Invalid file identifier.")

    meta = get_file_metadata(file_id)
    if not meta:
        raise HTTPException(status_code=404, detail="File metadata not found.")

    target_path = settings.uploads_dir / file_id
    if not target_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk.")

    return FileResponse(
        path=target_path,
        filename=meta["original_name"],
        media_type="application/octet-stream",
        headers={
            "X-Content-Type-Options": "nosniff"
        }
    )

@router.delete("/{file_id}")
def delete_file(file_id: str, session: SessionData = Depends(get_current_session)):
    if not re.match(r"^file_[a-f0-9]+$", file_id):
        raise HTTPException(status_code=400, detail="Invalid file identifier.")

    target_path = settings.uploads_dir / file_id
    if target_path.exists():
        target_path.unlink()

    delete_file_metadata(file_id)
    return {"success": True}
