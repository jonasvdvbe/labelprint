// LabelPrint UI
import * as pdfjsLib from "./vendor/pdf.min.mjs";
import {
  LABEL_SIZES, LANGUAGES, CROP_PRESETS, mmToDots, toLuma, detectBlocks, contentBox,
  toMono, monoTransform, monoGet, monoBlackRatio, encodeLabels, calibrateCommand,
} from "./labelcore.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";
const PDF_OPTS = {
  cMapUrl: "vendor/cmaps/", cMapPacked: true,
  standardFontDataUrl: "vendor/standard_fonts/",
  wasmUrl: "vendor/wasm/", iccUrl: "vendor/iccs/",
  isEvalSupported: false,
};
const NET = "__net__";
const ANALYSIS_PX_PER_MM = 3;

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("t") || "";

const S = {
  printers: [],
  platform: "",
  downloads: "",
  cfg: { hotFolder: { enabled: false, path: "", filter: "", autoPrint: false }, ui: {} },
  docs: [],
  pages: [],
  current: 0,
  labels: [],
  gen: 0,
  autoPrintPending: false,
  printing: false,
};

// ---------------------------------------------------------------------------
// backend API

async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const res = await fetch(path, { method, body, headers: { "X-Token": token, ...headers } });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (raw) return res;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res;
}

let saveTimer = 0;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api("/api/config", { method: "POST", body: JSON.stringify(S.cfg), headers: { "Content-Type": "application/json" } })
      .catch((e) => console.warn("config save failed", e));
  }, 400);
}

// ---------------------------------------------------------------------------
// settings model

const ui = () => S.cfg.ui;

function defaultPset(printerKey) {
  const p = S.printers.find((x) => x.name === printerKey);
  return {
    lang: printerKey === NET ? "zpl" : p?.suggested || "driver",
    size: "102x152", wmm: 101.6, hmm: 152.4, dpi: 203,
    darkness: "", speed: "", media: "", gapMM: 3, offX: 0, offY: 0, flip: false,
    mono: "threshold", threshold: 150,
  };
}

function printerKey() { return $("printer").value; }

function pset() {
  const key = printerKey();
  ui().printers ??= {};
  ui().printers[key] ??= defaultPset(key);
  return ui().printers[key];
}

function labelMM(ps) {
  if (ps.size === "custom") return [Number(ps.wmm) || 100, Number(ps.hmm) || 150];
  const s = LABEL_SIZES.find((x) => x.id === ps.size) || LABEL_SIZES[0];
  return [s.w, s.h];
}

const PREF_DEFAULTS = { theme: "system", defaultCrop: "", padMM: 1.5, skipEmpty: true, afterPrint: "none", confirmOver: 20, notify: true, openWithPrint: false };
function prefs() {
  ui().prefs = { ...PREF_DEFAULTS, ...(ui().prefs || {}) };
  return ui().prefs;
}

function applyTheme() {
  const t = prefs().theme;
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function cropCfg() {
  ui().crop ??= { mode: "auto", rotation: "auto", fit: "fit", margin: 1 };
  return ui().crop;
}

// ---------------------------------------------------------------------------
// init

async function init() {
  fillSelect($("lang"), LANGUAGES.map((l) => [l.id, l.name]));
  fillSelect($("size"), LABEL_SIZES.map((s) => [s.id, s.name]));
  bindEvents();

  try {
    const st = await api("/api/state");
    S.printers = st.printers || [];
    S.platform = st.platform;
    S.downloads = st.downloads;
    if (st.config) {
      S.cfg.hotFolder = { ...S.cfg.hotFolder, ...(st.config.hotFolder || {}) };
      S.cfg.ui = st.config.ui || {};
    }
    $("aboutVersion").textContent = "v" + st.version;
  } catch (e) {
    toast("Cannot reach LabelPrint service: " + e.message, true);
  }
  fillPrinters();
  fillCropModes();
  applySettingsToForm();
  applyHotFolderToForm();
  applyTheme();
  updateHotChip();
  connectEvents();
  api("/api/shell").then((r) => ($("shellInt").checked = r.enabled)).catch(() => {});
}

function fillSelect(sel, items) {
  sel.innerHTML = "";
  for (const [v, t] of items) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t; sel.appendChild(o);
  }
}

function fillPrinters() {
  const sel = $("printer");
  sel.innerHTML = "";
  for (const p of S.printers) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name + (p.isDefault ? "  (default)" : "");
    sel.appendChild(o);
  }
  const net = document.createElement("option");
  net.value = NET; net.textContent = "Network printer (IP address, port 9100)…";
  sel.appendChild(net);
  // choose: last used → a recognised label printer → default
  const last = ui().lastPrinter;
  const pick = (last && [...sel.options].some((o) => o.value === last)) ? last
    : (S.printers.find((p) => p.suggested !== "driver") || S.printers.find((p) => p.isDefault) || {}).name || NET;
  sel.value = pick;
}

function fillCropModes() {
  const sel = $("cropMode");
  sel.innerHTML = "";
  const g1 = document.createElement("optgroup"); g1.label = "Detection & areas";
  for (const c of CROP_PRESETS) {
    const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; g1.appendChild(o);
  }
  sel.appendChild(g1);
  const presets = ui().presets || [];
  if (presets.length) {
    const g2 = document.createElement("optgroup"); g2.label = "Saved presets";
    presets.forEach((p, i) => {
      const o = document.createElement("option"); o.value = "preset:" + i; o.textContent = "★ " + p.name; g2.appendChild(o);
    });
    sel.appendChild(g2);
  }
  const c = cropCfg();
  sel.value = [...sel.options].some((o) => o.value === c.mode) ? c.mode : "auto";
  $("btnDelPreset").hidden = !sel.value.startsWith("preset:");
}

