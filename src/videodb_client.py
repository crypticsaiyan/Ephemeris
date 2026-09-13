"""VideoDB connection helpers.

Everything goes through `get_collection()`. Calling `conn.get_collection()` with
no argument returns the account's default collection, which holds unrelated
videos, and collection-scoped search/ask/aggregate fan out across every indexed
video in scope. That would silently mix foreign footage into every result.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import videodb
from dotenv import load_dotenv
from videodb.collection import Collection
from videodb.client import Connection

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    load_dotenv(PROJECT_ROOT / ".env")


@lru_cache(maxsize=1)
def connect() -> Connection:
    load_env()
    key = (os.environ.get("VIDEO_DB_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("VIDEO_DB_API_KEY not set. Put it in .env at the project root.")
    # Hosting dashboards hand back whatever was pasted into the box, newline included, and the
    # SDK puts this value straight into an Authorization header where a trailing "\n" is a hard
    # error rather than something the HTTP layer tidies up. The failure surfaces far from its
    # cause, as an "Invalid request" from the first API call, so normalise it at the source.
    # Written back to the environment because `videodb.connect()` reads it from there itself.
    os.environ["VIDEO_DB_API_KEY"] = key
    return videodb.connect()


@lru_cache(maxsize=1)
def get_collection() -> Collection:
    load_env()
    # Stripped for the same reason as the key: a pasted value carries whatever came with it,
    # and here it would go into a request path instead of a header.
    collection_id = (os.environ.get("VIDEODB_COLLECTION_ID") or "").strip()
    if not collection_id:
        raise RuntimeError(
            "VIDEODB_COLLECTION_ID not set. Refusing to fall back to the default "
            "collection, which contains unrelated videos."
        )
    return connect().get_collection(collection_id)


@lru_cache(maxsize=1)
def text_collection() -> Collection:
    """Where `generate_text` runs, which is not always where retrieval runs.

    The corpus collection is public, so any key can search it. Text generation against it is a
    different matter: a key from another account gets "Given collection id not found in your
    account", measured, not assumed. Synthesis therefore needs a collection the caller owns.

    For whoever owns the corpus that is the corpus itself, and nothing changes. For anyone
    borrowing it, this falls back to the account default, which is empty and used only as the
    scope for an LLM call. Retrieval is unaffected either way.
    """
    corpus = get_collection()
    conn = connect()
    try:
        owned = {c.id for c in conn.get_collections()}
    except Exception:  # noqa: BLE001 - an unreadable collection list is not worth failing over
        return corpus
    if corpus.id in owned:
        return corpus
    return conn.get_collection()


def usage() -> dict:
    """Account usage snapshot. Call around expensive runs to track credit burn."""
    return connect().check_usage()


def player_url(stream_url: str) -> str:
    return f"https://console.videodb.io/player?url={stream_url}"
