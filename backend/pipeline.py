"""
SELENE-REG registration engine.

Real OpenCV image-registration pipeline for Chandrayaan-2 optical imagery
(OHRC / TMC-2 / IIRS) against lunar reference basemaps (LRO NAC, SELENE TC).

Addresses the three challenges in ISRO SIH problem statement 26166:

  * Illumination variation -> CLAHE + optional gradient-domain / polarity handling
  * Viewpoint variation    -> homography / affine / similarity models via RANSAC
  * Scale variation        -> GSD-aware pre-scaling before detection

Plus the two explicit deliverable requirements:

  * sub-pixel accuracy        -> optional ECC photometric refinement of the transform
  * uniform match distribution -> bucketed adaptive non-maximal suppression (ANMS)
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field, asdict
from typing import Any

import cv2
import numpy as np

MAX_DIM = 1600          # working resolution cap (keeps the UI interactive)
GRID = 8                # uniformity grid is GRID x GRID


# --------------------------------------------------------------------------- config
DETECTORS = ("SIFT", "AKAZE", "ORB", "BRISK")
MODELS = ("homography", "affine", "similarity")
ROBUST = ("MAGSAC", "RANSAC", "LMEDS")

# Post-prescale pixel budget. Measured on this service: SIFT costs roughly 235 MB
# of peak RSS per megapixel of input (1 MP -> 281 MB, 4 MP -> 967 MB, 6 MP -> 1395 MB,
# 9 MP -> OOM on a 2 GB box). Both source and reference are detected, so the cap has
# to leave headroom for two of them plus the product rasters. 3 MP keeps worst-case
# peak near 700 MB per image and has never been killed in soak testing.
MAX_WORK_PIXELS = 3_000_000

# A homography can always be fitted to 4 coincidental points, so RANSAC returning a
# matrix is NOT evidence of a real match. A registration is only reported as
# successful when it clears these floors; otherwise it is an explicit failure and no
# metrics are published.
MIN_INLIERS = 12          # below this the transform is not statistically meaningful
MIN_INLIER_RATIO = 0.06   # inliers as a fraction of candidate correspondences


@dataclass
class EngineParams:
    detector: str = "SIFT"          # SIFT | AKAZE | ORB | BRISK
    model: str = "homography"       # homography | affine | similarity
    ransac: str = "MAGSAC"          # MAGSAC | RANSAC | LMEDS
    ratio: float = 0.80             # Lowe ratio-test threshold
    threshold: float = 3.0          # RANSAC reprojection threshold (px)
    prescale: float = 1.0           # GSD normalisation factor applied to source
    clahe: float = 3.0              # CLAHE clip limit (0 disables)
    invert: bool = False            # flip source polarity (multi-modal IIRS pairs)
    anms: bool = True               # spatially uniform keypoint selection
    ecc: bool = False               # ECC sub-pixel refinement
    crosscheck: bool = False        # mutual nearest-neighbour filter
    maxFeatures: int = 6000
    rejected: list = field(default_factory=list)   # invalid values replaced by defaults

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "EngineParams":
        p = EngineParams()
        for k, v in (d or {}).items():
            if not hasattr(p, k):
                continue
            cur = getattr(p, k)
            try:
                if isinstance(cur, bool):
                    setattr(p, k, v if isinstance(v, bool) else str(v).lower() == "true")
                elif isinstance(cur, float):
                    setattr(p, k, float(v))
                elif isinstance(cur, int):
                    setattr(p, k, int(v))
                else:
                    setattr(p, k, str(v))
            except (TypeError, ValueError):
                pass
        p.ratio = float(np.clip(p.ratio, 0.30, 0.99))
        p.threshold = float(np.clip(p.threshold, 0.25, 12.0))
        p.prescale = float(np.clip(p.prescale, 0.15, 8.0))
        p.clahe = float(np.clip(p.clahe, 0.0, 12.0))
        p.maxFeatures = int(np.clip(p.maxFeatures, 500, 20000))

        # Unknown enum values must not be echoed back as if they had been used —
        # the UI displays these, so silently reporting a detector that never ran
        # would be a fabricated result. Fall back and record the substitution.
        p.rejected = []
        if p.detector.upper() not in DETECTORS:
            p.rejected.append(f"detector {p.detector!r} → SIFT")
            p.detector = "SIFT"
        else:
            p.detector = p.detector.upper()
        if p.model.lower() not in MODELS:
            p.rejected.append(f"model {p.model!r} → homography")
            p.model = "homography"
        else:
            p.model = p.model.lower()
        if p.ransac.upper() not in ROBUST:
            p.rejected.append(f"robust estimator {p.ransac!r} → MAGSAC")
            p.ransac = "MAGSAC"
        else:
            p.ransac = p.ransac.upper()
        return p


@dataclass
class Stage:
    name: str
    ms: float
    detail: str = ""


@dataclass
class Result:
    ok: bool = True
    error: str = ""
    warnings: list[str] = field(default_factory=list)
    stages: list[Stage] = field(default_factory=list)
    H: list[list[float]] | None = None
    decomp: dict[str, float] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    grid: list[list[int]] = field(default_factory=list)
    matches: list[dict[str, float]] = field(default_factory=list)
    prescaleUsed: float = 1.0
    srcSize: list[int] = field(default_factory=list)
    refSize: list[int] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["stages"] = [asdict(s) for s in self.stages]
        return d


class _Clock:
    def __init__(self, sink: list[Stage]):
        self.sink = sink
        self.t = time.perf_counter()

    def lap(self, name: str, detail: str = "") -> None:
        now = time.perf_counter()
        self.sink.append(Stage(name, round((now - self.t) * 1000, 1), detail))
        self.t = now


# ------------------------------------------------------------------------ utilities
def decode_image(buf: bytes) -> np.ndarray | None:
    arr = np.frombuffer(buf, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.ndim == 3:
        img = cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
    if img.dtype != np.uint8:                      # 16-bit planetary products
        img = cv2.normalize(img.astype(np.float32), None, 0, 255,
                            cv2.NORM_MINMAX).astype(np.uint8)
    return img


def fit_working(img: np.ndarray, cap: int = MAX_DIM) -> tuple[np.ndarray, float]:
    """Downscale oversized rasters. Returns (image, scale_applied).

    Two independent limits apply: the longest edge (keeps the UI interactive) and
    the total pixel count (keeps SIFT inside the memory budget for wide or tall
    rasters that would pass the edge test).
    """
    h, w = img.shape[:2]
    s = 1.0
    m = max(h, w)
    if m > cap:
        s = cap / m
    if h * w * s * s > MAX_WORK_PIXELS:
        s = float(np.sqrt(MAX_WORK_PIXELS / float(h * w)))
    if s >= 1.0:
        return img, 1.0
    return cv2.resize(img, (max(1, int(round(w * s))), max(1, int(round(h * s)))),
                      interpolation=cv2.INTER_AREA), s


def preprocess(gray: np.ndarray, clip: float, invert: bool = False) -> np.ndarray:
    """Illumination normalisation — the core of sun-angle invariance."""
    g = 255 - gray if invert else gray
    if clip > 0:
        g = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(g)
    return g


def build_detector(name: str, n: int):
    name = name.upper()
    if name == "AKAZE":
        return cv2.AKAZE_create(threshold=0.0008), cv2.NORM_HAMMING
    if name == "ORB":
        return cv2.ORB_create(nfeatures=n, scaleFactor=1.18, nlevels=10,
                              fastThreshold=8, edgeThreshold=21), cv2.NORM_HAMMING
    if name == "BRISK":
        return cv2.BRISK_create(thresh=18, octaves=4), cv2.NORM_HAMMING
    return cv2.SIFT_create(nfeatures=n, contrastThreshold=0.005,
                           edgeThreshold=16), cv2.NORM_L2


def anms_bucket(kps, descs, shape, target: int, g: int = 10):
    """
    Spatially uniform keypoint selection.

    Splits the frame into a g x g lattice and keeps the strongest keypoints per
    cell. Directly serves the problem statement's requirement that match points
    maintain a uniform distribution across the image, and stops RANSAC from
    fitting a transform biased toward one high-texture region.
    """
    if descs is None or len(kps) <= target:
        return kps, descs
    h, w = shape[:2]
    per = max(1, target // (g * g))
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, k in enumerate(kps):
        cx = min(g - 1, int(k.pt[0] / w * g))
        cy = min(g - 1, int(k.pt[1] / h * g))
        buckets.setdefault((cy, cx), []).append(i)

    keep: list[int] = []
    leftovers: list[int] = []
    for idxs in buckets.values():
        idxs.sort(key=lambda i: kps[i].response, reverse=True)
        keep.extend(idxs[:per])
        leftovers.extend(idxs[per:])
    if len(keep) < target and leftovers:
        leftovers.sort(key=lambda i: kps[i].response, reverse=True)
        keep.extend(leftovers[: target - len(keep)])

    keep.sort()
    return [kps[i] for i in keep], descs[keep]


def match_descriptors(d1, d2, norm, ratio, crosscheck):
    """k-NN matching + Lowe ratio test (+ optional mutual-consistency check)."""
    if d1 is None or d2 is None or len(d1) < 2 or len(d2) < 2:
        return [], 0
    if norm == cv2.NORM_L2:
        matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=96))
        a = np.float32(d1); b = np.float32(d2)
    else:
        matcher = cv2.BFMatcher(norm)
        a, b = d1, d2

    knn = matcher.knnMatch(a, b, k=2)
    fwd = {}
    for pair in knn:
        if len(pair) != 2:
            continue
        m, n = pair
        r = m.distance / (n.distance + 1e-7)
        if r < 0.98:                      # superset; strict filter applied later
            fwd[m.queryIdx] = (m, r)

    if crosscheck:
        back = matcher.knnMatch(b, a, k=2)
        rev = {}
        for pair in back:
            if len(pair) != 2:
                continue
            m, n = pair
            if m.distance / (n.distance + 1e-7) < 0.98:
                rev[m.queryIdx] = m.trainIdx
        fwd = {q: v for q, v in fwd.items() if rev.get(v[0].trainIdx) == q}

    return list(fwd.values()), len(knn)


def estimate(src_pts, dst_pts, model: str, method: str, thr: float):
    flag = {"MAGSAC": cv2.USAC_MAGSAC, "RANSAC": cv2.RANSAC,
            "LMEDS": cv2.LMEDS}.get(method.upper(), cv2.USAC_MAGSAC)
    n = len(src_pts)
    if model == "affine":
        if n < 3:
            return None, None
        A, mask = cv2.estimateAffine2D(
            src_pts, dst_pts,
            method=cv2.RANSAC if flag == cv2.USAC_MAGSAC else flag,
            ransacReprojThreshold=thr, maxIters=20000, confidence=0.9995)
        return (np.vstack([A, [0, 0, 1]]) if A is not None else None), mask
    if model == "similarity":
        if n < 2:
            return None, None
        A, mask = cv2.estimateAffinePartial2D(
            src_pts, dst_pts,
            method=cv2.RANSAC if flag == cv2.USAC_MAGSAC else flag,
            ransacReprojThreshold=thr, maxIters=20000, confidence=0.9995)
        return (np.vstack([A, [0, 0, 1]]) if A is not None else None), mask
    if n < 4:
        return None, None
    if flag == cv2.LMEDS:
        H, mask = cv2.findHomography(src_pts, dst_pts, cv2.LMEDS)
    else:
        H, mask = cv2.findHomography(src_pts, dst_pts, flag, thr,
                                     maxIters=20000, confidence=0.9995)
    return H, mask


def ecc_refine(H, src_gray, ref_gray):
    """
    Photometric sub-pixel refinement.

    Warps the source with the feature-based H, then solves a residual ECC
    correction between the warped source and the reference and composes it back.
    Working in the reference frame keeps both inputs the same size.
    """
    h, w = ref_gray.shape[:2]
    warped = cv2.warpPerspective(src_gray, H, (w, h), flags=cv2.INTER_LINEAR)
    valid = cv2.warpPerspective(np.full(src_gray.shape, 255, np.uint8), H, (w, h))
    if (valid > 0).mean() < 0.12:
        raise cv2.error("insufficient overlap for ECC")

    a = cv2.normalize(warped.astype(np.float32), None, 0, 1, cv2.NORM_MINMAX)
    b = cv2.normalize(ref_gray.astype(np.float32), None, 0, 1, cv2.NORM_MINMAX)
    warp = np.eye(3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-7)
    cv2.findTransformECC(b, a, warp, cv2.MOTION_HOMOGRAPHY, crit,
                         (valid > 0).astype(np.uint8), 5)
    return warp.astype(np.float64) @ H


# -------------------------------------------------------------------------- metrics
def decompose(H) -> dict[str, float]:
    a, b, c, d = H[0, 0], H[0, 1], H[1, 0], H[1, 1]
    sx = math.hypot(a, c)
    sy = (a * d - b * c) / max(sx, 1e-9)
    return {
        "scale": round(float((sx + abs(sy)) / 2), 4),
        "rotation": round(float(math.degrees(math.atan2(c, a))), 3),
        "tx": round(float(H[0, 2]), 2),
        "ty": round(float(H[1, 2]), 2),
        "shear": round(float((a * b + c * d) / max(sx * sx, 1e-9)), 4),
        "aspect": round(float(abs(sy) / max(sx, 1e-9)), 4),
    }


def uniformity(pts, w, h, g: int = GRID):
    grid = np.zeros((g, g), np.int32)
    for x, y in pts:
        gx = min(g - 1, max(0, int(x / w * g)))
        gy = min(g - 1, max(0, int(y / h * g)))
        grid[gy, gx] += 1
    occupied = int((grid > 0).sum())
    occ = occupied / (g * g)
    tot = grid.sum()
    if tot <= 0:
        return 0.0, 0.0, grid.tolist()
    p = grid.astype(np.float64).ravel() / tot
    nz = p[p > 0]
    ent = float(-(nz * np.log(nz)).sum() / math.log(g * g)) if occupied > 1 else 0.0
    return round(0.5 * occ + 0.5 * ent, 4), round(occ, 4), grid.tolist()


# ------------------------------------------------------------------------- pipeline
def register(src_raw: np.ndarray, ref_raw: np.ndarray, p: EngineParams) -> Result:
    res = Result()
    clock = _Clock(res.stages)

    src_w, wsc = fit_working(src_raw)
    ref_w, wrc = fit_working(ref_raw)
    if wsc != 1.0 or wrc != 1.0:
        res.warnings.append(
            f"Working resolution capped at {MAX_DIM}px "
            f"(source ×{wsc:.2f}, reference ×{wrc:.2f}); coordinates are reported "
            f"in original source pixels.")
    clock.lap("Decode & scale",
              f"{src_w.shape[1]}×{src_w.shape[0]} vs {ref_w.shape[1]}×{ref_w.shape[0]}")

    # ---- GSD normalisation (scale invariance) ------------------------------
    ps = p.prescale
    sh0, sw0 = src_w.shape[:2]
    if sh0 * sw0 * ps * ps > MAX_WORK_PIXELS:
        ps_capped = float(np.sqrt(MAX_WORK_PIXELS / float(sh0 * sw0)))
        res.warnings.append(
            f"GSD pre-scale reduced ×{ps:g} → ×{ps_capped:.2f} to stay within the "
            f"{MAX_WORK_PIXELS // 1_000_000} MP working budget.")
        ps = ps_capped
    res.prescaleUsed = round(float(ps), 4)
    src_s = src_w if ps == 1.0 else cv2.resize(
        src_w, None, fx=ps, fy=ps,
        interpolation=cv2.INTER_CUBIC if ps > 1 else cv2.INTER_AREA)
    clock.lap("GSD normalisation", f"×{ps:g} → {src_s.shape[1]}×{src_s.shape[0]}")

    # ---- illumination equalisation (sun-angle invariance) ------------------
    sp = preprocess(src_s, p.clahe, p.invert)
    rp = preprocess(ref_w, p.clahe, False)
    clock.lap("Illumination equalisation",
              f"CLAHE clip {p.clahe:g}" + (" · polarity inverted" if p.invert else ""))

    # ---- detection ---------------------------------------------------------
    # When ANMS is on we deliberately over-detect, then bucket-select down to the
    # budget — otherwise the detector already returns <= budget and ANMS is a no-op.
    detect_budget = p.maxFeatures * 3 if p.anms else p.maxFeatures
    det, norm = build_detector(p.detector, detect_budget)
    k1, d1 = det.detectAndCompute(sp, None)
    k2, d2 = det.detectAndCompute(rp, None)
    if not k1 or not k2 or d1 is None or d2 is None:
        res.ok = False
        res.error = f"{p.detector} found no usable features in one of the images."
        return res
    raw1, raw2 = len(k1), len(k2)

    if p.anms:
        k1, d1 = anms_bucket(k1, d1, sp.shape, p.maxFeatures, g=12)
        k2, d2 = anms_bucket(k2, d2, rp.shape, p.maxFeatures, g=12)
    clock.lap(f"{p.detector} detection",
              f"{raw1}/{raw2} → {len(k1)}/{len(k2)} keypoints"
              + (" (ANMS)" if p.anms else ""))

    # ---- matching ----------------------------------------------------------
    cand, knn_n = match_descriptors(d1, d2, norm, p.ratio, p.crosscheck)
    if len(cand) < 4:
        res.ok = False
        res.error = ("Not enough descriptor matches survived the ratio test — "
                     "try a lower detector threshold, a different detector, or "
                     "check the GSD pre-scale.")
        res.counts = {"kpSrc": len(k1), "kpRef": len(k2), "knn": knn_n, "candidates": len(cand)}
        return res
    clock.lap("Descriptor matching",
              f"{knn_n} k-NN → {len(cand)} candidates"
              + (" · cross-checked" if p.crosscheck else ""))

    strict = [(m, r) for m, r in cand if r < p.ratio]
    if len(strict) < 4:
        strict = sorted(cand, key=lambda t: t[1])[:max(8, len(cand) // 4)]
        res.warnings.append(
            f"Lowe ratio {p.ratio:.2f} left too few matches; relaxed automatically.")

    sp_pts = np.float32([k1[m.queryIdx].pt for m, _ in strict]).reshape(-1, 1, 2)
    rp_pts = np.float32([k2[m.trainIdx].pt for m, _ in strict]).reshape(-1, 1, 2)

    # ---- robust model estimation (viewpoint invariance) --------------------
    H, mask = estimate(sp_pts, rp_pts, p.model, p.ransac, p.threshold)
    if H is None:
        res.ok = False
        res.error = ("Robust estimation failed to find a consistent transform. "
                     "The pair may not overlap, or the model is too constrained.")
        res.counts = {"kpSrc": len(k1), "kpRef": len(k2), "knn": knn_n,
                      "candidates": len(strict)}
        return res
    n_inl = int(mask.sum()) if mask is not None else 0
    n_cand = len(strict)
    ratio_inl = (n_inl / n_cand) if n_cand else 0.0
    clock.lap(f"{p.ransac} · {p.model}",
              f"{n_inl} inliers @ τ={p.threshold:g}px")

    # ---- confidence gate ---------------------------------------------------
    if n_inl < MIN_INLIERS or ratio_inl < MIN_INLIER_RATIO:
        res.ok = False
        res.error = (
            f"No reliable correspondence found — only {n_inl} inliers from "
            f"{n_cand} candidates ({ratio_inl * 100:.1f}%). A transform fitted to so "
            f"few points is not statistically meaningful, so no metrics are reported. "
            f"The images may not overlap, or may be too dissimilar to match.")
        res.counts = {"kpSrcRaw": raw1, "kpSrc": len(k1),
                      "kpRefRaw": raw2, "kpRef": len(k2), "knn": knn_n,
                      "candidates": n_cand, "inliers": n_inl}
        return res

    # ---- optional photometric sub-pixel refinement -------------------------
    if p.ecc:
        try:
            H = ecc_refine(H, sp, rp)
            clock.lap("ECC sub-pixel refinement", "converged")
        except cv2.error:
            res.warnings.append("ECC refinement did not converge; feature-based transform kept.")
            clock.lap("ECC sub-pixel refinement", "not converged")

    # ---- residuals over the full candidate set -----------------------------
    all_src = np.float32([k1[m.queryIdx].pt for m, _ in cand]).reshape(-1, 1, 2)
    all_ref = np.float32([k2[m.trainIdx].pt for m, _ in cand])
    proj = cv2.perspectiveTransform(all_src, H).reshape(-1, 2)
    resid = np.linalg.norm(proj - all_ref, axis=1)

    matches = []
    for i, (m, r) in enumerate(cand):
        x1, y1 = k1[m.queryIdx].pt
        x2, y2 = k2[m.trainIdx].pt
        e = float(resid[i])
        matches.append({
            "sx": round(x1 / ps / wsc, 2), "sy": round(y1 / ps / wsc, 2),
            "rx": round(x2 / wrc, 2), "ry": round(y2 / wrc, 2),
            "vx": round(x1 / ps, 2), "vy": round(y1 / ps, 2),
            "ratio": round(float(r), 3), "err": round(e, 3),
            "scl": round(float(k1[m.queryIdx].size), 2),
            "ang": round(float(k1[m.queryIdx].angle), 1),
            "in": bool(r < p.ratio and e <= p.threshold),
        })
    matches.sort(key=lambda d: d["err"])

    inl = [m for m in matches if m["in"]]
    errs = np.array([m["err"] for m in inl]) if inl else np.array([0.0])
    uni, occ, grid = uniformity([(m["rx"], m["ry"]) for m in inl],
                                ref_raw.shape[1], ref_raw.shape[0])
    cands_strict = [m for m in matches if m["ratio"] < p.ratio]

    res.H = [[round(float(v), 9) for v in row] for row in H]
    res.decomp = decompose(H)
    res.counts = {
        "kpSrcRaw": raw1, "kpRefRaw": raw2, "kpSrc": len(k1), "kpRef": len(k2),
        "knn": knn_n, "candidates": len(cands_strict), "inliers": len(inl),
    }
    res.metrics = {
        "rmse": round(float(np.sqrt((errs ** 2).mean())), 4),
        "mae": round(float(errs.mean()), 4),
        "max": round(float(errs.max()), 4),
        "p90": round(float(np.percentile(errs, 90)), 4),
        "median": round(float(np.median(errs)), 4),
        "inlierRatio": round(len(inl) / max(len(cands_strict), 1), 4),
        "uniformity": uni, "occupancy": occ,
    }
    res.grid = grid
    res.matches = matches[:2500]
    res.srcSize = [int(src_raw.shape[1]), int(src_raw.shape[0])]
    res.refSize = [int(ref_raw.shape[1]), int(ref_raw.shape[0])]
    clock.lap("Metrics", f"RMSE {res.metrics['rmse']:.3f}px · {len(inl)} inliers")

    # transform expressed in ORIGINAL source/reference pixel coordinates
    S = np.diag([ps * wsc, ps * wsc, 1.0])
    T = np.diag([1.0 / wrc, 1.0 / wrc, 1.0])
    res.H = [[round(float(v), 9) for v in row] for row in (T @ H @ np.linalg.inv(S))]
    return res


# ------------------------------------------------------------------------ products
def make_products(src_raw, ref_raw, H, colormap: str | None = None):
    """Warped source, checkerboard mosaic and residual heat-map, in reference space."""
    h, w = ref_raw.shape[:2]
    src_bgr = (cv2.applyColorMap(src_raw, cv2.COLORMAP_INFERNO)
               if colormap == "inferno" else cv2.cvtColor(src_raw, cv2.COLOR_GRAY2BGR))
    ref_bgr = cv2.cvtColor(ref_raw, cv2.COLOR_GRAY2BGR)

    Hm = np.array(H, dtype=np.float64)
    warped = cv2.warpPerspective(src_bgr, Hm, (w, h))

    # Valid-coverage mask: where the warped source actually has data. The source
    # frame is usually smaller than the reference, so everything outside it must
    # fall back to the reference instead of rendering as black tiles.
    cover = cv2.warpPerspective(np.full(src_bgr.shape[:2], 255, np.uint8), Hm, (w, h)) > 0

    chk = ref_bgr.copy()
    cell = max(24, w // 14)
    src_tile = np.zeros((h, w), bool)   # which pixels came from the registered source
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2 == 0:
                tile_cov = cover[y:y + cell, x:x + cell]
                if not tile_cov.any():
                    continue
                tile = chk[y:y + cell, x:x + cell]
                tile[tile_cov] = warped[y:y + cell, x:x + cell][tile_cov]
                src_tile[y:y + cell, x:x + cell] |= tile_cov

    # Outline every seam. A correct registration keeps crater rims continuous ACROSS
    # these lines, which is the whole point of the checkerboard test.
    seam = (cv2.dilate(src_tile.astype(np.uint8), np.ones((3, 3), np.uint8)) -
            src_tile.astype(np.uint8)).astype(bool)
    chk[seam] = (140, 235, 175)

    a = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    a = cv2.normalize(cv2.GaussianBlur(a, (0, 0), 1.2), None, 0, 255, cv2.NORM_MINMAX)
    b = cv2.normalize(cv2.GaussianBlur(b, (0, 0), 1.2), None, 0, 255, cv2.NORM_MINMAX)
    diff = cv2.absdiff(a, b).astype(np.uint8)
    diff[~cover] = 0
    heat = cv2.applyColorMap(diff, cv2.COLORMAP_TURBO)
    # outside the overlap show a dim version of the reference for spatial context
    ctx_bg = (ref_bgr.astype(np.float32) * 0.22).astype(np.uint8)
    heat[~cover] = ctx_bg[~cover]

    return {"source": src_bgr, "reference": ref_bgr,
            "registered": warped, "checker": chk, "diff": heat}
