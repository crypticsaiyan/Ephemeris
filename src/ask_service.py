"""HTTP front for the agent, so a Node-only host can serve live asks.

The Next.js route used to spawn `scripts/ask.py` itself, which tied the web server to a box that
also held the Python environment. This module is that spawn, moved behind one endpoint: the web
app POSTs a question, this process runs the agent and streams the same event stream the route
used to build, and nothing else changes shape. The browser never talks to this service directly.

A run outlives the connection that started it. It is kept as a job: `POST /ask` streams its events
for up to STREAM_SECONDS and names the job in `x-ask-job`, and `GET /ask/<job>?after=<n>` replays
from event n, so a caller that was cut off, or simply reached the end of a segment, picks up again.

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
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "ask.py"

MAX_QUESTION = 400
MAX_CONCURRENT = 2
KEEPALIVE_SECONDS = 15
# One connection never outlives this. A run takes minutes on a free host and a long-held stream
# gets cut somewhere between here and the browser, so the run carries on in a job and the caller
# reconnects with `GET /ask/<job>?after=<events seen>` until the answer arrives.
STREAM_SECONDS = 40
JOB_KEEP_SECONDS = 600
PROGRESS_PREFIX = "@progress "
JOB_ID = re.compile(r"^[0-9a-f]{32}$")

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


class Job:
    """One run's events, kept so a caller that was cut off can pick up where it stopped."""

    def __init__(self) -> None:
        self.id = secrets.token_hex(16)
        self.events: list[tuple[str, object]] = []
        self.done = False
        self.finished_at = 0.0
        self.cond = threading.Condition()

    def emit(self, event: str, data) -> None:
        with self.cond:
            self.events.append((event, data))
            self.cond.notify_all()

    def finish(self) -> None:
        with self.cond:
            self.done = True
            self.finished_at = time.time()
            self.cond.notify_all()


_jobs: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def _prune_jobs() -> None:
    cutoff = time.time() - JOB_KEEP_SECONDS
    with _jobs_lock:
        for job_id in [k for k, j in _jobs.items() if j.done and j.finished_at < cutoff]:
            del _jobs[job_id]


def _run_job(job: Job, question: str) -> None:
    """Runs the agent to the end whether or not anyone is still listening."""
    try:
        run_agent(question, job.emit)
    except Exception as error:  # noqa: BLE001
        raw = str(error)
        sys.stderr.write(f"[ask-service] run failed: {raw}\n")
        job.emit("error", {"error": redact(raw)})
    finally:
        job.finish()
        _slots.release()


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

    def _authorised(self) -> bool:
        expected = os.environ.get("ASK_SERVICE_TOKEN", "")
        return bool(expected) and self.headers.get("x-service-token", "") == expected

    def do_GET(self) -> None:  # noqa: N802
        url = urlsplit(self.path)
        if url.path in ("/", "/healthz"):
            self._json(200, {"ok": True, "service": "ephemeris-ask"})
            return

        match = re.fullmatch(r"/ask/([0-9a-f]{32})", url.path)
        if not match:
            self._json(404, {"error": "not found"})
            return
        if not self._authorised():
            self._json(401, {"error": "unauthorised"})
            return
        with _jobs_lock:
            job = _jobs.get(match.group(1))
        if job is None:
            self._json(404, {"error": "unknown run"})
            return
        try:
            after = max(0, int(parse_qs(url.query).get("after", ["0"])[0]))
        except ValueError:
            self._json(400, {"error": "after must be a number"})
            return
        self._stream(job, after)

    def _stream(self, job: Job, after: int) -> None:
        """Sends the job's events from `after` on, then ends, so the caller reconnects for more."""
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("cache-control", "no-cache, no-transform")
        self.send_header("x-ask-job", job.id)
        # No length up front, so closing the connection is what ends the stream.
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()

        deadline = time.time() + STREAM_SECONDS
        sent = after
        try:
            while True:
                with job.cond:
                    if sent >= len(job.events) and not job.done:
                        job.cond.wait(timeout=min(KEEPALIVE_SECONDS, max(0.0, deadline - time.time())))
                    pending = job.events[sent:]
                    finished = job.done and sent + len(pending) >= len(job.events)
                chunk = "".join(
                    f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in pending
                ) or ": keepalive\n\n"
                self.wfile.write(chunk.encode())
                self.wfile.flush()
                sent += len(pending)
                if finished or time.time() >= deadline:
                    return
        except OSError:
            return  # the caller went away; the run does not need it

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/ask":
            self._json(404, {"error": "not found"})
            return

        if not self._authorised():
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

        _prune_jobs()
        job = Job()
        with _jobs_lock:
            _jobs[job.id] = job
        threading.Thread(target=_run_job, args=(job, question), daemon=True).start()
        self._stream(job, 0)


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    if not os.environ.get("ASK_SERVICE_TOKEN"):
        sys.stderr.write("[ask-service] ASK_SERVICE_TOKEN is not set; every ask will be refused\n")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    sys.stderr.write(f"[ask-service] listening on :{port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
