import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


def run_command(command: list[str], cwd: Path) -> None:
    process = subprocess.run(command, cwd=str(cwd), check=False)
    if process.returncode != 0:
        raise RuntimeError(f"Command failed ({process.returncode}): {' '.join(command)}")


def sync_frontend_build(repo_root: Path) -> None:
    print("[RUN_ALL] Building frontend...")
    run_command(["npm", "run", "build"], repo_root)

    dist_dir = repo_root / "dist"
    static_dir = repo_root / "backend" / "static"
    static_dir.mkdir(parents=True, exist_ok=True)

    print("[RUN_ALL] Syncing dist -> backend/static ...")
    for item in dist_dir.iterdir():
        target = static_dir / item.name
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def start_process(command: list[str], cwd: Path, env: dict[str, str]) -> subprocess.Popen:
    return subprocess.Popen(command, cwd=str(cwd), env=env)


def main() -> int:
    parser = argparse.ArgumentParser(description="Start NFC app backend + local agent")
    parser.add_argument("--station-id", default="local-station", help="Station id used by frontend/agent")
    parser.add_argument("--central-url", default="http://127.0.0.1:3210", help="Central API URL for agent")
    parser.add_argument("--skip-build", action="store_true", help="Skip frontend build sync")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent

    if not args.skip_build:
        sync_frontend_build(repo_root)

    env_agent = os.environ.copy()
    env_agent["NFC_CENTRAL_BASE_URL"] = args.central_url
    env_agent["NFC_STATION_ID"] = args.station_id

    env_backend = os.environ.copy()

    backend_dir = repo_root / "backend"

    print(f"[RUN_ALL] Starting agent with station_id={args.station_id}")
    agent_proc = start_process([sys.executable, "nfc_agent.py"], backend_dir, env_agent)

    print("[RUN_ALL] Starting backend API/web server")
    backend_proc = start_process([sys.executable, "main.py"], backend_dir, env_backend)

    print("")
    print("[RUN_ALL] App ready")
    print("[RUN_ALL] Open: http://127.0.0.1:3210")
    print("[RUN_ALL] Press Ctrl+C here to stop both processes")

    try:
        return backend_proc.wait()
    except KeyboardInterrupt:
        print("\n[RUN_ALL] Stopping...")
        return 0
    finally:
        for proc in [backend_proc, agent_proc]:
            if proc.poll() is None:
                proc.terminate()
        for proc in [backend_proc, agent_proc]:
            if proc.poll() is None:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
