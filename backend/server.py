"""
SELENE-REG API — FastAPI service wrapping the OpenCV registration engine.

Endpoints
  GET  /api/health                 engine + capability probe
  GET  /api/presets                built-in Chandrayaan-2 demo pairs
  POST /api/upload                 store a source/reference raster, get an id
  POST /api/register               run registration, return match points + metrics
  GET  /api/image/{id}             serve a stored/derived raster as PNG
  GET  /api/export/{job}/matches.csv
  GET  /api/export/{job}/report.json
  GET  /api/export/{job}/{product}.png
"""
from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from pipeline import (
    EngineParams, decode_image, make_products, register,
)

HERE = os.path.dirname(os.path.abspath(__file__))
PRESET_DIR = os.path.join(HERE, "presets")
MAX_UPLOAD = 40 * 1024 * 1024          # 40 MB per raster

app = FastAPI(title="SELENE-REG API", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# in-memory stores (single-process demo service)
IMAGES: dict[str, np.ndarray] = {}
META: dict[str, dict[str, Any]] = {}
JOBS: dict[str, dict[str, Any]] = {}

# Presets and user uploads must never be evicted; only derived product rasters are.
PINNED: set[str] = set()

MAX_JOBS = 24        # keep the last N runs exportable
MAX_PRODUCT_MB = 420 # hard ceiling on derived-raster memory


def _product_bytes() -> int:
    return sum(int(a.nbytes) for k, a in IMAGES.items() if k not in PINNED)


def _evict_jobs() -> None:
    """Drop the oldest jobs (and the product rasters only they referenced) until we
    are back under both the job-count and the memory ceiling. Without this the
    service is OOM-killed after roughly sixty registrations, since every run adds
    five full-resolution product images."""
    while JOBS and (len(JOBS) > MAX_JOBS
                    or _product_bytes() > MAX_PRODUCT_MB * 1024 * 1024):
        oldest, victim = next(iter(JOBS.items()))
        JOBS.pop(oldest, None)
        still_used = {pid
                      for b in JOBS.values()
                      for pid in (b.get("products") or {}).values()}
        for pid in (victim.get("products") or {}).values():
            if pid and pid not in still_used and pid not in PINNED:
                IMAGES.pop(pid, None)
                META.pop(pid, None)


def _png(img: np.ndarray, q: int = 6) -> bytes:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, q])
    if not ok:
        raise HTTPException(500, "PNG encode failed")
    return buf.tobytes()


def _store(img: np.ndarray, name: str, kind: str, extra: dict | None = None) -> str:
    iid = uuid.uuid4().hex[:12]
    IMAGES[iid] = img
    META[iid] = {"id": iid, "name": name, "kind": kind,
                 "w": int(img.shape[1]), "h": int(img.shape[0]),
                 **(extra or {})}
    return iid


# --------------------------------------------------------------------- presets
def _load_presets() -> list[dict[str, Any]]:
    path = os.path.join(PRESET_DIR, "presets.json")
    if not os.path.exists(path):
        return []
    with open(path) as f:
        defs = json.load(f)

    out = []
    for d in defs:
        sp = os.path.join(PRESET_DIR, d["srcFile"])
        rp = os.path.join(PRESET_DIR, d["refFile"])
        s = cv2.imread(sp, cv2.IMREAD_GRAYSCALE)
        r = cv2.imread(rp, cv2.IMREAD_GRAYSCALE)
        if s is None or r is None:
            continue
        sid = _store(s, d["srcName"], "source",
                     {"sensor": d["sensor"], "gsd": d["gsdSrc"], "preset": d["id"]})
        rid = _store(r, d["refName"], "reference",
                     {"sensor": d["refLabel"], "gsd": d["gsdRef"], "preset": d["id"]})
        e = dict(d)
        e["srcId"] = sid
        e["refId"] = rid
        e["srcSize"] = [int(s.shape[1]), int(s.shape[0])]
        e["refSize"] = [int(r.shape[1]), int(r.shape[0])]
        e.pop("srcFile", None)
        e.pop("refFile", None)
        out.append(e)
    return out


PRESETS: list[dict[str, Any]] = []


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global PRESETS
    PRESETS = _load_presets()
    PINNED.update(IMAGES.keys())
    print(f"[selene-reg] loaded {len(PRESETS)} presets, {len(IMAGES)} rasters")
    yield


app.router.lifespan_context = lifespan


# ---------------------------------------------------------------------- routes
@app.get("/api/health")
def health():
    return {
        "ok": True,
        "engine": "OpenCV " + cv2.__version__,
        "detectors": ["SIFT", "AKAZE", "ORB", "BRISK"],
        "models": ["homography", "affine", "similarity"],
        "robust": ["MAGSAC", "RANSAC", "LMEDS"],
        "presets": len(PRESETS),
        "jobs": len(JOBS),
    }


@app.get("/api/presets")
def presets():
    return {"presets": PRESETS}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), role: str = Form("source")):
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "Empty file.")
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD // (1024 * 1024)} MB limit.")
    img = decode_image(raw)
    if img is None:
        raise HTTPException(
            400, "Could not decode image. Supported: PNG, JPEG, TIFF, BMP "
                 "(8- or 16-bit, grayscale or colour).")
    if min(img.shape[:2]) < 64:
        raise HTTPException(400, "Image too small — minimum 64px on the short edge.")
    iid = _store(img, file.filename or f"{role}.png",
                 "reference" if role == "reference" else "source",
                 {"uploaded": True, "bytes": len(raw)})
    PINNED.add(iid)   # the user's own raster must survive product-cache eviction
    return {**META[iid]}


