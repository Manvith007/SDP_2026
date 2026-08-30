# SELENE-REG (SDP_2026)

**Multi-modal, sun-angle and scale invariant image correspondence between Chandrayaan-2 optical imagery and lunar reference maps.**

Smart India Hackathon · Problem Statement **26166** · ISRO / Dept. of Space

---

## Overview

A working image-registration system, not a mockup. A FastAPI + OpenCV backend performs live feature detection, descriptor matching, and robust model fitting; a React front end drives it and visualises every intermediate result.

Every number displayed in the UI — RMSE, inlier count, inlier ratio, uniformity, per-stage timings, the recovered transform — is read back from an actual OpenCV run. Nothing is hard-coded or simulated.

---

## The Problem

Chandrayaan-2 payloads (OHRC, TMC-2, IIRS) image the Moon at wildly different ground sampling distances, in different spectral bands, and under different solar illumination than the reference maps they must be co-registered against (LRO NAC, SELENE TC). Naive intensity correlation fails. The system must be invariant to:

| # | Challenge | Approach |
|---|-----------|----------|
| 1 | **Illumination / sun angle** | CLAHE local contrast equalisation + gradient-orientation descriptors, which encode structure rather than brightness |
| 2 | **Viewpoint / rotation** | Keypoint dominant-orientation assignment; homography / affine / similarity fitting under MAGSAC++ |
| 3 | **Scale (GSD mismatch)** | Scale-space pyramid detection plus optional explicit GSD pre-scaling |
| 4 | **Uniform match spread** | Adaptive non-maximal suppression — over-detect 3×, then bucket-select across a 12×12 grid |

The **Report** tab renders this table live, filled in with the measured values from the current run.

---

## Getting Started & Running

The application consists of two processes. Start the backend first.

### 1. Backend (FastAPI + OpenCV)

```bash
pip install fastapi uvicorn opencv-python-headless numpy python-multipart
python backend/server.py          # serves on http://localhost:8000
```

On boot, it loads the 3 built-in preset scene pairs (6 rasters) and logs:
`[selene-reg] loaded 3 presets, 6 rasters`.

### 2. Frontend (React + Vite)

```bash
cd chandra-reg
npm install
npm run dev                        # http://localhost:5173
```

Vite proxies `/api/*` to `http://localhost:8000`, so the browser uses relative URLs. If the API is down, the UI displays a fallback screen with a retry option.

Production build:
```bash
npm run build                      # outputs to dist/
```

---

## API Endpoints

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

---

## Key Features & Safety Mechanisms

### Confidence Gate & Refusal to Invent Results
A homography can always be fitted to four coincidental points, so RANSAC returning a matrix is *not* evidence of a real match. Before publishing metrics, the engine applies a confidence gate — at least **12 inliers** and a **6% inlier ratio**. Below either threshold, the response returns `ok: false` with an explanation and no metrics, preventing fabricated sub-pixel RMSE values.

### Memory Safety & Resolution Capping
To avoid out-of-memory errors on large images, working resolution is capped at **3 MP** by pixel count and 1600 px on the long edge. Job store evicts oldest-first past 24 jobs or 420 MB of derived imagery.

---

## Measured Performance Benchmarks

Live backend performance on default parameters with OpenCV 4.11.0:

| Preset | RMSE (px) | Inliers / Candidates | Inlier % | Uniformity | Scale | Rotation | Time (ms) |
|--------|-----------|----------------------|----------|------------|-------|----------|-----------|
| **OHRC → LRO NAC**   | 0.651 | 87 / 128  | 68 % | 0.533 | 0.739× | +11.46° | 1481 |
| **TMC-2 → LRO NAC**  | 1.199 | 120 / 263 | 46 % | 0.712 | 1.629× | −23.96° | 1420 |
| **IIRS → SELENE TC** | 0.761 | 109 / 394 | 28 % | 0.663 | 1.129× | +21.98° | 1277 |

**Detector Comparison** (OHRC↔NAC, ratio 0.80, threshold 3.0):

| Detector | RMSE (px) | Inliers | Time (ms) |
|----------|-----------|---------|-----------|
| **SIFT**  | 0.661 | 86  | 1199 |
| **AKAZE** | 1.069 | 175 | 984  |
| **ORB**   | 1.317 | 296 | 450  |
| **BRISK** | 0.838 | 93  | 5542 |

---

## Repository Structure

```text
├── assets/             # Project assets and diagrams
├── backend/
│   ├── server.py       # FastAPI routes, job store, preset loading
│   ├── pipeline.py     # OpenCV registration engine: detect → match → filter → fit → measure
│   └── presets/        # Generated scene pairs + metadata
├── chandra-reg/        # Frontend web application (React + Vite)
│   ├── src/App.jsx     # Shell, state, and API orchestration
│   ├── src/lib/api.js  # Typed API client
│   └── src/components/ # UI components (MatchCanvas, ProductView, Panels, Dropzone)
└── tools/              # Utility scripts for preset generation
```
