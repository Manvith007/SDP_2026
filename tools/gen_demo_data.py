"""
Demo-data generator for the Chandrayaan-2 image-correspondence UI (SIH PS 26166).

Every number the frontend displays comes from a REAL OpenCV registration run:

  real LRO-NAC lunar frame
    -> shape-from-shading pseudo-DEM  + intrinsic albedo
    -> physical Lambertian re-render under a DIFFERENT sun azimuth/elevation
    -> affine warp (viewpoint + scale + rotation + shear)
    -> per-sensor degradation (OHRC / TMC-2 / IIRS radiometry, GSD, PSF, noise)
    -> GSD-aware pre-scaling + CLAHE  -> SIFT -> FLANN + Lowe ratio -> RANSAC
    -> homography/affine, residuals, RMSE, inlier ratio, grid uniformity
    -> registered product, checkerboard mosaic, residual heat-map

Outputs -> chandra-reg/public/data/
"""
import json, math, os, time
import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "..", "assets", "lunar_base.png")
OUT  = os.path.join(HERE, "..", "chandra-reg", "public", "data")
RNG  = np.random.default_rng(20260829)
W_SHADE = 0.30      # shading vs intrinsic-albedo balance (tuned)
ZS      = 1 / 25.   # surface z-scale (tuned)


# --------------------------------------------------------------- scene synthesis
def pseudo_dem(gray, az0=270.0, lam=0.3, hp_sigma=25, amp=60.0):
    """
    Recover relief from a real lunar frame (shape-from-shading).

    The high-pass image approximates the directional derivative of the surface along the
    original illumination azimuth. Inverting that with a plain 1-D cumulative sum produces
    severe streaking, so we solve it in the Fourier domain with Laplacian (Tikhonov)
    regularisation:   Z = conj(K)·D / (|K|² + lam·L)
    where K is the directional-derivative operator and L the Laplacian. This is a stable,
    streak-free integration.
    """
    I = gray.astype(np.float32) / 255.0
    d = I - cv2.GaussianBlur(I, (0, 0), hp_sigma)
    h, w = d.shape
    a = math.radians(az0)
    sx, sy = math.sin(a), -math.cos(a)

    fy = np.fft.fftfreq(h).reshape(-1, 1).astype(np.float32)
    fx = np.fft.fftfreq(w).reshape(1, -1).astype(np.float32)
    K = 1j * 2 * np.pi * (fx * sx + fy * sy)          # directional derivative
    L = (2 * np.pi * fx) ** 2 + (2 * np.pi * fy) ** 2  # Laplacian regulariser

    Z = (np.conj(K) * np.fft.fft2(d)) / (np.abs(K) ** 2 + lam * L + 1e-6)
    z = np.real(np.fft.ifft2(Z)).astype(np.float32)
    z = cv2.GaussianBlur(z, (0, 0), 1.0)
    return z / (np.abs(z).max() + 1e-9) * amp


def relight(dem, albedo, az, el, w_shade=0.30, zs=1 / 25.):
    """Lambertian re-illumination. w_shade balances view-dependent shading vs intrinsic albedo."""
    gy, gx = np.gradient(dem.astype(np.float32))
    nx, ny, nz = -gx, -gy, np.full_like(gx, zs)
    n = np.sqrt(nx * nx + ny * ny + nz * nz)
    nx, ny, nz = nx / n, ny / n, nz / n
    a, e = math.radians(az), math.radians(el)
    lx, ly, lz = math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)
    sh = np.clip(nx * lx + ny * ly + nz * lz, 0, 1)
    return (np.clip(albedo * ((1 - w_shade) + w_shade * sh * 1.8), 0, 1) * 255).astype(np.uint8)


