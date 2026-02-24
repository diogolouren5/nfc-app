import os
import time
import threading
import sqlite3
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# -------------------------------------------------
# CONFIG
# -------------------------------------------------

HOST = "127.0.0.1"
PORT = 3210
INACTIVITY_TIMEOUT = 0  # 0 = no auto-shutdown
STATION_ONLINE_TTL_SECONDS = int(os.getenv("STATION_ONLINE_TTL_SECONDS", "20"))
MAX_EVENTS_PER_STATION = int(os.getenv("MAX_EVENTS_PER_STATION", "2000"))
SHARED_TOKEN = os.getenv("NFC_SHARED_TOKEN")
LOCAL_ONLY_MODE = os.getenv("NFC_LOCAL_ONLY_MODE", "1") == "1"
LOCAL_STATION_ID = os.getenv("NFC_LOCAL_STATION_ID", "local-station")

# -------------------------------------------------
# APP INIT
# -------------------------------------------------

app = FastAPI(title="NFC Central API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

last_request_time = time.time()
stations_lock = threading.Lock()

stations: dict[str, dict[str, Any]] = {}
station_events: dict[str, list[dict[str, Any]]] = {}
global_event_id = 0
evacuation_db_lock = threading.Lock()
EVAC_DB_PATH = os.path.join(os.path.dirname(__file__), "evacuation_sessions.db")


class ReaderHeartbeatIn(BaseModel):
    station_id: str = Field(min_length=1, max_length=120)
    reader_connected: bool = False
    agent_version: str | None = None
    hostname: str | None = None
    timestamp: str | None = None


class ReaderEventIn(BaseModel):
    station_id: str = Field(min_length=1, max_length=120)
    uid: str = Field(min_length=1, max_length=120)
    timestamp: str | None = None


class EvacuationMemberIn(BaseModel):
    employee_number: str = Field(min_length=1, max_length=120)
    full_name: str = ""
    emergency_role: str = ""
    access_full_name: str = ""
    email: str = ""
    phone: str = ""
    area: str = ""
    sub_area: str = ""
    department: str = ""


class EvacuationSessionCreateIn(BaseModel):
    members: list[EvacuationMemberIn]
    metadata: dict[str, Any] | None = None


class EvacuationAcknowledgeIn(BaseModel):
    employee_number: str = Field(min_length=1, max_length=120)
    acknowledged: bool = True
    ack_source: str | None = "operator"


class EvacuationBulkAcknowledgeIn(BaseModel):
    employee_numbers: list[str] = Field(default_factory=list)
    ack_source: str | None = "operator"


class EvacuationMemberConfirmIn(BaseModel):
    employee_number: str = Field(min_length=1, max_length=120)

# -------------------------------------------------
# UTILS
# -------------------------------------------------

def update_activity():
    global last_request_time
    last_request_time = time.time()


def parse_iso_or_none(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_token(request: Request) -> str | None:
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()
    return request.headers.get("X-API-Token")


def require_shared_token_if_configured(request: Request) -> None:
    if not SHARED_TOKEN:
        return
    client_token = extract_token(request)
    if client_token != SHARED_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


def sanitize_uid(uid: str) -> str:
    return uid.strip().upper()


def normalize_station_id(station_id: str) -> str:
    station = station_id.strip()
    if LOCAL_ONLY_MODE:
        return LOCAL_STATION_ID
    return station


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(EVAC_DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_evacuation_db() -> None:
    with evacuation_db_lock:
        conn = get_db_conn()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS evacuation_sessions (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    metadata_json TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS evacuation_session_members (
                    session_id TEXT NOT NULL,
                    employee_number TEXT NOT NULL,
                    full_name TEXT NOT NULL,
                    emergency_role TEXT NOT NULL,
                    access_full_name TEXT NOT NULL,
                    email TEXT NOT NULL,
                    phone TEXT NOT NULL,
                    area TEXT NOT NULL,
                    sub_area TEXT NOT NULL,
                    department TEXT NOT NULL,
                    ack_status TEXT NOT NULL,
                    ack_at TEXT,
                    ack_source TEXT,
                    PRIMARY KEY (session_id, employee_number),
                    FOREIGN KEY (session_id) REFERENCES evacuation_sessions(session_id) ON DELETE CASCADE
                )
                """
            )
            conn.commit()
        finally:
            conn.close()


def serialize_evacuation_session(session_id: str) -> dict[str, Any]:
    conn = get_db_conn()
    try:
        session = conn.execute(
            "SELECT session_id, status, created_at, updated_at, metadata_json FROM evacuation_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if not session:
            raise HTTPException(status_code=404, detail="Evacuation session not found")

        members_rows = conn.execute(
            """
            SELECT employee_number, full_name, emergency_role, access_full_name, email, phone, area, sub_area, department,
                   ack_status, ack_at, ack_source
            FROM evacuation_session_members
            WHERE session_id = ?
            ORDER BY employee_number
            """,
            (session_id,),
        ).fetchall()
    finally:
        conn.close()

    members = [dict(r) for r in members_rows]
    ack_count = sum(1 for m in members if m["ack_status"] == "acknowledged")
    total_count = len(members)
    pending_count = max(0, total_count - ack_count)
    try:
        metadata = json.loads(session["metadata_json"] or "{}")
    except json.JSONDecodeError:
        metadata = {}

    return {
        "session_id": session["session_id"],
        "status": session["status"],
        "created_at": session["created_at"],
        "updated_at": session["updated_at"],
        "metadata": metadata,
        "summary": {
            "total": total_count,
            "acknowledged": ack_count,
            "pending": pending_count,
            "ack_percent": round((ack_count / total_count) * 100, 1) if total_count else 0,
        },
        "members": members,
    }


def set_evacuation_member_ack(
    session_id: str,
    employee_number: str,
    acknowledged: bool,
    ack_source: str | None,
) -> dict[str, Any]:
    now_iso = utc_now_iso()
    ack_status = "acknowledged" if acknowledged else "pending"
    ack_at = now_iso if acknowledged else None
    ack_source_value = (ack_source or "operator").strip()[:120]

    with evacuation_db_lock:
        conn = get_db_conn()
        try:
            cur = conn.execute(
                """
                UPDATE evacuation_session_members
                SET ack_status = ?, ack_at = ?, ack_source = ?
                WHERE session_id = ? AND employee_number = ?
                """,
                (
                    ack_status,
                    ack_at,
                    ack_source_value if acknowledged else None,
                    session_id,
                    employee_number.strip(),
                ),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Member not found in session")

            cur2 = conn.execute(
                "UPDATE evacuation_sessions SET updated_at = ? WHERE session_id = ?",
                (now_iso, session_id),
            )
            if cur2.rowcount == 0:
                raise HTTPException(status_code=404, detail="Evacuation session not found")
            conn.commit()
        finally:
            conn.close()

    return serialize_evacuation_session(session_id)


# -------------------------------------------------
# ENDPOINTS
# -------------------------------------------------

@app.get("/api/health")
def health():
    update_activity()
    return {"status": "ok"}


@app.post("/api/reader-heartbeat")
def reader_heartbeat(payload: ReaderHeartbeatIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)
    station_id = normalize_station_id(payload.station_id)

    now = datetime.now(timezone.utc)
    client_ts = parse_iso_or_none(payload.timestamp)

    with stations_lock:
        stations[station_id] = {
            "station_id": station_id,
            "reader_connected": payload.reader_connected,
            "agent_version": payload.agent_version,
            "hostname": payload.hostname,
            "client_timestamp": client_ts.isoformat() if client_ts else None,
            "last_seen": now,
            "last_seen_iso": now.isoformat(),
        }

    return {
        "status": "ok",
        "station_id": station_id,
        "server_time": now.isoformat(),
    }


@app.post("/api/reader-events")
def reader_event(payload: ReaderEventIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)

    station_id = normalize_station_id(payload.station_id)
    uid = sanitize_uid(payload.uid)
    now = datetime.now(timezone.utc)
    client_ts = parse_iso_or_none(payload.timestamp)

    global global_event_id
    with stations_lock:
        global_event_id += 1

        # Ensure station exists/updates even if heartbeat is delayed.
        station_info = stations.get(station_id, {})
        station_info.update(
            {
                "station_id": station_id,
                "reader_connected": True,
                "last_seen": now,
                "last_seen_iso": now.isoformat(),
            }
        )
        stations[station_id] = station_info

        events = station_events.setdefault(station_id, [])
        event_obj = {
            "event_id": global_event_id,
            "station_id": station_id,
            "uid": uid,
            "client_timestamp": client_ts.isoformat() if client_ts else None,
            "server_timestamp": now.isoformat(),
        }
        events.append(event_obj)
        if len(events) > MAX_EVENTS_PER_STATION:
            del events[: len(events) - MAX_EVENTS_PER_STATION]

    return {"status": "ok", "event_id": global_event_id}


@app.get("/api/stations/{station_id}/status")
def station_status(station_id: str):
    update_activity()
    now = datetime.now(timezone.utc)
    effective_station_id = normalize_station_id(station_id)

    with stations_lock:
        station = stations.get(effective_station_id)
        if not station:
            return {
                "station_id": effective_station_id,
                "online": False,
                "reader_connected": False,
                "last_seen": None,
                "agent_version": None,
                "hostname": None,
                "server_time": now.isoformat(),
            }

        last_seen_dt: datetime | None = station.get("last_seen")
        is_online = (
            (now - last_seen_dt).total_seconds() <= STATION_ONLINE_TTL_SECONDS
            if last_seen_dt
            else False
        )

        return {
            "station_id": effective_station_id,
            "online": is_online,
            "reader_connected": bool(station.get("reader_connected", False)),
            "last_seen": station.get("last_seen_iso"),
            "agent_version": station.get("agent_version"),
            "hostname": station.get("hostname"),
            "server_time": now.isoformat(),
        }


@app.get("/api/stations/{station_id}/events")
def station_events_since(station_id: str, after_event_id: int = 0, limit: int = 100):
    update_activity()
    safe_limit = max(1, min(limit, 500))
    effective_station_id = normalize_station_id(station_id)

    with stations_lock:
        all_events = station_events.get(effective_station_id, [])
        new_events = [e for e in all_events if e["event_id"] > after_event_id]
        sliced_events = new_events[:safe_limit]
        last_event_id = after_event_id if not sliced_events else sliced_events[-1]["event_id"]

    return {
        "station_id": effective_station_id,
        "events": sliced_events,
        "last_event_id": last_event_id,
    }


@app.get("/api/stations")
def list_stations():
    update_activity()
    now = datetime.now(timezone.utc)
    result = []

    with stations_lock:
        for station_id, station in stations.items():
            last_seen_dt: datetime | None = station.get("last_seen")
            is_online = (
                (now - last_seen_dt).total_seconds() <= STATION_ONLINE_TTL_SECONDS
                if last_seen_dt
                else False
            )
            result.append(
                {
                    "station_id": station_id,
                    "online": is_online,
                    "reader_connected": bool(station.get("reader_connected", False)),
                    "last_seen": station.get("last_seen_iso"),
                    "agent_version": station.get("agent_version"),
                    "hostname": station.get("hostname"),
                }
            )

    return {"stations": sorted(result, key=lambda x: x["station_id"])}


@app.get("/api/agent/download-info")
def agent_download_info():
    update_activity()
    return {
        "download_url": os.getenv("NFC_AGENT_DOWNLOAD_URL", ""),
        "instructions": "Download and run the NFC Bridge installer, then click retry.",
    }


@app.post("/api/evacuation-sessions")
def create_evacuation_session(payload: EvacuationSessionCreateIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)

    if not payload.members:
        raise HTTPException(status_code=400, detail="members cannot be empty")

    session_id = f"evac-{uuid.uuid4().hex[:10]}"
    now_iso = utc_now_iso()
    metadata_json = json.dumps(payload.metadata or {}, ensure_ascii=False)

    unique_members: dict[str, EvacuationMemberIn] = {}
    for member in payload.members:
        emp = member.employee_number.strip()
        if not emp or emp in unique_members:
            continue
        unique_members[emp] = member

    with evacuation_db_lock:
        conn = get_db_conn()
        try:
            # Mantener una única sesión abierta simplifica el flujo de "sesión activa" para miembros.
            conn.execute(
                "UPDATE evacuation_sessions SET status = 'closed', updated_at = ? WHERE status = 'open'",
                (now_iso,),
            )
            conn.execute(
                """
                INSERT INTO evacuation_sessions (session_id, status, created_at, updated_at, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, "open", now_iso, now_iso, metadata_json),
            )
            conn.executemany(
                """
                INSERT INTO evacuation_session_members (
                    session_id, employee_number, full_name, emergency_role, access_full_name, email, phone,
                    area, sub_area, department, ack_status, ack_at, ack_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        session_id,
                        emp,
                        m.full_name or "",
                        m.emergency_role or "",
                        m.access_full_name or "",
                        m.email or "",
                        m.phone or "",
                        m.area or "",
                        m.sub_area or "",
                        m.department or "",
                        "pending",
                        None,
                        None,
                    )
                    for emp, m in unique_members.items()
                ],
            )
            conn.commit()
        finally:
            conn.close()

    return serialize_evacuation_session(session_id)


@app.get("/api/evacuation-sessions/active")
def get_active_evacuation_session():
    update_activity()
    conn = get_db_conn()
    try:
        row = conn.execute(
            """
            SELECT session_id
            FROM evacuation_sessions
            WHERE status = 'open'
            ORDER BY created_at DESC
            LIMIT 1
            """
        ).fetchone()
    finally:
        conn.close()

    if not row:
        raise HTTPException(status_code=404, detail="No active evacuation session")

    return serialize_evacuation_session(row["session_id"])


@app.get("/api/evacuation-sessions/{session_id}")
def get_evacuation_session(session_id: str):
    update_activity()
    return serialize_evacuation_session(session_id)


@app.post("/api/evacuation-sessions/{session_id}/acknowledge")
def acknowledge_evacuation_member(session_id: str, payload: EvacuationAcknowledgeIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)
    return set_evacuation_member_ack(
        session_id=session_id,
        employee_number=payload.employee_number,
        acknowledged=payload.acknowledged,
        ack_source=payload.ack_source or "operator",
    )


@app.post("/api/evacuation-sessions/{session_id}/member-confirm")
def member_confirm_evacuation(session_id: str, payload: EvacuationMemberConfirmIn):
    update_activity()
    # Endpoint pensado para miembros del equipo en un dispositivo distinto (sin token en MVP).
    return set_evacuation_member_ack(
        session_id=session_id,
        employee_number=payload.employee_number,
        acknowledged=True,
        ack_source="member",
    )


@app.post("/api/evacuation-sessions/{session_id}/acknowledge-bulk")
def acknowledge_evacuation_bulk(session_id: str, payload: EvacuationBulkAcknowledgeIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)
    numbers = [n.strip() for n in payload.employee_numbers if n and n.strip()]
    if not numbers:
        raise HTTPException(status_code=400, detail="employee_numbers cannot be empty")

    now_iso = utc_now_iso()
    ack_source = (payload.ack_source or "operator").strip()[:120]
    placeholders = ",".join("?" for _ in numbers)

    with evacuation_db_lock:
        conn = get_db_conn()
        try:
            conn.execute(
                f"""
                UPDATE evacuation_session_members
                SET ack_status = 'acknowledged', ack_at = ?, ack_source = ?
                WHERE session_id = ? AND employee_number IN ({placeholders})
                """,
                (now_iso, ack_source, session_id, *numbers),
            )
            conn.execute(
                "UPDATE evacuation_sessions SET updated_at = ? WHERE session_id = ?",
                (now_iso, session_id),
            )
            conn.commit()
        finally:
            conn.close()

    return serialize_evacuation_session(session_id)


@app.post("/shutdown")
def shutdown(request: Request):
    """
    Permite apagar el conector solo si la petición viene de localhost.
    """
    client_host = request.client.host
    if client_host != "127.0.0.1":
        return JSONResponse(status_code=403, content={"error": "Forbidden"})

    threading.Thread(target=force_shutdown).start()
    return {"status": "shutting_down"}


def force_shutdown():
    time.sleep(1)
    os._exit(0)


# -------------------------------------------------
# OPTIONAL INACTIVITY SHUTDOWN
# -------------------------------------------------

def inactivity_monitor():
    if INACTIVITY_TIMEOUT <= 0:
        return

    while True:
        if time.time() - last_request_time > INACTIVITY_TIMEOUT:
            os._exit(0)
        time.sleep(30)


app.mount("/", StaticFiles(directory="static", html=True), name="static")
init_evacuation_db()

# -------------------------------------------------
# ENTRY POINT
# -------------------------------------------------

if __name__ == "__main__":
    if INACTIVITY_TIMEOUT > 0:
        threading.Thread(target=inactivity_monitor, daemon=True).start()

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_config=None,
        access_log=False
    )
