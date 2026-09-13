/** Scrubbing for text that leaves the server as an error.
 *
 *  `/api/ask` forwards the agent's stderr to the browser and `recordFailure` writes a slice of it
 *  into the saved run, which `/api/answers/[id]` serves to anyone. That is worth keeping: a
 *  traceback is what makes a failed run diagnosable at all. What is not worth keeping is the two
 *  things riding along with it, so both are removed here rather than at each call site.
 *
 *  Nothing today puts the VideoDB key in an error. It travels as a header, and the SDK builds its
 *  messages from the server's own `message` field, verified by running the agent with a sentinel
 *  key and finding no trace of it in stderr. This exists because that is a property of the current
 *  dependency, not of this code: a key moved into a query string, or a library that prints its
 *  request headers, would put the secret on a public URL with no other line of defence.
 *
 *  Server-only: imported by route handlers, never by a client component. */

/** Redacted by value, wherever they appear. `VIDEODB_COLLECTION_ID` is deliberately absent: the
 *  corpus is shared read-only and its id is published in the README. */
const SECRET_ENV = ["VIDEO_DB_API_KEY", "EPHEMERIS_ASK_TOKEN"] as const;

/** A short value would match everywhere and turn the message into redaction markers. Anything
 *  this short is not a credential worth protecting at the cost of an unreadable error. */
const MIN_SECRET_LENGTH = 8;

/** What every redaction leaves behind. Deliberately free of the words this module matches on, so
 *  running the function twice cannot chew up its own output. Which secret it was is a question for
 *  the log, which keeps the unredacted text. */
const MARKER = "<redacted>";

/** Credentials named rather than valued, for the case where the environment does not hold the one
 *  that leaked: a dumped header, or a key belonging to some other caller. The value stops at a
 *  quote or a comma so that redacting a field inside a printed dict leaves the dict readable, and
 *  an auth scheme is kept because `Bearer` is not the secret. */
const CREDENTIAL_FIELD =
  /((?:x-access-token|x-ask-token|authorization|api[_-]?key)["'\s:=]+(?:bearer\s+)?)[^\s,'"]+/gi;

/** Absolute paths, which tracebacks are made of. The negative lookbehind is what keeps URLs
 *  intact: in `https://host/path` the first slash follows a colon and the rest follow a slash or a
 *  word character, so no part of a URL can start a match. */
const ABSOLUTE_PATH = /(?<![\w:/])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;

/** Enough to identify the file, not enough to describe the filesystem it sits on. */
function shorten(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

export function redact(text: string): string {
  // Named fields first. Doing it after the values below would let the marker's own text be read
  // as a field name and half of it eaten as the value.
  let out = text.replace(CREDENTIAL_FIELD, (_match, field: string) => `${field}${MARKER}`);

  for (const name of SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= MIN_SECRET_LENGTH) {
      // Split/join rather than a RegExp: the value is arbitrary and would otherwise need escaping.
      out = out.split(value).join(MARKER);
    }
  }

  return out.replace(ABSOLUTE_PATH, shorten);
}
