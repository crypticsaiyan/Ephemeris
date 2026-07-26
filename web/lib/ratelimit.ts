/** Guards on `/api/ask`, because a run is not a cheap request.
 *
 *  Ninety seconds of Python, several VideoDB calls, and a compiled reel, all on someone else's
 *  API credits. Left open, a single script can drain the account in a few minutes and the
 *  deployed demo stops working for everyone.
 *
 *  State is per process and in memory, which is correct for one Render instance and wrong the
 *  moment there are two: each would keep its own count and the effective limit would double.
 *  Redis is the answer at that point, not a bigger Map.
 */

/** One run at a time, globally.
 *
 *  Not a fairness rule, a memory one. The agent holds a few hundred megabytes next to the Node
 *  server, and a 512 MB starter instance running two of them gets the container OOM-killed
 *  mid-answer, which reads as a crash rather than a limit. */
const MAX_CONCURRENT = 1;

/** Per-address hourly quota. Enough to explore the archive, not enough to mine it. */
const PER_IP_PER_HOUR = 5;
const WINDOW_MS = 60 * 60 * 1000;

let inFlight = 0;
const hits = new Map<string, number[]>();

/** Render terminates TLS upstream, so the socket address is its proxy for every visitor.
 *  `x-forwarded-for` is the real client, first entry, and it is only trustworthy because a
 *  managed proxy sets it: exposed directly to the internet this header is caller-controlled. */
export function clientAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Set `EPHEMERIS_ASK_TOKEN` in the environment and send it as `x-ask-token` to skip the quota.
 *  Lets the deployment stay limited for visitors while remaining usable for a live demo. */
function bypasses(request: Request): boolean {
  const expected = process.env.EPHEMERIS_ASK_TOKEN;
  return Boolean(expected) && request.headers.get("x-ask-token") === expected;
}

export type Rejection = { status: number; error: string; retryAfter: number };

/** Returns a rejection to send back, or a `release` to call when the run ends.
 *
 *  The caller must invoke `release` on every path, including failures, or the concurrency slot
 *  is lost for the lifetime of the process. */
export function admit(request: Request): { ok: true; release: () => void } | { ok: false } & Rejection {
  if (bypasses(request)) {
    inFlight += 1;
    return { ok: true, release: releaseOnce() };
  }

  if (inFlight >= MAX_CONCURRENT) {
    return {
      ok: false,
      status: 429,
      error: "Another question is being answered right now. A run takes about ninety seconds.",
      retryAfter: 90,
    };
  }

  const now = Date.now();
  const address = clientAddress(request);
  const recent = (hits.get(address) ?? []).filter((at) => now - at < WINDOW_MS);

  if (recent.length >= PER_IP_PER_HOUR) {
    const oldest = Math.min(...recent);
    return {
      ok: false,
      status: 429,
      error: `Limit of ${PER_IP_PER_HOUR} questions an hour reached. The saved runs below are real answers and cost nothing to reopen.`,
      retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000)),
    };
  }

  recent.push(now);
  hits.set(address, recent);

  // Addresses that stopped asking would otherwise accumulate for the life of the process.
  if (hits.size > 1000) {
    for (const [key, times] of hits) {
      if (times.every((at) => now - at >= WINDOW_MS)) hits.delete(key);
    }
  }

  inFlight += 1;
  return { ok: true, release: releaseOnce() };
}

/** A double release would let concurrency drift below zero and quietly disable the limit. */
function releaseOnce(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight = Math.max(0, inFlight - 1);
  };
}