function applySettingsToForm() {
  const key = printerKey();
  const ps = pset();
  $("netHostRow").hidden = key !== NET;
  $("netHost").value = ui().netHost || "";
  // network printers can only receive printer languages
  for (const o of $("lang").options) o.disabled = key === NET && o.value === "driver";
  if (key === NET && ps.lang === "driver") ps.lang = "zpl";
  $("lang").value = ps.lang;
  $("size").value = ps.size;
  $("wmm").value = ps.wmm; $("hmm").value = ps.hmm;
  $("customSizeRow").hidden = ps.size !== "custom";
  $("dpi").value = String(ps.dpi);
  $("darkness").value = ps.darkness ?? "";
  $("speed").value = ps.speed ?? "";
  $("media").value = ps.media || "";
  $("gapMM").value = ps.gapMM ?? 3;
  $("offX").value = ps.offX ?? 0; $("offY").value = ps.offY ?? 0;
  $("flip").checked = !!ps.flip;
  $("zplRaw").checked = !!ps.zplRaw;
  $("mono").value = ps.mono || "threshold";
  $("threshold").value = ps.threshold ?? 150;
  $("thrVal").textContent = $("threshold").value;
  const c = cropCfg();
  $("rotation").value = c.rotation; $("fit").value = c.fit; $("margin").value = c.margin;
  $("copies").value = ui().copies || 1;
  updateLangHints();
}

function updateLangHints() {
  const ps = pset();
  const p = S.printers.find((x) => x.name === printerKey());
  const hints = {
    zpl: "Label is sent as a ZPL image straight to the printer (RAW) – exact size, no driver scaling. Works with the ZDesigner driver or a “Generic / Text Only” printer.",
    epl: "Label is sent as an EPL2 image straight to the printer (RAW).",
    tspl: "Label is sent as a TSPL bitmap straight to the printer (RAW).",
    driver: "Printed through the Windows driver. Set the paper/label size in the printer's “Printing preferences” to match the label size here.",
  };
  let h = hints[ps.lang] || "";
  if (p && p.brand) h = `Detected: ${p.brand}. ` + h;
  $("langHint").textContent = h;
  const dark = { zpl: "Darkness −30…30 (relative, ^MD), speed 2–14 ips.", epl: "Darkness 0–15, speed 1–6.", tspl: "Density 0–15, speed 1–14.", driver: "Darkness/speed/media: set them in the Windows driver." };
  $("darkHint").textContent = dark[ps.lang] || "";
  const raw = ps.lang !== "driver";
  for (const id of ["darkness", "speed", "media", "gapMM"]) $(id).disabled = !raw;
  $("btnCalibrate").disabled = !raw;
  $("gapRow").hidden = !(ps.media === "gap" || ps.media === "mark" || ps.lang === "tspl");
  $("zplRawRow").hidden = ps.lang !== "zpl";
}

function applyHotFolderToForm() {
  const hf = S.cfg.hotFolder;
  $("hotEnabled").checked = !!hf.enabled;
  $("hotPath").value = hf.path || "";
  $("hotPath").placeholder = S.downloads || "";
  $("hotFilter").value = hf.filter || "";
  $("hotAuto").checked = !!hf.autoPrint;
}

// ---------------------------------------------------------------------------
// events

