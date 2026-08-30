import { useEffect, useRef, useState } from "react";

export const fmt = (n, d = 3) =>
  n === undefined || n === null || Number.isNaN(n) ? "—" : Number(n).toFixed(d);

export function Card({ title, right, children, pad = 13, style, className, icon }) {
  return (
    <div className={className} style={{
      background: "var(--panel)", border: "1px solid var(--line)",
      borderRadius: 13, overflow: "hidden", boxShadow: "var(--shadow)",
      display: "flex", flexDirection: "column", ...style,
    }}>
      {title && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", borderBottom: "1px solid var(--line)",
          background: "linear-gradient(180deg,var(--panel2),var(--panel))",
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 1.1, color: "var(--dim)",
            textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6,
          }}>{icon}{title}</span>
          {right}
        </div>
      )}
      <div style={{ padding: pad, flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}

/** Metric tile with a smooth count-up and a flash when the value changes. */
export function Metric({ label, value, unit, tone = "", sub, loading, decimals }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)"
    : tone === "bad" ? "var(--bad)" : "var(--txt)";
  const [disp, setDisp] = useState(value);
  const [bump, setBump] = useState(false);
  const prev = useRef(value);

  useEffect(() => {
    if (typeof value !== "number" || typeof prev.current !== "number") {
      setDisp(value); prev.current = value; return;
    }
    if (value === prev.current) return;
    setBump(true);
    const from = prev.current, to = value, t0 = performance.now(), dur = 420;
    let raf;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setDisp(from + (to - from) * e);
      if (k < 1) raf = requestAnimationFrame(tick);
      else { prev.current = to; setTimeout(() => setBump(false), 260); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  const shown = typeof disp === "number"
    ? (decimals !== undefined
        ? disp.toFixed(decimals)
        : Number.isInteger(value) ? Math.round(disp).toLocaleString() : disp.toFixed(3))
    : disp;

  return (
    <div style={{
      background: bump ? "#4da3ff10" : "var(--panel2)",
      border: `1px solid ${bump ? "#4da3ff44" : "var(--line)"}`,
      borderRadius: 10, padding: "9px 11px", transition: "background .3s, border-color .3s",
    }}>
      <div style={{
        fontSize: 9, letterSpacing: .9, color: "var(--dim)",
        textTransform: "uppercase", fontWeight: 600, marginBottom: 4,
      }}>{label}</div>
      {loading ? (
        <div className="skel" style={{ height: 22, width: "72%" }} />
      ) : (
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{
            fontFamily: "var(--mono)", fontSize: 20, fontWeight: 700,
            color, letterSpacing: -.5,
          }}>{shown}</span>
          {unit && <span style={{ fontSize: 10, color: "var(--dim)" }}>{unit}</span>}
        </div>
      )}
      {sub && !loading && (
        <div style={{ fontSize: 9.5, color: "var(--dim2)", marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

export function Row({ k, v, mono = true, tone }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", gap: 10,
      padding: "4px 0", borderBottom: "1px solid #ffffff07", fontSize: 11.5,
    }}>
      <span style={{ color: "var(--dim)", flexShrink: 0 }}>{k}</span>
      <span style={{
        fontFamily: mono ? "var(--mono)" : "inherit", textAlign: "right",
        color: tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)"
          : tone === "bad" ? "var(--bad)" : "var(--txt)",
        wordBreak: "break-word",
      }}>{v}</span>
    </div>
  );
}

export function Slider({ label, value, min, max, step, onChange, display, disabled, hint }) {
  return (
    <div style={{ marginBottom: 11, opacity: disabled ? .5 : 1 }}>
      <div style={{
        display: "flex", justifyContent: "space-between", marginBottom: 5,
        fontSize: 10.5, color: "var(--dim)",
      }}>
        <span title={hint}>{label}</span>
        <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
             onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

export function Toggle({ label, checked, onChange, color = "var(--accent)", hint, disabled }) {
  return (
    <button onClick={() => !disabled && onChange(!checked)} title={hint} disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        background: "transparent", border: "none", padding: "4px 0",
        color: disabled ? "var(--dim2)" : "var(--txt)", fontSize: 11.5, textAlign: "left",
      }}>
      <span style={{
        width: 29, height: 16, borderRadius: 9, position: "relative", flexShrink: 0,
        background: checked ? color : "#243350", transition: "background .18s",
      }}>
        <span style={{
          position: "absolute", top: 2.5, left: checked ? 15 : 2.5,
          width: 11, height: 11, borderRadius: "50%", background: "#fff",
          transition: "left .18s",
        }} />
      </span>
      {label}
    </button>
  );
}

export function Select({ label, value, options, onChange, hint }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10.5, color: "var(--dim)", marginBottom: 5 }} title={hint}>
        {label}
      </div>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const [v, l] = Array.isArray(o) ? o : [o, o];
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </div>
  );
}

export function Segmented({ options, value, onChange, size = 10.5 }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} style={{
          flex: 1, padding: "5px 0", borderRadius: 7, fontSize: size, fontWeight: 600,
          border: `1px solid ${value === k ? "var(--accent)" : "var(--line2)"}`,
          background: value === k ? "#4da3ff1c" : "transparent",
          color: value === k ? "var(--accent)" : "var(--dim)",
          transition: "all .15s",
        }}>{l}</button>
      ))}
    </div>
  );
}

