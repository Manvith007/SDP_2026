# SELENE-REG

**Multi-modal, sun-angle and scale invariant image correspondence between Chandrayaan-2
optical imagery and lunar reference maps.**

Smart India Hackathon · Problem Statement **26166** · ISRO / Dept. of Space

---

## What this is

A working image-registration system, not a mockup. A FastAPI + OpenCV backend performs
live feature detection, descriptor matching and robust model fitting; a React front end
drives it and visualises every intermediate result.

Every number displayed in the UI — RMSE, inlier count, inlier ratio, uniformity,
per-stage timings, the recovered transform — is read back from an actual OpenCV run.
Nothing is hard-coded or simulated.

## The problem

Chandrayaan-2 payloads (OHRC, TMC-2, IIRS) image the Moon at wildly different ground
sampling distances, in different spectral bands, and under different solar illumination
than the reference maps they must be co-registered against (LRO NAC, SELENE TC). Naive
intensity correlation fails. The system must be invariant to:

| # | Challenge | Approach |
|---|-----------|----------|
| 1 | **Illumination / sun angle** | CLAHE local contrast equalisation + gradient-orientation descriptors, which encode structure rather than brightness |
| 2 | **Viewpoint / rotation** | Keypoint dominant-orientation assignment; homography / affine / similarity fitting under MAGSAC++ |
| 3 | **Scale (GSD mismatch)** | Scale-space pyramid detection plus optional explicit GSD pre-scaling |
| 4 | **Uniform match spread** | Adaptive non-maximal suppression — over-detect 3×, then bucket-select across a 12×12 grid |

The **Report** tab renders this table live, filled in with the measured values from the
current run.

---

## Running it

Two processes. Backend first.

### 1. Backend (FastAPI + OpenCV)

```bash
pip install fastapi uvicorn opencv-python-headless numpy python-multipart
python3 backend/server.py          # serves on http://0.0.0.0:8000
```

On boot it generates/loads 3 preset scene pairs (6 rasters) and logs
`[selene-reg] loaded 3 presets, 6 rasters`.

### 2. Front end (React + Vite)

```bash
cd chandra-reg
npm install
npm run dev                        # http://localhost:5173
```

Vite proxies `/api/*` to `127.0.0.1:8000`, so the browser only ever uses relative URLs.
If the API is down the UI shows a "Registration API unreachable" screen with a retry
button rather than failing silently.

Production build: `npm run build` → `dist/`.

---

## API

| Method | Route | Purpose |
|--------|-------|---------|
| `GET`  | `/api/health` | Engine version, available detectors / models / estimators, preset & job counts |
| `GET`  | `/api/presets` | The three built-in scene pairs with sensor metadata and illumination geometry |
| `POST` | `/api/upload` | Multipart (`file`, `role`) raster upload, 40 MB cap → `{id, w, h}` |
| `GET`  | `/api/image/{id}` | Decoded raster as PNG; optional `max=` downscale and `colormap=` |
| `POST` | `/api/register` | Run the full pipeline; returns metrics, counts, decomposition, stages, matches, product IDs |
| `GET`  | `/api/export/{job}/matches.csv` | Every correspondence with coordinates, residual and Lowe ratio |
| `GET`  | `/api/export/{job}/report.json` | Complete machine-readable run record |
| `GET`  | `/api/export/{job}/{registered,checker,diff}.png` | Rendered products |

### `/api/register` response

```jsonc
{
  "ok": true, "job": "c70996a76daf", "warnings": [],
  "metrics": { "rmse": 0.520, "inlierRatio": 0.701, "uniformity": 0.520, "occupancy": 0.36, ... },
  "counts":  { "kpSrcRaw": 18001, "kpSrc": 6000, "candidates": 147, "inliers": 103, ... },
  "decomp":  { "scale": 0.7404, "rotation": 11.461, "tx": 270.4, "ty": 118.8, "shear": -0.0064 },
  "stages":  [ { "name": "detect", "ms": 1419, "detail": "18001/18000 → 6000/6000 keypoints (ANMS)" }, ... ],
  "products":{ "registered": "...", "checker": "...", "diff": "..." },
  "totalMs": 1716, "H": [[...]], "matches": [ ... ]
}
```

### Refusing to invent results

A homography can always be fitted to four coincidental points, so RANSAC returning a
matrix is *not* evidence of a real match. Before publishing metrics the engine applies a
confidence gate — at least **12 inliers** and a **6 % inlier ratio**. Below either floor
the response is `ok: false` with an explanation and **no metrics at all**, rather than a
fabricated sub-pixel RMSE. Verified against pathological inputs:

| Source vs. reference | Result |
|---|---|
| Flat gray, no texture | `SIFT found no usable features` |
| Pure noise | `only 6 inliers from 230 candidates` — rejected |
| All black | `SIFT found no usable features` |
| 64 px thumbnail | `only 4 inliers from 8 candidates` — rejected |
| 2000×80 sliver | `only 5 inliers from 17 candidates` — rejected |
| A genuinely unrelated lunar region | `only 5 inliers from 76 candidates` — rejected |