@app.get("/api/image/{image_id}")
def get_image(image_id: str, colormap: str = "", max: int = 0):
    img = IMAGES.get(image_id)
    if img is None:
        raise HTTPException(404, "Unknown image id.")
    out = img
    if max and max > 0:
        m = builtins_max(out.shape[0], out.shape[1])
        if m > max:
            s = max / m
            out = cv2.resize(out, (int(out.shape[1] * s), int(out.shape[0] * s)),
                             interpolation=cv2.INTER_AREA)
    if colormap == "inferno":
        out = cv2.applyColorMap(out, cv2.COLORMAP_INFERNO)
    return Response(_png(out), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


def builtins_max(a: int, b: int) -> int:
    return a if a > b else b


@app.post("/api/register")
async def do_register(payload: dict[str, Any]):
    src_id = payload.get("srcId")
    ref_id = payload.get("refId")
    src = IMAGES.get(src_id)
    ref = IMAGES.get(ref_id)
    if src is None or ref is None:
        raise HTTPException(400, "Both srcId and refId must reference uploaded images.")

    params = EngineParams.from_dict(payload.get("params", {}))
    t0 = time.perf_counter()
    res = register(src, ref, params)
    total = round((time.perf_counter() - t0) * 1000, 1)

    if not res.ok:
        return JSONResponse(
            {"ok": False, "error": res.error, "warnings": res.warnings,
             "stages": [s.__dict__ for s in res.stages],
             "counts": res.counts, "totalMs": total},
            status_code=200)

    job = uuid.uuid4().hex[:12]
    colormap = "inferno" if (META.get(src_id, {}).get("sensor") == "IIRS") else None
    prods = make_products(src, ref, res.H, colormap)
    pids = {k: _store(v if v.ndim == 2 else cv2.cvtColor(v, cv2.COLOR_BGR2GRAY),
                      f"{k}.png", "product")
            for k, v in prods.items()}
    # store colour products directly so heat-maps keep their palette
    for k, v in prods.items():
        IMAGES[pids[k]] = v

    body = res.as_dict()
    body.update({
        "ok": True, "job": job, "totalMs": total,
        "products": pids,
        "srcId": src_id, "refId": ref_id,
        "srcName": META.get(src_id, {}).get("name", "source"),
        "refName": META.get(ref_id, {}).get("name", "reference"),
        # report the prescale the engine actually applied, not merely the one asked for
        "params": {**params.__dict__, "prescale": res.prescaleUsed,
                   "prescaleRequested": params.prescale},
        "gsdSrc": META.get(src_id, {}).get("gsd"),
        "gsdRef": META.get(ref_id, {}).get("gsd"),
    })
    JOBS[job] = body
    _evict_jobs()
    return body


@app.get("/api/export/{job}/matches.csv")
def export_csv(job: str):
    b = JOBS.get(job)
    if not b:
        raise HTTPException(404, "Unknown job.")
    rows = ["idx,src_x,src_y,ref_x,ref_y,lowe_ratio,residual_px,keypoint_sigma,angle_deg,inlier"]
    for i, m in enumerate(b["matches"]):
        rows.append(f'{i},{m["sx"]},{m["sy"]},{m["rx"]},{m["ry"]},{m["ratio"]},'
                    f'{m["err"]},{m["scl"]},{m["ang"]},{int(m["in"])}')
    return Response("\n".join(rows), media_type="text/csv",
                    headers={"Content-Disposition":
                             f'attachment; filename="{job}_matchpoints.csv"'})


@app.get("/api/export/{job}/report.json")
def export_report(job: str):
    b = JOBS.get(job)
    if not b:
        raise HTTPException(404, "Unknown job.")
    gsd_ref = b.get("gsdRef")
    report = {
        "problem_statement": "ISRO SIH 26166 — Multi-modal, sun-angle and scale "
                             "invariant image correspondence",
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": b["srcName"], "reference": b["refName"],
        "source_size_px": b["srcSize"], "reference_size_px": b["refSize"],
        "parameters": b["params"],
        "transform_source_to_reference": b["H"],
        "decomposition": b["decomp"],
        "counts": b["counts"],
        "metrics": b["metrics"],
        "metrics_ground": ({"rmse_m": round(b["metrics"]["rmse"] * gsd_ref, 4),
                            "mae_m": round(b["metrics"]["mae"] * gsd_ref, 4)}
                           if gsd_ref else None),
        "uniformity_grid_8x8": b["grid"],
        "stages_ms": b["stages"],
        "total_ms": b["totalMs"],
        "warnings": b["warnings"],
    }
    return Response(json.dumps(report, indent=2), media_type="application/json",
                    headers={"Content-Disposition":
                             f'attachment; filename="{job}_report.json"'})


@app.get("/api/export/{job}/{product}.png")
def export_product(job: str, product: str):
    b = JOBS.get(job)
    if not b:
        raise HTTPException(404, "Unknown job.")
    pid = b["products"].get(product)
    if not pid or pid not in IMAGES:
        raise HTTPException(404, f"Unknown product '{product}'.")
    return Response(_png(IMAGES[pid]), media_type="image/png",
                    headers={"Content-Disposition":
                             f'attachment; filename="{job}_{product}.png"'})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
