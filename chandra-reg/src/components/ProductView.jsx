import { useEffect, useRef, useState } from "react";
import { imageUrl } from "../lib/api";

/**
 * Registered-product inspector.
 * Swipe / blend / checkerboard / residual views of the warped source against
 * the fixed reference — all served live from the backend.
 */
export default function ProductView({ products, mode, setMode, busy }) {
  const [swipe, setSwipe] = useState(50);
  const [blend, setBlend] = useState(55);
  const [dragging, setDragging] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    const up = () => setDragging(false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const setFromEvent = (e) => {
    if (!boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setSwipe(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };

  const MODES = [["swipe", "Swipe"], ["blend", "Blend"],
                 ["checker", "Checkerboard"], ["diff", "Residual"]];

  const imgStyle = {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    objectFit: "contain", userSelect: "none", pointerEvents: "none",
  };

  if (!products) {
    return (
      <div style={{
        height: "100%", display: "grid", placeItems: "center",
        color: "var(--dim2)", fontSize: 12,
      }}>
        Run a registration to generate products.
      </div>
    );
  }

  const U = (k) => imageUrl(products[k]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 9 }}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flexShrink: 0 }}>
        {MODES.map(([k, label]) => (
          <button key={k} onClick={() => setMode(k)} style={{
            padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600,
            border: `1px solid ${mode === k ? "var(--accent)" : "var(--line2)"}`,
            background: mode === k ? "#4da3ff1c" : "transparent",
            color: mode === k ? "var(--accent)" : "var(--dim)",
          }}>{label}</button>
        ))}
      </div>

      <div
        ref={boxRef}
        onMouseMove={(e) => dragging && setFromEvent(e)}
        onMouseDown={(e) => { if (mode === "swipe") { setDragging(true); setFromEvent(e); } }}
        style={{
          position: "relative", flex: 1, minHeight: 220, borderRadius: 11,
          overflow: "hidden", background: "#03050a", border: "1px solid var(--line)",
          cursor: mode === "swipe" ? "ew-resize" : "default",
          opacity: busy ? .45 : 1, transition: "opacity .2s",
        }}
      >
        {mode === "swipe" && (
          <>
            <img src={U("reference")} style={imgStyle} alt="reference" />
            <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${100 - swipe}% 0 0)` }}>
              <img src={U("registered")} style={imgStyle} alt="registered source" />
            </div>
            <div style={{
              position: "absolute", top: 0, bottom: 0, left: `${swipe}%`, width: 2,
              background: "var(--accent)", boxShadow: "0 0 12px #4da3ff",
            }}>
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%,-50%)", width: 25, height: 25,
                borderRadius: "50%", background: "var(--accent)", display: "grid",
                placeItems: "center", color: "#04121f", fontSize: 11, fontWeight: 800,
              }}>⇔</div>
            </div>
            <Tag left>REGISTERED SOURCE</Tag>
            <Tag>REFERENCE</Tag>
          </>
        )}

        {mode === "blend" && (
          <>
            <img src={U("reference")} style={imgStyle} alt="reference" />
            <img src={U("registered")} style={{ ...imgStyle, opacity: blend / 100 }}
                 alt="registered source" />
          </>
        )}

        {mode === "checker" && <img src={U("checker")} style={imgStyle} alt="checkerboard mosaic" />}
        {mode === "diff" && <img src={U("diff")} style={imgStyle} alt="residual heat map" />}
      </div>

      {mode === "blend" && (
        <div style={{ flexShrink: 0 }}>
          <div style={{
            display: "flex", justifyContent: "space-between", fontSize: 10,
            color: "var(--dim)", marginBottom: 4,
          }}>
            <span>reference</span>
            <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{blend}%</span>
            <span>registered</span>
          </div>
          <input type="range" min="0" max="100" value={blend}
                 onChange={(e) => setBlend(+e.target.value)} />
        </div>
      )}

      {mode === "diff" && (
        <div style={{
          fontSize: 10, color: "var(--dim)", display: "flex", gap: 9,
          alignItems: "center", flexShrink: 0,
        }}>
          <span>|registered − reference|</span>
          <span style={{
            flex: 1, height: 7, borderRadius: 4,
            background: "linear-gradient(90deg,#30123b,#4145ab,#26bf8c,#c9ef34,#f9a72b,#a2170a)",
          }} />
          <span>low → high</span>
        </div>
      )}

      {mode === "checker" && (
        <div style={{ fontSize: 10, color: "var(--dim)", flexShrink: 0 }}>
          Alternating tiles of registered source and reference — continuous crater rims across
          tile boundaries indicate correct alignment.
        </div>
      )}
    </div>
  );
}

function Tag({ children, left }) {
  return (
    <div style={{
      position: "absolute", top: 8, [left ? "left" : "right"]: 8,
      fontFamily: "var(--mono)", fontSize: 9, letterSpacing: .5,
      padding: "3px 7px", borderRadius: 5, background: "#05070ecc",
      border: "1px solid var(--line2)",
      color: left ? "var(--accent)" : "var(--accent2)",
    }}>{children}</div>
  );
}