Before this gate existed, the unrelated-region pair reported a confident
`RMSE 0.234 px` from 5 accidental inliers. The UI mirrors the gate: metric tiles blank
to `—`, the canvas clears and the failure reason is shown.

Invalid enum values are not echoed back either. Sending `detector: "NOPE"` falls back to
SIFT *and* reports `params.rejected: ["detector 'NOPE' → SIFT"]`, so the interface can
never display an engine setting that did not actually run. Likewise `params.prescale`
reports the value the engine applied, with `prescaleRequested` alongside it.

Requests that produce too few correspondences but still clear the gate do not error —
the backend relaxes the constraints, proceeds, and reports what it did in `warnings[]`,
which the UI surfaces as a banner.

### Memory safety

SIFT costs roughly 235 MB of peak RSS per megapixel (measured: 1 MP → 281 MB,
4 MP → 967 MB, 6 MP → 1395 MB, 9 MP → OOM on a 2 GB box). Both images are detected, so
the working resolution is capped at **3 MP** by pixel count *and* 1600 px on the long
edge — extreme aspect ratios cannot slip past the edge test. An absurd `prescale: 500`
is clamped with a warning rather than killing the process.

Every run generates five full-resolution product rasters, so the job store evicts
oldest-first past 24 jobs or 420 MB of derived imagery. Presets and user uploads are
pinned and never evicted. Soak-tested at 70 consecutive registrations: resident memory
plateaus around 660 MB and stays flat, exports on recent jobs keep returning 200 while
evicted jobs correctly return 404.

---

## Measured results

Live backend, default parameters, OpenCV 4.11.0:

| Preset | RMSE px | inliers / candidates | inlier % | uniformity | scale | rotation | ms |
|--------|---------|----------------------|----------|------------|-------|----------|-----|
| OHRC → LRO NAC   | 0.651 | 87 / 128  | 68 % | 0.533 | 0.739× | +11.46° | 1481 |
| TMC-2 → LRO NAC  | 1.199 | 120 / 263 | 46 % | 0.712 | 1.629× | −23.96° | 1420 |
| IIRS → SELENE TC | 0.761 | 109 / 394 | 28 % | 0.663 | 1.129× | +21.98° | 1277 |

The preset pairs are synthesised from a real LRO mosaic with a *known* transform, so the
solver can be checked against ground truth: OHRC recovers 0.739× against an injected
1/1.35 = 0.741×, and TMC-2 recovers −23.96° against an injected −24.0°.

**Detector comparison** (OHRC↔NAC, ratio 0.80, threshold 3.0):

| Detector | RMSE px | inliers | ms |
|----------|---------|---------|-----|
| SIFT  | 0.661 | 86  | 1199 |
| AKAZE | 1.069 | 175 | 984  |
| ORB   | 1.317 | 296 | 450  |
| BRISK | 0.838 | 93  | 5542 |

**Transform model** on the same pair: affine 0.486 px < homography 0.657 px < similarity
1.130 px. ECC sub-pixel refinement adds roughly 1.3 s and an eighth pipeline stage.

Grid occupancy sits around 0.33–0.36 on the OHRC pair because the source frame only
covers about a third of the reference — that is geometry, not a defect.

---

## Interface

**Correspondence tab** — side-by-side match plot with pan/zoom, a 4× loupe that samples
full-resolution pixels, per-point hover inspection, the projected source footprint drawn
on the reference, and colour-by residual / Lowe ratio / scale. The *Residual field* view
switches to a quiver plot: arrows from each observed point toward its reprojection,
auto-scaled in screen space so sub-pixel error is actually visible.

**Product tab** — swipe divider, blend slider, checkerboard mosaic (seams outlined so
continuity across tile boundaries can be judged) and a residual heat map with colourbar.

**Report tab** — the estimated 3×3 matrix, its decomposition, detector/matcher counts,
accuracy statistics, the live PS-compliance matrix, and CSV / JSON / PNG exports.

Left rail carries scene metadata, an illumination-geometry dial and the timed pipeline
breakdown. Right rail exposes detector, transform model, robust estimator, Lowe ratio,
RANSAC threshold, GSD pre-scale, CLAHE clip, feature budget, ANMS, ECC refinement,
polarity inversion and cross-checking. Changing any control re-runs the registration
against the live backend after a short debounce.

Bring your own data with the two dropzones — any pair of rasters works, and uploaded
pairs run through exactly the same pipeline as the presets.

## Layout

```
backend/
  server.py           FastAPI routes, job store, preset loading
  pipeline.py         the OpenCV engine: detect → match → filter → fit → measure
  presets/            generated scene pairs + presets.json
chandra-reg/
  src/App.jsx                    application shell, state, API orchestration
  src/lib/api.js                 typed client (relative URLs, upload progress, abort)
  src/components/MatchCanvas.jsx correspondence + residual-field renderer
  src/components/ProductView.jsx swipe / blend / checkerboard / heat-map inspector
  src/components/Panels.jsx      metric tiles, sliders, toggles, histogram, sun dial
  src/components/Dropzone.jsx    raster upload with progress
tools/
  make_presets.py     builds the preset pairs from a base mosaic
```
