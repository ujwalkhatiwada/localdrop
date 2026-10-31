import time
import uuid
from fastapi import APIRouter, Request, Response, HTTPException, status
from pydantic import BaseModel
from localdrop.app.auth import (
    pairing_manager,
    active_sessions,
    failed_attempts,
    SessionData,
    parse_device_label
)
from localdrop.app.config import settings

router = APIRouter(prefix="/api", tags=["Pairing"])

class PairRequest(BaseModel):
    secret: str

@router.post("/pair")
def pair_client(payload: PairRequest, request: Request, response: Response):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()

    # Rate limiting on failed attempts
    attempt = failed_attempts.get(client_ip, {"count": 0, "locked_until": 0})
    if attempt["locked_until"] > now:
        wait_seconds = int(attempt["locked_until"] - now)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Too many failed attempts. Try again in {wait_seconds} seconds."
        )

    if not settings.sharing_active:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sharing is currently stopped on the host PC."
        )

    if not pairing_manager.is_valid(payload.secret):
        attempt["count"] += 1
        if attempt["count"] >= settings.max_pairing_attempts:
            attempt["locked_until"] = now + settings.pairing_lockout_seconds
        failed_attempts[client_ip] = attempt
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired pairing code."
        )

    # Reset attempt counter on success
    if client_ip in failed_attempts:
        del failed_attempts[client_ip]

    session_id = uuid.uuid4().hex
    ua = request.headers.get("user-agent", "")
    device_label = parse_device_label(ua)

    session = SessionData(
        session_id=session_id,
        client_ip=client_ip,
        user_agent=ua,
        device_label=device_label
    )
    active_sessions[session_id] = session

    # Set HttpOnly SameSite cookie
    response.set_cookie(
        key="localdrop_session",
        value=session_id,
        httponly=True,
        samesite="lax",
        max_age=settings.session_lifespan_seconds,
        path="/"
    )

    return {
        "success": True,
        "session_id": session_id,
        "device_label": device_label,
        "expires_in": settings.session_lifespan_seconds
    }

@router.post("/logout")
def logout_client(request: Request, response: Response):
    session_id = request.cookies.get("localdrop_session")
    if session_id and session_id in active_sessions:
        del active_sessions[session_id]
    response.delete_cookie(key="localdrop_session", path="/")
    return {"success": True}
