"""
Build the Chandrayaan-2 demo image pairs served by the backend as presets.

Reuses the physically-motivated scene synthesis from gen_demo_data.py:
real lunar frame -> pseudo-DEM -> Lambertian re-lighting under a different sun
angle -> geometric warp -> per-sensor degradation. The backend then registers
these pairs live with OpenCV, so nothing is precomputed.
"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_demo_data as G   # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", "presets")
RNG = np.random.default_rng(20260829)


def main():
    os.makedirs(OUT, exist_ok=True)
    base = cv2.imread(G.BASE, cv2.IMREAD_GRAYSCALE)

    fine = base.astype(np.float32) / 255.0
    fine = fine - cv2.GaussianBlur(fine, (0, 0), 3.0)
    dem = G.pseudo_dem(base, 270.0, lam=0.3, hp_sigma=12, amp=60.0) + 20.0 * fine
    albedo = cv2.normalize(base.astype(np.float32) / 255.0, None, 0.45, 1.0, cv2.NORM_MINMAX)

    REF_SUN = (45, 58)
    ref_full = G.relight(dem, albedo, *REF_SUN, w_shade=G.W_SHADE, zs=G.ZS)

    # LRO NAC-class reference (0.52 m/px)
    nac = ref_full[300:1500, 300:1500]
    nac = np.clip(nac.astype(np.float32) + RNG.normal(0, 1.8, nac.shape), 0, 255).astype(np.uint8)

    # SELENE TC-class reference (7.4 m/px)
    tc = cv2.resize(ref_full, None, fx=0.42, fy=0.42, interpolation=cv2.INTER_AREA)
    tc = cv2.GaussianBlur(tc, (0, 0), 0.6)
    tc = np.clip(tc.astype(np.float32) + RNG.normal(0, 1.8, tc.shape), 0, 255).astype(np.uint8)
    tc = tc[120:700, 120:700]

    cv2.imwrite(f"{OUT}/ref_nac.png", nac)
    cv2.imwrite(f"{OUT}/ref_tc.png", tc)

    scenes = [
        dict(id="ohrc_nac", sensor="OHRC", refLabel="LRO NAC",
             srcName="ch2_ohr_ncp_20210531T0912_d18", refName="LRO NAC M1096952439RE",
             site="Boguslawsky E crater rim", coords="72.9°S, 43.2°E",
             gsdSrc=0.32, gsdRef=0.52, bands="Panchromatic 400–800 nm",
             altitude="99 km", swath="3 km",
             sun=(100, 40), scale=1.35, rot=11.5, shear=0.008, out=1100,
             sensorFn=lambda i: G.sensor_ohrc(i), refFile="ref_nac.png",
             params=dict(detector="SIFT", model="homography", ransac="MAGSAC",
                         ratio=0.80, threshold=3.0, prescale=1.0, clahe=3.0,
                         invert=False, anms=True, ecc=False)),

        dict(id="tmc_nac", sensor="TMC-2", refLabel="LRO NAC",
             srcName="ch2_tmc_ndn_20200914T1122_d18", refName="LRO NAC M1142582789LE",
             site="Mare Smythii", coords="2.1°N, 86.4°E",
             gsdSrc=5.0, gsdRef=0.52, bands="Panchromatic 500–850 nm",
             altitude="100 km", swath="20 km",
             sun=(100, 40), scale=0.62, rot=-24.0, shear=-0.006, out=1100,
             sensorFn=lambda i: G.sensor_tmc(i), refFile="ref_nac.png",
             params=dict(detector="SIFT", model="homography", ransac="MAGSAC",
                         ratio=0.84, threshold=3.0, prescale=2.2, clahe=3.0,
                         invert=False, anms=True, ecc=False)),

        dict(id="iirs_tc", sensor="IIRS", refLabel="SELENE TC",
             srcName="ch2_iir_nci_20211102T0655_d18", refName="SELENE TC Morning Map",
             site="Sinus Iridum", coords="44.1°N, 31.5°W",
             gsdSrc=80.0, gsdRef=7.4, bands="SWIR 0.8–5.0 µm (256 bands)",
             altitude="100 km", swath="20 km",
             sun=(100, 40), scale=0.90 * 0.42, rot=22.0, shear=0.008, out=1400,
             sensorFn=lambda i: G.sensor_iirs(i), refFile="ref_tc.png",
             params=dict(detector="SIFT", model="affine", ransac="MAGSAC",
                         ratio=0.86, threshold=3.0, prescale=1.4, clahe=3.0,
                         invert=False, anms=True, ecc=False)),
    ]

    defs = []
    for sc in scenes:
        src_full = G.relight(dem, albedo, *sc["sun"], w_shade=G.W_SHADE, zs=G.ZS)
        moved = G.affine_warp(src_full, 900, 900, sc["out"], sc["out"],
                              sc["scale"], sc["rot"], sc["shear"])
        src = sc["sensorFn"](moved)
        fn = f"src_{sc['id']}.png"
        cv2.imwrite(f"{OUT}/{fn}", src)

        defs.append({
            "id": sc["id"], "sensor": sc["sensor"], "refLabel": sc["refLabel"],
            "srcName": sc["srcName"], "refName": sc["refName"],
            "site": sc["site"], "coords": sc["coords"],
            "gsdSrc": sc["gsdSrc"], "gsdRef": sc["gsdRef"],
            "bands": sc["bands"], "altitude": sc["altitude"], "swath": sc["swath"],
            "sunSrc": {"az": sc["sun"][0], "el": sc["sun"][1]},
            "sunRef": {"az": REF_SUN[0], "el": REF_SUN[1]},
            "srcFile": fn, "refFile": sc["refFile"],
            "defaults": sc["params"],
            "colormap": "inferno" if sc["sensor"] == "IIRS" else None,
        })
        print(f"{sc['id']:10s} src {src.shape[1]}×{src.shape[0]}  -> {fn}")

    with open(f"{OUT}/presets.json", "w") as f:
        json.dump(defs, f, indent=2)
    print("wrote presets.json")


if __name__ == "__main__":
    main()