function bindEvents() {
  $("btnOpen").onclick = () => { $("fileInput").dataset.append = ""; $("fileInput").click(); };
  $("btnAdd").onclick = () => { $("fileInput").dataset.append = "1"; $("fileInput").click(); };
  $("fileInput").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    await loadFiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))), !!$("fileInput").dataset.append);
  };

  const stage = $("stage");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) stage.classList.remove("dragover"); }));
  document.addEventListener("drop", async (e) => {
    stage.classList.remove("dragover");
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!files.length) { toast("Please drop a PDF file", true); return; }
    await loadFiles(await Promise.all(files.map(async (f) => ({ name: f.name, data: await f.arrayBuffer() }))), e.shiftKey);
  });

  $("printer").onchange = () => {
    ui().lastPrinter = printerKey();
    applySettingsToForm(); saveConfig(); regenerate();
  };
  $("netHost").onchange = () => { ui().netHost = $("netHost").value.trim(); saveConfig(); };

  const psFields = {
    lang: (v) => v, size: (v) => v, wmm: Number, hmm: Number, dpi: Number,
    darkness: (v) => (v === "" ? "" : Number(v)), speed: (v) => (v === "" ? "" : Number(v)), media: (v) => v,
    gapMM: Number, offX: Number, offY: Number, mono: (v) => v, threshold: Number,
  };
  for (const [id, conv] of Object.entries(psFields)) {
    $(id).addEventListener(id === "threshold" ? "input" : "change", () => {
      const ps = pset();
      ps[id] = conv($(id).value);
      if (id === "size") {
        const s = LABEL_SIZES.find((x) => x.id === ps.size);
        if (s && s.id !== "custom") { ps.wmm = s.w; ps.hmm = s.h; }
        $("customSizeRow").hidden = ps.size !== "custom";
        $("wmm").value = ps.wmm; $("hmm").value = ps.hmm;
      }
      if (id === "threshold") $("thrVal").textContent = $("threshold").value;
      updateLangHints(); saveConfig();
      if (id === "size" || id === "wmm" || id === "hmm") { S.pages.forEach((p) => (p.analysis = null)); }
      regenerate();
    });
  }
  $("flip").onchange = () => { pset().flip = $("flip").checked; saveConfig(); regenerate(); };
  $("zplRaw").onchange = () => { pset().zplRaw = $("zplRaw").checked; saveConfig(); };
  $("shellInt").onchange = async () => {
    try {
      const r = await api("/api/shell", { method: "POST", body: JSON.stringify({ enable: $("shellInt").checked }), headers: { "Content-Type": "application/json" } });
      $("shellInt").checked = r.enabled;
      toast(r.enabled ? "Added to the PDF right-click menu (Windows 11: “Show more options”)" : "Removed from the right-click menu");
    } catch (e) { toast(e.message, true); }
  };

  $("cropMode").onchange = () => {
    const v = $("cropMode").value;
    cropCfg().mode = v;
    if (v.startsWith("preset:")) {
      const p = (ui().presets || [])[+v.slice(7)];
      if (p?.rotation) { cropCfg().rotation = p.rotation; $("rotation").value = p.rotation; }
    }
    if (v === "manual" && !ui().manualRect) ui().manualRect = [0.05, 0.05, 0.5, 0.45];
    $("btnDelPreset").hidden = !v.startsWith("preset:");
    saveConfig(); drawOverlay(); regenerate();
  };
  for (const id of ["rotation", "fit", "margin"]) {
    $(id).onchange = () => { cropCfg()[id] = id === "margin" ? Number($(id).value) || 0 : $(id).value; saveConfig(); regenerate(); };
  }
  $("btnSavePreset").onclick = savePreset;
  $("btnDelPreset").onclick = () => {
    const v = $("cropMode").value;
    if (!v.startsWith("preset:")) return;
    const i = +v.slice(7);
    const p = ui().presets[i];
    if (!confirm(`Delete crop preset “${p.name}”?`)) return;
    ui().presets.splice(i, 1);
    cropCfg().mode = "auto";
    fillCropModes(); saveConfig(); drawOverlay(); regenerate();
  };
  $("copies").onchange = () => { ui().copies = Math.max(1, Number($("copies").value) || 1); saveConfig(); };

  $("btnPrint").onclick = () => printLabels();
  $("btnTest").onclick = () => printTestLabel();
  $("btnCalibrate").onclick = calibrate;
  $("exportSel").onchange = async () => {
    const v = $("exportSel").value; $("exportSel").value = "";
    if (v === "png") exportPNG(); else if (v === "prn") exportPRN();
  };

  // hot folder
  const hfSave = () => {
    S.cfg.hotFolder = {
      enabled: $("hotEnabled").checked,
      path: $("hotPath").value.trim() || (($("hotEnabled").checked && S.downloads) || ""),
      filter: $("hotFilter").value.trim(),
      autoPrint: $("hotAuto").checked,
    };
    $("hotPath").value = S.cfg.hotFolder.path;
    updateHotChip();
    saveConfig();
  };
  for (const id of ["hotEnabled", "hotPath", "hotFilter", "hotAuto"]) $(id).onchange = hfSave;
  $("btnBrowse").onclick = async () => {
    try {
      const r = await api("/api/browse-folder?start=" + encodeURIComponent($("hotPath").value));
      if (r.path) { $("hotPath").value = r.path; hfSave(); }
    } catch (e) { toast(e.message, true); }
  };
  $("btnDataDir").onclick = () => api("/api/open-datadir").catch(() => {});
  $("btnHelp").onclick = () => $("helpDlg").showModal();
  $("btnSettings").onclick = () => openSettings();
  $("hotChip").onclick = () => openSettings("watch");
  $("btnCloseSettings").onclick = () => $("settingsDlg").close();
  $("settingsDlg").addEventListener("click", (e) => { if (e.target === $("settingsDlg")) $("settingsDlg").close(); });
  for (const b of $("setTabs").querySelectorAll("button")) b.onclick = () => showTab(b.dataset.tab);
  bindPrefs();

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "p") { e.preventDefault(); printLabels(); }
    if (e.ctrlKey && e.key.toLowerCase() === "o") { e.preventDefault(); $("btnOpen").click(); }
    if (!S.pages.length || ["INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") selectPage(Math.min(S.pages.length - 1, S.current + 1));
    if (e.key === "ArrowLeft" || e.key === "PageUp") selectPage(Math.max(0, S.current - 1));
  });
  new ResizeObserver(() => drawPage()).observe($("stage"));
  setupOverlayInteraction();
}

function connectEvents() {
  if (!token) return;
  const es = new EventSource("/api/events?t=" + token);
  let queue = Promise.resolve();
  es.addEventListener("file", (ev) => {
    if (!ev.data) return;
    const d = JSON.parse(ev.data);
    // files are handled one after another (several can arrive at once)
    queue = queue.then(async () => {
      try {
        const res = await api("/api/file?path=" + encodeURIComponent(d.path), { raw: true });
        const data = await res.arrayBuffer();
        const auto = !!d.auto || (d.source === "open" && prefs().openWithPrint);
        S.autoPrintPending = auto;
        S.autoJobName = auto ? d.name : "";
        await loadFiles([{ name: d.name, data }], false);
        toast((auto ? "Printing " : "Opened ") + d.name);
        while (S.printing) await new Promise((r) => setTimeout(r, 200));
      } catch (e) { toast(`Cannot open ${d.name}: ${e.message}`, true); }
    });
  });
  es.onerror = () => { /* browser reconnects automatically */ };
}

// ---------------------------------------------------------------------------
// loading PDFs

async function loadFiles(files, append) {
  if (!files.length) return;
  S.loadId = (S.loadId || 0) + 1;
  if (!append && prefs().defaultCrop && cropCfg().mode !== prefs().defaultCrop) {
    cropCfg().mode = prefs().defaultCrop;
    fillCropModes();
    saveConfig();
  }
  if (!append) {
    for (const d of S.docs) { try { d.task.destroy(); } catch { /* ignore */ } }
    S.docs = []; S.pages = []; S.current = 0;
  }
  for (const f of files) {
    try {
      const task = pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(f.data) });
      const pdf = await task.promise;
      const doc = { name: f.name, pdf, task };
      S.docs.push(doc);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        S.pages.push({ doc, num: n, page, include: true, analysis: null, viewCache: null });
      }
    } catch (e) {
      toast(`Cannot read ${f.name}: ${e.message}`, true);
    }
  }
  $("docName").textContent = S.docs.map((d) => d.name).join(", ") || "No file loaded";
  $("dropHint").hidden = S.pages.length > 0;
  $("pageWrap").hidden = S.pages.length === 0;
  // analyse pages (also detects empty pages)
  for (const p of S.pages) {
    await analysePage(p);
    if (!p.analysis.content && prefs().skipEmpty) p.include = false;
  }
  await buildThumbs();
  selectPage(Math.min(S.current, S.pages.length - 1));
  await regenerate(true);
  window.__lpLoaded = true;
}

