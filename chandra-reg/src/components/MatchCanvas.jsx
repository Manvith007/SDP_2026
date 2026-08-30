import { useCallback, useEffect, useRef, useState } from "react";

const RESID_GAIN = 25;   // residual vectors are sub-pixel; scale them to be visible

/** Apply a 3x3 homography to a point. */
function applyH(H, x, y) {
  const d = H[2][0] * x + H[2][1] * y + H[2][2];
  return [(H[0][0] * x + H[0][1] * y + H[0][2]) / d,
          (H[1][0] * x + H[1][1] * y + H[1][2]) / d];
}

/**
 * Correspondence viewer.
 *
 * layout "side"    — source | reference with match lines bridging them
 * layout "overlay" — both frames stacked in reference space, showing each
 *                    match as a residual vector (the transform's error field)
 *
 * Supports pan/zoom, hover inspection, a magnifier loupe, and colour-by mode.
 */
export default function MatchCanvas({
  srcImg, refImg, srcSize, refSize, H, matches,
  showLines, showOutliers, showFootprint, colorBy, density,
  layout = "side", loupe = false, sensor, refLabel, busy,
}) {
  const wrapRef = useRef(null);
  const cvRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [drag, setDrag] = useState(null);
  const [hover, setHover] = useState(null);
  const [mouse, setMouse] = useState(null);
  const [size, setSize] = useState({ w: 1000, h: 600 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setView({ x: 0, y: 0, k: 1 }); }, [srcImg, refImg, layout]);

  const GAP_PX = 34;   // screen-space gutter between the two panels
  const TOP_PAD = 40;  // reserved strip for the floating layout toggle + captions

  const geom = useCallback(() => {
    const [sw, sh] = srcSize, [rw, rh] = refSize;
    if (layout === "overlay") {
      const availO = size.h - TOP_PAD;
      const base = Math.min(size.w / rw, availO / rh) * 0.94;
      const k = base * view.k;
      return {
        k, mode: "overlay",
        refX: (size.w - rw * k) / 2 + view.x,
        refY: TOP_PAD + (availO - rh * k) / 2 + view.y,
        srcX: (size.w - rw * k) / 2 + view.x,
        srcY: TOP_PAD + (availO - rh * k) / 2 + view.y,
        sw, sh, rw, rh,
      };
    }
    // On a portrait / narrow viewport, stacking the pair vertically uses the space
    // far better than squeezing two frames into one short row.
    const stacked = size.w < 620 && size.h > size.w * 0.9;
    if (stacked) {
      const avail = size.h - TOP_PAD;
      const totalW = Math.max(sw, rw);
      const base = Math.min(size.w / totalW, (avail - GAP_PX) / (sh + rh)) * 0.94;
      const k = base * view.k;
      const totalHpx = (sh + rh) * k + GAP_PX;
      const offX = (size.w - totalW * k) / 2 + view.x;
      const offY = TOP_PAD + (avail - totalHpx) / 2 + view.y;
      return {
        k, mode: "side", stacked: true, sw, sh, rw, rh,
        srcX: offX + ((totalW - sw) * k) / 2, srcY: offY,
        refX: offX + ((totalW - rw) * k) / 2, refY: offY + sh * k + GAP_PX,
      };
    }

    // Fit both frames side by side, reserving a fixed screen-space gutter so the
    // panels never appear to touch regardless of zoom level.
    const totalH = Math.max(sh, rh);
    const avail = size.h - TOP_PAD;
    const base = Math.min((size.w - GAP_PX) / (sw + rw), avail / totalH) * 0.94;
    const k = base * view.k;
    const totalWpx = (sw + rw) * k + GAP_PX;
    const offX = (size.w - totalWpx) / 2 + view.x;
    const offY = TOP_PAD + (avail - totalH * k) / 2 + view.y;
    return {
      k, mode: "side", stacked: false, sw, sh, rw, rh,
      srcX: offX, srcY: offY + ((totalH - sh) * k) / 2,
      refX: offX + sw * k + GAP_PX, refY: offY + ((totalH - rh) * k) / 2,
    };
  }, [srcSize, refSize, size, view, layout]);

  const colorFor = useCallback((m) => {
    if (colorBy === "error") {
      const t = Math.min(1, m.err / 3);
      return `rgb(${Math.round(34 + t * 220)},${Math.round(211 - t * 152)},${Math.round(154 - t * 46)})`;
    }
    if (colorBy === "ratio") {
      const t = Math.min(1, Math.max(0, (m.ratio - .4) / .5));
      return `hsl(${Math.round(190 - t * 190)},86%,62%)`;
    }
    const t = Math.min(1, m.scl / 30);
    return `hsl(${Math.round(282 - t * 192)},82%,65%)`;
  }, [colorBy]);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size.w * dpr; cv.height = size.h * dpr;
    cv.style.width = size.w + "px"; cv.style.height = size.h + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!srcImg || !refImg) return;

    const L = geom();
    const inl = matches.filter((m) => m.in);
    const out = matches.filter((m) => !m.in);

    // ---------------------------------------------------------------- panels
    ctx.save();
    ctx.shadowColor = "#000a"; ctx.shadowBlur = 20;
    if (L.mode === "overlay") {
      ctx.globalAlpha = 1;
      ctx.drawImage(refImg, L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.restore();

      // Tint the two frames complementary so misalignment reads as colour fringing:
      // reference stays cyan-ish, the warped source is overlaid magenta at 50%.
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.clip();
      ctx.globalAlpha = 0.5;
      const m = H;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.transform(L.k, 0, 0, L.k, L.refX, L.refY);
      ctx.transform(m[0][0], m[1][0], m[0][1], m[1][1], m[0][2], m[1][2]);
      ctx.drawImage(srcImg, 0, 0, L.sw, L.sh);
      ctx.restore();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // heavy scrim: the imagery is context here, the vector field is the subject
      ctx.save();
      ctx.globalAlpha = 0.62;
      ctx.fillStyle = "#05070e";
      ctx.fillRect(L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.restore();
    } else {
      ctx.globalAlpha = .84;
      ctx.drawImage(srcImg, L.srcX, L.srcY, L.sw * L.k, L.sh * L.k);
      ctx.drawImage(refImg, L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.restore();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#4da3ff4d";
      ctx.strokeRect(L.srcX, L.srcY, L.sw * L.k, L.sh * L.k);
      ctx.strokeStyle = "#8b5cf64d";
      ctx.strokeRect(L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.font = "600 11px ui-monospace, Menlo, monospace";
      ctx.fillStyle = "#4da3ff";
      ctx.fillText(`SOURCE · ${sensor || "moving"}`, L.srcX + 2, L.srcY - 6);
      ctx.fillStyle = "#8b5cf6";
      ctx.fillText(`REFERENCE · ${refLabel || "fixed"}`, L.refX + 2, L.refY - 6);
    }

    const SP = (m) => L.mode === "overlay"
      ? [L.refX + m.rx * L.k, L.refY + m.ry * L.k]     // vector tail = observed ref point
      : [L.srcX + m.sx * L.k, L.srcY + m.sy * L.k];
    const RP = (m) => {
      if (L.mode !== "overlay") return [L.refX + m.rx * L.k, L.refY + m.ry * L.k];
      const [px, py] = applyH(H, m.sx, m.sy);           // vector head = projected point
      return [L.refX + px * L.k, L.refY + py * L.k];
    };

    // ------------------------------------------------------------- footprint
    if (showFootprint && L.mode === "side") {
      ctx.save();
      ctx.beginPath();
      ctx.rect(L.refX, L.refY, L.rw * L.k, L.rh * L.k);
      ctx.clip();
      ctx.setLineDash([7, 5]); ctx.lineWidth = 1.7;
      ctx.strokeStyle = "#22d39a"; ctx.fillStyle = "#22d39a14";
      ctx.beginPath();
      [[0, 0], [L.sw, 0], [L.sw, L.sh], [0, L.sh]].forEach(([x, y], i) => {
        const [px, py] = applyH(H, x, y);
        const cx = L.refX + px * L.k, cy = L.refY + py * L.k;
        i ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy);
      });
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // -------------------------------------------------------------- outliers
    if (showOutliers && out.length) {
      const step = Math.max(1, Math.ceil(out.length / 140));
      ctx.lineWidth = .7; ctx.strokeStyle = "#ff5f6d33";
      for (let i = 0; i < out.length; i += step) {
        const [x1, y1] = SP(out[i]), [x2, y2] = RP(out[i]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
    }

    // --------------------------------------------------------------- inliers
    // Residual vectors are sub-pixel. Scale them ADAPTIVELY in *screen* space so the
    // field stays legible at any zoom: the median residual maps to ~18 screen px.
    let residGain = RESID_GAIN;
    if (L.mode === "overlay" && inl.length) {
      const es = inl.map((m) => m.err).sort((a, b) => a - b);
      const med = es[Math.floor(es.length / 2)] || 0.5;
      residGain = Math.max(6, Math.min(320, 18 / Math.max(med * L.k, 1e-3)));
    }

    // Hard ceiling on rendered lines: past a few hundred the plot turns into a
    // hairball that hides the very structure it is meant to show.
    const MAX_LINES = 240;
    const want = Math.min(
      L.mode === "overlay" ? 600 : MAX_LINES,
      Math.max(1, Math.round((density / 100) * inl.length)));
    const step = Math.max(1, Math.ceil(inl.length / want));
    const shown = [];
    for (let i = 0; i < inl.length; i += step) shown.push(inl[i]);

    if (showLines) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineWidth = L.mode === "overlay" ? 2 : 1.1;
      for (const m of shown) {
        const [x1, y1] = SP(m), [x2, y2] = RP(m);
        ctx.strokeStyle = colorFor(m) + (L.mode === "overlay" ? "ff" : "aa");
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (L.mode === "overlay") {
          // exaggerate the residual so sub-pixel error becomes visible
          const ex = x1 + (x2 - x1) * residGain;
          const ey = y1 + (y2 - y1) * residGain;
          ctx.lineTo(ex, ey);
          ctx.stroke();
          // arrow head
          const a = Math.atan2(ey - y1, ex - x1);
          const len = Math.hypot(ex - x1, ey - y1);
          if (len > 4) {
            const hs = 6.5;
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - hs * Math.cos(a - 0.42), ey - hs * Math.sin(a - 0.42));
            ctx.lineTo(ex - hs * Math.cos(a + 0.42), ey - hs * Math.sin(a + 0.42));
            ctx.closePath();
            ctx.fillStyle = colorFor(m);
            ctx.fill();
          }
          ctx.fillStyle = "#ffffffcc";
          ctx.beginPath(); ctx.arc(x1, y1, 1.5, 0, 7); ctx.fill();
          continue;
        }
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();
    }

    for (const m of (L.mode === "overlay" && showLines ? [] : shown)) {
      const c = colorFor(m);
      const pts = L.mode === "overlay" ? [SP(m)] : [SP(m), RP(m)];
      for (const [x, y] of pts) {
        ctx.fillStyle = "#00000088";
        ctx.beginPath(); ctx.arc(x, y, 3.1, 0, 7); ctx.fill();
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
      }
    }

    // ----------------------------------------------------------------- hover
    if (hover) {
      const [x1, y1] = SP(hover), [x2, y2] = RP(hover);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.6;
      if (L.mode === "side") {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      for (const [x, y] of (L.mode === "overlay" ? [[x1, y1]] : [[x1, y1], [x2, y2]])) {
        ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.stroke();
        ctx.fillStyle = "#fff";
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 7); ctx.fill();
      }
    }

    // ---------------------------------------------------------------- loupe
    if (loupe && mouse && L.mode === "side") {
      const RAD = 74;
      // Magnify 4x relative to what is currently on screen (not 4x absolute pixels),
      // so the loupe stays useful whether the pair is fit-to-view or already zoomed in.
      const ZOOM = Math.max(1.5, Math.min(9, L.k * 4));
      // which panel is the cursor over?
      const overSrc = L.stacked
        ? mouse.y < L.refY - GAP_PX / 2
        : mouse.x >= L.srcX && mouse.x <= L.srcX + L.sw * L.k;
      const img = overSrc ? srcImg : refImg;
      const ox = overSrc ? L.srcX : L.refX, oy = overSrc ? L.srcY : L.refY;
      const iw = overSrc ? L.sw : L.rw, ih = overSrc ? L.sh : L.rh;
      const ix = (mouse.x - ox) / L.k, iy = (mouse.y - oy) / L.k;
      if (ix >= 0 && iy >= 0 && ix <= iw && iy <= ih) {
        const lx = Math.min(size.w - RAD - 8, mouse.x + RAD + 18);
        const ly = Math.min(size.h - RAD - 8, Math.max(RAD + 8, mouse.y));
        ctx.save();
        ctx.beginPath(); ctx.arc(lx, ly, RAD, 0, 7); ctx.clip();
        ctx.fillStyle = "#05070e"; ctx.fillRect(lx - RAD, ly - RAD, RAD * 2, RAD * 2);
        const sw2 = (RAD * 2) / ZOOM;
        // interpolate until we are genuinely past 1:1, then show real pixels
        ctx.imageSmoothingEnabled = ZOOM < 3.2;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, ix - sw2 / 2, iy - sw2 / 2, sw2, sw2,
                      lx - RAD, ly - RAD, RAD * 2, RAD * 2);
        // overlay nearby keypoints inside the loupe
        for (const m of inl) {
          const mx = overSrc ? m.sx : m.rx, my = overSrc ? m.sy : m.ry;
          if (Math.abs(mx - ix) < sw2 / 2 && Math.abs(my - iy) < sw2 / 2) {
            ctx.fillStyle = colorFor(m);
            ctx.beginPath();
            ctx.arc(lx + (mx - ix) * ZOOM, ly + (my - iy) * ZOOM, 2.6, 0, 7);
            ctx.fill();
          }
        }
        ctx.restore();
        ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(lx, ly, RAD, 0, 7); ctx.stroke();
        ctx.strokeStyle = "#ffffff44"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(lx - 8, ly); ctx.lineTo(lx + 8, ly);
        ctx.moveTo(lx, ly - 8); ctx.lineTo(lx, ly + 8); ctx.stroke();
        ctx.fillStyle = "#4da3ff"; ctx.font = "600 9px var(--mono)";
        ctx.fillText(`${(ZOOM / L.k).toFixed(1)}× ${overSrc ? "SRC" : "REF"}`,
                     lx - RAD + 6, ly + RAD - 7);
      }
    }
  }, [srcImg, refImg, size, view, matches, showLines, showOutliers, showFootprint,
      density, hover, geom, colorFor, H, sensor, refLabel, loupe, mouse]);

  const onWheel = (e) => {
    const r = cvRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.13 : 1 / 1.13;
    setView((v) => {
      const nk = Math.max(.5, Math.min(18, v.k * f));
      const s = nk / v.k;
      return { k: nk, x: mx - (mx - v.x) * s, y: my - (my - v.y) * s };
    });
  };

  const onMove = (e) => {
    const r = cvRef.current.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    setMouse({ x: mx, y: my });
    if (drag) {
      setView((v) => ({ ...v, x: drag.vx + (mx - drag.mx), y: drag.vy + (my - drag.my) }));
      return;
    }
    const L = geom();
    let best = null, bd = 12;
    for (const m of matches) {
      if (!m.in) continue;
      const pts = L.mode === "overlay"
        ? [[L.refX + m.rx * L.k, L.refY + m.ry * L.k]]
        : [[L.srcX + m.sx * L.k, L.srcY + m.sy * L.k],
           [L.refX + m.rx * L.k, L.refY + m.ry * L.k]];
      for (const [px, py] of pts) {
        const d = Math.hypot(px - mx, py - my);
        if (d < bd) { bd = d; best = m; }
      }
    }
    setHover(best);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas ref={cvRef} onWheel={onWheel} onMouseMove={onMove}
        onMouseDown={(e) => {
          const r = cvRef.current.getBoundingClientRect();
          setDrag({ mx: e.clientX - r.left, my: e.clientY - r.top, vx: view.x, vy: view.y });
        }}
        onMouseUp={() => setDrag(null)}
        onMouseLeave={() => { setDrag(null); setHover(null); setMouse(null); }}
        style={{ display: "block", cursor: drag ? "grabbing" : hover ? "pointer" : "grab" }} />

      {busy && (
        <div style={{
          position: "absolute", inset: 0, display: "grid", placeItems: "center",
          background: "#05070ecc", backdropFilter: "blur(2px)",
        }}>
          <div style={{ textAlign: "center", color: "var(--dim)", fontSize: 11.5 }}>
            <div style={{
              width: 30, height: 30, border: "3px solid #22304d", borderTopColor: "var(--accent)",
              borderRadius: "50%", margin: "0 auto 10px", animation: "spin .85s linear infinite",
            }} />
            Registering…
          </div>
        </div>
      )}

      <div style={{ position: "absolute", left: 10, bottom: 10, display: "flex", gap: 5 }}>
        {[["−", () => setView((v) => ({ ...v, k: Math.max(.5, v.k / 1.3) }))],
          ["+", () => setView((v) => ({ ...v, k: Math.min(18, v.k * 1.3) }))],
          ["⟲", () => setView({ x: 0, y: 0, k: 1 })]].map(([l, fn]) => (
          <button key={l} onClick={fn} style={{
            width: 28, height: 28, borderRadius: 8, background: "#0c111de8",
            border: "1px solid var(--line2)", color: "var(--txt)", fontSize: 14,
          }}>{l}</button>
        ))}
        <div style={{
          alignSelf: "center", marginLeft: 5, fontFamily: "var(--mono)",
          fontSize: 10.5, color: "var(--dim2)",
        }}>
          {view.k.toFixed(2)}× · {layout === "overlay" ? "residual vectors · auto-scaled" : "scroll · drag"}
        </div>
      </div>

      {hover && (
        <div style={{
          position: "absolute", right: 10, top: 10, background: "#05070ef2",
          border: "1px solid var(--line2)", borderRadius: 10, padding: "9px 11px",
          fontFamily: "var(--mono)", fontSize: 10.5, lineHeight: 1.6, minWidth: 184,
          pointerEvents: "none",
        }}>
          <div style={{ color: "var(--accent)", marginBottom: 3, fontWeight: 700 }}>
            MATCH POINT
          </div>
          <div>src <span style={{ color: "var(--dim)" }}>
            {hover.sx.toFixed(1)}, {hover.sy.toFixed(1)}</span></div>
          <div>ref <span style={{ color: "var(--dim)" }}>
            {hover.rx.toFixed(1)}, {hover.ry.toFixed(1)}</span></div>
          <div>err <span style={{ color: hover.err <= 1 ? "var(--ok)" : "var(--warn)" }}>
            {hover.err.toFixed(3)} px</span></div>
          <div>lowe <span style={{ color: "var(--dim)" }}>{hover.ratio.toFixed(3)}</span></div>
          <div>σ <span style={{ color: "var(--dim)" }}>{hover.scl.toFixed(1)}</span>
            {"  θ "}<span style={{ color: "var(--dim)" }}>{hover.ang.toFixed(0)}°</span></div>
        </div>
      )}
    </div>
  );
}
