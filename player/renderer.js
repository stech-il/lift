const STORAGE = {
  baseUrl: "pirsum_base_url",
  token: "pirsum_token",
  orientation: "pirsum_orientation",
  exitPassword: "pirsum_exit_password",
};

const DEFAULT_EXIT_PASSWORD = "12345";

function isLocalHttpHost(hostname) {
  return /^(localhost|127\.0\.0\.1)$/i.test(hostname);
}

/** פרודקשן: HTTPS + WSS. מקומי: רק localhost יכול להישאר ב־http */
function normalizePlayerBaseUrl(raw) {
  let s = String(raw || "").trim().replace(/\/$/, "");
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) {
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol === "http:" && !isLocalHttpHost(u.hostname)) {
      u.protocol = "https:";
    }
    return u.origin;
  } catch {
    return s;
  }
}

function getExpectedExitPassword() {
  const v = localStorage.getItem(STORAGE.exitPassword);
  return v != null && String(v).length > 0 ? String(v) : DEFAULT_EXIT_PASSWORD;
}

function cacheExitPasswordFromConfig(config) {
  if (config && config.exit_password != null && String(config.exit_password).length > 0) {
    localStorage.setItem(STORAGE.exitPassword, String(config.exit_password));
  }
}

function clampNum(n, min, max, fallback) {
  const x = Number(n);
  if (Number.isNaN(x)) return fallback;
  return Math.max(min, Math.min(max, x));
}

let lastTickerConfig = null;
let tickerLayoutTimer = null;

/** גובה מקטע אחד בפיקסלים — בלי gap בין שני ה-chunks, המרחק ללופ חייב להיות בדיוק h ולא 50% מהכול. */
function measureSideTickerLoopPx() {
  const sideEl = document.getElementById("sideTicker");
  if (!sideEl) return 0;
  const first = sideEl.querySelector(".side-chunk");
  if (!first) return 0;
  const h = first.offsetHeight;
  if (h > 0) {
    sideEl.style.setProperty("--side-loop-px", `${Math.round(h * 1000) / 1000}px`);
  }
  return h;
}

function layoutTickerAnimations(config) {
  lastTickerConfig = config || lastTickerConfig;
  const cfg = lastTickerConfig;
  const rssSec = clampNum(cfg?.rss_track_duration_sec, 15, 600, 48);
  const sideSec = clampNum(cfg?.side_ticker_duration_sec, 20, 900, 150);

  const sideEl = document.getElementById("sideTicker");
  const rssTrack = document.getElementById("rssTrack");

  const applySideAnim = () => {
    if (!sideEl) return;
    const h = measureSideTickerLoopPx();
    if (h < 1) {
      sideEl.style.animation = "none";
      return;
    }
    sideEl.style.animation = `sideScrollSeamless ${sideSec}s linear infinite`;
    sideEl.style.animationFillMode = "none";
  };

  applySideAnim();
  requestAnimationFrame(() => {
    measureSideTickerLoopPx();
    requestAnimationFrame(applySideAnim);
  });

  if (rssTrack) {
    rssTrack.style.animation = `rssScrollSeamlessLtr ${rssSec}s linear infinite`;
    rssTrack.style.animationFillMode = "none";
  }
}

function scheduleTickerLayout() {
  clearTimeout(tickerLayoutTimer);
  tickerLayoutTimer = setTimeout(() => layoutTickerAnimations(null), 120);
}

function applyOrientation() {
  const v = localStorage.getItem(STORAGE.orientation) || "landscape";
  document.documentElement.classList.toggle("player-orientation-portrait", v === "portrait");
}