async function analysePage(p) {
  if (p.analysis) return p.analysis;
  const base = p.page.getViewport({ scale: 1 });
  const scale = (ANALYSIS_PX_PER_MM * 25.4) / 72;
  const vp = p.page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await renderQueued(p.page, { canvas: c, canvasContext: ctx, viewport: vp, intent: "print" });
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const luma = toLuma(img.data, c.width, c.height);
  const [lw, lh] = labelMM(pset());
  const blocks = detectBlocks(luma, c.width, c.height, ANALYSIS_PX_PER_MM, { targetAspect: Math.max(lw, lh) / Math.min(lw, lh), labelMM: [lw, lh] });
  const cb = contentBox(luma, c.width, c.height);
  const pad = Math.max(0, Number(prefs().padMM) || 0) * ANALYSIS_PX_PER_MM;
  const norm = (b) => {
    const x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
    const x1 = Math.min(c.width, b.x + b.w + pad), y1 = Math.min(c.height, b.y + b.h + pad);
    return [x0 / c.width, y0 / c.height, (x1 - x0) / c.width, (y1 - y0) / c.height];
  };
  p.analysis = {
    widthMM: base.width / 72 * 25.4,
    heightMM: base.height / 72 * 25.4,
    blocks: blocks.map((b) => ({ ...b, rect: norm(b) })),
    content: cb ? norm(cb) : null,
  };
  return p.analysis;
}

// pdf.js renders are serialised so the same page is never rendered twice at once
let renderChain = Promise.resolve();
function renderQueued(page, params) {
  const job = renderChain.then(() => page.render(params).promise);
  renderChain = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// crop rectangles per page

function pageMatchesLabel(a) {
  const [lw, lh] = labelMM(pset());
  const close = (x, y) => Math.abs(x - y) / y < 0.08;
  return (close(a.widthMM, lw) && close(a.heightMM, lh)) || (close(a.widthMM, lh) && close(a.heightMM, lw));
}

function rectsForPage(p) {
  const mode = cropCfg().mode;
  const a = p.analysis;
  if (mode.startsWith("preset:")) {
    const pr = (ui().presets || [])[+mode.slice(7)];
    return pr ? [pr.rect] : [[0, 0, 1, 1]];
  }
  const fixed = CROP_PRESETS.find((c) => c.id === mode && c.r);
  if (fixed) return [fixed.r];
  if (mode === "full") return [[0, 0, 1, 1]];
  if (mode === "manual") return [ui().manualRect || [0, 0, 1, 1]];
  if (!a) return [[0, 0, 1, 1]];
  if (mode === "content") return [a.content || [0, 0, 1, 1]];
  // automatic modes
  if (pageMatchesLabel(a)) return [[0, 0, 1, 1]];
  if (!a.blocks.length) return [a.content || [0, 0, 1, 1]];
  if (mode === "auto-multi") {
    const best = a.blocks[0];
    const pageArea = (a.widthMM * ANALYSIS_PX_PER_MM) * (a.heightMM * ANALYSIS_PX_PER_MM);
    const picked = a.blocks.filter((b) => b.score >= best.score * 0.3 && b.area >= pageArea * 0.04);
    picked.sort((u, v) => (Math.abs(u.rect[1] - v.rect[1]) > 0.05 ? u.rect[1] - v.rect[1] : u.rect[0] - v.rect[0]));
    return picked.map((b) => b.rect);
  }
  return [a.blocks[0].rect];
}

function savePreset() {
  if (!S.pages.length) { toast("Open a PDF first", true); return; }
  const rect = rectsForPage(S.pages[S.current])[0];
  const name = prompt("Name for this crop preset (e.g. the carrier):", "");
  if (!name) return;
  ui().presets ??= [];
  ui().presets.push({ name: name.trim(), rect: rect.map((v) => Math.round(v * 10000) / 10000), rotation: cropCfg().rotation });
  cropCfg().mode = "preset:" + (ui().presets.length - 1);
  fillCropModes(); saveConfig(); drawOverlay(); regenerate();
  toast(`Preset “${name}” saved`);
}

// ---------------------------------------------------------------------------
// page view + overlay

async function buildThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  if (S.pages.length <= 1) return;
  for (const [i, p] of S.pages.entries()) {
    const el = document.createElement("div");
    el.className = "thumb" + (p.include ? "" : " excluded");
    const vp1 = p.page.getViewport({ scale: 1 });
    const scale = 70 / vp1.height;
    const vp = p.page.getViewport({ scale: scale * devicePixelRatio });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    c.style.width = Math.ceil(vp1.width * scale) + "px"; c.style.height = "70px";
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    el.appendChild(c);
    const num = document.createElement("span"); num.className = "num";
    num.textContent = (S.docs.length > 1 ? `${S.docs.indexOf(p.doc) + 1}·` : "") + p.num;
    el.appendChild(num);
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = p.include; cb.title = "Print this page";
    cb.onclick = (e) => { e.stopPropagation(); p.include = cb.checked; el.classList.toggle("excluded", !p.include); regenerate(); };
    el.appendChild(cb);
    el.onclick = () => selectPage(i);
    box.appendChild(el);
    renderQueued(p.page, { canvas: c, canvasContext: ctx, viewport: vp }).catch(() => {});
  }
}

function selectPage(i) {
  if (i < 0 || i >= S.pages.length) return;
  S.current = i;
  [...$("thumbs").children].forEach((el, j) => el.classList.toggle("active", j === i));
  drawPage();
}