/** 8x8 inlier occupancy heat grid over the reference frame. */
export function GridMap({ grid, g = 8 }) {
  const flat = grid.flat ? grid.flat() : grid;
  const max = Math.max(...flat, 1);
  return (
    <div>
      <div style={{
        display: "grid", gridTemplateColumns: `repeat(${g}, 1fr)`, gap: 2,
        aspectRatio: "1", marginBottom: 7,
      }}>
        {flat.map((v, i) => {
          const t = v / max;
          return (
            <div key={i} title={`${v} match point${v === 1 ? "" : "s"}`} style={{
              borderRadius: 2,
              background: v === 0 ? "#101828"
                : `rgba(${Math.round(38 + t * 62)},${Math.round(150 + t * 90)},${Math.round(232 - t * 62)},${.2 + t * .8})`,
              border: v === 0 ? "1px solid #18223a" : "1px solid transparent",
              transition: "background .3s",
            }} />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--dim2)" }}>
        <span>empty</span><span>{max} pts / cell</span>
      </div>
    </div>
  );
}

/** Residual histogram with the RANSAC threshold marked. */
export function Histogram({ bins, maxV, thresh }) {
  const max = Math.max(...bins, 1);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 68, position: "relative" }}>
        {bins.map((v, i) => {
          const c = (i / bins.length) * maxV;
          const over = c > thresh;
          return (
            <div key={i} title={`${c.toFixed(2)}–${(c + maxV / bins.length).toFixed(2)} px · ${v}`}
              style={{
                flex: 1, height: `${Math.max(2, (v / max) * 100)}%`,
                background: over ? "linear-gradient(180deg,#ff5f6d,#ff5f6d44)"
                  : "linear-gradient(180deg,#4da3ff,#8b5cf688)",
                borderRadius: "2px 2px 0 0", transition: "height .3s",
              }} />
          );
        })}
        <div style={{
          position: "absolute", left: `${Math.min(100, (thresh / maxV) * 100)}%`,
          top: 0, bottom: 0, width: 1, background: "var(--warn)", opacity: .85,
        }} />
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between", fontSize: 9.5,
        color: "var(--dim2)", marginTop: 4,
      }}>
        <span>0 px</span>
        <span style={{ color: "var(--warn)" }}>τ = {fmt(thresh, 1)} px</span>
        <span>{fmt(maxV, 1)} px</span>
      </div>
    </div>
  );
}

