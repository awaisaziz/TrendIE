"""HTTP wrapper for the PDF inspector, deployed as an internal Vercel service.

Only the web service reaches it (via the PDF_INSPECTION_URL binding). It receives raw PDF bytes,
applies the same limits as the CLI, and returns the same JSON shape. It never fetches URLs.
"""
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from inspect_pdf import MAX_BYTES, inspect_bytes

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/inspect")
async def inspect_endpoint(request: Request) -> JSONResponse:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_BYTES:
        return JSONResponse({"error": "file byte limit exceeded"}, status_code=413)
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            return JSONResponse({"error": "file byte limit exceeded"}, status_code=413)
    try:
        return JSONResponse(inspect_bytes(bytes(data)), headers={"cache-control": "no-store"})
    except Exception as exc:  # fail closed with a bounded message
        return JSONResponse({"error": str(exc)[:200]}, status_code=422)
