"""The ask service, checked offline.

What this guards: the HTTP front in `src/ask_service.py` is the only way the web app reaches the
agent now, so a regression here takes every live ask down at once. The checks are the ones a
deployment mistake would trip: a missing or wrong token must refuse, bad input must be refused
before anything is spawned, and a good run must stream the agent's progress lines and then its
answer in the exact event format the browser already parses.

Run with:  python tests/test_ask_service.py

No pytest dependency and no network: the agent script is replaced with a stub that prints two
progress lines to stderr and writes a small answer file, so this exercises the server and the
stream framing rather than VideoDB.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import ask_service  # noqa: E402

TOKEN = "test-token-0123456789"

STUB = '''\
import json, sys
question, flag, out = sys.argv[1], sys.argv[2], sys.argv[3]
assert flag == "--json", flag
print("@progress " + json.dumps({"n": 1, "kind": "decompose", "summary": "split " + question}), file=sys.stderr)
print("not a progress line, just noise", file=sys.stderr)
print("@progress " + json.dumps({"n": 2, "kind": "retrieve", "summary": "found"}), file=sys.stderr)
if question == "fail":
    print("boom: the agent fell over", file=sys.stderr)
    sys.exit(3)
json.dump({"answer": "stub answer to " + question, "evidence": []}, open(out, "w"))
'''


def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ask_service.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def call(base, path, body=None, token=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(base + path, data=data, method="POST" if data is not None else "GET")
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("x-service-token", token)
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status, res.headers, res.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read().decode()


def events(text):
    out = []
    for block in text.strip().split("\n\n"):
        lines = [l for l in block.split("\n") if l and not l.startswith(":")]
        if not lines:
            continue
        event = next(l[len("event: "):] for l in lines if l.startswith("event: "))
        data = next(l[len("data: "):] for l in lines if l.startswith("data: "))
        out.append((event, json.loads(data)))
    return out


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        stub = Path(tmp) / "ask.py"
        stub.write_text(STUB)
        ask_service.SCRIPT = stub
        os.environ["ASK_SERVICE_TOKEN"] = TOKEN
        os.environ["VIDEO_DB_API_KEY"] = "sk-secret-value-that-must-not-leak"

        server, base = serve()
        try:
            status, _, body = call(base, "/healthz")
            assert status == 200 and json.loads(body)["ok"] is True, (status, body)

            status, _, body = call(base, "/nope")
            assert status == 404, (status, body)

            # Token first: nothing else is looked at without it.
            status, _, body = call(base, "/ask", {"question": "hi"})
            assert status == 401, (status, body)
            status, _, body = call(base, "/ask", {"question": "hi"}, token="wrong")
            assert status == 401, (status, body)

            # Validation before any spawn.
            status, _, body = call(base, "/ask", {"question": "  "}, token=TOKEN)
            assert status == 400 and "required" in body, (status, body)
            status, _, body = call(base, "/ask", {"question": "x" * 401}, token=TOKEN)
            assert status == 400 and "too long" in body, (status, body)
            status, _, body = call(base, "/ask", raw=b"not json", token=TOKEN)
            assert status == 400 and "invalid JSON" in body, (status, body)

            # A good run: the stream carries every progress line, then the answer, in order.
            status, headers, body = call(base, "/ask", {"question": "water on mars"}, token=TOKEN)
            assert status == 200 and headers["content-type"].startswith("text/event-stream"), headers
            got = events(body)
            assert [e for e, _ in got] == ["progress", "progress", "result"], got
            assert got[0][1]["summary"] == "split water on mars", got[0]
            assert got[2][1]["answer"] == "stub answer to water on mars", got[2]

            # A failed run ends in one error event carrying the agent's stderr, with secrets
            # scrubbed, and never a result.
            os.environ["VIDEO_DB_API_KEY"] = "boom: the agent fell over"
            status, _, body = call(base, "/ask", {"question": "fail"}, token=TOKEN)
            got = events(body)
            assert [e for e, _ in got] == ["progress", "progress", "error"], got
            assert "<redacted>" in got[2][1]["error"] and "fell over" not in got[2][1]["error"], got[2]

            # A refusal sent before the body is read must not poison the connection. The token
            # is checked first, so the 401 goes out with the JSON body still unread; if the
            # connection stayed open, those bytes would be parsed as the next request line.
            import http.client
            conn = http.client.HTTPConnection(base.split("//")[1], timeout=10)
            conn.request("POST", "/ask", body=json.dumps({"question": "hi"}),
                         headers={"content-type": "application/json", "x-service-token": "wrong"})
            first = conn.getresponse(); first.read()
            assert first.status == 401, first.status
            assert (first.getheader("connection") or "").lower() == "close", first.getheaders()
            conn.request("GET", "/healthz")
            second = conn.getresponse()
            assert second.status == 200, f"request after a refusal got {second.status}"
            conn.close()

            # Without a configured token the service refuses everyone, including a caller
            # sending the empty string.
            os.environ["ASK_SERVICE_TOKEN"] = ""
            status, _, body = call(base, "/ask", {"question": "hi"}, token="")
            assert status == 401, (status, body)
        finally:
            server.shutdown()

    print("\nOK: health, auth, validation, stream framing, error redaction, fail-closed token")


if __name__ == "__main__":
    main()
