#!/usr/bin/env python3
"""Pull enabled airport subscriptions and run lightweight Mihomo health checks."""

from __future__ import annotations

import concurrent.futures
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


AGENT_VERSION = "1.0.0"
HEALTH_URL = "https://cp.cloudflare.com/generate_204"
HEALTH_TIMEOUT_MS = 5000
MAX_CONCURRENCY = 16
MAX_NODES = 500
MIHOMO_BIN = os.environ.get("MIHOMO_BIN", "/opt/tg-sub-monitor/mihomo")
WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
MONITOR_TOKEN = os.environ["MONITOR_TOKEN"]
PROBE_ID = os.environ.get("PROBE_ID", "haichuang")
PROBE_LABEL = os.environ.get("PROBE_LABEL", "海创 VPS")


def api_request(path: str, *, method: str = "GET", body: dict[str, Any] | None = None, timeout: int = 30) -> tuple[bytes, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        f"{WORKER_URL}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {MONITOR_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": f"tg-sub-monitor/{AGENT_VERSION}",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers


def controller_request(port: int, controller_secret: str, path: str, timeout: int = 10) -> dict[str, Any]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        headers={"Authorization": f"Bearer {controller_secret}"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_controller(process: subprocess.Popen[bytes], port: int, controller_secret: str) -> None:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("mihomo_exited")
        try:
            controller_request(port, controller_secret, "/version", timeout=1)
            return
        except (OSError, ValueError, urllib.error.URLError):
            time.sleep(0.25)
    raise RuntimeError("mihomo_start_timeout")


def monitor_config(port: int, controller_secret: str) -> str:
    return f'''allow-lan: false
bind-address: 127.0.0.1
external-controller: 127.0.0.1:{port}
secret: "{controller_secret}"
log-level: warning
ipv6: true
mode: direct
proxy-providers:
  airport:
    type: file
    path: ./provider.txt
    health-check:
      enable: false
      url: {HEALTH_URL}
      interval: 600
      timeout: {HEALTH_TIMEOUT_MS}
      lazy: false
proxy-groups:
  - name: MONITOR
    type: select
    use:
      - airport
rules:
  - MATCH,DIRECT
'''


def node_healthcheck(port: int, controller_secret: str, name: str) -> int | None:
    quoted = urllib.parse.quote(name, safe="")
    query = urllib.parse.urlencode({"url": HEALTH_URL, "timeout": HEALTH_TIMEOUT_MS})
    try:
        result = controller_request(
            port,
            controller_secret,
            f"/providers/proxies/airport/{quoted}/healthcheck?{query}",
            timeout=HEALTH_TIMEOUT_MS // 1000 + 3,
        )
        delay = int(result.get("delay", 0))
        return delay if 0 < delay < 65535 else None
    except (OSError, ValueError, TypeError, urllib.error.URLError):
        return None


def test_provider(content: bytes) -> tuple[int, int, int | None, str | None]:
    with tempfile.TemporaryDirectory(prefix="tg-sub-monitor-") as temp_dir_value:
        temp_dir = Path(temp_dir_value)
        (temp_dir / "provider.txt").write_bytes(content)
        port = free_loopback_port()
        controller_secret = secrets.token_urlsafe(24)
        (temp_dir / "config.yaml").write_text(monitor_config(port, controller_secret), encoding="utf-8")
        process = subprocess.Popen(
            [MIHOMO_BIN, "-d", str(temp_dir), "-f", str(temp_dir / "config.yaml")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            wait_for_controller(process, port, controller_secret)
            provider = controller_request(port, controller_secret, "/providers/proxies/airport", timeout=10)
            proxies = provider.get("proxies")
            if not isinstance(proxies, list):
                return 0, 0, None, "provider_parse_failed"
            names = [item.get("name") for item in proxies if isinstance(item, dict) and isinstance(item.get("name"), str)]
            names = names[:MAX_NODES]
            if not names:
                return 0, 0, None, "no_nodes"
            with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as executor:
                delays = list(executor.map(lambda name: node_healthcheck(port, controller_secret, name), names))
            online_delays = sorted(delay for delay in delays if delay is not None)
            median = online_delays[len(online_delays) // 2] if online_delays else None
            return len(names), len(online_delays), median, None
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


def fetch_jobs() -> list[dict[str, str]]:
    query = urllib.parse.urlencode({"probe_id": PROBE_ID, "label": PROBE_LABEL, "version": AGENT_VERSION})
    content, _ = api_request(f"/internal/monitor/jobs?{query}")
    payload = json.loads(content.decode("utf-8"))
    targets = payload.get("targets", [])
    return [item for item in targets if isinstance(item, dict)]


def run_target(target: dict[str, str]) -> dict[str, Any]:
    user_id = str(target.get("userId", ""))
    sub_id = str(target.get("subId", ""))
    checked_at = int(time.time() * 1000)
    report: dict[str, Any] = {
        "userId": user_id,
        "subId": sub_id,
        "checkedAt": checked_at,
        "totalNodes": 0,
        "onlineNodes": 0,
        "medianDelayMs": None,
        "subscriptionFetchOk": False,
        "errorCode": None,
    }
    try:
        query = urllib.parse.urlencode({"user_id": user_id, "sub_id": sub_id})
        provider_content, headers = api_request(f"/internal/monitor/provider?{query}", timeout=45)
        report["subscriptionFetchOk"] = headers.get("X-Monitor-Subscription-Fetch") == "ok"
        total, online, median, error = test_provider(provider_content)
        report.update(totalNodes=total, onlineNodes=online, medianDelayMs=median, errorCode=error)
    except urllib.error.HTTPError as error:
        report["errorCode"] = f"provider_http_{error.code}"
    except (OSError, RuntimeError, ValueError, urllib.error.URLError):
        report["errorCode"] = "probe_failed"
    return report


def post_report(report: dict[str, Any]) -> None:
    api_request(
        "/internal/monitor/report",
        method="POST",
        body={"probeId": PROBE_ID, "probeLabel": PROBE_LABEL, "version": AGENT_VERSION, "results": [report]},
        timeout=30,
    )


def main() -> int:
    if sys.argv[1:] == ["--setup"]:
        return setup_bot()
    try:
        targets = fetch_jobs()
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(f"monitor agent could not fetch jobs: {type(error).__name__}")
        return 1

    completed = 0
    for target in targets:
        report = run_target(target)
        try:
            post_report(report)
            completed += 1
        except (OSError, ValueError, urllib.error.URLError) as error:
            print(f"monitor agent could not post report: {type(error).__name__}")
            return 1
    print(f"monitor agent completed {completed} target(s)")
    return 0


def setup_bot() -> int:
    try:
        setup_content, _ = api_request("/internal/monitor/setup", method="POST", timeout=30)
        status_content, _ = api_request("/internal/monitor/telegram-status", timeout=30)
        setup = json.loads(setup_content.decode("utf-8"))
        status = json.loads(status_content.decode("utf-8"))
        webhook = status.get("webhook", {})
        commands = status.get("commands", [])
        command_names = [item.get("command") for item in commands if isinstance(item, dict)]
        print(
            "telegram setup ok=%s webhook=%s pending=%s commands=%s monitor=%s errors=%s"
            % (
                bool(setup.get("ok")),
                bool(webhook.get("url")),
                int(webhook.get("pendingUpdateCount", 0)),
                len(commands),
                "monitor" in command_names,
                bool(webhook.get("lastErrorMessage")),
            )
        )
        return 0 if setup.get("ok") and webhook.get("url") and "monitor" in command_names else 1
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(f"telegram setup failed: {type(error).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
