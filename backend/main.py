import os
import time
import threading
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

    now = datetime.now(timezone.utc)
    client_ts = parse_iso_or_none(payload.timestamp)

    with stations_lock:
        stations[payload.station_id] = {
            "station_id": payload.station_id,
            "reader_connected": payload.reader_connected,
            "agent_version": payload.agent_version,
            "hostname": payload.hostname,
            "client_timestamp": client_ts.isoformat() if client_ts else None,
            "last_seen": now,
            "last_seen_iso": now.isoformat(),
        }

    return {
        "status": "ok",
        "station_id": payload.station_id,
        "server_time": now.isoformat(),
    }


@app.post("/api/reader-events")
def reader_event(payload: ReaderEventIn, request: Request):
    update_activity()
    require_shared_token_if_configured(request)

    uid = sanitize_uid(payload.uid)
    now = datetime.now(timezone.utc)
    client_ts = parse_iso_or_none(payload.timestamp)

    global global_event_id
    with stations_lock:
        global_event_id += 1

        # Ensure station exists/updates even if heartbeat is delayed.
        station_info = stations.get(payload.station_id, {})
        station_info.update(
            {
                "station_id": payload.station_id,
                "reader_connected": True,
                "last_seen": now,
                "last_seen_iso": now.isoformat(),
            }
        )
        stations[payload.station_id] = station_info

        events = station_events.setdefault(payload.station_id, [])
        event_obj = {
            "event_id": global_event_id,
            "station_id": payload.station_id,
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

    with stations_lock:
        station = stations.get(station_id)
        if not station:
            return {
                "station_id": station_id,
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
            "station_id": station_id,
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

    with stations_lock:
        all_events = station_events.get(station_id, [])
        new_events = [e for e in all_events if e["event_id"] > after_event_id]
        sliced_events = new_events[:safe_limit]
        last_event_id = after_event_id if not sliced_events else sliced_events[-1]["event_id"]

    return {
        "station_id": station_id,
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
