import time
import secrets
import string
from fastapi import Request, HTTPException, status
from localdrop.app.config import settings

# Characters excluding ambiguous glyphs (0, O, 1, I)
PIN_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

class SessionData:
    def __init__(self, session_id: str, client_ip: str, user_agent: str, device_label: str):
        self.session_id = session_id
        self.client_ip = client_ip
        self.user_agent = user_agent
        self.device_label = device_label
        self.created_at = time.time()
        self.expires_at = time.time() + settings.session_lifespan_seconds
        self.last_active = time.time()

# In-memory session and challenge state
active_sessions: dict[str, SessionData] = {}
failed_attempts: dict[str, dict] = {}

class PairingManager:
    def __init__(self):
        self.secret = self._generate_secret()
        self.expires_at = time.time() + settings.pairing_code_lifespan_seconds

    def _generate_secret(self) -> str:
        return "".join(secrets.choice(PIN_CHARS) for _ in range(6))

    def regenerate(self) -> str:
        self.secret = self._generate_secret()
        self.expires_at = time.time() + settings.pairing_code_lifespan_seconds
        return self.secret

    def is_valid(self, candidate: str) -> bool:
        if time.time() > self.expires_at:
            return False
        return secrets.compare_digest(candidate.strip().upper(), self.secret)

pairing_manager = PairingManager()

def parse_device_label(user_agent: str) -> str:
    ua = user_agent.lower()
    if "iphone" in ua:
        return "iPhone (Safari)"
    if "ipad" in ua:
        return "iPad (Safari)"
    if "android" in ua:
        return "Android Phone"
    if "macintosh" in ua or "mac os" in ua:
        return "MacBook / Mac"
    if "windows" in ua:
        return "Windows PC"
    return "Mobile / Browser Device"

def get_current_session(request: Request) -> SessionData:
    if not settings.sharing_active:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LocalDrop sharing has been stopped by the PC host."
        )

    # Check HttpOnly cookie or Authorization Bearer header
    session_id = request.cookies.get("localdrop_session")
    if not session_id:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            session_id = auth_header[7:].strip()

    if not session_id or session_id not in active_sessions:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid paired session is required to access shared files."
        )

    session = active_sessions[session_id]
    if time.time() > session.expires_at:
        del active_sessions[session_id]
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Pairing session has expired. Please re-pair."
        )

    session.last_active = time.time()
    return session
