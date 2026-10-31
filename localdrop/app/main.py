import argparse
import uvicorn
from pathlib import Path
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from localdrop.app.config import settings
from localdrop.app.database import init_db
from localdrop.app.network import get_candidate_lan_ips
from localdrop.app.auth import pairing_manager
from localdrop.app.routes import pairing, files, admin, contacts

app = FastAPI(
    title="LocalDrop",
    description="Browser-based local-network file-transfer application",
    version="1.0.0"
)

# Restrict CORS to same-origin / local hosts (no wildcard *)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        f"http://{settings.advertise_ip}:{settings.port}",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

# Size limiter middleware before multipart parsing
@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    if request.method == "POST" and request.url.path.startswith("/api/files"):
        content_length = request.headers.get("content-length")
        if content_length:
            length = int(content_length)
            if length > settings.max_file_size_bytes + 1024 * 1024:
                return Response(
                    content='{"detail": "Incoming payload exceeds maximum allowed file size"}',
                    status_code=413,
                    media_type="application/json"
                )
    return await call_next(request)

@app.on_event("startup")
def on_startup():
    init_db()

@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "LocalDrop",
        "sharing_active": settings.sharing_active
    }

# Include routes
app.include_router(pairing.router)
app.include_router(files.router)
app.include_router(admin.router)
app.include_router(contacts.router)

def run_cli():
    parser = argparse.ArgumentParser(description="LocalDrop: LAN File Transfer Server")
    parser.add_argument("--lan", action="store_true", help="Bind to 0.0.0.0 for LAN exposure (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--advertise-ip", type=str, default=None, help="Explicit IP printed/encoded for phone access")
    parser.add_argument("--storage-dir", type=str, default=None, help="Custom folder for shared files storage")

    args = parser.parse_args()

    settings.port = args.port
    if args.storage_dir:
        settings.uploads_dir = Path(args.storage_dir)
        settings.uploads_dir.mkdir(parents=True, exist_ok=True)

    if args.lan:
        settings.host = "0.0.0.0"
        candidates = get_candidate_lan_ips()
        settings.advertise_ip = args.advertise_ip if args.advertise_ip else candidates[0]
    else:
        settings.host = "127.0.0.1"
        settings.advertise_ip = "127.0.0.1"

    print("=" * 60)
    print(" LocalDrop - Local Area Network File Transfer")
    print("=" * 60)
    print(f"[*] Bound Host:       {settings.host}:{settings.port}")
    print(f"[*] Share URL:        http://{settings.advertise_ip}:{settings.port}")
    print(f"[*] Pairing Passcode: {pairing_manager.secret} (valid for 5 mins)")
    print(f"[*] Storage Dir:      {settings.uploads_dir}")
    print("=" * 60)
    print("[!] Security Note: LAN HTTP is unencrypted. Do not transfer secrets on untrusted Wi-Fi.")
    print("=" * 60)

    uvicorn.run(app, host=settings.host, port=settings.port)

if __name__ == "__main__":
    run_cli()
