import { admit } from "@/lib/ratelimit";
import { redact } from "@/lib/redact";

/** Forwards a question to the ask service and streams its answer back.
 *
 *  This route used to spawn `scripts/ask.py` itself, which meant the web server had to live on
 *  a box that also held the Python environment. The spawn now lives in `src/ask_service.py`,
 *  behind one endpoint, so the web app can run on a Node-only host with preview deployments and
 *  the agent can stay where Python is. The event stream the browser reads is unchanged:
 *  `progress` events as the agent reasons, then one `result` or one `error`.
 *
 *  Validation and the visitor quota stay here, in front of the paid call. The service has its own
 *  token, sent as `x-service-token`, so nothing reaches the agent except through this route.
 *
 *  The server keeps nothing. Whoever asked is the only one who ends up holding the run, in their
 *  own browser. */

export const maxDuration = 300;

const SERVICE_URL = (process.env.ASK_SERVICE_URL ?? "").replace(/\/+$/, "");
const SERVICE_TOKEN = process.env.ASK_SERVICE_TOKEN ?? "";

const encoder = new TextEncoder();

/** Statuses a sleeping host's edge answers with while the process behind it starts. */
const WAKING_STATUSES = new Set([502, 503, 504]);
const WAKE_RETRY_MS = 5_000;
/** Long enough for a cold start, short enough that the run itself still fits `maxDuration`. */
const WAKE_BUDGET_MS = 75_000;

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request) {
  let question = "";
  try {
    ({ question } = await request.json());
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  question = (question ?? "").trim();
  if (!question) return Response.json({ error: "question is required" }, { status: 400 });
  if (question.length > 400) {
    return Response.json({ error: "question too long" }, { status: 400 });
  }

  // Checked after validation, so a malformed request never spends part of someone's quota.
  const admission = admit(request);
  if (!admission.ok) {
    return Response.json(
      { error: admission.error },
      { status: admission.status, headers: { "retry-after": String(admission.retryAfter) } },
    );
  }

  if (!SERVICE_URL || !SERVICE_TOKEN) {
    admission.release();
    // Fails closed and says so. A missing secret is a deployment mistake, not a visitor's.
    console.error("[ask] ASK_SERVICE_URL or ASK_SERVICE_TOKEN is not set");
    return Response.json({ error: "live asks are not configured on this deployment" }, { status: 503 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // A free host stops an idle service and starts it again on the next request, which takes
        // about forty seconds, and its edge answers 502, 503 or 504 until the process is up. The
        // first question after a quiet spell used to fail with "ask service answered 502"; a
        // TestSprite run on a pull request hit exactly that. Those three statuses and a refused
        // connection mean "not up yet", so wait and ask again, and tell the visitor why the
        // trace has not started. Anything else, including the service's own 400 and 401, is an
        // answer and is passed on as it is.
        const deadline = Date.now() + WAKE_BUDGET_MS;
        let upstream: Response | null = null;
        for (let attempt = 1; ; attempt++) {
          try {
            upstream = await fetch(`${SERVICE_URL}/ask`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-service-token": SERVICE_TOKEN,
              },
              body: JSON.stringify({ question }),
              signal: AbortSignal.timeout(maxDuration * 1000),
            });
            if (!WAKING_STATUSES.has(upstream.status)) break;
            await upstream.body?.cancel();
          } catch (error) {
            // A refused or reset connection is the same "not up yet"; a deliberate abort is not.
            if (error instanceof DOMException && error.name === "AbortError") throw error;
          }
          if (Date.now() + WAKE_RETRY_MS > deadline) {
            throw new Error("the ask service did not wake up in time: try again in a minute");
          }
          controller.enqueue(
            sse("progress", {
              n: -attempt,
              kind: "waking",
              summary: "the archive's host was asleep and is starting up, about 40 seconds",
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, WAKE_RETRY_MS));
        }

        if (!upstream) throw new Error("no answer from the ask service");
        if (!upstream.ok || !upstream.body) {
          let detail = `ask service answered ${upstream.status}`;
          try {
            const body = await upstream.json();
            if (typeof body?.error === "string") detail = body.error;
          } catch {
            // No JSON body; the status line is the message.
          }
          throw new Error(detail);
        }

        // The service already speaks the browser's event format, keepalives included, so the
        // bytes pass through untouched.
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        console.error("[ask] run failed:", raw);
        controller.enqueue(sse("error", { error: redact(raw) }));
      } finally {
        admission.release();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