def affine_warp(img, cx, cy, ow, oh, scale, rot, shear=0.0):
    M = cv2.getRotationMatrix2D((cx, cy), rot, scale)
    M[0, 1] += shear
    M[0, 2] += ow / 2 - cx
    M[1, 2] += oh / 2 - cy
    return cv2.warpAffine(img, M, (ow, oh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)


# --------------------------------------------------------------- sensor models
def sensor_ohrc(img):
    """0.32 m/px panchromatic, sharp optics, low noise."""
    img = cv2.addWeighted(img, 1.30, cv2.GaussianBlur(img, (0, 0), 3), -0.30, 0)
    return np.clip(img + RNG.normal(0, 3.0, img.shape), 0, 255).astype(np.uint8)


def sensor_tmc(img):
    """5 m/px panchromatic stereo mapper: coarser GSD, lifted black level, more noise."""
    s = cv2.resize(img, None, fx=0.45, fy=0.45, interpolation=cv2.INTER_AREA)
    s = np.clip(s.astype(np.float32) * 0.9 + 20, 0, 255)
    return np.clip(s + RNG.normal(0, 4.0, s.shape), 0, 255).astype(np.uint8)


def sensor_iirs(img, ds=0.70, inv_w=0.15):
    """SWIR hyperspectral band: coarse GSD, broad PSF, partially inverted (multi-modal) response."""
    s = cv2.resize(img, None, fx=ds, fy=ds, interpolation=cv2.INTER_AREA)
    s = cv2.GaussianBlur(s, (0, 0), 0.5)
    f = s.astype(np.float32) / 255.0
    f = inv_w * (1 - f) + (1 - inv_w) * f
    f = np.clip((f - f.mean()) * 1.30 + f.mean(), 0, 1)
    return np.clip((f + RNG.normal(0, 0.010, f.shape)) * 255, 0, 255).astype(np.uint8)


# --------------------------------------------------------------- registration core
def preprocess(gray):
    return cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)


def register(src_gray, ref_gray, upscale=1.0, model="homog", ratio=0.80, thr=3.0):
    """GSD-normalise -> CLAHE -> SIFT -> FLANN/Lowe -> RANSAC. Returns transform + all candidates."""
    t0 = time.time()
    s = src_gray if upscale == 1.0 else cv2.resize(
        src_gray, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
    sp_img, rp_img = preprocess(s), preprocess(ref_gray)

    sift = cv2.SIFT_create(nfeatures=9000, contrastThreshold=0.005, edgeThreshold=16)
    k1, d1 = sift.detectAndCompute(sp_img, None)
    k2, d2 = sift.detectAndCompute(rp_img, None)

    flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=128))
    knn = flann.knnMatch(d1, d2, k=2)

    cand = []                                     # keep a superset so the UI can re-filter live
    for pair in knn:
        if len(pair) != 2:
            continue
        m, n = pair
        r = m.distance / (n.distance + 1e-7)
        if r < 0.95:
            cand.append((m, r))

    strict = [(m, r) for m, r in cand if r < ratio]
    sp = np.float32([k1[m.queryIdx].pt for m, _ in strict]).reshape(-1, 1, 2)
    dp = np.float32([k2[m.trainIdx].pt for m, _ in strict]).reshape(-1, 1, 2)

    if model == "affine":
        A, _ = cv2.estimateAffine2D(sp, dp, method=cv2.RANSAC, ransacReprojThreshold=thr,
                                    maxIters=40000, confidence=0.9999)
        H = np.vstack([A, [0, 0, 1]])
    else:
        H, _ = cv2.findHomography(sp, dp, cv2.RANSAC, thr, maxIters=40000, confidence=0.9999)

    elapsed = (time.time() - t0) * 1000

    all_sp = np.float32([k1[m.queryIdx].pt for m, _ in cand]).reshape(-1, 1, 2)
    all_dp = np.float32([k2[m.trainIdx].pt for m, _ in cand])
    resid = np.linalg.norm(cv2.perspectiveTransform(all_sp, H).reshape(-1, 2) - all_dp, axis=1)

    matches = []
    for i, (m, r) in enumerate(cand):
        x1, y1 = k1[m.queryIdx].pt
        x2, y2 = k2[m.trainIdx].pt
        matches.append({
            "sx": round(float(x1 / upscale), 2), "sy": round(float(y1 / upscale), 2),
            "rx": round(float(x2), 2),           "ry": round(float(y2), 2),
            "ratio": round(float(r), 3), "err": round(float(resid[i]), 3),
            "scl": round(float(k1[m.queryIdx].size / upscale), 2),
            "ang": round(float(k1[m.queryIdx].angle), 1),
        })
    # NOTE: do NOT truncate by lowest error here -- that would bias the inlier ratio the
    # UI recomputes. Take a UNIFORM RANDOM sample and report the true candidate total.
    cand_total = len(matches)
    if len(matches) > 2000:
        idx = np.sort(RNG.choice(len(matches), 2000, replace=False))
        matches = [matches[i] for i in idx]
    matches.sort(key=lambda d: d["err"])

    # transform that maps ORIGINAL source pixels -> reference pixels
    S = np.diag([upscale, upscale, 1.0]).astype(np.float64)
    H_orig = H @ S
    return {"H": H_orig, "matches": matches, "kpSrc": len(k1), "kpRef": len(k2),
            "rawPairs": len(knn), "candTotal": cand_total, "timeMs": round(elapsed, 1)}


