import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MatchCanvas from "./components/MatchCanvas";
import ProductView from "./components/ProductView";
import Dropzone from "./components/Dropzone";
import {
  Banner, Card, GridMap, Histogram, Metric, Row, Segmented, Select,
  Slider, StageList, SunDial, Toggle, fmt,
} from "./components/Panels";
import {
  exportUrl, getPresets, health, imageUrl, runRegistration, uploadImage,
  getApiBaseUrl, setApiBaseUrl, isDemoMode, setDemoMode,
} from "./lib/api";

const DEFAULTS = {
  detector: "SIFT", model: "homography", ransac: "MAGSAC",
  ratio: 0.8, threshold: 3.0, prescale: 1.0, clahe: 3.0,
  invert: false, anms: true, ecc: false, crosscheck: false, maxFeatures: 6000,
};

const STAGE_LABELS = [
  "Decoding rasters…", "Normalising GSD…", "Equalising illumination…",
  "Detecting keypoints…", "Matching descriptors…", "Rejecting outliers…",
  "Computing metrics…",
];

export default function App() {
  const [api, setApi] = useState(null);
  const [apiErr, setApiErr] = useState("");
  const [presets, setPresets] = useState([]);
  const [presetId, setPresetId] = useState(null);
  const [showApiModal, setShowApiModal] = useState(false);
  const [apiUrlInput, setApiUrlInput] = useState(getApiBaseUrl());

  const [src, setSrc] = useState(null);          // {id,name,w,h,gsd,sensor,uploaded}
  const [ref, setRef] = useState(null);
  const [upErr, setUpErr] = useState({});
  const [upProg, setUpProg] = useState({});

  const [params, setParams] = useState(DEFAULTS);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stageIdx, setStageIdx] = useState(0);
  const [runErr, setRunErr] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const [tab, setTab] = useState("match");
  const [prodMode, setProdMode] = useState("swipe");
  const [layout, setLayout] = useState("side");
  const [colorBy, setColorBy] = useState("error");
  const [density, setDensity] = useState(45);
  const [showLines, setShowLines] = useState(true);
  const [showOut, setShowOut] = useState(false);
  const [showFp, setShowFp] = useState(true);
  const [loupe, setLoupe] = useState(false);
  const [autoRun, setAutoRun] = useState(true);

  const [srcImg, setSrcImg] = useState(null);
  const [refImg, setRefImg] = useState(null);
  const abortRef = useRef(null);
  const stageTimer = useRef(null);
  const firstRun = useRef(true);

  const applyPreset = useCallback((p, initial = false) => {
    setPresetId(p.id);
    setSrc({ id: p.srcId, name: p.srcName, w: p.srcSize[0], h: p.srcSize[1],
             gsd: p.gsdSrc, sensor: p.sensor, meta: p });
    setRef({ id: p.refId, name: p.refName, w: p.refSize[0], h: p.refSize[1],
             gsd: p.gsdRef, sensor: p.refLabel });
    setParams({ ...DEFAULTS, ...p.defaults });
    setResult(null);
    setRunErr("");
    if (!initial) firstRun.current = true;
  }, []);

  // ------------------------------------------------------------- boot
  const initApp = useCallback(async (enableDemo = false) => {
    if (enableDemo) setDemoMode(true);
    try {
      const h = await health();
      setApi(h);
      setApiErr("");
    } catch (e) {
      setApiErr(e.message || "Cannot reach the registration API.");
    }
    try {
      const ps = await getPresets();
      setPresets(ps);
      if (ps.length) applyPreset(ps[0], true);
    } catch (e) {
      setApiErr(e.message);
    }
  }, [applyPreset]);

  useEffect(() => {
    initApp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initApp]);

  // load preview bitmaps
  useEffect(() => {
    if (!src?.id) { setSrcImg(null); return; }
    const i = new Image();
    i.src = imageUrl(src.id, { colormap: src.sensor === "IIRS" ? "inferno" : "" });
    i.onload = () => setSrcImg(i);
  }, [src?.id, src?.sensor]);

  useEffect(() => {
    if (!ref?.id) { setRefImg(null); return; }
    const i = new Image();
    i.src = imageUrl(ref.id);
    i.onload = () => setRefImg(i);
  }, [ref?.id]);

  // ------------------------------------------------------------- run
  const run = useCallback(async (p = params) => {
    if (!src?.id || !ref?.id || busy) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setBusy(true); setRunErr(""); setDismissed(false); setStageIdx(0);
    clearInterval(stageTimer.current);
    stageTimer.current = setInterval(
      () => setStageIdx((i) => Math.min(STAGE_LABELS.length - 1, i + 1)), 260);

    try {
      const r = await runRegistration({ srcId: src.id, refId: ref.id, params: p }, ctrl.signal);
      if (!r.ok) { setRunErr(r.error || "Registration failed."); setResult(null); }
      else { setResult(r); firstRun.current = false; }
    } catch (e) {
      if (e.name !== "AbortError") setRunErr(e.message || "Request failed.");
    } finally {
      clearInterval(stageTimer.current);
      setBusy(false);
    }
  }, [src?.id, ref?.id, params, busy]);

  // auto-run when the pair changes
  useEffect(() => {
    if (src?.id && ref?.id && firstRun.current && !busy) run(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src?.id, ref?.id]);

  // debounced re-run when parameters change
  useEffect(() => {
    if (!autoRun || firstRun.current || !src?.id || !ref?.id) return;
    const t = setTimeout(() => run(params), 520);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, autoRun]);

  const setP = (k, v) => setParams((o) => ({ ...o, [k]: v }));

  // ------------------------------------------------------------- upload
  const doUpload = async (file, role) => {
    setUpErr((e) => ({ ...e, [role]: "" }));
    setUpProg((p) => ({ ...p, [role]: 0 }));
    try {
      const m = await uploadImage(file, role, (f) => setUpProg((p) => ({ ...p, [role]: f })));
      const rec = { id: m.id, name: m.name, w: m.w, h: m.h, uploaded: true };
      if (role === "source") setSrc(rec); else setRef(rec);
      setPresetId(null); setResult(null); firstRun.current = true;
    } catch (e) {
      setUpErr((x) => ({ ...x, [role]: e.message }));
    } finally {
      setUpProg((p) => ({ ...p, [role]: undefined }));
    }
  };

  // ------------------------------------------------------------- derived
  const M = result?.metrics;
  const C = result?.counts;
  const D = result?.decomp;
  const matches = result?.matches || [];
  const hist = useMemo(() => {
    const maxV = Math.max(params.threshold * 2, 4);
    const bins = new Array(26).fill(0);
    for (const m of matches) {
      if (m.ratio >= params.ratio) continue;
      const i = Math.min(25, Math.floor((m.err / maxV) * 26));
      if (i >= 0) bins[i] += 1;
    }
    return { bins, maxV };
  }, [matches, params.threshold, params.ratio]);

  const preset = presets.find((p) => p.id === presetId);
  const rmseTone = !M ? "" : M.rmse < 1 ? "ok" : M.rmse < 2 ? "warn" : "bad";
  const uniTone = !M ? "" : M.uniformity > .6 ? "ok" : M.uniformity > .4 ? "warn" : "bad";
  const gsdRatio = src?.gsd && ref?.gsd ? src.gsd / ref.gsd : null;

  // ------------------------------------------------------------- API down
  if (apiErr && !api && !isDemoMode()) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh", padding: 24, background: "#06090f" }}>
        <div style={{ maxWidth: 520, textAlign: "center", background: "#0c1322", padding: 32, borderRadius: 16, border: "1px solid var(--line)", boxShadow: "0 10px 40px #00000080" }}>
          <div style={{ fontSize: 42, marginBottom: 12 }}>🌗</div>
          <h2 style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 700 }}>SELENE-REG Engine Connection</h2>
          <p style={{ color: "var(--dim)", fontSize: 13, lineHeight: 1.6, marginBottom: 20 }}>
            Hosted on static platform. Connect to your Python FastAPI backend or explore with built-in interactive demo mode.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
            <button
              onClick={() => initApp(true)}
              style={{
                padding: "12px 20px", borderRadius: 10, border: "none",
                background: "linear-gradient(135deg,#4da3ff,#8b5cf6)", color: "#fff",
                fontWeight: 700, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                boxShadow: "0 4px 15px #4da3ff40",
              }}
            >
              <span>🚀 Launch Interactive Demo Mode</span>
            </button>
          </div>

          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 20, textAlign: "left" }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--txt)", marginBottom: 8 }}>
              Connect Custom Backend API URL:
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                value={apiUrlInput}
                onChange={(e) => setApiUrlInput(e.target.value)}
                placeholder="http://localhost:8000/api"
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)",
                  background: "#06090f", color: "#fff", fontFamily: "var(--mono)", fontSize: 12,
                }}
              />
              <button
                onClick={() => {
                  setApiBaseUrl(apiUrlInput);
                  setDemoMode(false);
                  initApp(false);
                }}
                style={{
                  padding: "8px 14px", borderRadius: 8, border: "1px solid var(--accent)",
                  background: "#4da3ff20", color: "var(--accent)", fontWeight: 600, fontSize: 12, cursor: "pointer",
                }}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* ------------------------------------------------------------- header */}
      <header className="topbar" style={{
        display: "flex", alignItems: "center", gap: 15, padding: "10px 18px",
        borderBottom: "1px solid var(--line)", background: "#06090fee",
        position: "sticky", top: 0, zIndex: 40, backdropFilter: "blur(14px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 33, height: 33, borderRadius: 9,
            background: "linear-gradient(135deg,#4da3ff,#8b5cf6)",
            display: "grid", placeItems: "center", fontSize: 16,
            boxShadow: "0 3px 14px #4da3ff40",
          }}>🌗</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: -.2 }}>SELENE-REG</div>
            <div style={{ fontSize: 9.5, color: "var(--dim)" }}>
              Multi-modal · sun-angle &amp; scale invariant correspondence
            </div>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div className="tabs" style={{
          display: "flex", gap: 4, background: "#0a0f1a", padding: 3,
          borderRadius: 9, border: "1px solid var(--line)",
        }}>
          {[["match", "Correspondence"], ["product", "Product"], ["report", "Report"]]
            .map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                padding: "6px 13px", borderRadius: 7, border: "none",
                fontSize: 11.5, fontWeight: 600,
                background: tab === k ? "linear-gradient(135deg,#4da3ff,#8b5cf6)" : "transparent",
                color: tab === k ? "#fff" : "var(--dim)",
              }}>{l}</button>
            ))}
        </div>

        <div className="hdr-meta" style={{
          fontSize: 9.5, color: "var(--dim2)", fontFamily: "var(--mono)",
          textAlign: "right", lineHeight: 1.5,
        }}>
          <button
            onClick={() => setShowApiModal(true)}
            style={{
              display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end",
              background: "transparent", border: "1px solid var(--line)", padding: "3px 8px",
              borderRadius: 6, color: "var(--txt)", cursor: "pointer", fontSize: 10,
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: api?.demo ? "#f59e0b" : api ? "var(--ok)" : "var(--bad)",
            }} />
            {api?.demo ? "Demo Mode" : api ? api.engine : "Offline"}
            <span style={{ fontSize: 9, color: "var(--dim)" }}>⚙️</span>
          </button>
          ISRO · SIH PS 26166
        </div>
      </header>

      {/* -------------------------------------------------------- preset strip */}
      <div style={{
        display: "flex", gap: 7, padding: "10px 18px", borderBottom: "1px solid var(--line)",
        overflowX: "auto", background: "#080c15",
      }}>
        {presets.map((p) => (
          <button key={p.id} onClick={() => applyPreset(p)} disabled={busy} style={{
            padding: "8px 13px", borderRadius: 10, textAlign: "left", minWidth: 205,
            border: `1px solid ${p.id === presetId ? "var(--accent)" : "var(--line)"}`,
            background: p.id === presetId ? "#4da3ff14" : "var(--panel)",
            color: "var(--txt)", flexShrink: 0, opacity: busy ? .6 : 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
              <span style={{
                fontSize: 8.5, fontWeight: 800, padding: "2px 6px", borderRadius: 4,
                background: p.id === presetId ? "var(--accent)" : "#1e2a44",
                color: p.id === presetId ? "#04101f" : "var(--dim)", letterSpacing: .5,
              }}>{p.sensor}</span>
              <span style={{ fontSize: 11.5, fontWeight: 600 }}>→ {p.refLabel}</span>
            </div>
            <div style={{ fontSize: 10, color: "var(--dim)" }}>{p.site}</div>
            <div style={{ fontSize: 9, color: "var(--dim2)", fontFamily: "var(--mono)", marginTop: 1 }}>
              {p.gsdSrc} → {p.gsdRef} m/px · {(p.gsdSrc / p.gsdRef).toFixed(1)}× scale
            </div>
          </button>
        ))}
        {!presetId && (src?.uploaded || ref?.uploaded) && (
          <div style={{
            padding: "8px 13px", borderRadius: 10, minWidth: 190, flexShrink: 0,
            border: "1px solid var(--accent)", background: "#4da3ff14",
          }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--accent)" }}>
              Custom pair
            </div>
            <div style={{ fontSize: 9.5, color: "var(--dim)", marginTop: 2 }}>
              Your uploaded rasters
            </div>
          </div>
        )}
      </div>

      {/* ---------------------------------------------------------------- body */}
      <div className="workspace">
        {/* ------------------------------------------------------- left rail */}
        <div className="rail rail-left">
          <Card title="Input pair" icon="🛰️">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Dropzone role="source" meta={src} accent="var(--accent)"
                        onFile={(f) => doUpload(f, "source")}
                        progress={upProg.source} error={upErr.source} />
              <Dropzone role="reference" meta={ref} accent="var(--accent2)"
                        onFile={(f) => doUpload(f, "reference")}
                        progress={upProg.reference} error={upErr.reference} />
            </div>
            {preset && (
              <div style={{ marginTop: 10 }}>
                <Row k="Site" v={preset.site} mono={false} />
                <Row k="Coordinates" v={preset.coords} />
                <Row k="Spectral" v={preset.bands} mono={false} />
                <Row k="Altitude" v={preset.altitude} />
              </div>
            )}
            {gsdRatio && (
              <div style={{ marginTop: 8 }}>
                <Row k="Scale ratio" v={`${gsdRatio.toFixed(2)}×`}
                     tone={gsdRatio > 4 || gsdRatio < 0.25 ? "warn" : ""} />
              </div>
            )}
          </Card>

          {preset && (
            <Card title="Illumination geometry" icon="☀️">
              <SunDial src={preset.sunSrc} ref={preset.sunRef} />
            </Card>
          )}

          <Card title="Pipeline" icon="⚙️"
                right={result && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--dim)" }}>
                    {result.totalMs?.toFixed(0)}ms
                  </span>
                )}>
            <StageList stages={result?.stages} running={busy}
                       activeLabel={STAGE_LABELS[stageIdx]} />
            <button onClick={() => run(params)} disabled={busy || !src || !ref} style={{
              width: "100%", marginTop: 10, padding: "9px 0", borderRadius: 9,
              border: "none", fontWeight: 700, fontSize: 11.5,
              background: busy || !src || !ref
                ? "#1b2740" : "linear-gradient(135deg,#4da3ff,#8b5cf6)",
              color: busy || !src || !ref ? "var(--dim2)" : "#fff",
            }}>
              {busy ? "Running…" : "▶  Run registration"}
            </button>
            <div style={{ marginTop: 7 }}>
              <Toggle label="Auto re-run on change" checked={autoRun} onChange={setAutoRun}
                      hint="Re-register automatically when a parameter changes" />
            </div>
          </Card>
        </div>

        {/* ----------------------------------------------------------- centre */}
        <div style={{ display: "flex", flexDirection: "column", gap: 11, minWidth: 0 }}>
          {runErr && !dismissed && (
            <Banner tone="error" title="Registration failed" onClose={() => setDismissed(true)}>
              {runErr}
            </Banner>
          )}
          {result?.warnings?.map((w, i) => (
            <Banner key={i} tone="warn" title="Note">{w}</Banner>
          ))}

          <div className="metrics">
            <Metric label="RMSE" value={M?.rmse} unit="px" tone={rmseTone} loading={busy && !M}
                    sub={M ? (M.rmse < 1 ? "sub-pixel ✓" : "above 1 px") : "—"} />
            <Metric label="Inliers" value={C?.inliers} tone="ok" loading={busy && !C}
                    sub={C ? `of ${C.candidates} candidates` : "—"} />
            <Metric label="Inlier ratio" value={M ? M.inlierRatio * 100 : undefined} unit="%"
                    loading={busy && !M} decimals={1}
                    tone={!M ? "" : M.inlierRatio > .5 ? "ok" : M.inlierRatio > .25 ? "warn" : "bad"} />
            <Metric label="Uniformity" value={M?.uniformity} tone={uniTone} loading={busy && !M}
                    sub={M ? `${Math.round(M.occupancy * 64)}/64 cells` : "—"} />
            <Metric label="Median err" value={M?.median} unit="px" loading={busy && !M} />
            <Metric label="90th pct" value={M?.p90} unit="px" loading={busy && !M} />
          </div>

          {tab === "match" && (
            <Card pad={0} className="viewer" style={{ position: "relative" }}>
              <div style={{
                position: "absolute", top: 9, left: 9, zIndex: 5, display: "flex", gap: 5,
              }}>
                <div style={{
                  display: "flex", gap: 3, background: "#05070ee8", padding: 3,
                  borderRadius: 8, border: "1px solid var(--line2)",
                }}>
                  {[["side", "Side by side"], ["overlay", "Residual field"]].map(([k, l]) => (
                    <button key={k} onClick={() => setLayout(k)} style={{
                      padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 600,
                      border: "none",
                      background: layout === k ? "var(--accent)" : "transparent",
                      color: layout === k ? "#04121f" : "var(--dim)",
                    }}>{l}</button>
                  ))}
                </div>
              </div>
              {result ? (
                <MatchCanvas
                  srcImg={srcImg} refImg={refImg}
                  srcSize={result.srcSize} refSize={result.refSize}
                  H={result.H} matches={matches}
                  showLines={showLines} showOutliers={showOut} showFootprint={showFp}
                  colorBy={colorBy} density={density} layout={layout} loupe={loupe}
                  sensor={src?.sensor} refLabel={ref?.sensor} busy={busy}
                />
              ) : (
                <div style={{
                  height: "100%", display: "grid", placeItems: "center",
                  color: "var(--dim2)", fontSize: 12,
                }}>
                  {busy ? "Registering…" : "Run a registration to see correspondences."}
                </div>
              )}
            </Card>
          )}

          {tab === "product" && (
            <Card pad={12} className="viewer">
              <ProductView products={result?.products} mode={prodMode}
                           setMode={setProdMode} busy={busy} />
            </Card>
          )}

          {tab === "report" && (
            <Card title="Registration report" pad={15} icon="📄">
              {!result ? (
                <div style={{ color: "var(--dim2)", fontSize: 12, padding: "20px 0" }}>
                  No results yet.
                </div>
              ) : (
                <>
                  <div className="report-grid">
                    <div>
                      <H>Estimated transform (source → reference)</H>
                      <pre style={{
                        fontFamily: "var(--mono)", fontSize: 10, background: "#05080f",
                        border: "1px solid var(--line)", borderRadius: 8, padding: 10,
                        margin: "0 0 13px", lineHeight: 1.7, overflowX: "auto", color: "#9fd0ff",
                      }}>
{result.H.map((r) => "[ " + r.map((v) =>
  (v >= 0 ? " " : "") + v.toFixed(6).padStart(11)).join("  ") + " ]").join("\n")}
                      </pre>
                      <H>Decomposition</H>
                      <Row k="Model" v={result.params.model} />
                      <Row k="Scale" v={`${fmt(result.decomp.scale, 4)}×`} />
                      <Row k="Rotation" v={`${fmt(result.decomp.rotation, 3)}°`} />
                      <Row k="Translation"
                           v={`(${fmt(result.decomp.tx, 1)}, ${fmt(result.decomp.ty, 1)}) px`} />
                      <Row k="Shear" v={fmt(result.decomp.shear, 4)} />
                      <Row k="Aspect" v={fmt(result.decomp.aspect, 4)} />
                    </div>
                    <div>
                      <H>Detector / matcher</H>
                      <Row k="Detector" v={result.params.detector} />
                      <Row k="Keypoints (src)"
                           v={`${(C?.kpSrc ?? 0).toLocaleString()}${C?.kpSrcRaw !== C?.kpSrc ? ` of ${(C?.kpSrcRaw ?? 0).toLocaleString()}` : ""}`} />
                      <Row k="Keypoints (ref)"
                           v={`${(C?.kpRef ?? 0).toLocaleString()}${C?.kpRefRaw !== C?.kpRef ? ` of ${(C?.kpRefRaw ?? 0).toLocaleString()}` : ""}`} />
                      <Row k="k-NN pairs" v={(C?.knn ?? 0).toLocaleString()} />
                      <Row k="After ratio test" v={(C?.candidates ?? 0).toLocaleString()} />
                      <Row k="RANSAC inliers" v={(C?.inliers ?? 0).toLocaleString()} tone="ok" />
                      <Row k="Robust method" v={result.params.ransac} />
                      <div style={{ height: 12 }} />
                      <H>Accuracy</H>
                      <Row k="RMSE" v={`${fmt(M.rmse, 4)} px`} tone={rmseTone} />
                      {ref?.gsd && (
                        <Row k="RMSE (ground)" v={`${fmt(M.rmse * ref.gsd, 3)} m`} />
                      )}
                      <Row k="Mean abs error" v={`${fmt(M.mae, 4)} px`} />
                      <Row k="Median" v={`${fmt(M.median, 4)} px`} />
                      <Row k="Max error" v={`${fmt(M.max, 4)} px`} />
                      <Row k="Uniformity" v={fmt(M.uniformity, 4)} tone={uniTone} />
                      <Row k="Grid occupancy" v={`${Math.round(M.occupancy * 100)}%`} />
                      <Row k="Total runtime" v={`${result.totalMs?.toFixed(0)} ms`} />
                    </div>
                  </div>

                  <div style={{
                    marginTop: 16, padding: 12, borderRadius: 9,
                    background: M.rmse < 1 ? "#22d39a12" : "#ffb54712",
                    border: `1px solid ${M.rmse < 1 ? "#22d39a44" : "#ffb54744"}`,
                    fontSize: 11.5, lineHeight: 1.65,
                  }}>
                    <b style={{ color: M.rmse < 1 ? "var(--ok)" : "var(--warn)" }}>
                      {M.rmse < 1 ? "✓ Sub-pixel registration achieved" : "△ Near-pixel registration"}
                    </b>
                    <span style={{ color: "var(--dim)" }}>
                      {" "}— {src?.sensor || "source"} → {ref?.sensor || "reference"}
                      {preset && ` across a ${Math.abs(preset.sunSrc.az - preset.sunRef.az)}° solar-azimuth difference`}
                      {gsdRatio && ` and ${gsdRatio.toFixed(1)}× scale ratio`}.
                      RMSE {fmt(M.rmse, 3)} px
                      {ref?.gsd && ` ≈ ${fmt(M.rmse * ref.gsd, 2)} m on the surface`},
                      from {C.inliers} inliers over {Math.round(M.occupancy * 64)}/64 grid cells.
                    </span>
                  </div>

                  <div style={{ marginTop: 13, display: "flex", gap: 7, flexWrap: "wrap" }}>
                    <Dl href={exportUrl(result.job, "matches.csv")} label="⬇ Match points (CSV)" />
                    <Dl href={exportUrl(result.job, "report.json")} label="⬇ Full report (JSON)" />
                    <Dl href={exportUrl(result.job, "registered.png")} label="⬇ Registered raster" />
                    <Dl href={exportUrl(result.job, "checker.png")} label="⬇ Checkerboard" />
                    <Dl href={exportUrl(result.job, "diff.png")} label="⬇ Residual map" />
                  </div>
                </>
              )}
            </Card>
          )}

          {tab === "report" && M && D && (
            <Card title="Problem-statement compliance" pad={15} icon="🎯">
              <div className="ps-grid">
                <PsCard
                  n="01" title="Illumination / sun-angle invariance"
                  need="Match across different solar azimuth and elevation."
                  evidence={preset
                    ? `Δaz ${Math.abs(preset.sunSrc.az - preset.sunRef.az)}° · Δel ${Math.abs(preset.sunSrc.el - preset.sunRef.el)}° between the two frames`
                    : "Uploaded pair — illumination difference unknown"}
                  how={`CLAHE local contrast equalisation${params.clahe > 0 ? ` (clip ${params.clahe.toFixed(1)})` : " disabled"} + gradient-orientation descriptors, which encode structure rather than brightness.`}
                  metric={`${C.inliers} inliers survived`} ok={C.inliers >= 20} />
                <PsCard
                  n="02" title="Viewpoint / rotation invariance"
                  need="Match across differing look angles and image rotation."
                  evidence={`Recovered rotation ${fmt(D.rotation, 2)}° · shear ${fmt(D.shear, 4)}`}
                  how={`${params.model} model fitted with ${params.ransac} — keypoint dominant-orientation makes descriptors rotation invariant.`}
                  metric={`${fmt(M.inlierRatio * 100, 1)}% inlier ratio`} ok={M.inlierRatio > 0.25} />
                <PsCard
                  n="03" title="Scale invariance"
                  need="Match imagery at different ground sampling distances."
                  evidence={gsdRatio
                    ? `${src?.gsd ?? "?"} m/px → ${ref?.gsd ?? "?"} m/px · ${gsdRatio.toFixed(1)}× GSD ratio`
                    : "Uploaded pair — GSD not declared"}
                  how={`Scale-space pyramid detection${params.prescale !== 1 ? ` with ${params.prescale.toFixed(2)}× GSD pre-scaling` : ""}. Recovered scale ${fmt(D.scale, 4)}×.`}
                  metric={`RMSE ${fmt(M.rmse, 3)} px`} ok={M.rmse < 2} />
                <PsCard
                  n="04" title="Uniform match distribution"
                  need="Correspondences spread over the frame, not clustered."
                  evidence={`${Math.round(M.occupancy * 64)} of 64 grid cells populated`}
                  how={`Adaptive non-maximal suppression ${params.anms ? "on" : "off"} — over-detects then bucket-selects to spread keypoints evenly.`}
                  metric={`uniformity ${fmt(M.uniformity, 3)}`} ok={M.uniformity > 0.4} />
              </div>
              <p className="ps-foot">
                Every value above is read back from the OpenCV run that produced job{" "}
                <code>{result.job}</code> — nothing on this page is hard-coded.
              </p>
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------ right rail */}
        <div className="rail rail-right">
          <Card title="Engine" icon="🎛️">
            <Select label="Detector" value={params.detector}
                    options={[["SIFT", "SIFT — scale invariant"],
                              ["AKAZE", "AKAZE — fast, nonlinear"],
                              ["ORB", "ORB — fastest, binary"],
                              ["BRISK", "BRISK — binary, robust"]]}
                    onChange={(v) => setP("detector", v)} />
            <Select label="Transform model" value={params.model}
                    options={[["homography", "Homography — 8 DOF"],
                              ["affine", "Affine — 6 DOF"],
                              ["similarity", "Similarity — 4 DOF"]]}
                    onChange={(v) => setP("model", v)} />
            <Select label="Robust estimator" value={params.ransac}
                    options={[["MAGSAC", "MAGSAC++"], ["RANSAC", "RANSAC"], ["LMEDS", "LMedS"]]}
                    onChange={(v) => setP("ransac", v)} />
          </Card>

          <Card title="Matcher" icon="🎚️">
            <Slider label="Lowe ratio (τ)" value={params.ratio} min={.5} max={.95} step={.01}
                    onChange={(v) => setP("ratio", v)} display={params.ratio.toFixed(2)}
                    hint="Lower = stricter descriptor matching" />
            <Slider label="RANSAC threshold" value={params.threshold} min={.5} max={8} step={.1}
                    onChange={(v) => setP("threshold", v)}
                    display={`${params.threshold.toFixed(1)} px`} />
            <Slider label="GSD pre-scale" value={params.prescale} min={.25} max={4} step={.05}
                    onChange={(v) => setP("prescale", v)}
                    display={`${params.prescale.toFixed(2)}×`}
                    hint="Resample the source toward the reference GSD before detection" />
            <Slider label="CLAHE clip" value={params.clahe} min={0} max={8} step={.5}
                    onChange={(v) => setP("clahe", v)}
                    display={params.clahe === 0 ? "off" : params.clahe.toFixed(1)}
                    hint="Local contrast equalisation — the core of illumination invariance" />
            <Slider label="Max features" value={params.maxFeatures} min={1000} max={12000} step={500}
                    onChange={(v) => setP("maxFeatures", v)}
                    display={params.maxFeatures.toLocaleString()} />
            <div style={{ height: 3 }} />
            <Toggle label="Uniform keypoints (ANMS)" checked={params.anms}
                    onChange={(v) => setP("anms", v)}
                    hint="Bucketed selection so match points spread across the frame" />
            <Toggle label="ECC sub-pixel refine" checked={params.ecc}
                    onChange={(v) => setP("ecc", v)} color="var(--ok)"
                    hint="Photometric refinement of the transform after RANSAC" />
            <Toggle label="Invert source polarity" checked={params.invert}
                    onChange={(v) => setP("invert", v)} color="var(--warn)"
                    hint="For multi-modal pairs such as IIRS SWIR vs visible" />
            <Toggle label="Cross-check matches" checked={params.crosscheck}
                    onChange={(v) => setP("crosscheck", v)}
                    hint="Keep only mutual nearest neighbours" />
            <button onClick={() => { setParams(preset ? { ...DEFAULTS, ...preset.defaults } : DEFAULTS); }}
              style={{
                width: "100%", marginTop: 9, padding: "6px 0", borderRadius: 8,
                border: "1px solid var(--line2)", background: "transparent",
                color: "var(--dim)", fontSize: 10.5,
              }}>Reset to preset defaults</button>
          </Card>

          <Card title="Display" icon="👁️">
            <Toggle label="Correspondence lines" checked={showLines} onChange={setShowLines} />
            <Toggle label="Rejected outliers" checked={showOut} onChange={setShowOut}
                    color="var(--bad)" />
            <Toggle label="Projected footprint" checked={showFp} onChange={setShowFp}
                    color="var(--ok)" />
            <Toggle label="Magnifier loupe" checked={loupe} onChange={setLoupe}
                    color="var(--cyan)" hint="4× inspection lens that follows the cursor" />
            <div style={{ marginTop: 9 }}>
              <Slider label="Line density" value={density} min={2} max={100} step={1}
                      onChange={setDensity} display={`${density}%`} />
            </div>
            <div style={{ fontSize: 10.5, color: "var(--dim)", margin: "3px 0 5px" }}>
              Colour points by
            </div>
            <Segmented value={colorBy} onChange={setColorBy}
                       options={[["error", "Residual"], ["ratio", "Lowe"], ["scale", "Scale"]]} />
          </Card>

          <Card title="Residual distribution" icon="📊">
            {result ? (
              <>
                <Histogram bins={hist.bins} maxV={hist.maxV} thresh={params.threshold} />
                <div style={{ marginTop: 7, fontSize: 10.5, color: "var(--dim)" }}>
                  <span style={{ color: "var(--accent)" }}>■</span> inliers ≤ τ{"  "}
                  <span style={{ color: "var(--bad)" }}>■</span> rejected
                </div>
              </>
            ) : <Empty />}
          </Card>

          <Card title="Match-point distribution" icon="🗺️"
                right={M && (
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 9.5,
                    color: uniTone === "ok" ? "var(--ok)" : "var(--warn)",
                  }}>{fmt(M.uniformity, 3)}</span>
                )}>
            {result ? (
              <>
                <GridMap grid={result.grid} />
                <div style={{ fontSize: 9.5, color: "var(--dim2)", marginTop: 6, lineHeight: 1.5 }}>
                  8×8 occupancy over the reference frame. Uniform spread avoids a transform
                  biased toward one region.
                </div>
              </>
            ) : <Empty />}
          </Card>
        </div>
      </div>

      <footer style={{
        padding: "10px 18px", borderTop: "1px solid var(--line)", fontSize: 10,
        color: "var(--dim2)", display: "flex", justifyContent: "space-between",
        flexWrap: "wrap", gap: 8,
      }}>
        <span>
          Live registration by {api?.engine || "OpenCV"} — SIFT/AKAZE/ORB/BRISK · FLANN ·
          MAGSAC++ · ECC refinement
        </span>
        <span style={{ fontFamily: "var(--mono)" }}>
          Smart India Hackathon · PS 26166 · ISRO / Dept. of Space
        </span>
      </footer>

      {showApiModal && (
        <div style={{ position: "fixed", inset: 0, background: "#000000aa", backdropFilter: "blur(6px)", display: "grid", placeItems: "center", zIndex: 100 }}>
          <div style={{ background: "#0c1322", width: 440, padding: 24, borderRadius: 14, border: "1px solid var(--line)", boxShadow: "0 10px 40px #000" }}>
            <h3 style={{ margin: "0 0 12px", fontSize: 16 }}>API Connection Settings</h3>
            <p style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.5, marginBottom: 16 }}>
              Configure your Python FastAPI backend server endpoint, or toggle Interactive Demo Mode.
            </p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, color: "var(--txt)", display: "block", marginBottom: 6 }}>API Base URL</label>
              <input
                type="text"
                value={apiUrlInput}
                onChange={(e) => setApiUrlInput(e.target.value)}
                style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid var(--line)", background: "#06090f", color: "#fff", fontSize: 12, fontFamily: "var(--mono)", boxSizing: "border-box" }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => {
                  setShowApiModal(false);
                  initApp(true);
                }}
                style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "transparent", color: "var(--dim)", fontSize: 12, cursor: "pointer" }}
              >
                Use Demo Mode
              </button>
              <button
                onClick={() => {
                  setApiBaseUrl(apiUrlInput);
                  setDemoMode(false);
                  setShowApiModal(false);
                  initApp(false);
                }}
                style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: "var(--accent)", color: "#fff", fontWeight: 600, fontSize: 12, cursor: "pointer" }}
              >
                Connect Backend
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const H = ({ children }) => (
  <div style={{
    fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "var(--dim)",
    textTransform: "uppercase", marginBottom: 6,
  }}>{children}</div>
);

const Empty = () => (
  <div style={{ fontSize: 10.5, color: "var(--dim2)", padding: "8px 0" }}>
    Awaiting registration.
  </div>
);

/** One row of the problem-statement compliance matrix. */
function PsCard({ n, title, need, evidence, how, metric, ok }) {
  return (
    <div className="ps-card">
      <div className="ps-head">
        <span className="ps-n">{n}</span>
        <span className="ps-t">{title}</span>
        <span className={"ps-pill " + (ok ? "good" : "warn")}>{metric}</span>
      </div>
      <div className="ps-need">{need}</div>
      <div className="ps-ev">{evidence}</div>
      <div className="ps-how">{how}</div>
    </div>
  );
}

const Dl = ({ href, label }) => (
  <a href={href} download style={{
    padding: "7px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600,
    border: "1px solid var(--line2)", background: "var(--panel2)",
    color: "var(--txt)", textDecoration: "none",
  }}>{label}</a>
);