/** Sun-position dial comparing source vs reference illumination geometry. */
export function SunDial({ src, ref: r }) {
  if (!src || !r) return null;
  const R = 42, C = 50;
  const pt = (az, el) => {
    const rad = ((90 - el) / 90) * R;
    const a = ((az - 90) * Math.PI) / 180;
    return [C + rad * Math.cos(a), C + rad * Math.sin(a)];
  };
  const [sx, sy] = pt(src.az, src.el);
  const [rx, ry] = pt(r.az, r.el);
  let d = Math.abs(src.az - r.az) % 360;
  if (d > 180) d = 360 - d;
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <svg width="100" height="100" style={{ flexShrink: 0 }}>
        {[R, R * .66, R * .33].map((rr, i) => (
          <circle key={i} cx={C} cy={C} r={rr} fill="none" stroke="#22304d" strokeWidth="1" />
        ))}
        <line x1={C - R} y1={C} x2={C + R} y2={C} stroke="#22304d" strokeWidth="1" />
        <line x1={C} y1={C - R} x2={C} y2={C + R} stroke="#22304d" strokeWidth="1" />
        <line x1={rx} y1={ry} x2={sx} y2={sy} stroke="#ffb547" strokeWidth="1.2"
              strokeDasharray="3 3" opacity=".8" />
        <circle cx={rx} cy={ry} r="4.6" fill="#8b5cf6" stroke="#fff" strokeWidth="1.1" />
        <circle cx={sx} cy={sy} r="4.6" fill="#4da3ff" stroke="#fff" strokeWidth="1.1" />
        <text x={C} y="10" fill="#5c6d8f" fontSize="7.5" textAnchor="middle">N</text>
      </svg>
      <div style={{ fontSize: 10.5, lineHeight: 1.8 }}>
        <div><span style={{ color: "#4da3ff" }}>●</span> source{" "}
          <span style={{ fontFamily: "var(--mono)", color: "var(--dim)" }}>
            az {src.az}° el {src.el}°</span></div>
        <div><span style={{ color: "#8b5cf6" }}>●</span> reference{" "}
          <span style={{ fontFamily: "var(--mono)", color: "var(--dim)" }}>
            az {r.az}° el {r.el}°</span></div>
        <div style={{ color: "var(--warn)", fontFamily: "var(--mono)", marginTop: 2 }}>
          Δaz {d}° · Δel {Math.abs(src.el - r.el)}°
        </div>
      </div>
    </div>
  );
}

/** Live pipeline stage timeline returned by the backend. */
export function StageList({ stages, running, activeLabel }) {
  if (running) {
    return (
      <div style={{ fontSize: 10.5, lineHeight: 1.8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent)" }}>
          <span style={{
            width: 12, height: 12, border: "2px solid #23304d", borderTopColor: "var(--accent)",
            borderRadius: "50%", animation: "spin .8s linear infinite", flexShrink: 0,
          }} />
          <span className="pulse" style={{ fontFamily: "var(--mono)" }}>{activeLabel}</span>
        </div>
      </div>
    );
  }
  if (!stages?.length) {
    return <div style={{ fontSize: 10.5, color: "var(--dim2)" }}>No run yet.</div>;
  }
  const total = stages.reduce((a, s) => a + s.ms, 0) || 1;
  return (
    <div style={{ fontSize: 10.5 }}>
      {stages.map((s, i) => (
        <div key={i} className="fade-up" style={{ marginBottom: 6, animationDelay: `${i * 28}ms` }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ color: "var(--txt)" }}>{s.name}</span>
            <span style={{ fontFamily: "var(--mono)", color: "var(--dim)", flexShrink: 0 }}>
              {s.ms.toFixed(0)}ms
            </span>
          </div>
          {s.detail && (
            <div style={{ fontSize: 9.5, color: "var(--dim2)", marginTop: 1 }}>{s.detail}</div>
          )}
          <div style={{ height: 2, background: "#162034", borderRadius: 2, marginTop: 3 }}>
            <div style={{
              height: "100%", width: `${(s.ms / total) * 100}%`, borderRadius: 2,
              background: "linear-gradient(90deg,var(--accent),var(--accent2))",
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Banner({ tone = "info", title, children, onClose }) {
  const c = tone === "error" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  return (
    <div className="fade-up" style={{
      display: "flex", gap: 10, padding: "10px 12px", borderRadius: 10,
      background: `${c}12`, border: `1px solid ${c}44`, fontSize: 11.5, lineHeight: 1.6,
    }}>
      <span style={{ color: c, fontWeight: 800, flexShrink: 0 }}>
        {tone === "error" ? "✕" : tone === "warn" ? "△" : "i"}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <b style={{ color: c }}>{title}</b>}
        {title && " — "}
        <span style={{ color: "var(--dim)" }}>{children}</span>
      </div>
      {onClose && (
        <button onClick={onClose} style={{
          background: "none", border: "none", color: "var(--dim)", fontSize: 14, padding: 0,
        }}>×</button>
      )}
    </div>
  );
}