let drawToken = 0;
async function drawPage() {
  const p = S.pages[S.current];
  if (!p) return;
  const stage = $("stage");
  const vp1 = p.page.getViewport({ scale: 1 });
  const availW = stage.clientWidth - 40, availH = stage.clientHeight - 40;
  if (availW <= 0 || availH <= 0) return;
  const scale = Math.min(availW / vp1.width, availH / vp1.height);
  const cssW = Math.floor(vp1.width * scale), cssH = Math.floor(vp1.height * scale);
  const key = `${S.loadId}|${S.current}|${cssW}|${cssH}`;
  const canvas = $("pageCanvas");
  canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
  $("pageWrap").style.width = cssW + "px"; $("pageWrap").style.height = cssH + "px";
  drawOverlay();
  if (canvas.dataset.key === key) return;
  const my = ++drawToken;
  const vp = p.page.getViewport({ scale: scale * devicePixelRatio });
  const off = document.createElement("canvas");
  off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
  const ctx = off.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, off.width, off.height);
  await renderQueued(p.page, { canvas: off, canvasContext: ctx, viewport: vp });
  if (my !== drawToken) return;
  canvas.width = off.width; canvas.height = off.height;
  canvas.getContext("2d").drawImage(off, 0, 0);
  canvas.dataset.key = key;
}

function drawOverlay() {
  const ov = $("overlay");
  ov.innerHTML = "";
  const p = S.pages[S.current];
  if (!p) return;
  const rects = p.include ? rectsForPage(p) : [];
  ov.classList.toggle("multi", rects.length > 1);
  ov.classList.toggle("dim", rects.length > 1 || !p.include);
  const firstIdx = S.pages.slice(0, S.current).filter((q) => q.include).reduce((n, q) => n + rectsForPage(q).length, 0);
  rects.forEach((r, i) => {
    const el = document.createElement("div");
    el.className = "crop";
    el.dataset.idx = i;
    setRectStyle(el, r);
    const tag = document.createElement("span"); tag.className = "tag";
    tag.textContent = `Label ${firstIdx + i + 1}`;
    el.appendChild(tag);
    for (const h of ["nw", "ne", "sw", "se"]) {
      const hd = document.createElement("div"); hd.className = "h " + h; hd.dataset.h = h; el.appendChild(hd);
    }
    ov.appendChild(el);
  });
}

function setRectStyle(el, r) {
  el.style.left = r[0] * 100 + "%"; el.style.top = r[1] * 100 + "%";
  el.style.width = r[2] * 100 + "%"; el.style.height = r[3] * 100 + "%";
}

function setupOverlayInteraction() {
  const ov = $("overlay");
  let drag = null;
  const norm = (e) => {
    const b = ov.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))];
  };
  ov.addEventListener("pointerdown", (e) => {
    const p = S.pages[S.current];
    if (!p) return;
    const [x, y] = norm(e);
    const cropEl = e.target.closest(".crop");
    const start = cropEl ? rectsForPage(p)[+cropEl.dataset.idx].slice() : null;
    if (e.target.dataset.h) drag = { kind: "resize", h: e.target.dataset.h, start, x, y, el: cropEl };
    else if (cropEl) drag = { kind: "move", start, x, y, el: cropEl };
    else {
      ov.innerHTML = "";
      const el = document.createElement("div"); el.className = "crop"; ov.appendChild(el);
      drag = { kind: "new", x, y, el, start: [x, y, 0, 0] };
    }
    ov.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  ov.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = norm(e);
    let r;
    if (drag.kind === "new") {
      r = [Math.min(x, drag.x), Math.min(y, drag.y), Math.abs(x - drag.x), Math.abs(y - drag.y)];
    } else if (drag.kind === "move") {
      const s = drag.start;
      r = [Math.min(1 - s[2], Math.max(0, s[0] + x - drag.x)), Math.min(1 - s[3], Math.max(0, s[1] + y - drag.y)), s[2], s[3]];
    } else {
      const s = drag.start;
      let x0 = s[0], y0 = s[1], x1 = s[0] + s[2], y1 = s[1] + s[3];
      if (drag.h.includes("w")) x0 = x; if (drag.h.includes("e")) x1 = x;
      if (drag.h.includes("n")) y0 = y; if (drag.h.includes("s")) y1 = y;
      r = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    }
    drag.rect = r;
    setRectStyle(drag.el, r);
  });
  const end = () => {
    if (!drag) return;
    const r = drag.rect;
    drag = null;
    if (!r || r[2] < 0.02 || r[3] < 0.02) { drawOverlay(); return; }
    ui().manualRect = r.map((v) => Math.round(v * 10000) / 10000);
    cropCfg().mode = "manual";
    $("cropMode").value = "manual";
    $("btnDelPreset").hidden = true;
    saveConfig(); drawOverlay(); regenerate();
  };
  ov.addEventListener("pointerup", end);
  ov.addEventListener("pointercancel", end);
}

// ---------------------------------------------------------------------------
// label rendering

function labelGeometry(ps) {
  const [wmm, hmm] = labelMM(ps);
  return { wmm, hmm, Wd: mmToDots(wmm, ps.dpi), Hd: mmToDots(hmm, ps.dpi) };
}