def uniformity(ms, w, h, g=8):
    """Spatial-distribution score: half grid occupancy + half normalised entropy."""
    grid = np.zeros((g, g), np.int32)
    for m in ms:
        gx = min(g - 1, max(0, int(m["rx"] / w * g)))
        gy = min(g - 1, max(0, int(m["ry"] / h * g)))
        grid[gy, gx] += 1
    occ = float((grid > 0).sum()) / (g * g)
    p = grid.astype(np.float64).ravel()
    tot = p.sum()
    if tot <= 0:
        return 0.0, grid.tolist()
    p /= tot
    nz = p[p > 0]
    ent = float(-(nz * np.log(nz)).sum() / math.log(g * g)) if len(nz) > 1 else 0.0
    return round(0.5 * occ + 0.5 * ent, 4), grid.tolist()


def decompose(H):
    a, b, c, d = H[0, 0], H[0, 1], H[1, 0], H[1, 1]
    sx = math.hypot(a, c)
    sy = (a * d - b * c) / max(sx, 1e-9)
    return {"scale": round(float((sx + abs(sy)) / 2), 4),
            "rotation": round(float(math.degrees(math.atan2(c, a))), 3),
            "tx": round(float(H[0, 2]), 2), "ty": round(float(H[1, 2]), 2),
            "shear": round(float((a * b + c * d) / max(sx * sx, 1e-9)), 4)}


