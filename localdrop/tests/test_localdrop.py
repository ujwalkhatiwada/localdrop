import pytest
from fastapi.testclient import TestClient
from localdrop.app.main import app
from localdrop.app.config import settings
from localdrop.app.auth import pairing_manager, active_sessions

client = TestClient(app)

def test_health_check():
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service"] == "LocalDrop"

def test_unauthorized_file_access():
    response = client.get("/api/files")
    assert response.status_code == 401

def test_pairing_flow_and_session_cookie():
    secret = pairing_manager.secret
    response = client.post("/api/pair", json={"secret": secret})
    assert response.status_code == 200
    data = response.json()
    assert data["success"] is True
    session_id = data["session_id"]
    assert session_id in active_sessions

    # Access files with paired session
    headers = {"Authorization": f"Bearer {session_id}"}
    files_res = client.get("/api/files", headers=headers)
    assert files_res.status_code == 200
    assert "files" in files_res.json()

def test_invalid_pairing_secret():
    response = client.post("/api/pair", json={"secret": "WRONG_SECRET"})
    assert response.status_code == 400

def test_path_traversal_rejection():
    secret = pairing_manager.secret
    pair_res = client.post("/api/pair", json={"secret": secret})
    session_id = pair_res.json()["session_id"]
    headers = {"Authorization": f"Bearer {session_id}"}

    # Attempt directory traversal in file_id
    response = client.get("/api/files/../../etc/passwd/download", headers=headers)
    assert response.status_code in [400, 404]

def test_stop_sharing_rejects_paired_clients():
    secret = pairing_manager.secret
    pair_res = client.post("/api/pair", json={"secret": secret})
    session_id = pair_res.json()["session_id"]
    headers = {"Authorization": f"Bearer {session_id}"}

    # Host halts sharing
    client.post("/api/admin/toggle-sharing", json={"active": False})
    
    # Request should be rejected with 503
    response = client.get("/api/files", headers=headers)
    assert response.status_code == 503

    # Restore sharing
    client.post("/api/admin/toggle-sharing", json={"active": True})
