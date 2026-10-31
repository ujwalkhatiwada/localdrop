import time
from fastapi import APIRouter
from pydantic import BaseModel
from localdrop.app.auth import pairing_manager, active_sessions
from localdrop.app.config import settings
from localdrop.app.network import get_candidate_lan_ips
from localdrop.app.database import get_total_storage_used

router = APIRouter(prefix="/api/admin", tags=["Host Admin"])

class SharingToggleRequest(BaseModel):
    active: bool

class NetworkConfigRequest(BaseModel):
    advertise_ip: str

class RevokeSessionRequest(BaseModel):
    session_id: str

@router.get("/status")
def get_admin_status():
    now = time.time()
    remaining = max(0, int(pairing_manager.expires_at - now))
    candidate_ips = get_candidate_lan_ips()
    total_used = get_total_storage_used()

    sessions = [
        {
            "session_id": s.session_id,
            "client_ip": s.client_ip,
            "device_label": s.device_label,
            "connected_ago": int(now - s.created_at),
            "expires_in": max(0, int(s.expires_at - now)),
        }
        for s in active_sessions.values()
    ]

    return {
        "sharing_active": settings.sharing_active,
        "pairing_secret": pairing_manager.secret,
        "pairing_expires_in_seconds": remaining,
        "advertise_ip": settings.advertise_ip,
        "candidate_ips": candidate_ips,
        "port": settings.port,
        "max_file_size": settings.max_file_size_bytes,
        "max_total_storage": settings.max_total_storage_bytes,
        "total_storage_used": total_used,
        "active_sessions": sessions
    }

@router.post("/toggle-sharing")
def toggle_sharing(payload: SharingToggleRequest):
    settings.sharing_active = payload.active
    return {"sharing_active": settings.sharing_active}

@router.post("/regenerate-invite")
def regenerate_invite():
    new_secret = pairing_manager.regenerate()
    return {
        "secret": new_secret,
        "expires_in_seconds": settings.pairing_code_lifespan_seconds
    }

@router.post("/configure-network")
def configure_network(payload: NetworkConfigRequest):
    settings.advertise_ip = payload.advertise_ip.strip()
    return {"advertise_ip": settings.advertise_ip}

@router.post("/revoke-session")
def revoke_session(payload: RevokeSessionRequest):
    if payload.session_id in active_sessions:
        del active_sessions[payload.session_id]
        return {"success": True}
    return {"success": False, "detail": "Session not found"}

@router.post("/revoke-all")
def revoke_all():
    count = len(active_sessions)
    active_sessions.clear()
    return {"success": True, "revoked_count": count}
