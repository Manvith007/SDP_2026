// ---------------------------------------------------------------------------
// SELENE-REG Demo / Offline Engine
// Provides full interactive registration visualizations when no live Python
// backend is connected (e.g. static hosting on GitHub Pages, Vercel, Netlify).
// ---------------------------------------------------------------------------

export const DEMO_PRESETS = [
  {
    id: "ohrc_nac",
    sensor: "OHRC",
    refLabel: "LRO NAC",
    srcName: "ch2_ohr_ncp_20210531T0912_d18",
    refName: "LRO NAC M1096952439RE",
    site: "Boguslawsky E crater rim",
    coords: "72.9°S, 43.2°E",
    gsdSrc: 0.32,
    gsdRef: 0.52,
    bands: "Panchromatic 400–800 nm",
    altitude: "99 km",
    swath: "3 km",
    sunSrc: { az: 100, el: 40 },
    sunRef: { az: 45, el: 58 },
    srcFile: "presets/src_ohrc_nac.png",
    refFile: "presets/ref_nac.png",
    defaults: {
      detector: "SIFT",
      model: "homography",
      ransac: "MAGSAC",
      ratio: 0.8,
      threshold: 3.0,
      prescale: 1.0,
      clahe: 3.0,
      invert: false,
      anms: true,
      ecc: false,
    },
    srcId: "demo_src_ohrc",
    refId: "demo_ref_nac",
    srcSize: [1100, 1100],
    refSize: [1200, 1200],
    colormap: null,
  },
  {
    id: "tmc_nac",
    sensor: "TMC-2",
    refLabel: "LRO NAC",
    srcName: "ch2_tmc_ndn_20200914T1122_d18",
    refName: "LRO NAC M1142582789LE",
    site: "Mare Smythii",
    coords: "2.1°N, 86.4°E",
    gsdSrc: 5.0,
    gsdRef: 0.52,
    bands: "Panchromatic 500–850 nm",
    altitude: "100 km",
    swath: "20 km",
    sunSrc: { az: 100, el: 40 },
    sunRef: { az: 45, el: 58 },
    srcFile: "presets/src_tmc_nac.png",
    refFile: "presets/ref_nac.png",
    defaults: {
      detector: "SIFT",
      model: "homography",
      ransac: "MAGSAC",
      ratio: 0.84,
      threshold: 3.0,
      prescale: 2.2,
      clahe: 3.0,
      invert: false,
      anms: true,
      ecc: false,
    },
    srcId: "demo_src_tmc",
    refId: "demo_ref_nac",
    srcSize: [495, 495],
    refSize: [1200, 1200],
    colormap: null,
  },
  {
    id: "iirs_tc",
    sensor: "IIRS",
    refLabel: "SELENE TC",
    srcName: "ch2_iir_nci_20211102T0655_d18",
    refName: "SELENE TC Morning Map",
    site: "Sinus Iridum",
    coords: "44.1°N, 31.5°W",
    gsdSrc: 80.0,
    gsdRef: 7.4,
    bands: "SWIR 0.8–5.0 µm (256 bands)",
    altitude: "100 km",
    swath: "20 km",
    sunSrc: { az: 100, el: 40 },
    sunRef: { az: 45, el: 58 },
    srcFile: "presets/src_iirs_tc.png",
    refFile: "presets/ref_tc.png",
    defaults: {
      detector: "SIFT",
      model: "affine",
      ransac: "MAGSAC",
      ratio: 0.86,
      threshold: 3.0,
      prescale: 1.4,
      clahe: 3.0,
      invert: false,
      anms: true,
      ecc: false,
    },
    srcId: "demo_src_iirs",
    refId: "demo_ref_tc",
    srcSize: [980, 980],
    refSize: [580, 580],
    colormap: "inferno",
  },
];

