import argparse
import json
import os
import random
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request
from binascii import hexlify
from datetime import datetime, timezone


CENTRAL_BASE_URL = os.getenv("NFC_CENTRAL_BASE_URL", "http://127.0.0.1:3210").rstrip("/")
STATION_ID = os.getenv("NFC_STATION_ID", "local-station")
SHARED_TOKEN = os.getenv("NFC_SHARED_TOKEN", "")
HEARTBEAT_INTERVAL_SECONDS = float(os.getenv("NFC_HEARTBEAT_INTERVAL_SECONDS", "5"))
READ_POLL_INTERVAL_SECONDS = float(os.getenv("NFC_READ_POLL_INTERVAL_SECONDS", "0.25"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("NFC_REQUEST_TIMEOUT_SECONDS", "4"))
SIMULATE_READS = os.getenv("SIMULATE_READS", "0") == "1"
READER_MATCH_HINTS = tuple(
    token.strip().upper()
    for token in os.getenv("NFC_READER_MATCH_HINTS", "ACR122,ACS,PICC").split(",")
    if token.strip()
)


def configure_from_args() -> None:
    """Override configuration from command line args when provided."""
    parser = argparse.ArgumentParser(description="NFC agent")
    parser.add_argument("--station-id", dest="station_id", help="Station id to report to central API")
    parser.add_argument("--central-url", dest="central_url", help="Central API base URL (e.g. http://127.0.0.1:3210)")
    parser.add_argument("--shared-token", dest="shared_token", help="Shared API token")
    parser.add_argument("--simulate-reads", dest="simulate_reads", action="store_true", help="Simulate card reads if no real reader is found")
    args, _ = parser.parse_known_args()
    global CENTRAL_BASE_URL, STATION_ID, SHARED_TOKEN, SIMULATE_READS
    if args.central_url:
        CENTRAL_BASE_URL = args.central_url.rstrip("/")
    if args.station_id:
        STATION_ID = args.station_id
    if args.shared_token:
        SHARED_TOKEN = args.shared_token
    if args.simulate_reads:
        SIMULATE_READS = True


def wait_for_central(timeout_seconds: int = 30) -> bool:
    """Wait up to timeout_seconds for the central API to respond to /api/health."""
    start = time.time()
    health_url = f"{CENTRAL_BASE_URL}/api/health"
    while time.time() - start < timeout_seconds:
        try:
            with urllib.request.urlopen(health_url, timeout=3) as resp:
                if getattr(resp, "status", None) in (200, None):
                    # Some environments don't expose .status on response
                    print(f"[AGENT] Central API reachable at {CENTRAL_BASE_URL}")
                    return True
        except Exception as exc:
            print(f"[AGENT] Central API not reachable yet ({exc}), retrying...")
            time.sleep(2)
    print(f"[AGENT] Central API did not respond within {timeout_seconds}s. Continuing anyway.")
    return False


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if SHARED_TOKEN:
        headers["Authorization"] = f"Bearer {SHARED_TOKEN}"
    return headers


def post_json(path: str, payload: dict) -> dict | None:
    url = f"{CENTRAL_BASE_URL}{path}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers=build_headers())
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            response_data = response.read().decode("utf-8")
            return json.loads(response_data) if response_data else {}
    except urllib.error.URLError as exc:
        print(f"[AGENT] POST {path} failed: {exc}")
        # Detailed debug for connection issues
        try:
            traceback.print_exc()
        except Exception:
            pass
        return None


def get_acr122_reader():
    try:
        from smartcard.System import readers

        available_readers = list(readers())
        if not available_readers:
            return None

        # Prefer known ACR122-like names, but fallback to first available reader.
        for reader in available_readers:
            reader_name = str(reader).upper()
            if any(hint in reader_name for hint in READER_MATCH_HINTS):
                return reader

        return available_readers[0]
    except Exception as exc:
        print(f"[AGENT] Reader discovery error: {exc}")
        return None


def read_uid(reader):
    try:
        connection = reader.createConnection()
        connection.connect()
        data, sw1, sw2 = connection.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])
        uid = hexlify(bytes(data)).decode("utf-8").upper()
        try:
            connection.disconnect()
        except Exception:
            pass

        if sw1 == 0x90 and sw2 == 0x00 and uid:
            return uid
        return None
    except Exception:
        return None


def send_heartbeat(reader_connected: bool):
    payload = {
        "station_id": STATION_ID,
        "reader_connected": reader_connected,
        "agent_version": "1.0.0",
        "hostname": socket.gethostname(),
        "timestamp": utc_now_iso(),
    }
    post_json("/api/reader-heartbeat", payload)


def send_event(uid: str):
    payload = {
        "station_id": STATION_ID,
        "uid": uid,
        "timestamp": utc_now_iso(),
    }
    response = post_json("/api/reader-events", payload)
    if response is not None:
        print(f"[AGENT] UID sent: {uid} (event_id={response.get('event_id')})")


def run_loop():
    print(f"[AGENT] Starting NFC agent for station_id={STATION_ID}")
    print(f"[AGENT] Central API: {CENTRAL_BASE_URL}")

    last_heartbeat = 0.0
    latched_uid = None

    while True:
        now = time.time()
        reader = get_acr122_reader()
        reader_connected = reader is not None
        if not reader_connected and SIMULATE_READS:
            # when simulating, act as if a reader is present
            reader_connected = True

        if now - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
            send_heartbeat(reader_connected)
            last_heartbeat = now

        if reader_connected:
            uid = None
            if reader is not None:
                uid = read_uid(reader)
            else:
                # simulate a UID occasionally when simulating reads
                if SIMULATE_READS and random.random() < 0.1:
                    uid = f"SIM{random.randint(1000,9999)}"

            if uid:
                if uid != latched_uid:
                    send_event(uid)
                    latched_uid = uid
            else:
                # Reset latch when the card is removed so the same UID can be read again.
                latched_uid = None
        else:
            latched_uid = None

        time.sleep(READ_POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        configure_from_args()
        wait_for_central()
        run_loop()
    except KeyboardInterrupt:
        print("\n[AGENT] Stopped by user.")
