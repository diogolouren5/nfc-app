import os
import time
import threading
from binascii import hexlify
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
from fastapi.staticfiles import StaticFiles


# -------------------------------------------------
# CONFIG
# -------------------------------------------------

HOST = "127.0.0.1"
PORT = 3210
INACTIVITY_TIMEOUT = 0  # 0 = no auto-shutdown

# -------------------------------------------------
# APP INIT
# -------------------------------------------------

app = FastAPI(title="NFC Local Connector")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

last_request_time = time.time()
card_state_lock = threading.Lock()
latched_uid = None

# -------------------------------------------------
# UTILS
# -------------------------------------------------

def update_activity():
    global last_request_time
    last_request_time = time.time()


def get_acr122_reader():
    try:
        from smartcard.System import readers

        for r in readers():
            if "ACR122" in str(r):
                return r
        return None
    except Exception:
        return None


# -------------------------------------------------
# ENDPOINTS
# -------------------------------------------------

@app.get("/api/health")
def health():
    update_activity()
    return {"status": "ok"}


@app.get("/api/status")
def status():
    update_activity()

    try:
        from smartcard.System import readers
        all_readers = readers()
        reader = get_acr122_reader()

        if reader:
            return {
                "status": "reader_detected",
                "reader_name": str(reader),
                "all_readers": [str(r) for r in all_readers]
            }

        return {
            "status": "no_reader",
            "all_readers": [str(r) for r in all_readers]
        }

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/api/read")
def read_card(timeout: int = 2):
    global latched_uid
    update_activity()

    reader = get_acr122_reader()
    if not reader:
        return {"uid": None}

    start_time = time.time()

    while time.time() - start_time < timeout:
        try:
            connection = reader.createConnection()
            connection.connect()
            data, sw1, sw2 = connection.transmit([0xFF, 0xCA, 0x00, 0x00, 0x00])
            uid = hexlify(bytes(data)).decode().upper()

            try:
                connection.disconnect()
            except:
                pass

            with card_state_lock:
                if latched_uid == uid:
                    return {"uid": None}

                latched_uid = uid
                return {"uid": uid}

        except Exception:
            time.sleep(0.2)

    # No tarjeta detectada en el timeout: limpiamos latch para permitir
    # una nueva lectura cuando se vuelva a apoyar.
    with card_state_lock:
        latched_uid = None

    return {"uid": None}


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
