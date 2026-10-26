"""HTTP front for the agent, so a Node-only host can serve live asks.

The Next.js route used to spawn `scripts/ask.py` itself, which tied the web server to a box that
also held the Python environment. This module is that spawn, moved behind one endpoint: the web
app POSTs a question, this process runs the agent and streams the same event stream the route
used to build, and nothing else changes shape. The browser never talks to this service directly.

Standard library only. The service runs at most two agents at once, and a run spends its time
waiting on VideoDB rather than computing, so a threaded stdlib server is the right size.

    ASK_SERVICE_TOKEN   required; the web app sends it as `x-service-token`. Unset refuses every
                        ask, so a forgotten secret fails closed instead of opening a paid endpoint.
    PORT                injected by the host; 8000 when run by hand.

Run with `python -P src/ask_service.py` from the repo root. `-P` matters for the same reason it
does in the route: without it `scripts/select.py` would shadow the stdlib `select` module the
server depends on.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "ask.py"

MAX_QUESTION = 400
MAX_CONCURRENT = 2
KEEPALIVE_SECONDS = 15
PROGRESS_PREFIX = "@progress "

# Taken, not waited on: a third ask is refused at once rather than queued, which is the
# behaviour the web app's own limiter already promises its callers.
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)

# Redacted by value from anything that leaves as an error. Same list and same floor as
# `web/lib/redact.ts`; the web app redacts again on its side, this is defence in depth.
_SECRET_ENV = ("VIDEO_DB_API_KEY", "ASK_SERVICE_TOKEN", "EPHEMERIS_ASK_TOKEN")
_MIN_SECRET_LENGTH = 8


def redact(text: str) -> str:
    for name in _SECRET_ENV:
        value = os.environ.get(name, "")
        if len(value) >= _MIN_SECRET_LENGTH:
            text = text.replace(value, "<redacted>")
    return text.replace(str(ROOT), "<repo>")


def run_agent(question: str, emit) -> None:
    """Runs one ask and calls `emit(event, data)` for each event, result or error last."""
    with tempfile.TemporaryDirectory(prefix="ephemeris-") as scratch:
        out_path = Path(scratch) / "answer.json"
        # The question is its own argv entry, never a shell string.
        child = subprocess.Popen(
            [sys.executable, "-P", str(SCRIPT), question, "--json", str(out_path)],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        errors: list[str] = []
        assert child.stderr is not None
        for line in child.stderr:
            line = line.rstrip("\n")
            if line.startswith(PROGRESS_PREFIX):
                try:
                    emit("progress", json.loads(line[len(PROGRESS_PREFIX):]))
                except json.JSONDecodeError:
                    pass  # a malformed progress line is not worth failing a run over
            elif line.strip():
                errors.append(line)
        code = child.wait()
        if code != 0:
            raise RuntimeError("\n".join(errors).strip()[-1200:] or f"agent exited {code}")
        emit("result", json.loads(out_path.read_text("utf8")))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: D102
        sys.stderr.write("[ask-service] %s\n" % (fmt % args))

    def _json(self, status: int, body: dict, headers: dict | None = None) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        if status >= 400:
            # A refusal is often sent before the request body has been read: the token is
            # checked first, on purpose, so an unauthorised caller costs nothing. The unread
            # bytes would then sit in front of the next request on this connection, and a proxy
            # that reuses upstream connections hands that next request, from somebody else, a
            # 400 from the parser. Closing after every refusal makes that impossible.
            self.send_header("connection", "close")
            self.close_connection = True
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path in ("/", "/healthz"):
            self._json(200, {"ok": True, "service": "ephemeris-ask"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ask":
            self._json(404, {"error": "not found"})
            return

        expected = os.environ.get("ASK_SERVICE_TOKEN", "")
        if not expected or self.headers.get("x-service-token", "") != expected:
            self._json(401, {"error": "unauthorised"})
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            question = str(body.get("question", "")).strip()
        except (ValueError, AttributeError):
            self._json(400, {"error": "invalid JSON body"})
            return
        if not question:
            self._json(400, {"error": "question is required"})
            return
        if len(question) > MAX_QUESTION:
            self._json(400, {"error": "question too long"})
            return

        if not _slots.acquire(blocking=False):
            self._json(429, {"error": "too many runs in progress"}, {"retry-after": "60"})
            return

        try:
            self.send_response(200)
            self.send_header("content-type", "text/event-stream; charset=utf-8")
            self.send_header("cache-control", "no-cache, no-transform")
            # The body has no length up front, so closing the connection is what tells the
            # caller the stream is over. Keep-alive here would leave the web app waiting
            # for an end that never comes.
            self.send_header("connection", "close")
            self.close_connection = True
            self.end_headers()

            lock = threading.Lock()

            def write(chunk: str) -> None:
                with lock:
                    self.wfile.write(chunk.encode())
                    self.wfile.flush()

            def emit(event: str, data) -> None:
                write(f"event: {event}\ndata: {json.dumps(data)}\n\n")

            # Retrieval and synthesis are long silences, and a proxy reads silence as a dead
            # connection. An SSE comment keeps bytes flowing and the client ignores it.
            stop = threading.Event()

            def heartbeat() -> None:
                while not stop.wait(KEEPALIVE_SECONDS):
                    try:
                        write(": keepalive\n\n")
                    except OSError:
                        return

            threading.Thread(target=heartbeat, daemon=True).start()
            try:
                run_agent(question, emit)
            except Exception as error:  # noqa: BLE001
                raw = str(error)
                sys.stderr.write(f"[ask-service] run failed: {raw}\n")
                try:
                    emit("error", {"error": redact(raw)})
                except OSError:
                    pass
            finally:
                stop.set()
        finally:
            _slots.release()


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    if not os.environ.get("ASK_SERVICE_TOKEN"):
        sys.stderr.write("[ask-service] ASK_SERVICE_TOKEN is not set; every ask will be refused\n")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"[ask-service] listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
