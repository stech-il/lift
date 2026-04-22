const STORAGE = {
  baseUrl: "pirsum_v2_base_url",
  token: "pirsum_v2_token",
  orientation: "pirsum_v2_orientation",
  exitPassword: "pirsum_v2_exit_password",
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

/** רוחב מקטע RSS אחד (בפיקסלים) — ל־WebView משווים כמה מקורות רוחב. */
function measureRssLoopPx() {
  const track = document.getElementById("rssTrack");
  if (!track) return 0;
  const first = track.querySelector(".rss-inner");
  if (!first) return 0;
  const w = Math.max(
    first.offsetWidth || 0,
    first.scrollWidth || 0,
    first.getBoundingClientRect().width || 0
  );
  if (w > 0) {
    track.style.setProperty("--rss-loop-px", `${Math.round(w * 1000) / 1000}px`);
  }
  return w;
}

/** גלילת RSS ב־rAF לפי זמן אמיתי — באנדרואיד WebView אנימציית CSS על transform לעיתים רצה מהר מדי / לא עקבית. */
let rssRafId = null;
let rssRafStartMs = 0;
let rssRafDurationSec = 48;
let rssRafLoopPx = 0;

function stopRssRaf() {
  if (rssRafId != null) {
    cancelAnimationFrame(rssRafId);
    rssRafId = null;
  }
}

function rssRafTick() {
  const track = document.getElementById("rssTrack");
  if (!track) {
    rssRafId = null;
    return;
  }
  const W = rssRafLoopPx;
  if (W < 1) {
    rssRafId = null;
    return;
  }
  const rssSec = rssRafDurationSec;
  const elapsed = (performance.now() - rssRafStartMs) / 1000;
  const t = (elapsed % rssSec) / rssSec;
  const x = -W * (1 - t);
  track.style.transform = `translate3d(${x}px, 0, 0)`;
  rssRafId = requestAnimationFrame(rssRafTick);
}

function startRssRaf() {
  stopRssRaf();
  rssRafStartMs = performance.now();
  rssRafId = requestAnimationFrame(rssRafTick);
}

function layoutTickerAnimations(config) {
  lastTickerConfig = config || lastTickerConfig;
  const cfg = lastTickerConfig;
  const rssSec = clampNum(Number(cfg?.rss_track_duration_sec), 15, 600, 48);
  const sideSec = clampNum(Number(cfg?.side_ticker_duration_sec), 20, 900, 150);

  const sideEl = document.getElementById("sideTicker");
  const rssTrack = document.getElementById("rssTrack");

  const applySideAnim = () => {
    if (!sideEl) return;
    const h = measureSideTickerLoopPx();
    if (h < 1) {
      sideEl.style.animation = "none";
      return;
    }
    const nextAnim = `sideScrollSeamless ${sideSec}s linear infinite`;
    if (sideEl.style.animation !== nextAnim) {
      sideEl.style.animation = nextAnim;
      sideEl.style.animationFillMode = "none";
    }
  };

  applySideAnim();
  requestAnimationFrame(() => {
    measureSideTickerLoopPx();
    requestAnimationFrame(applySideAnim);
  });

  const applyRssAnim = () => {
    if (!rssTrack) return;
    rssTrack.style.animation = "none";
    const rw = measureRssLoopPx();
    if (rw < 1) {
      stopRssRaf();
      rssTrack.style.removeProperty("transform");
      return;
    }
    const prevSec = rssRafDurationSec;
    rssRafDurationSec = rssSec;
    rssRafLoopPx = rw;
    if (document.visibilityState === "hidden") {
      stopRssRaf();
      rssTrack.style.removeProperty("transform");
      return;
    }
    const needRestart = rssRafId == null || prevSec !== rssSec;
    if (needRestart) {
      startRssRaf();
    }
  };

  applyRssAnim();
  requestAnimationFrame(() => {
    measureRssLoopPx();
    requestAnimationFrame(applyRssAnim);
  });
}

function scheduleTickerLayout() {
  clearTimeout(tickerLayoutTimer);
  tickerLayoutTimer = setTimeout(() => layoutTickerAnimations(null), 120);
}

function applyOrientation() {
  const v = localStorage.getItem(STORAGE.orientation) || "portrait";
  document.documentElement.classList.toggle("player-orientation-portrait", v === "portrait");
}

const DB_NAME = "pirsum_cache_v2";
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
/** חתימת media_items מהשרת (רשימת היעד). */
let lastPlaylistMediaSig = "";
/** חתימת הפריטים שבאמת נטענו ל־IDB (יש blob) — לזיהוי שינוי במצב הורדה. */
let lastPlaylistSig = "";
/** מונע ביטול blob והצגה מחדש של אותו סלייד בכל sync — מפחית הבזק לבן ב־WebView (אנדרואיד). */
let lastRenderedMediaId = null;
/** מונעים ריענון DOM של פסי טקסט כשאין שינוי — מפחיתים ריענון שכבת וידאו ב־WebView. */
let lastSideRenderedFingerprint = "";
let lastRssRenderedFingerprint = "";
/** משך/גופן RSS — כשזה לא משתנה, מעדכנים רק טקסט בלי למחוק DOM (מונע הבזק באנדרואיד). */
let lastRssLayoutMetaFingerprint = "";

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
  if (!baseUrl || !token) return;
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
  /** רק URL — לא updated_at של המעלית (משתנה בעריכות שלא קשורות ללוגו) */
  const sig = `${config.logo_url || ""}`;
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

async function syncBackgroundBlob(db, config, token) {
  if (!config) return;
  /** רק URL — לא updated_at (מונע הורדה וריענון blob בכל שינוי במעלית) */
  const sig = `${config.background_url || ""}`;
  const prev = await idbGet(db, "background_sig");
  if (sig === prev) return;

  if (!config.background_url) {
    await idbDel(db, "background_blob");
    await idbDel(db, "background_sig");
    return;
  }
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const bgUrl = alignMediaUrlToPlayerBase(config.background_url, baseUrl);
  try {
    const res = await fetch(bgUrl, {
      headers: authHeaders(token),
      signal: abortSignal(120000),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    await idbSet(db, "background_blob", blob);
    await idbSet(db, "background_sig", sig);
  } catch {
    /* keep previous */
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

let lastTypographyFingerprint = "";

function typographyFingerprint(config) {
  if (!config) return "";
  const keys = [
    "font_clock_time_px",
    "font_clock_date_px",
    "font_weather_px",
    "font_brand_px",
    "logo_max_height_px",
    "font_side_ticker_px",
    "font_rss_px",
    "media_scale_percent",
  ];
  return keys.map((k) => config[k]).join("|");
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
  const hero = Math.round(clampNum(c.font_clock_time_px, 14, 72, 24) * 1.45);
  disp.style.setProperty("--font-clock-hero", `${hero}px`);
}

async function syncOnce() {
  const baseUrl = localStorage.getItem(STORAGE.baseUrl)?.replace(/\/$/, "");
  const token = localStorage.getItem(STORAGE.token);
  if (!baseUrl || !token) return;

  dbPromise = dbPromise || openDb();
  const db = await dbPromise;

  try {
    /** לא מסתמכים על navigator.onLine — ב־Capacitor/Android WebView הוא לעיתים false למרות רשת תקינה, ואז לא נמשכים נתונים בכלל. */
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
    await syncBackgroundBlob(db, config, token);

    try {
      const w = await fetchWeatherFromServer(baseUrl, token);
      const tempStr = w.temp != null && String(w.temp).trim() !== "" ? String(w.temp) : null;
      const store = { temp: tempStr, city: w.city || "", at: w.at || Date.now() };
      await idbSet(db, "weather", store);
      localStorage.setItem("pirsum_v2_weather_cache", JSON.stringify(store));
    } catch {
      /* keep old */
    }
  } catch (e) {
    console.warn("sync failed", e);
  }

  await renderFromCache();
}

async function renderFromCache() {
  dbPromise = dbPromise || openDb();
  const db = await dbPromise;

  const [configRaw, rssItemsRaw, weatherRaw, bgSigRaw, bgBlob, logoSigRaw, logoBlob] = await Promise.all([
    idbGet(db, "config"),
    idbGet(db, "rss_items"),
    idbGet(db, "weather"),
    idbGet(db, "background_sig"),
    idbGet(db, "background_blob"),
    idbGet(db, "logo_sig"),
    idbGet(db, "logo_blob"),
  ]);

  const bgSig = bgSigRaw ?? "";
  const logoSig = logoSigRaw ?? "";

  const config = configRaw || null;
  if (config) cacheExitPasswordFromConfig(config);
  const tf = typographyFingerprint(config);
  if (tf !== lastTypographyFingerprint) {
    lastTypographyFingerprint = tf;
    applyPlayerTypography(config);
  }
  const rssItems = rssItemsRaw || [];
  let weather = weatherRaw;
  if (!weather) {
    try {
      weather = JSON.parse(localStorage.getItem("pirsum_v2_weather_cache") || "null");
    } catch {
      weather = null;
    }
  }

  const imgEl = document.getElementById("mediaImage");
  const vidEl = document.getElementById("mediaVideo");
  const phEl = document.getElementById("mediaPlaceholder");

  const dispEl = document.getElementById("display");
  if (dispEl) {
    const canSkipBg =
      dispEl._lastRenderedBgSig === bgSig &&
      ((!bgBlob && !dispEl._bgUrl && bgSig === "") || Boolean(bgBlob && dispEl._bgUrl));
    if (!canSkipBg) {
      dispEl._lastRenderedBgSig = bgSig;
      if (dispEl._bgUrl) {
        try {
          URL.revokeObjectURL(dispEl._bgUrl);
        } catch {
          /* ignore */
        }
        dispEl._bgUrl = null;
      }
      if (bgBlob) {
        const u = URL.createObjectURL(bgBlob);
        dispEl._bgUrl = u;
        dispEl.style.backgroundImage = `url("${u}")`;
        dispEl.style.backgroundSize = "cover";
        dispEl.style.backgroundPosition = "center center";
        dispEl.style.backgroundRepeat = "no-repeat";
      } else {
        dispEl.style.backgroundImage = "none";
      }
    }
  }

  const brandImg = document.getElementById("brandLogo");
  const brandText = document.getElementById("elevName");
  if (brandImg && brandText) {
    if (logoBlob) {
      const canSkipLogo = logoSig === brandImg._lastRenderedLogoSig && brandImg._blobUrl && logoBlob;
      if (!canSkipLogo) {
        brandImg._lastRenderedLogoSig = logoSig;
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
        brandImg.removeAttribute("width");
        brandImg.removeAttribute("height");
        brandImg.classList.remove("hidden");
        brandText.classList.add("hidden");
      }
      brandImg.alt = config?.name || "";
    } else {
      brandImg._lastRenderedLogoSig = logoSig;
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

  const phoneEl = document.getElementById("headerPhone");
  if (phoneEl) {
    const p = (config?.header_phone != null ? String(config.header_phone) : "").trim();
    phoneEl.textContent = p;
    phoneEl.classList.toggle("hidden", !p);
  }

  const wText =
    weather?.temp && String(weather.temp).trim() !== "" && weather.temp !== "—"
      ? `${weather.city ? weather.city + " · " : ""}${weather.temp}`
      : "—";
  document.getElementById("weatherText").textContent = wText;

  const side = config?.side_ticker_text || "";
  const sideText = side.trim() || "אין עדכונים — ניתן לערוך בלוח הבקרה";
  const sideTickerEl = document.getElementById("sideTicker");
  const sideFingerprint = `${sideText}|${config?.side_ticker_duration_sec ?? ""}|${config?.font_side_ticker_px ?? ""}`;
  if (sideTickerEl && sideFingerprint !== lastSideRenderedFingerprint) {
    lastSideRenderedFingerprint = sideFingerprint;
    sideTickerEl.innerHTML = buildSideTickerHtml(sideText);
  }

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
  if (rssHeadingEl) rssHeadingEl.textContent = "מבזקי חדשות";

  const rssLayoutMeta = `${config?.rss_track_duration_sec ?? ""}|${config?.font_rss_px ?? ""}`;
  const rssFingerprint = `${rssText}|${rssLayoutMeta}`;
  const track = document.getElementById("rssTrack");
  if (track && rssFingerprint !== lastRssRenderedFingerprint) {
    const inners = track.querySelectorAll(".rss-inner");
    const canPatchOnly =
      inners.length === 2 &&
      lastRssLayoutMetaFingerprint !== "" &&
      rssLayoutMeta === lastRssLayoutMetaFingerprint;

    if (canPatchOnly) {
      inners[0].textContent = rssText;
      inners[1].textContent = rssText;
      lastRssRenderedFingerprint = rssFingerprint;
    } else {
      stopRssRaf();
      lastRssRenderedFingerprint = rssFingerprint;
      lastRssLayoutMetaFingerprint = rssLayoutMeta;
      track.innerHTML = "";
      const inner1 = document.createElement("div");
      inner1.className = "rss-inner";
      inner1.textContent = rssText;
      const inner2 = inner1.cloneNode(true);
      track.appendChild(inner1);
      track.appendChild(inner2);
    }
  }

  lastTickerConfig = config;
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        layoutTickerAnimations(config);
        resolve();
      });
    });
  });

  await playPlaylistFromCache(db, imgEl, vidEl, phEl, config);
}

async function playPlaylistFromCache(db, imgEl, vidEl, phEl, configCached) {
  const config = configCached != null ? configCached : (await idbGet(db, "config")) || null;
  const items = config?.media_items || [];
  const configListSig = playlistSignature(items);

  const resolved = [];
  for (const it of items) {
    const b = await idbGet(db, "m_" + it.id);
    if (b) resolved.push({ id: it.id, media_type: it.media_type, blob: b });
  }
  const resolvedSig = playlistSignature(resolved);

  /** לא משווים config ל־lastPlaylistSig — זה היה רק resolved, אז בכל sync נחשב "שינוי" והווידאו התאפס (מסך שחור). */
  if (
    configListSig === lastPlaylistMediaSig &&
    resolvedSig === lastPlaylistSig &&
    playlistItems.length &&
    lastRenderedMediaId
  ) {
    return;
  }

  if (!resolved.length) {
    clearImageSlide();
    revokeAllBlobUrls();
    lastRenderedMediaId = null;
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
    lastPlaylistMediaSig = "";
    return;
  }

  if (resolvedSig !== lastPlaylistSig) {
    lastPlaylistSig = resolvedSig;
    playlistIndex = 0;
  }
  lastPlaylistMediaSig = configListSig;
  playlistItems = resolved;
  showPlaylistSlide(db, imgEl, vidEl, phEl);
}

function advancePlaylist(db, imgEl, vidEl, phEl) {
  if (!playlistItems.length) return;
  playlistIndex = (playlistIndex + 1) % playlistItems.length;
  showPlaylistSlide(db, imgEl, vidEl, phEl);
}

function showPlaylistSlide(db, imgEl, vidEl, phEl) {
  const item = playlistItems[playlistIndex];
  if (!item) return;
  if (item.id === lastRenderedMediaId) {
    return;
  }
  clearImageSlide();
  lastRenderedMediaId = item.id;

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
  const weekday = now.toLocaleDateString("he-IL", { weekday: "long" });
  const d = now.getDate();
  const m = now.getMonth() + 1;
  const shortDate = `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  const dateLine = `${weekday} ${shortDate}`;
  const elLine = document.getElementById("clockDateLine");
  const elT = document.getElementById("clockTime");
  if (elLine) elLine.textContent = dateLine;
  if (elT) elT.textContent = time;
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
  const orient = localStorage.getItem(STORAGE.orientation) || "portrait";
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
    if (document.visibilityState === "hidden") {
      stopRssRaf();
      return;
    }
    syncOnce().catch(() => {});
    scheduleTickerLayout();
  });
  const sideWrap = document.querySelector(".ann-white-panel .side-rss-marquee");
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
