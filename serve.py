#!/usr/bin/env python3
"""
Local development server for Ubuntu AI Desktop.

    python serve.py [port]        # default 8321

Why this exists instead of `python -m http.server`:

1. ES modules require an http(s) origin. Opening index.html with file:// fails
   with a CORS error before a single module loads.
2. `python -m http.server` sends no cache headers, so browsers apply heuristic
   caching to .js files. During development you then edit a module, reload, and
   silently keep running the old code. This server sends `Cache-Control:
   no-store` so a reload always fetches what is actually on disk.
3. It sets the correct MIME type for .js and .mjs, which some Windows Python
   installs get wrong by reading the registry (they can report text/plain, and
   a module with the wrong MIME type is rejected outright).

For production this file is irrelevant — GitHub Pages serves the directory as
static files with sensible defaults.
"""

from __future__ import annotations

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class DevHandler(SimpleHTTPRequestHandler):
    """Static handler with development-friendly headers."""

    # Windows Python reads MIME types from the registry, where .js is often
    # registered as text/plain. Pin the types the app depends on.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".html": "text/html",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Keep 404s (they usually mean a broken import path); drop the rest.
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            super().log_message(fmt, *args)


def main() -> int:
    port = 8321
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Not a port number: {sys.argv[1]}", file=sys.stderr)
            return 2

    handler = partial(DevHandler, directory=str(ROOT))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    except OSError as err:
        print(f"Could not bind port {port}: {err}", file=sys.stderr)
        return 1

    print(f"Ubuntu AI Desktop -> http://localhost:{port}")
    print("Caching is disabled; edit a module and just reload. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