// Seeded pseudo-random generator for consistent demo matches
function pseudoRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateDemoRegistration({ srcId, refId, params }) {
  const p = DEMO_PRESETS.find((x) => x.srcId === srcId || x.id === srcId) || DEMO_PRESETS[0];
  const [sw, sh] = p.srcSize;
  const [rw, rh] = p.refSize;

  // Approximate ground truth transform based on preset
  let angleDeg = 11.46;
  let scale = 0.74;
  let tx = 270.4;
  let ty = 118.8;

  if (p.id === "tmc_nac") {
    angleDeg = -23.96;
    scale = 1.63;
    tx = 180.2;
    ty = 210.5;
  } else if (p.id === "iirs_tc") {
    angleDeg = 21.98;
    scale = 1.13;
    tx = 85.0;
    ty = 60.0;
  }

  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const H = [
    [scale * cos, -scale * sin, tx],
    [scale * sin, scale * cos, ty],
    [0, 0, 1],
  ];

  const rng = pseudoRandom(12345 + (p.id === "tmc_nac" ? 999 : p.id === "iirs_tc" ? 888 : 0));

  const totalMatches = 150;
  const matches = [];

  for (let i = 0; i < totalMatches; i++) {
    const sx = 60 + rng() * (sw - 120);
    const sy = 60 + rng() * (sh - 120);

    // Apply ground truth H + noise
    const trueRx = scale * cos * sx - scale * sin * sy + tx;
    const trueRy = scale * sin * sx + scale * cos * sy + ty;

    const isOutlier = rng() > 0.75;
    const noiseX = (rng() - 0.5) * (isOutlier ? 40 : 1.2);
    const noiseY = (rng() - 0.5) * (isOutlier ? 40 : 1.2);

    const rx = trueRx + noiseX;
    const ry = trueRy + noiseY;

    const err = Math.sqrt(noiseX * noiseX + noiseY * noiseY);
    const ratio = isOutlier ? 0.85 + rng() * 0.14 : 0.4 + rng() * 0.38;

    matches.push({
      sx: Math.round(sx * 10) / 10,
      sy: Math.round(sy * 10) / 10,
      rx: Math.round(rx * 10) / 10,
      ry: Math.round(ry * 10) / 10,
      err: Math.round(err * 1000) / 1000,
      ratio: Math.round(ratio * 1000) / 1000,
    });
  }

  const ratioThresh = params.ratio || 0.8;
  const thresh = params.threshold || 3.0;

  const candidates = matches.filter((m) => m.ratio < ratioThresh);
  const inliers = candidates.filter((m) => m.err <= thresh);

  const inlierRatio = candidates.length ? inliers.length / candidates.length : 0;
  const totalErr = inliers.reduce((sum, m) => sum + m.err * m.err, 0);
  const rmseVal = inliers.length ? Math.sqrt(totalErr / inliers.length) : 0;

  return {
    ok: true,
    job: `demo_${Date.now().toString(16)}`,
    warnings: [
      "Running in Offline / Static Demo Mode. Metrics & correspondences recomputed locally.",
    ],
    metrics: {
      rmse: Math.round(rmseVal * 1000) / 1000,
      inlierRatio: Math.round(inlierRatio * 1000) / 1000,
      uniformity: 0.652,
      occupancy: 0.48,
    },
    counts: {
      kpSrcRaw: 12450,
      kpSrc: 6000,
      kpRefRaw: 14200,
      kpRef: 6000,
      candidates: candidates.length,
      inliers: inliers.length,
    },
    decomp: {
      scale: Math.round(scale * 10000) / 10000,
      rotation: angleDeg,
      tx: Math.round(tx * 10) / 10,
      ty: Math.round(ty * 10) / 10,
      shear: 0.0012,
    },
    stages: [
      { name: "detect", ms: 420, detail: "6000 keypoints (SIFT)" },
      { name: "match", ms: 180, detail: "FLANN Ratio test" },
      { name: "filter", ms: 95, detail: "MAGSAC++ inlier selection" },
      { name: "compute", ms: 45, detail: "Homography matrix fitting" },
    ],
    products: {
      registered: p.srcFile,
      checker: p.refFile,
      diff: p.srcFile,
    },
    totalMs: 740,
    H,
    matches,
  };
}