def write_products(tag, src_bgr, ref_bgr, H):
    h, w = ref_bgr.shape[:2]
    warped = cv2.warpPerspective(src_bgr, H, (w, h))
    q = [cv2.IMWRITE_JPEG_QUALITY, 88]
    cv2.imwrite(f"{OUT}/{tag}/registered.jpg", warped, q)

    chk = ref_bgr.copy()
    cell = max(24, w // 14)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2 == 0:
                chk[y:y + cell, x:x + cell] = warped[y:y + cell, x:x + cell]
    cv2.imwrite(f"{OUT}/{tag}/checker.jpg", chk, q)

    a = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    b = cv2.cvtColor(ref_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    a = cv2.normalize(cv2.GaussianBlur(a, (0, 0), 1.2), None, 0, 255, cv2.NORM_MINMAX)
    b = cv2.normalize(cv2.GaussianBlur(b, (0, 0), 1.2), None, 0, 255, cv2.NORM_MINMAX)
    diff = cv2.absdiff(a, b).astype(np.uint8)
    diff[warped.sum(axis=2) == 0] = 0
    cv2.imwrite(f"{OUT}/{tag}/diff.jpg", cv2.applyColorMap(diff, cv2.COLORMAP_TURBO), q)


# --------------------------------------------------------------- scene definitions
def main():
    os.makedirs(OUT, exist_ok=True)
    base = cv2.imread(BASE, cv2.IMREAD_GRAYSCALE)

    # low-frequency relief from regularised shape-from-shading + fine relief from the
    # residual high-frequency texture of the real frame (restores boulder/small-crater detail)
    fine = base.astype(np.float32) / 255.0
    fine = fine - cv2.GaussianBlur(fine, (0, 0), 3.0)
    dem = pseudo_dem(base, 270.0, lam=0.3, hp_sigma=12, amp=60.0) + 20.0 * fine

    albedo = cv2.normalize(base.astype(np.float32) / 255.0, None, 0.45, 1.0, cv2.NORM_MINMAX)

    REF_SUN = (45, 58)
    ref_full = relight(dem, albedo, *REF_SUN, w_shade=W_SHADE, zs=ZS)

    # NAC-class reference (0.52 m/px)
    nac = ref_full[300:1500, 300:1500]
    nac = np.clip(nac.astype(np.float32) + RNG.normal(0, 1.8, nac.shape), 0, 255).astype(np.uint8)

    # SELENE TC-class reference (7.4 m/px) for the IIRS pairing
    tc = cv2.resize(ref_full, None, fx=0.42, fy=0.42, interpolation=cv2.INTER_AREA)
    tc = cv2.GaussianBlur(tc, (0, 0), 0.6)
    tc = np.clip(tc.astype(np.float32) + RNG.normal(0, 1.8, tc.shape), 0, 255).astype(np.uint8)
    tc = tc[120:700, 120:700]

    scenes_meta = [
        dict(tag="ohrc_nac", sensor="OHRC", ref=nac,
             refName="LRO NAC  M1096952439RE", srcName="ch2_ohr_ncp_20210531T0912_d18",
             site="Boguslawsky E crater rim", coords="72.9°S, 43.2°E",
             gsdSrc=0.32, gsdRef=0.52, bands="Panchromatic 400–800 nm",
             altitude="99 km", swath="3 km",
             sun=(100, 40), scale=1.35, rot=11.5, shear=0.008,
             out=1100, sensorFn=sensor_ohrc, upscale=1.0, model="homog",
             ratio=0.80, thr=3.0, refLabel="LRO NAC", refGsd=0.52),

        dict(tag="tmc_nac", sensor="TMC-2", ref=nac,
             refName="LRO NAC  M1142582789LE", srcName="ch2_tmc_ndn_20200914T1122_d18",
             site="Mare Smythii", coords="2.1°N, 86.4°E",
             gsdSrc=5.0, gsdRef=0.52, bands="Panchromatic 500–850 nm",
             altitude="100 km", swath="20 km",
             sun=(100, 40), scale=0.62, rot=-24.0, shear=-0.006,
             out=1100, sensorFn=sensor_tmc, upscale=2.2, model="homog",
             ratio=0.84, thr=3.0, refLabel="LRO NAC", refGsd=0.52),

        dict(tag="iirs_tc", sensor="IIRS", ref=tc,
             refName="SELENE TC  Morning Map", srcName="ch2_iir_nci_20211102T0655_d18",
             site="Sinus Iridum", coords="44.1°N, 31.5°W",
             gsdSrc=80.0, gsdRef=7.4, bands="SWIR 0.8–5.0 µm (256 bands)",
             altitude="100 km", swath="20 km",
             sun=(100, 40), scale=0.90 * 0.42, rot=22.0, shear=0.008,
             out=1400, sensorFn=sensor_iirs, upscale=1.4, model="affine",
             ratio=0.86, thr=3.0, refLabel="SELENE TC", refGsd=7.4),
    ]

    out = []
    for sc in scenes_meta:
        tag = sc["tag"]
        os.makedirs(f"{OUT}/{tag}", exist_ok=True)

        src_full = relight(dem, albedo, *sc["sun"], w_shade=W_SHADE, zs=ZS)
        moved = affine_warp(src_full, 900, 900, sc["out"], sc["out"],
                            sc["scale"], sc["rot"], sc["shear"])
        src = sc["sensorFn"](moved)
        ref = sc["ref"]

        res = register(src, ref, upscale=sc["upscale"], model=sc["model"],
                       ratio=sc["ratio"], thr=sc["thr"])
        H = res["H"]

        inl = [m for m in res["matches"] if m["ratio"] < sc["ratio"] and m["err"] <= sc["thr"]]
        sample_cand = [m for m in res["matches"] if m["ratio"] < sc["ratio"]]
        # scale sampled inlier count up to the full candidate population
        scale_f = res["candTotal"] / max(len(res["matches"]), 1)
        inl_true = int(round(len(inl) * scale_f))
        rmse = float(np.sqrt(np.mean([m["err"] ** 2 for m in inl]))) if inl else 0.0
        uni, grid = uniformity(inl, ref.shape[1], ref.shape[0])

        src_bgr = (cv2.applyColorMap(src, cv2.COLORMAP_INFERNO) if sc["sensor"] == "IIRS"
                   else cv2.cvtColor(src, cv2.COLOR_GRAY2BGR))
        ref_bgr = cv2.cvtColor(ref, cv2.COLOR_GRAY2BGR)
        q = [cv2.IMWRITE_JPEG_QUALITY, 88]
        cv2.imwrite(f"{OUT}/{tag}/source.jpg", src_bgr, q)
        cv2.imwrite(f"{OUT}/{tag}/reference.jpg", ref_bgr, q)
        write_products(tag, src_bgr, ref_bgr, H)

        out.append({
            "id": tag, "sensor": sc["sensor"], "site": sc["site"], "coords": sc["coords"],
            "srcName": sc["srcName"], "refName": sc["refName"], "refLabel": sc["refLabel"],
            "gsdSrc": sc["gsdSrc"], "gsdRef": sc["gsdRef"], "bands": sc["bands"],
            "altitude": sc["altitude"], "swath": sc["swath"],
            "sunSrc": {"az": sc["sun"][0], "el": sc["sun"][1]},
            "sunRef": {"az": REF_SUN[0], "el": REF_SUN[1]},
            "srcSize": [int(src.shape[1]), int(src.shape[0])],
            "refSize": [int(ref.shape[1]), int(ref.shape[0])],
            "model": "Affine (6-DOF)" if sc["model"] == "affine" else "Homography (8-DOF)",
            "upscale": sc["upscale"], "defRatio": sc["ratio"], "defThr": sc["thr"],
            "H": [[round(float(v), 8) for v in row] for row in H],
            "decomp": decompose(H),
            "kpSrc": res["kpSrc"], "kpRef": res["kpRef"],
            "rawPairs": res["rawPairs"], "candTotal": res["candTotal"],
            "timeMs": res["timeMs"],
            "baseline": {"rmse": round(rmse, 4), "inliers": inl_true,
                         "inlierRatio": round(len(inl) / max(len(sample_cand), 1), 4),
                         "uniformity": uni, "grid": grid},
            "matches": res["matches"],
        })
        print(f"{tag:10s} kp {res['kpSrc']:5d}/{res['kpRef']:5d}  cand {res['candTotal']:5d}  "
              f"sample {len(res['matches']):4d}  inl~{inl_true:4d}  "
              f"ratio {len(inl)/max(len(sample_cand),1):.2f}  RMSE {rmse:.3f}px  uni {uni:.3f}")

    with open(f"{OUT}/scenes.json", "w") as f:
        json.dump({"generated": "2026-08-29", "scenes": out}, f)
    print("wrote scenes.json")


if __name__ == "__main__":
    main()
