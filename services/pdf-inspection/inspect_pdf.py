#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

import pymupdf

MAX_BYTES = 5_000_000
MAX_PAGES = 20
MAX_TEXT = 100_000
MAX_SECONDS = 3.0


def inspect(path: Path) -> dict:
    started = time.monotonic()
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("file byte limit exceeded")
    return inspect_bytes(path.read_bytes(), started)


def inspect_bytes(data: bytes, started: float | None = None) -> dict:
    started = time.monotonic() if started is None else started
    if len(data) > MAX_BYTES or not data.startswith(b"%PDF-"):
        raise ValueError("invalid or oversized PDF")
    doc = pymupdf.open(stream=data, filetype="pdf")
    try:
        if doc.is_encrypted:
            raise ValueError("encrypted PDF is unsupported")
        if doc.page_count > MAX_PAGES:
            raise ValueError("page limit exceeded")
        pages = []
        text_size = 0
        for number, page in enumerate(doc):
            if time.monotonic() - started > MAX_SECONDS:
                raise ValueError("processing time limit exceeded")
            text = page.get_text("text")
            text_size += len(text)
            if text_size > MAX_TEXT:
                raise ValueError("extracted text limit exceeded")
            pages.append({"page": number + 1, "text": text})
        return {"provenance": "synthetic-or-user-local-document", "pages": pages, "pageCount": doc.page_count, "textChars": text_size, "limitations": ["text extraction does not inspect every visual or semantic attack", "findings are advisory", "no URL fetch or script execution"]}
    finally:
        doc.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.path)))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:200]}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
