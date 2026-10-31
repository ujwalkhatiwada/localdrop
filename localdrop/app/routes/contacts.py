import re
from fastapi import APIRouter, Depends, HTTPException, status
from localdrop.app.auth import get_current_session, SessionData
from localdrop.app.config import settings
from localdrop.app.database import get_file_metadata

router = APIRouter(prefix="/api/files", tags=["Contacts Preview"])

MAX_VCF_SIZE = 5 * 1024 * 1024  # 5 MiB max size for in-memory preview
MAX_CONTACTS = 500

@router.get("/{file_id}/contacts-preview")
def preview_contacts(file_id: str, session: SessionData = Depends(get_current_session)):
    if not re.match(r"^file_[a-f0-9]+$", file_id):
        raise HTTPException(status_code=400, detail="Invalid file identifier.")

    meta = get_file_metadata(file_id)
    if not meta:
        raise HTTPException(status_code=404, detail="File metadata not found.")

    file_path = settings.uploads_dir / file_id
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found.")

    if file_path.stat().st_size > MAX_VCF_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Contact file is too large for web preview (> 5 MiB). Download file directly."
        )

    try:
        raw_text = file_path.read_text(encoding="utf-8", errors="replace")
        # Unfold lines (RFC 6350)
        unfolded = re.sub(r"\r?\n[ \t]", "", raw_text)
        lines = unfolded.splitlines()

        contacts = []
        current = None
        count = 0

        for line in lines:
            line = line.strip()
            if not line:
                continue

            if line.upper() == "BEGIN:VCARD":
                current = {
                    "fn": "",
                    "phones": [],
                    "emails": [],
                    "org": "",
                    "title": "",
                    "note": ""
                }
                continue

            if line.upper() == "END:VCARD":
                if current and (current["fn"] or current["phones"]):
                    contacts.append({
                        "fn": current["fn"] or "Unnamed Contact",
                        "phones": current["phones"],
                        "emails": current["emails"],
                        "org": current["org"],
                        "title": current["title"],
                        "note": current["note"]
                    })
                    count += 1
                    if count >= MAX_CONTACTS:
                        break
                current = None
                continue

            if not current or ":" not in line:
                continue

            header, value = line.split(":", 1)
            value = value[:300].strip()  # Enforce field length limit
            parts = header.split(";")
            prop = parts[0].upper()

            if prop == "FN":
                current["fn"] = value
            elif prop == "TEL":
                type_label = "Mobile"
                for p in parts[1:]:
                    p_upper = p.upper()
                    if "WORK" in p_upper: type_label = "Work"
                    elif "HOME" in p_upper: type_label = "Home"
                    elif "CELL" in p_upper: type_label = "Cell"
                current["phones"].append({"type": type_label, "value": value})
            elif prop == "EMAIL":
                type_label = "Personal"
                for p in parts[1:]:
                    if "WORK" in p.upper(): type_label = "Work"
                current["emails"].append({"type": type_label, "value": value})
            elif prop == "ORG":
                current["org"] = value.replace(";", " - ")
            elif prop == "TITLE":
                current["title"] = value
            elif prop == "NOTE":
                current["note"] = value

        # Duplicate candidate detection (cautious phone & name match)
        phone_counts = {}
        name_counts = {}
        for c in contacts:
            norm_name = re.sub(r"[^a-zA-Z0-9]", "", c["fn"].lower())
            if norm_name:
                name_counts[norm_name] = name_counts.get(norm_name, 0) + 1
            for p in c["phones"]:
                digits = re.sub(r"[^0-9]", "", p["value"])[-10:]
                if len(digits) >= 7:
                    phone_counts[digits] = phone_counts.get(digits, 0) + 1

        dups_count = 0
        for c in contacts:
            norm_name = re.sub(r"[^a-zA-Z0-9]", "", c["fn"].lower())
            has_dup = False
            if norm_name and name_counts.get(norm_name, 0) > 1:
                has_dup = True
            for p in c["phones"]:
                digits = re.sub(r"[^0-9]", "", p["value"])[-10:]
                if len(digits) >= 7 and phone_counts.get(digits, 0) > 1:
                    has_dup = True
            c["is_possible_duplicate"] = has_dup
            if has_dup:
                dups_count += 1

        return {
            "filename": meta["original_name"],
            "total_contacts": len(contacts),
            "duplicate_candidates_count": dups_count,
            "contacts": contacts[:200],
            "truncated": len(contacts) > 200,
            "import_guidance": {
                "ios": "On iPhone: Download the .vcf file, tap it in Safari Downloads/Files, then tap 'Add all contacts' into Contacts app.",
                "android": "On Android: Download file, open Contacts app > Settings > Import from .vcf file.",
                "windows_mac": "On PC/Mac: Double-click downloaded .vcf file to import into Windows People or Apple Contacts."
            }
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse vCard: {str(e)}")
