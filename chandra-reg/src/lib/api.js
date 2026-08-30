// ---------------------------------------------------------------------------
// SELENE-REG API client with configurable endpoint & static demo fallback.
// ---------------------------------------------------------------------------

import { DEMO_PRESETS, generateDemoRegistration } from "./demoEngine";

let isDemoModeActive = false;

export function getApiBaseUrl() {
  const custom = localStorage.getItem("selene_api_url");
  if (custom) return custom.replace(/\/+$/, "");
  // Default to relative /api when hosted alongside backend, or http://localhost:8000
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return "/api";
  }
  return "http://localhost:8000/api";
}

export function setApiBaseUrl(url) {
  if (!url) {
    localStorage.removeItem("selene_api_url");
  } else {
    localStorage.setItem("selene_api_url", url);
  }
}

export function isDemoMode() {
  return isDemoModeActive;
}

export function setDemoMode(active) {
  isDemoModeActive = active;
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 5000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, {
      ...options,
      signal: options.signal || controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

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
  if (isDemoModeActive) {
    return {
      version: "1.0-demo",
      engine: "Static Demo Engine",
      detectors: ["SIFT", "AKAZE", "ORB", "BRISK"],
      models: ["homography", "affine", "similarity"],
      estimators: ["MAGSAC", "RANSAC", "LMedS"],
      demo: true,
    };
  }
  const base = getApiBaseUrl();
  try {
    const res = await fetchWithTimeout(`${base}/health`, { timeout: 3500 });
    return await jsonOrThrow(res);
  } catch (err) {
    // If live API fails, activate demo mode automatically
    isDemoModeActive = true;
    return {
      version: "1.0-demo",
      engine: "Static Demo Engine",
      detectors: ["SIFT", "AKAZE", "ORB", "BRISK"],
      models: ["homography", "affine", "similarity"],
      estimators: ["MAGSAC", "RANSAC", "LMedS"],
      demo: true,
      error: err.message,
    };
  }
}

export async function getPresets() {
  if (isDemoModeActive) return DEMO_PRESETS;
  const base = getApiBaseUrl();
  try {
    const b = await jsonOrThrow(await fetch(`${base}/presets`));
    return b.presets || DEMO_PRESETS;
  } catch {
    isDemoModeActive = true;
    return DEMO_PRESETS;
  }
}

export async function uploadImage(file, role, onProgress) {
  if (isDemoModeActive) {
    throw new Error("Custom upload requires a running backend API server.");
  }
  const base = getApiBaseUrl();
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("role", role);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/upload`);
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
  if (isDemoModeActive || srcId.startsWith("demo_") || refId.startsWith("demo_")) {
    return generateDemoRegistration({ srcId, refId, params });
  }
  const base = getApiBaseUrl();
  try {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srcId, refId, params }),
      signal,
    });
    return jsonOrThrow(res);
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // Fallback to demo registration if live API fails
    return generateDemoRegistration({ srcId, refId, params });
  }
}

export const imageUrl = (id, opts = {}) => {
  if (!id) return "";
  if (id.startsWith("demo_") || isDemoModeActive) {
    const p = DEMO_PRESETS.find((x) => x.srcId === id || x.refId === id || x.id === id);
    if (p) {
      return id === p.refId ? p.refFile : p.srcFile;
    }
    return "presets/ref_nac.png";
  }
  const base = getApiBaseUrl();
  const q = new URLSearchParams();
  if (opts.colormap) q.set("colormap", opts.colormap);
  if (opts.max) q.set("max", String(opts.max));
  const s = q.toString();
  return `${base}/image/${id}${s ? `?${s}` : ""}`;
};

export const exportUrl = (job, what) => {
  if (job?.startsWith("demo_") || isDemoModeActive) {
    return "#";
  }
  const base = getApiBaseUrl();
  return `${base}/export/${job}/${what}`;
};
