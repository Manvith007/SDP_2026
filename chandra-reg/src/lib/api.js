// ---------------------------------------------------------------------------
// SELENE-REG API client.
//
// All calls use relative /api/* URLs. Vite proxies them to the FastAPI service,
// so this works identically on localhost and behind the sandbox preview host.
// ---------------------------------------------------------------------------

async function jsonOrThrow(res) {
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `Server returned ${res.status} (${res.statusText || "error"}).` +
        (text ? ` ${text.slice(0, 160)}` : "")
    );
  }
  if (!res.ok) throw new Error(body?.detail || body?.error || `HTTP ${res.status}`);
  return body;
}

export async function health() {
  return jsonOrThrow(await fetch("/api/health"));
}

export async function getPresets() {
  const b = await jsonOrThrow(await fetch("/api/presets"));
  return b.presets || [];
}

export async function uploadImage(file, role, onProgress) {
  // XHR (not fetch) so we can report upload progress for large planetary rasters
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("role", role);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let b;
      try {
        b = JSON.parse(xhr.responseText);
      } catch {
        return reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(b);
      else reject(new Error(b?.detail || `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.timeout = 120000;
    xhr.send(fd);
  });
}

export async function runRegistration({ srcId, refId, params }, signal) {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ srcId, refId, params }),
    signal,
  });
  return jsonOrThrow(res);
}

export const imageUrl = (id, opts = {}) => {
  if (!id) return "";
  const q = new URLSearchParams();
  if (opts.colormap) q.set("colormap", opts.colormap);
  if (opts.max) q.set("max", String(opts.max));
  const s = q.toString();
  return `/api/image/${id}${s ? `?${s}` : ""}`;
};

export const exportUrl = (job, what) => `/api/export/${job}/${what}`;
