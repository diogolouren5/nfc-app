## MVP deployment flow

This project now supports a central API + local NFC agent flow.

### 1) Run central API (server)

```powershell
cd backend
python main.py
```

Optional environment variables:

- `NFC_SHARED_TOKEN` shared token expected from agents
- `STATION_ONLINE_TTL_SECONDS` online threshold (default `20`)
- `MAX_EVENTS_PER_STATION` in-memory event retention (default `2000`)
- `NFC_AGENT_DOWNLOAD_URL` URL shown in web modal for bridge download

### 2) Run local NFC agent (each station PC with reader)

```powershell
cd backend
$env:NFC_CENTRAL_BASE_URL = "https://your-server.example.com"
$env:NFC_STATION_ID = "station-abc123"
$env:NFC_SHARED_TOKEN = "same-token-as-server"
python nfc_agent.py
```

Agent behavior:

- Sends heartbeat to `/api/reader-heartbeat`
- Sends card events to `/api/reader-events`
- Reads ACR122 UID via `pyscard`

### 3) Frontend behavior

- Start screen checks `/api/stations/{station_id}/status`
- If online+reader: starts event
- If offline: opens install modal and allows retry
- Event view polls `/api/stations/{station_id}/events`

Important (current local-first setup):

- The backend runs in local-only mode by default (`NFC_LOCAL_ONLY_MODE=1`).
- Any station id requested by the web or sent by the agent is normalized to `local-station`.
- The agent also defaults to `NFC_STATION_ID=local-station`.
- This avoids frontend/agent station mismatches in single-PC usage.
