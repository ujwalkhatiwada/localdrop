import socket

def get_candidate_lan_ips() -> list[str]:
    """
    Find candidate local IPv4 addresses (e.g. 192.168.x.x, 10.x.x.x).
    Never returns 0.0.0.0 as a candidate destination.
    """
    candidates = []
    try:
        # Retrieve system host candidates
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127.") and ":" not in ip:
                candidates.append(ip)
    except Exception:
        pass

    # Method 2: Dummy socket connection without transmitting data
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            active_ip = s.getsockname()[0]
            if active_ip and active_ip not in candidates and not active_ip.startswith("127."):
                candidates.insert(0, active_ip)
    except Exception:
        pass

    if not candidates:
        candidates.append("127.0.0.1")

    return candidates