const DB_NAME = "pirsum_cache_v1";
const DB_VER = 2;
const IMAGE_SLIDE_MS = 8000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv");
      }
      if (ev.oldVersion < 2 && ev.target.transaction) {
        const st = ev.target.transaction.objectStore("kv");
        try {
          st.delete("media_blob");
          st.delete("media_type");
        } catch {
          /* ignore */
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readonly");
    const st = tx.objectStore("kv");
    const r = st.get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbSet(db, key, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const st = tx.objectStore("kv");
    const r = st.put(val, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

async function idbDel(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    const st = tx.objectStore("kv");
    const r = st.delete(key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** שורות אנכיות; שני מקטעים זהים ללופ חלק. חוזרים על השורות אם יש מעט מדי — כדי שלא ייראו שתי עותקים בו-זמנית בחלון. */
function buildSideTickerHtml(text) {
  const raw = text.trim() || "אין עדכונים — ניתן לערוך בלוח הבקרה";
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let blocks = lines.length ? lines : [raw];
  if (blocks.length < 6) {
    const seed = blocks.slice();
    while (blocks.length < 6) blocks.push(...seed);
  }
  const inner = blocks
    .map((line) => `<div class="side-line">${escapeHtml(line)}</div>`)
    .join("");
  const chunk = `<div class="side-chunk">${inner}</div>`;
  return chunk + chunk;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

/** WebView ישנים ללא AbortSignal.timeout — נמנעים מכשל שקט ב-fetch מדיה/הגדרות */
function abortSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchJson(url, opts = {}) {
  const { signal, ...rest } = opts;
  const res = await fetch(url, { ...rest, signal: signal ?? abortSignal(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** מזג אוויר דרך השרת (אותו מקור כמו שאר ה־API — תואם CSP ו־WebView) */
async function fetchWeatherFromServer(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/player/weather`, {
    headers: authHeaders(token),
    signal: abortSignal(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let dbPromise;
const blobUrls = new Set();
let playlistItems = [];
let playlistIndex = 0;
let imageSlideTimer = null;
let lastPlaylistSig = "";

let wsRef = null;
let wsReconnectTimer = null;
let wsBackoffMs = 2000;

function wsUrlFromHttp(baseUrl, token) {
  const trimmed = baseUrl.replace(/\/$/, "");
  const wsBase = trimmed.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}


async function sendPing() {
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const token = localStorage.getItem(STORAGE.token);
  if (!baseUrl || !token || !navigator.onLine) return;
  try {
    await fetch(`${baseUrl}/api/player/ping`, {
      method: "POST",
      headers: authHeaders(token),
      signal: abortSignal(15000),
    });
  } catch {
    /* ignore */
  }
}

function disconnectWs() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (wsRef) {
    try {
      wsRef.onclose = null;
      wsRef.onmessage = null;
      wsRef.onerror = null;
      wsRef.close();
    } catch {
      /* ignore */
    }
    wsRef = null;
  }
}

function connectWs() {
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const token = localStorage.getItem(STORAGE.token);
  disconnectWs();
  if (!baseUrl || !token) return;

  let url;
  try {
    url = wsUrlFromHttp(baseUrl, token);
  } catch {
    return;
  }

  wsBackoffMs = 2000;

  try {
    wsRef = new WebSocket(url);
  } catch (e) {
    console.warn("WebSocket failed", e);
    scheduleWsReconnect();
    return;
  }

  wsRef.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "refresh") {
        syncOnce().catch(() => {});
      }
    } catch {
      /* ignore */
    }
  };

  wsRef.onopen = () => {
    wsBackoffMs = 2000;
    sendPing().catch(() => {});
  };

  wsRef.onerror = () => {};

  wsRef.onclose = () => {
    wsRef = null;
    scheduleWsReconnect();
  };
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const token = localStorage.getItem(STORAGE.token);
  if (!baseUrl || !token) return;
  if (!navigator.onLine) return;

  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsBackoffMs = Math.min(wsBackoffMs * 1.5, 30000);
    connectWs();
  }, wsBackoffMs);
}

function revokeAllBlobUrls() {
  for (const u of blobUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
  blobUrls.clear();
}

function clearImageSlide() {
  if (imageSlideTimer) {
    clearTimeout(imageSlideTimer);
    imageSlideTimer = null;
  }
}

function playlistSignature(items) {
  return (items || []).map((x) => x.id + ":" + x.media_type).join("|");
}

/** אם השרת מאחורי פרוקסי החזיר host/protocol שגויים — מיישרים לכתובת הנגן מההגדרות */
function alignMediaUrlToPlayerBase(mediaUrl, baseUrl) {
  if (!baseUrl || !mediaUrl) return mediaUrl;
  try {
    const m = new URL(mediaUrl);
    const b = new URL(baseUrl);
    if (m.origin === b.origin) return mediaUrl;
    return `${b.origin}${m.pathname}${m.search}`;
  } catch {
    return mediaUrl;
  }
}

async function syncLogoBlob(db, config, token) {
  if (!config) return;
  const sig = `${config.logo_url || ""}|${config.updated_at || ""}`;
  const prev = await idbGet(db, "logo_sig");
  if (sig === prev) return;

  if (!config.logo_url) {
    await idbDel(db, "logo_blob");
    await idbDel(db, "logo_sig");
    return;
  }
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const logoUrl = alignMediaUrlToPlayerBase(config.logo_url, baseUrl);
  try {
    const res = await fetch(logoUrl, {
      headers: authHeaders(token),
      signal: abortSignal(60000),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    await idbSet(db, "logo_blob", blob);
    await idbSet(db, "logo_sig", sig);
  } catch {
    /* keep previous cached logo */
  }
}

async function syncMediaBlobs(db, items, token) {
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const prevKeys = (await idbGet(db, "media_keys")) || [];
  const nextIds = (items || []).map((i) => i.id);
  for (const id of prevKeys) {
    if (!nextIds.includes(id)) {
      await idbDel(db, "m_" + id);
    }
  }
  await idbSet(db, "media_keys", nextIds);

  for (const it of items || []) {
    const key = "m_" + it.id;
    const existing = await idbGet(db, key);
    if (existing) continue;
    try {
      const mediaUrl = alignMediaUrlToPlayerBase(it.media_url, baseUrl);
      const res = await fetch(mediaUrl, {
        headers: authHeaders(token),
        signal: abortSignal(120000),
      });
      if (!res.ok) continue;
      const blob = await res.blob();
      await idbSet(db, key, blob);
    } catch {
      /* skip item */
    }
  }
}

function padTickerText(s) {
  const t = (s || "").trim() || "—";
  let out = t;
  let guard = 0;
  while (out.length < 160 && guard++ < 28) {
    out += "   •   " + t;
  }
  return out;
}

/** גודלי טקסט ולוגו ומדיה — משתני CSS על #display (מגדירים בממשק הניהול). */
function applyPlayerTypography(config) {
  const disp = document.getElementById("display");
  if (!disp) return;
  const c = config || {};
  const px = (key, min, max, def) => `${clampNum(c[key], min, max, def)}px`;
  disp.style.setProperty("--font-clock-time", px("font_clock_time_px", 14, 72, 24));
  disp.style.setProperty("--font-clock-date", px("font_clock_date_px", 10, 42, 14));
  disp.style.setProperty("--font-weather", px("font_weather_px", 10, 42, 16));
  disp.style.setProperty("--font-brand", px("font_brand_px", 12, 56, 20));
  disp.style.setProperty("--logo-max-h", px("logo_max_height_px", 24, 120, 48));
  disp.style.setProperty("--font-side", px("font_side_ticker_px", 8, 36, 14));
  disp.style.setProperty("--font-rss", px("font_rss_px", 8, 36, 15));
  const ms = clampNum(c.media_scale_percent, 50, 150, 100) / 100;
  disp.style.setProperty("--media-scale", String(ms));
}

/** כותרת קבועה לפני פס הכותרות (למשל חדשות YNET כשה-RSS מ־ynet). */
function rssHeadingLabelFromConfig(config) {
  const url = (config?.rss_url || "").trim().toLowerCase();
  if (url.includes("ynet")) return "חדשות YNET";
  if (url) {
    try {
      const normalized = url.startsWith("http") ? url : "https://" + url;
      const u = new URL(normalized);
      const host = u.hostname.replace(/^www\./, "");
      const first = host.split(".")[0];
      if (first && first.length > 1) {
        return "חדשות " + first.charAt(0).toUpperCase() + first.slice(1);
      }
    } catch {
      /* ignore */
    }
  }
  return "חדשות";
}

async function syncOnce() {
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const token = localStorage.getItem(STORAGE.token);
  if (!baseUrl || !token) return;

  dbPromise = dbPromise || openDb();
  const db = await dbPromise;

  const online = navigator.onLine;

  try {
    if (online) {
      const config = await fetchJson(`${baseUrl}/api/player/config`, {
        headers: authHeaders(token),
      });
      cacheExitPasswordFromConfig(config);
      await idbSet(db, "config", config);
      sendPing().catch(() => {});

      const manualRss = (config.rss_ticker_text || "").trim();
      let rssItems = [];
      if (manualRss) {
        await idbSet(db, "rss_items", []);
      } else {
        try {
          const rss = await fetchJson(`${baseUrl}/api/player/rss`, {
            headers: authHeaders(token),
          });
          rssItems = rss.items || [];
        } catch {
          rssItems = (await idbGet(db, "rss_items")) || [];
        }
        await idbSet(db, "rss_items", rssItems);
      }

      const mediaItems = config.media_items || [];
      await syncMediaBlobs(db, mediaItems, token);
      await syncLogoBlob(db, config, token);

      try {
        const w = await fetchWeatherFromServer(baseUrl, token);
        const tempStr = w.temp != null && String(w.temp).trim() !== "" ? String(w.temp) : null;
        const store = { temp: tempStr, city: w.city || "", at: w.at || Date.now() };
        await idbSet(db, "weather", store);
        localStorage.setItem("pirsum_weather_cache", JSON.stringify(store));
      } catch {
        /* keep old */
      }
    }
  } catch (e) {
    console.warn("sync failed", e);
  }

  await renderFromCache();
}

async function renderFromCache() {
  dbPromise = dbPromise || openDb();
  const db = await dbPromise;

  const config = (await idbGet(db, "config")) || null;
  if (config) cacheExitPasswordFromConfig(config);
  applyPlayerTypography(config);
  const rssItems = (await idbGet(db, "rss_items")) || [];
  let weather = await idbGet(db, "weather");
  if (!weather) {
    try {
      weather = JSON.parse(localStorage.getItem("pirsum_weather_cache") || "null");
    } catch {
      weather = null;
    }
  }

  const imgEl = document.getElementById("mediaImage");
  const vidEl = document.getElementById("mediaVideo");
  const phEl = document.getElementById("mediaPlaceholder");

  const brandImg = document.getElementById("brandLogo");
  const brandText = document.getElementById("elevName");
  const logoBlob = await idbGet(db, "logo_blob");
  if (brandImg && brandText) {
    if (logoBlob) {
      if (brandImg._blobUrl) {
        try {
          URL.revokeObjectURL(brandImg._blobUrl);
        } catch {
          /* ignore */
        }
      }
      const u = URL.createObjectURL(logoBlob);
      brandImg._blobUrl = u;
      brandImg.src = u;
      brandImg.alt = config?.name || "";
      brandImg.removeAttribute("width");
      brandImg.removeAttribute("height");
      brandImg.classList.remove("hidden");
      brandText.classList.add("hidden");
    } else {
      if (brandImg._blobUrl) {
        try {
          URL.revokeObjectURL(brandImg._blobUrl);
        } catch {
          /* ignore */
        }
        brandImg._blobUrl = null;
      }
      brandImg.removeAttribute("src");
      brandImg.classList.add("hidden");
      brandText.classList.remove("hidden");
      brandText.textContent = config?.name || "—";
    }
  }

  const wText =
    weather?.temp && String(weather.temp).trim() !== "" && weather.temp !== "—"
      ? `${weather.city ? weather.city + " · " : ""}${weather.temp}`
      : "—";
  document.getElementById("weatherText").textContent = wText;

  const side = config?.side_ticker_text || "";
  const sideText = side.trim() || "אין עדכונים — ניתן לערוך בלוח הבקרה";
  const sideTickerEl = document.getElementById("sideTicker");
  if (sideTickerEl) sideTickerEl.innerHTML = buildSideTickerHtml(sideText);

  const sideHeadingEl = document.getElementById("sideTickerHeading");
  if (sideHeadingEl) sideHeadingEl.textContent = "עדכונים";

  const manualRss = (config?.rss_ticker_text || "").trim();
  let rssBase;
  if (manualRss) {
    const lines = manualRss.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    rssBase = lines.length ? lines.join("   •   ") : "—";
  } else {
    rssBase =
      rssItems.length > 0
        ? rssItems.map((i) => i.title).join("   •   ")
        : "אין חדשות — הגדר כותרות בניהול או כתובת RSS";
  }
  const rssText = padTickerText(rssBase) + "   •   ";

  const rssHeadingEl = document.getElementById("rssHeading");
  if (rssHeadingEl) rssHeadingEl.textContent = rssHeadingLabelFromConfig(config);

  const track = document.getElementById("rssTrack");
  track.innerHTML = "";
  const inner1 = document.createElement("div");
  inner1.className = "rss-inner";
  inner1.textContent = rssText;
  const inner2 = inner1.cloneNode(true);
  track.appendChild(inner1);
  track.appendChild(inner2);

  lastTickerConfig = config;
  layoutTickerAnimations(config);

  await playPlaylistFromCache(db, imgEl, vidEl, phEl);
}

async function playPlaylistFromCache(db, imgEl, vidEl, phEl) {
  const config = (await idbGet(db, "config")) || null;
  const items = config?.media_items || [];

  const resolved = [];
  for (const it of items) {
    const b = await idbGet(db, "m_" + it.id);
    if (b) resolved.push({ id: it.id, media_type: it.media_type, blob: b });
  }

  if (!resolved.length) {
    clearImageSlide();
    revokeAllBlobUrls();
    vidEl.onended = null;
    vidEl.loop = false;
    vidEl.pause();
    vidEl.removeAttribute("src");
    imgEl.removeAttribute("src");
    imgEl.classList.add("hidden");
    vidEl.classList.add("hidden");
    phEl.classList.remove("hidden");
    playlistItems = [];
    lastPlaylistSig = "";
    return;
  }

  const sig = playlistSignature(resolved);
  if (sig !== lastPlaylistSig) {
    lastPlaylistSig = sig;
    playlistIndex = 0;
  }
  playlistItems = resolved;
  showPlaylistSlide(db, imgEl, vidEl, phEl);
}

function advancePlaylist(db, imgEl, vidEl, phEl) {
  if (!playlistItems.length) return;
  playlistIndex = (playlistIndex + 1) % playlistItems.length;
  showPlaylistSlide(db, imgEl, vidEl, phEl);
}

function showPlaylistSlide(db, imgEl, vidEl, phEl) {
  clearImageSlide();
  const item = playlistItems[playlistIndex];
  if (!item) return;

  phEl.classList.add("hidden");
  revokeAllBlobUrls();
  const url = URL.createObjectURL(item.blob);
  blobUrls.add(url);

  const n = playlistItems.length;
  vidEl.onended = null;

  if (item.media_type === "video") {
    imgEl.classList.add("hidden");
    vidEl.classList.remove("hidden");
    vidEl.src = url;
    vidEl.loop = n === 1;
    vidEl.onended = () => {
      if (n <= 1) return;
      advancePlaylist(db, imgEl, vidEl, phEl);
    };
    vidEl.play().catch(() => {});
  } else {
    vidEl.pause();
    vidEl.removeAttribute("src");
    vidEl.classList.add("hidden");
    vidEl.loop = false;
    imgEl.classList.remove("hidden");
    imgEl.src = url;
    if (n > 1) {
      imageSlideTimer = setTimeout(() => {
        advancePlaylist(db, imgEl, vidEl, phEl);
      }, IMAGE_SLIDE_MS);
    }
  }
}

function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = now.toLocaleDateString("he-IL", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  document.getElementById("clockTime").textContent = time;
  document.getElementById("clockDate").textContent = date;
}

async function refreshLocalDataSection() {
  const sec = document.getElementById("localDataSection");
  const inp = document.getElementById("localDataPath");
  if (!sec || !inp) return;
  if (!window.pirsumEnv?.getPaths) {
    sec.classList.add("hidden");
    return;
  }
  sec.classList.remove("hidden");
  try {
    const { userData } = await window.pirsumEnv.getPaths();
    inp.value = userData || "";
  } catch {
    inp.value = "";
  }
}

function showSettings(show) {
  document.getElementById("settings").classList.toggle("hidden", !show);
  document.getElementById("display").classList.toggle("hidden", show);
  const fab = document.getElementById("fabSettings");
  if (fab) fab.classList.toggle("hidden", show);
  if (show) refreshLocalDataSection();
}

function initUi() {
  const storedUrl = localStorage.getItem(STORAGE.baseUrl) || "";
  if (storedUrl) {
    const n = normalizePlayerBaseUrl(storedUrl);
    if (n && n !== storedUrl) {
      localStorage.setItem(STORAGE.baseUrl, n);
    }
    document.getElementById("baseUrl").value = n || storedUrl;
  } else {
    document.getElementById("baseUrl").value = "";
  }
  document.getElementById("token").value = localStorage.getItem(STORAGE.token) || "";
  const orient = localStorage.getItem(STORAGE.orientation) || "landscape";
  document.getElementById("orientation").value = orient === "portrait" ? "portrait" : "landscape";
  applyOrientation();

  document.getElementById("orientation").addEventListener("change", () => {
    const v = document.getElementById("orientation").value;
    localStorage.setItem(STORAGE.orientation, v === "portrait" ? "portrait" : "landscape");
    applyOrientation();
    scheduleTickerLayout();
  });

  document.getElementById("btnOpenLocalDataFolder").onclick = async () => {
    const msg = document.getElementById("settingsMsg");
    if (!window.pirsumEnv?.openUserDataFolder) return;
    msg.textContent = "";
    try {
      const r = await window.pirsumEnv.openUserDataFolder();
      if (r?.error) msg.textContent = r.error;
    } catch (e) {
      msg.textContent = String(e.message || e);
    }
  };

  document.getElementById("btnCopyLocalDataPath").onclick = async () => {
    const p = document.getElementById("localDataPath")?.value;
    const msg = document.getElementById("settingsMsg");
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
      msg.textContent = "הנתיב הועתק ללוח";
      setTimeout(() => {
        msg.textContent = "";
      }, 2200);
    } catch {
      msg.textContent = "העתק ידנית מהשדה למעלה";
    }
  };

  document.getElementById("btnSaveSettings").onclick = () => {
    const baseUrl = normalizePlayerBaseUrl(document.getElementById("baseUrl").value);
    const token = document.getElementById("token").value.trim();
    const orientVal = document.getElementById("orientation").value;
    const msg = document.getElementById("settingsMsg");
    if (!baseUrl || !token) {
      msg.textContent = "נא למלא שרת וטוקן";
      return;
    }
    document.getElementById("baseUrl").value = baseUrl;
    localStorage.setItem(STORAGE.baseUrl, baseUrl);
    localStorage.setItem(STORAGE.token, token);
    localStorage.setItem(STORAGE.orientation, orientVal === "portrait" ? "portrait" : "landscape");
    applyOrientation();
    msg.textContent = "נשמר. מסנכרן…";
    showSettings(false);
    syncOnce()
      .then(() => {
        msg.textContent = "";
      })
      .finally(() => {
        connectWs();
      })
      .catch((e) => {
        msg.textContent = String(e.message || e);
        showSettings(true);
      });
  };

  const has = localStorage.getItem(STORAGE.baseUrl) && localStorage.getItem(STORAGE.token);
  if (has) {
    showSettings(false);
    syncOnce().catch(() => {});
    connectWs();
  } else {
    showSettings(true);
  }

  setInterval(tickClock, 1000);
  tickClock();

  setInterval(() => syncOnce(), 15 * 1000);
  setInterval(() => sendPing(), 45 * 1000);
  window.addEventListener("resize", () => scheduleTickerLayout());
  window.addEventListener("online", () => {
    syncOnce();
    connectWs();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && navigator.onLine) {
      syncOnce().catch(() => {});
      scheduleTickerLayout();
    }
  });
  const sideWrap = document.querySelector(".side-ticker-wrap");
  const rssVp = document.querySelector(".bottom-rss");
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => scheduleTickerLayout());
    if (sideWrap) ro.observe(sideWrap);
    if (rssVp) ro.observe(rssVp);
  }
  window.addEventListener("offline", () => {
    renderFromCache();
    disconnectWs();
  });

  function showKioskOverlay(show) {
    document.getElementById("kioskOverlay").classList.toggle("hidden", !show);
    if (show) {
      document.getElementById("kioskExitPassword").value = "";
      document.getElementById("kioskErr").textContent = "";
    }
  }
  function showKioskMenu(show) {
    document.getElementById("kioskMenu").classList.toggle("hidden", !show);
  }

  function openExitGateFromFab() {
    if (!document.getElementById("kioskMenu").classList.contains("hidden")) return;
    if (!document.getElementById("kioskOverlay").classList.contains("hidden")) {
      showKioskOverlay(false);
      return;
    }
    showKioskOverlay(true);
    setTimeout(() => document.getElementById("kioskExitPassword")?.focus(), 50);
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "F8") return;
      e.preventDefault();
      openExitGateFromFab();
    },
    true
  );

  document.getElementById("fabSettings")?.addEventListener("click", openExitGateFromFab);

  document.getElementById("btnKioskUnlock").onclick = () => {
    const err = document.getElementById("kioskErr");
    err.textContent = "";
    const entered = document.getElementById("kioskExitPassword").value;
    if (entered === getExpectedExitPassword()) {
      showKioskOverlay(false);
      showKioskMenu(true);
    } else {
      err.textContent = "סיסמה שגויה";
    }
  };

  document.getElementById("btnKioskOverlayCancel")?.addEventListener("click", () => {
    showKioskOverlay(false);
  });

  document.getElementById("btnKioskSettings").onclick = () => {
    showKioskMenu(false);
    showSettings(true);
  };

  document.getElementById("btnKioskQuit").onclick = () => {
    if (window.pirsumEnv && typeof window.pirsumEnv.quitApp === "function") {
      window.pirsumEnv.quitApp();
      return;
    }
    const capApp = window.Capacitor?.Plugins?.App;
    if (capApp && typeof capApp.exitApp === "function") {
      capApp.exitApp();
      return;
    }
    window.close();
  };

  document.getElementById("btnKioskCancel").onclick = () => {
    showKioskMenu(false);
  };
}

initUi();
