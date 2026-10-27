/** Picks up a run that a dropped or finished stream left behind.
 *
 *  `POST /api/ask` streams for at most about forty seconds and hands the page a job id; a run takes
 *  longer than that on a free host, and one long-held connection gets cut somewhere between the
 *  service and the browser. The page reconnects here with how many events it has already seen and
 *  the service replays the rest, so no single request has to survive the whole run.
 *
 *  No quota is spent here: the question was already admitted and paid for by the POST. The job id
 *  is 128 random bits and the service checks the shared token as well. */

export const maxDuration = 300;

const SERVICE_URL = (process.env.ASK_SERVICE_URL ?? "").replace(/\/+$/, "");
const SERVICE_TOKEN = process.env.ASK_SERVICE_TOKEN ?? "";

export async function GET(request: Request, context: { params: Promise<{ job: string }> }) {
  const { job } = await context.params;
  if (!/^[0-9a-f]{32}$/.test(job)) return Response.json({ error: "unknown run" }, { status: 404 });
  if (!SERVICE_URL || !SERVICE_TOKEN) {
    return Response.json({ error: "live asks are not configured on this deployment" }, { status: 503 });
  }

  const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
  if (!Number.isInteger(after) || after < 0) {
    return Response.json({ error: "after must be a number" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${SERVICE_URL}/ask/${job}?after=${after}`, {
      headers: { "x-service-token": SERVICE_TOKEN },
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    // Not up, or reset: the page treats any non-stream answer as "try again" while it still can.
    return Response.json({ error: "the ask service could not be reached" }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    // A restarted service has forgotten the run, which is a 404 here and final for the page.
    const status = upstream.status === 404 ? 404 : 502;
    const error = status === 404 ? "this run was lost when the host restarted" : "the ask service did not answer";
    await upstream.body?.cancel();
    return Response.json({ error }, { status });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
