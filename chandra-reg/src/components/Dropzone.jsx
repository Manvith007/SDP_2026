import { useRef, useState } from "react";

/** Drag-and-drop / click-to-browse raster upload with progress + preview. */
export default function Dropzone({ role, meta, onFile, progress, error, accent }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const busy = progress !== undefined && progress !== null && progress < 1;

  const pick = (files) => {
    const f = files?.[0];
    if (f) onFile(f);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `1.5px dashed ${error ? "var(--bad)" : over ? accent : "var(--line2)"}`,
        borderRadius: 10, padding: "11px 12px", cursor: "pointer",
        background: over ? `${accent}12` : "var(--panel2)",
        transition: "all .16s", position: "relative", overflow: "hidden",
      }}
    >
      <input ref={inputRef} type="file" hidden
             accept="image/png,image/jpeg,image/tiff,image/bmp,.tif,.tiff"
             onChange={(e) => pick(e.target.files)} />

      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: .8, color: accent, marginBottom: 4,
      }}>
        {role === "source" ? "MOVING / SOURCE" : "FIXED / REFERENCE"}
      </div>

      {meta ? (
        <>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--txt)",
            wordBreak: "break-all", lineHeight: 1.4,
          }}>{meta.name}</div>
          <div style={{ fontSize: 9.5, color: "var(--dim2)", marginTop: 2 }}>
            {meta.w}×{meta.h}px
            {meta.gsd ? ` · ${meta.gsd} m/px` : ""}
            {meta.uploaded ? " · uploaded" : " · preset"}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 11, color: "var(--dim)" }}>
          Drop a raster here, or click to browse
          <div style={{ fontSize: 9.5, color: "var(--dim2)", marginTop: 2 }}>
            PNG · JPEG · TIFF · BMP — 8/16-bit
          </div>
        </div>
      )}

      {busy && (
        <div style={{
          position: "absolute", left: 0, bottom: 0, height: 3,
          width: `${Math.round(progress * 100)}%`, background: accent,
          transition: "width .18s",
        }} />
      )}
      {error && (
        <div style={{ fontSize: 10, color: "var(--bad)", marginTop: 5 }}>{error}</div>
      )}
    </div>
  );
}