async function renderLabel(p, rectN, ps, crop) {
  const { Wd, Hd } = labelGeometry(ps);
  const dpi = ps.dpi;
  const base = p.page.getViewport({ scale: 1 });
  const rx = rectN[0] * base.width, ry = rectN[1] * base.height;
  const rw = rectN[2] * base.width, rh = rectN[3] * base.height;
  let rot;
  if (crop.rotation === "auto") rot = (rw > rh) !== (Wd > Hd) && Math.abs(rw - rh) > 2 && Wd !== Hd ? 90 : 0;
  else rot = Number(crop.rotation) || 0;
  const cw = rot % 180 ? rh : rw, ch = rot % 180 ? rw : rh;
  const m = mmToDots(Math.max(0, crop.margin || 0), dpi);
  const s = crop.fit === "actual" ? dpi / 72 : Math.max(0.01, Math.min((Wd - 2 * m) / cw, (Hd - 2 * m) / ch));
  const vp = p.page.getViewport({ scale: s, rotation: (p.page.rotate + rot) % 360 });
  const [x1, y1] = base.convertToPdfPoint(rx, ry);
  const [x2, y2] = base.convertToPdfPoint(rx + rw, ry + rh);
  const vr = [...vp.convertToViewportPoint(x1, y1), ...vp.convertToViewportPoint(x2, y2)];
  let vx = Math.min(vr[0], vr[2]), vy = Math.min(vr[1], vr[3]);
  let tw = Math.max(1, Math.round(Math.abs(vr[2] - vr[0]))), th = Math.max(1, Math.round(Math.abs(vr[3] - vr[1])));
  // never render more than fits on the label (matters for "actual size")
  if (tw > Wd) { vx += (tw - Wd) / 2; tw = Wd; }
  if (th > Hd) { vy += (th - Hd) / 2; th = Hd; }

  const tmp = document.createElement("canvas");
  tmp.width = tw; tmp.height = th;
  const tctx = tmp.getContext("2d");
  tctx.fillStyle = "#fff"; tctx.fillRect(0, 0, tw, th);
  await renderQueued(p.page, { canvas: tmp, canvasContext: tctx, viewport: vp, transform: [1, 0, 0, 1, -vx, -vy], intent: "print" });

  const lab = document.createElement("canvas");
  lab.width = Wd; lab.height = Hd;
  const lctx = lab.getContext("2d", { willReadFrequently: true });
  lctx.fillStyle = "#fff"; lctx.fillRect(0, 0, Wd, Hd);
  lctx.drawImage(tmp, Math.round((Wd - tw) / 2), Math.round((Hd - th) / 2));
  return canvasToMono(lab, ps);
}

function canvasToMono(canvas, ps) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const luma = toLuma(img.data, canvas.width, canvas.height);
  let mono = toMono(luma, canvas.width, canvas.height, { mode: ps.mono, threshold: ps.threshold ?? 150 });
  mono = monoTransform(mono, {
    flip: !!ps.flip,
    dx: mmToDots(Number(ps.offX) || 0, ps.dpi),
    dy: mmToDots(Number(ps.offY) || 0, ps.dpi),
  });
  return mono;
}

let regenTimer = 0;
function regenerate(immediate = false) {
  clearTimeout(regenTimer);
  return new Promise((resolve) => {
    regenTimer = setTimeout(async () => { await doRegenerate(); resolve(); }, immediate ? 0 : 120);
  });
}

async function doRegenerate() {
  const gen = ++S.gen;
  drawOverlay();
  const ps = { ...pset() };
  const crop = { ...cropCfg() };
  const out = [];
  for (const [pi, p] of S.pages.entries()) {
    if (!p.include) continue;
    await analysePage(p);
    const rects = rectsForPage(p);
    for (const r of rects) {
      if (gen !== S.gen) return;
      try {
        const mono = await renderLabel(p, r, ps, crop);
        out.push({ pageIdx: pi, rect: r, mono });
      } catch (e) {
        console.error(e);
        toast("Render error: " + e.message, true);
      }
    }
  }
  if (gen !== S.gen) return;
  S.labels = out;
  S.labelPset = ps;
  showPreviews();
  if (S.autoPrintPending) {
    S.autoPrintPending = false;
    if (S.labels.length) printLabels(true);
  }
}

function monoToCanvas(m) {
  const c = document.createElement("canvas");
  c.width = m.w; c.height = m.h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(m.w, m.h);
  const d = img.data;
  for (let y = 0, i = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++, i += 4) {
      const v = monoGet(m, x, y) ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function showPreviews() {
  const box = $("previews");
  box.innerHTML = "";
  const n = S.labels.length;
  $("labelCount").textContent = n ? `${n} label${n > 1 ? "s" : ""}` : "";
  $("btnPrint").disabled = n === 0;
  $("btnPrint").textContent = n > 1 ? `Print ${n} labels` : "Print";
  if (!n) {
    box.innerHTML = `<p class="muted center">${S.pages.length ? "No pages selected." : "The printed result appears here."}</p>`;
    return;
  }
  const ps = S.labelPset;
  const { wmm, hmm } = labelGeometry(ps);
  const maxW = box.clientWidth - 30;
  S.labels.forEach((l, i) => {
    const wrap = document.createElement("div"); wrap.className = "preview";
    const c = monoToCanvas(l.mono);
    const w = Math.min(maxW, 260);
    c.style.width = w + "px"; c.style.height = Math.round((w * l.mono.h) / l.mono.w) + "px";
    c.title = "Click to show the page";
    c.onclick = () => selectPage(l.pageIdx);
    wrap.appendChild(c);
    const cap = document.createElement("div"); cap.className = "cap";
    const p = S.pages[l.pageIdx];
    const ratio = monoBlackRatio(l.mono);
    cap.textContent = `Label ${i + 1} · page ${p.num} · ${fmt(wmm)}×${fmt(hmm)} mm @ ${ps.dpi} dpi`;
    if (ratio < 0.003) { wrap.classList.add("warn"); cap.textContent += " · looks empty"; }
    if (ratio > 0.6) { wrap.classList.add("warn"); cap.textContent += " · very dark – check threshold"; }
    wrap.appendChild(cap);
    box.appendChild(wrap);
  });
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();

// ---------------------------------------------------------------------------
// printing

function printOpts(ps, copies) {
  const { wmm, hmm } = labelGeometry(ps);
  return {
    dpi: ps.dpi, copies, darkness: ps.darkness, speed: ps.speed, media: ps.media, gapMM: ps.gapMM,
    widthMM: wmm, heightMM: hmm, compress: !ps.zplRaw,
  };
}

async function sendMonos(monos, ps, copies, docName) {
  const key = printerKey();
  if (ps.lang === "driver") {
    const pages = monos.map((m) => monoToCanvas(m).toDataURL("image/png"));
    const { wmm, hmm } = labelGeometry(ps);
    await api("/api/print/driver", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printer: key, docName, pages, copies, widthMM: wmm, heightMM: hmm, scale: "fit" }),
    });
    return;
  }
  const data = encodeLabels(ps.lang, monos, printOpts(ps, copies));
  await sendRaw(data, docName);
}

