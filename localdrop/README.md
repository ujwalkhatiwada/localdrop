# LocalDrop

**LocalDrop** is a browser-based local-network (LAN) file-transfer application for Windows, iPhone, Android, and Mac. It turns your PC into a dedicated temporary sharing hub, allowing phones and other computers on the same Wi-Fi network to upload and download files through their web browser without requiring external cloud servers, mobile app store downloads, or account creation.

---

## 1. System Architecture

```text
Windows PC Host
│
├── FastAPI / Express Backend
│   ├── Pairing & Session Management (5-minute PIN challenge, 30-minute HttpOnly sessions)
│   ├── Bounded Streaming & Quota Guard (100 MiB/file, 1 GiB aggregate storage)
│   ├── Atomic Disk Finalization (Temp files renamed atomically on completion)
│   ├── Read-Only VCF / vCard Parser & Duplicate Candidate Detection
│   └── Host Administration Controls (Stop sharing, revoke sessions, LAN IP broadcast)
│
└── Responsive Web Frontend (Plain HTML/CSS/Tailwind + React)
          │
          │ Same Local Wi-Fi / LAN Network (e.g. 192.168.1.145:8000)
          │
          ├── iPhone: Safari (Camera QR scan -> Auto URL Fragment redemption)
          ├── Android: Chrome / Samsung Internet / Firefox
          └── Other Laptop / Desktop: Browser
```

---

## 2. Security Architecture & Threat Model

| Requirement | Implementation & Defense |
|---|---|
| **No Cloud Dependency** | All transfers stay inside the local router network. No CDN or external analytics. |
| **LAN Exposure Boundary** | Starts on loopback (`127.0.0.1`) by default; LAN binding requires explicit `--lan` flag (`0.0.0.0`). |
| **Address Safety** | Server never prints `0.0.0.0` as a destination; displays candidate LAN IPv4 addresses (e.g. `192.168.1.x`). |
| **Pairing Challenge** | Ephemeral, cryptographically random 6-character secret displayed on host PC terminal/screen. |
| **URL Fragment Secret** | Encoded in `#secret=...` fragment so it is never sent to the server in HTTP query logs or web proxies. Frontend immediately removes it from browser history via `history.replaceState`. |
| **Brute Force Protection** | Rate limiter locks out pairing attempts after 5 consecutive failed tries. |
| **Path Traversal Defense** | Files are stored under random identifiers (`file_...`); original filenames are preserved in metadata only. Download endpoints enforce strict regex identifier checking. |
| **Malicious Active Content** | Uploaded HTML or SVG files are delivered with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` to prevent browser script execution. |
| **Bounded Stream Quotas** | Incoming body size is checked before allocating memory or disk; temporary upload files are cleaned up immediately upon error or quota overflow. |
| **Host Stop Sharing** | The PC host can instantly halt sharing; all existing or new client requests receive `503 Service Unavailable`. |

---

## 3. Quick Start on Windows (PowerShell)

### Prerequisites
- Python 3.10 or higher
- PowerShell (Windows 10/11)

### Steps
1. Open PowerShell and navigate to the project directory:
   ```powershell
   cd localdrop
   ```
2. Run the quick start script:
   ```powershell
   .\run.ps1
   ```
   Or run manually:
   ```powershell
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install fastapi "uvicorn[standard]" python-multipart qrcode[pil] vobject httpx pytest
   python -m localdrop.app.main --lan --port 8000
   ```

3. Note the LAN address and 6-character PIN printed in the terminal:
   ```text
   [*] Bound Host:       0.0.0.0:8000
   [*] Share URL:        http://192.168.1.145:8000
   [*] Pairing Passcode: 7M2K9X (valid for 5 mins)
   ```

4. Open the displayed URL on your phone or scan the QR code!

---

## 4. Running Automated Tests

Run the test suite with Pytest:
```bash
pytest localdrop/tests/test_localdrop.py -v
```

Tests cover:
- Health check endpoint
- Unauthorized file listing rejection (401)
- PIN validation and session cookie generation
- Rate limiting on brute-force pairing attempts
- Directory traversal attempts (`/../../etc/passwd`)
- Host stop-sharing toggle (503 rejection)

---

## 5. Docker Packaging

Run as a container with persistent storage:

```bash
docker build -t localdrop:latest -f localdrop/Dockerfile .
docker run -d -p 8000:8000 -v localdrop_data:/app/data --name localdrop localdrop:latest
```

---

## 6. Troubleshooting

- **Phone cannot reach PC address**:
  - Ensure phone and PC are on the **exact same Wi-Fi network**.
  - Check Windows Firewall: allow Python or port 8000 through private networks.
  - Disable "Guest Network" or "AP Isolation / Client Isolation" in your router settings.
  - If using a VPN (e.g. Tailscale, NordVPN, Wireguard), ensure you select your physical Wi-Fi IP rather than the virtual adapter.
- **Why not localhost?**
  - `localhost` or `127.0.0.1` refers to the device itself. A phone opening `localhost` looks for a server running on the phone, not your PC. Always use the PC's LAN IP (e.g., `192.168.x.x`).
