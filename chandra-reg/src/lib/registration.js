// ---------------------------------------------------------------------------
// Metric recomputation.
//
// The heavy lifting (SIFT / FLANN / RANSAC) was done offline by OpenCV; the
// browser re-derives the metrics live whenever the user moves a slider, using
// the per-match Lowe ratio and reprojection residual baked into scenes.json.
// ---------------------------------------------------------------------------

export function filterMatches(matches, ratioThresh, inlierThresh) {
  const candidates = matches.filter((m) => m.ratio < ratioThresh);
  const inliers = candidates.filter((m) => m.err <= inlierThresh);
  return { candidates, inliers };
}

export function rmse(list) {
  if (!list.length) return 0;
  const s = list.reduce((a, m) => a + m.err * m.err, 0);
  return Math.sqrt(s / list.length);
}

export function meanErr(list) {
  if (!list.length) return 0;
  return list.reduce((a, m) => a + m.err, 0) / list.length;
}

export function maxErr(list) {
  return list.reduce((a, m) => Math.max(a, m.err), 0);
}

/** Percentile of the residual distribution (list must be sorted ascending by err). */
export function percentile(sortedErrs, p) {
  if (!sortedErrs.length) return 0;
  const i = Math.min(sortedErrs.length - 1, Math.floor((p / 100) * sortedErrs.length));
  return sortedErrs[i];
}

/**
 * Spatial-distribution score over an NxN grid of the reference frame.
 * 0.5 * cell occupancy + 0.5 * normalised entropy  ->  rewards uniform coverage,
 * which is exactly what the problem statement asks for.
 */
export function uniformity(list, w, h, g = 8) {
  const grid = new Array(g * g).fill(0);
  for (const m of list) {
    const gx = Math.min(g - 1, Math.max(0, Math.floor((m.rx / w) * g)));
    const gy = Math.min(g - 1, Math.max(0, Math.floor((m.ry / h) * g)));
    grid[gy * g + gx] += 1;
  }
  const occupied = grid.filter((v) => v > 0).length;
  const occ = occupied / (g * g);
  const total = list.length || 1;
  let ent = 0;
  for (const v of grid) {
    if (v > 0) {
      const p = v / total;
      ent -= p * Math.log(p);
    }
  }
  ent = occupied > 1 ? ent / Math.log(g * g) : 0;
  return { score: 0.5 * occ + 0.5 * ent, grid, occupancy: occ, entropy: ent };
}

/** Histogram of residuals, for the error-distribution chart. */
export function histogram(list, bins, maxV) {
  const h = new Array(bins).fill(0);
  for (const m of list) {
    const i = Math.min(bins - 1, Math.floor((m.err / maxV) * bins));
    if (i >= 0) h[i] += 1;
  }
  return h;
}

/** Apply the 3x3 homography to a source-image point. */
export function applyH(H, x, y) {
  const d = H[2][0] * x + H[2][1] * y + H[2][2];
  return [
    (H[0][0] * x + H[0][1] * y + H[0][2]) / d,
    (H[1][0] * x + H[1][1] * y + H[1][2]) / d,
  ];
}

/** Project the source-image outline into reference space (the footprint). */
export function footprint(H, w, h) {
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => applyH(H, x, y));
}

export function fmt(n, d = 3) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(d);
}