async function sendRaw(data, docName) {
  const key = printerKey();
  if (key === NET) {
    const host = (ui().netHost || "").trim();
    if (!host) throw new Error("Enter the printer's IP address first");
    await api("/api/print/tcp?host=" + encodeURIComponent(host), { method: "POST", body: data });
  } else {
    await api(`/api/print/raw?printer=${encodeURIComponent(key)}&doc=${encodeURIComponent(docName)}`, { method: "POST", body: data });
  }
}

async function printLabels(auto = false) {
  if (S.printing || !S.labels.length) return;
  const total = S.labels.length * Math.max(1, Number($("copies").value) || 1);
  const limit = Number(prefs().confirmOver) || 0;
  if (!auto && limit > 0 && total > limit && !confirm(`Print ${total} labels?`)) return;
  S.printing = true;
  let ok = false;
  const st = $("printStatus");
  st.className = "status"; st.textContent = "Printing…";
  $("btnPrint").disabled = true;
  try {
    const ps = S.labelPset;
    const copies = Math.max(1, Number($("copies").value) || 1);
    const name = S.docs.map((d) => d.name).join(", ") || "label";
    await sendMonos(S.labels.map((l) => l.mono), ps, copies, name);
    const n = S.labels.length * copies;
    st.className = "status ok";
    st.textContent = `✓ Sent ${n} label${n > 1 ? "s" : ""} to ${printerKey() === NET ? ui().netHost : printerKey()} – ${new Date().toLocaleTimeString()}`;
    ok = true;
    if (auto && prefs().notify) notify("Label printed", `${S.autoJobName || name} → ${printerKey() === NET ? ui().netHost : printerKey()}`);
  } catch (e) {
    if (auto && prefs().notify) notify("Label NOT printed", e.message);
    st.className = "status err"; st.textContent = "Print failed: " + e.message;
    toast("Print failed: " + e.message, true);
  } finally {
    S.printing = false;
    $("btnPrint").disabled = S.labels.length === 0;
  }
  if (ok) afterPrint();
}

function afterPrint() {
  const a = prefs().afterPrint;
  if (a === "clear") clearDocument();
  else if (a === "close") setTimeout(() => window.close(), 900);
}

function clearDocument() {
  for (const d of S.docs) { try { d.task.destroy(); } catch { /* ignore */ } }
  S.docs = []; S.pages = []; S.labels = []; S.current = 0;
  $("docName").textContent = "No file loaded";
  $("dropHint").hidden = false; $("pageWrap").hidden = true;
  $("thumbs").innerHTML = ""; $("pageCanvas").dataset.key = "";
  showPreviews();
}

function notify(title, body) {
  try {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") new Notification(title, { body, icon: "icon.svg" });
    else if (Notification.permission !== "denied") Notification.requestPermission();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// settings dialog

function openSettings(tab = "general") {
  applyHotFolderToForm();
  const p = prefs();
  const dc = $("prefDefaultCrop");
  dc.length = 1;
  for (const c of CROP_PRESETS) dc.add(new Option(c.name, c.id));
  (ui().presets || []).forEach((pr, i) => dc.add(new Option("★ " + pr.name, "preset:" + i)));
  dc.value = [...dc.options].some((o) => o.value === p.defaultCrop) ? p.defaultCrop : "";
  $("prefTheme").value = p.theme;
  $("prefPad").value = p.padMM;
  $("prefSkipEmpty").checked = p.skipEmpty;
  $("prefAfterPrint").value = p.afterPrint;
  $("prefConfirm").value = p.confirmOver;
  $("prefNotify").checked = p.notify;
  $("prefOpenWithPrint").checked = p.openWithPrint;
  api("/api/shell").then((r) => ($("shellInt").checked = r.enabled)).catch(() => {});
  showTab(tab);
  if (!$("settingsDlg").open) $("settingsDlg").showModal();
}

function showTab(tab) {
  for (const b of $("setTabs").querySelectorAll("button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const sec of document.querySelectorAll("[data-panel]")) sec.hidden = sec.dataset.panel !== tab;
}

function bindPrefs() {
  const set = (k, v, after) => { prefs()[k] = v; saveConfig(); after?.(); };
  $("prefTheme").onchange = () => set("theme", $("prefTheme").value, applyTheme);
  $("prefDefaultCrop").onchange = () => set("defaultCrop", $("prefDefaultCrop").value);
  $("prefPad").onchange = () => set("padMM", Math.max(0, Number($("prefPad").value) || 0), () => { S.pages.forEach((p) => (p.analysis = null)); regenerate(); });
  $("prefSkipEmpty").onchange = () => set("skipEmpty", $("prefSkipEmpty").checked);
  $("prefAfterPrint").onchange = () => set("afterPrint", $("prefAfterPrint").value);
  $("prefConfirm").onchange = () => set("confirmOver", Math.max(0, Number($("prefConfirm").value) || 0));
  $("prefNotify").onchange = () => {
    set("notify", $("prefNotify").checked);
    if ($("prefNotify").checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission();
  };
  $("prefOpenWithPrint").onchange = () => set("openWithPrint", $("prefOpenWithPrint").checked);

  $("btnExportCfg").onclick = () => {
    const blob = new Blob([JSON.stringify({ app: "LabelPrint", ...S.cfg }, null, 2)], { type: "application/json" });
    download(blob, "LabelPrint-settings.json");
  };
  $("btnImportCfg").onclick = () => $("importInput").click();
  $("importInput").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try {
      const c = JSON.parse(await f.text());
      if (!c || typeof c !== "object" || !("ui" in c)) throw new Error("this is not a LabelPrint settings file");
      await writeConfigNow({ hotFolder: c.hotFolder || {}, ui: c.ui || {} });
      location.reload();
    } catch (err) { toast("Import failed: " + err.message, true); }
  };
  $("btnResetCfg").onclick = async () => {
    if (!confirm("Reset all LabelPrint settings, printers and crop presets?")) return;
    await writeConfigNow({ hotFolder: { enabled: false, path: "", filter: "", autoPrint: false }, ui: {} });
    location.reload();
  };
}

async function writeConfigNow(cfg) {
  clearTimeout(saveTimer);
  await api("/api/config", { method: "POST", body: JSON.stringify(cfg), headers: { "Content-Type": "application/json" } });
}

function updateHotChip() {
  const hf = S.cfg.hotFolder || {};
  const chip = $("hotChip");
  chip.hidden = !(hf.enabled && hf.path);
  if (!chip.hidden) {
    const folder = hf.path.split(/[\\/]/).filter(Boolean).pop() || hf.path;
    chip.textContent = (hf.autoPrint ? "Auto-printing from " : "Watching ") + folder;
    chip.title = hf.path + " – click to change";
  }
}

function makeTestLabel(ps) {
  const { wmm, hmm, Wd, Hd } = labelGeometry(ps);
  const c = document.createElement("canvas");
  c.width = Wd; c.height = Hd;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, Wd, Hd);
  ctx.strokeStyle = "#000"; ctx.fillStyle = "#000";
  const dpmm = ps.dpi / 25.4;
  ctx.lineWidth = Math.max(2, Math.round(dpmm * 0.4));
  ctx.strokeRect(dpmm * 2, dpmm * 2, Wd - dpmm * 4, Hd - dpmm * 4);
  // mm ruler along top and left
  ctx.lineWidth = 1;
  for (let mm = 0; mm <= wmm; mm += 1) {
    const x = Math.round(mm * dpmm) + 0.5, len = mm % 10 === 0 ? 4 : mm % 5 === 0 ? 2.5 : 1.2;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, len * dpmm); ctx.stroke();
  }
  for (let mm = 0; mm <= hmm; mm += 1) {
    const y = Math.round(mm * dpmm) + 0.5, len = mm % 10 === 0 ? 4 : mm % 5 === 0 ? 2.5 : 1.2;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(len * dpmm, y); ctx.stroke();
  }
  const fs = Math.round(Math.min(Wd, Hd) / 10);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `bold ${fs}px Segoe UI, Arial, sans-serif`;
  ctx.fillText("LabelPrint", Wd / 2, Hd * 0.32);
  ctx.font = `${Math.round(fs * 0.45)}px Segoe UI, Arial, sans-serif`;
  ctx.fillText(`${fmt(wmm)} × ${fmt(hmm)} mm  ·  ${ps.dpi} dpi  ·  ${ps.lang.toUpperCase()}`, Wd / 2, Hd * 0.45);
  ctx.fillText("The border should be 2 mm from every edge", Wd / 2, Hd * 0.52);
  // fake barcode (alternating bar widths) to check sharpness
  let x = Wd * 0.15; const y0 = Hd * 0.6, bh = Hd * 0.18;
  let k = 1;
  while (x < Wd * 0.85) {
    const bw = Math.round(((k * 7) % 4 + 1) * Math.max(1, Math.round(dpmm / 4)));
    if (k % 2) ctx.fillRect(Math.round(x), y0, bw, bh);
    x += bw; k++;
  }
  ctx.beginPath(); ctx.arc(Wd / 2, Hd * 0.88, Math.min(Wd, Hd) * 0.04, 0, Math.PI * 2); ctx.fill();
  return c;
}

async function printTestLabel() {
  const ps = { ...pset() };
  try {
    const mono = canvasToMono(makeTestLabel(ps), { ...ps, mono: "threshold", threshold: 128 });
    await sendMonos([mono], ps, 1, "LabelPrint test label");
    toast("Test label sent");
  } catch (e) { toast("Test print failed: " + e.message, true); }
}

async function calibrate() {
  const ps = pset();
  const cmd = calibrateCommand(ps.lang);
  if (!cmd) { toast("Calibrate from the printer driver for this printer", true); return; }
  try { await sendRaw(cmd, "LabelPrint calibrate"); toast("Calibration command sent – the printer feeds a few labels"); }
  catch (e) { toast("Calibration failed: " + e.message, true); }
}

// ---------------------------------------------------------------------------
// export

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const baseName = () => (S.docs[0]?.name || "label").replace(/\.pdf$/i, "");

function exportPNG() {
  if (!S.labels.length) return;
  S.labels.forEach((l, i) => {
    monoToCanvas(l.mono).toBlob((b) => download(b, `${baseName()}_label${S.labels.length > 1 ? i + 1 : ""}.png`), "image/png");
  });
}

function exportPRN() {
  if (!S.labels.length) return;
  const ps = S.labelPset;
  const lang = ps.lang === "driver" ? "zpl" : ps.lang;
  const data = encodeLabels(lang, S.labels.map((l) => l.mono), printOpts(ps, Math.max(1, Number($("copies").value) || 1)));
  download(new Blob([data], { type: "application/octet-stream" }), `${baseName()}.${lang === "zpl" ? "zpl" : "prn"}`);
}

// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : ""); t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

// test hooks (used by automated tests only)
window.__lp = { S, loadFiles, regenerate, printLabels, rectsForPage, encodeLabels };

init();
