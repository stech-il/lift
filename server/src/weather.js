import nodeFetch from "node-fetch";

const fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : nodeFetch;

export const DEFAULT_WEATHER_LAT = 32.0853;
export const DEFAULT_WEATHER_LON = 34.7818;

export function parseWeatherCoord(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(",", ".").trim());
  if (!Number.isFinite(n)) return fallback;
  return n;
}

/** נרמול קואורדינטות למזג אוויר (אובייקט מתקן או ערכים גולמיים) */
export function normalizeWeatherCoords(latRaw, lonRaw) {
  let lat = parseWeatherCoord(latRaw, DEFAULT_WEATHER_LAT);
  let lon = parseWeatherCoord(lonRaw, DEFAULT_WEATHER_LON);
  if (lat < -90 || lat > 90) lat = DEFAULT_WEATHER_LAT;
  if (lon < -180 || lon > 180) lon = DEFAULT_WEATHER_LON;
  return { lat, lon };
}

export function elevatorWeatherCoords(elevatorRow) {
  return normalizeWeatherCoords(elevatorRow?.latitude, elevatorRow?.longitude);
}

const OPEN_METEO_HEADERS = {
  Accept: "application/json",
  "User-Agent": "PirsumLift/1.0 (+https://github.com/stech-il/lift)",
};

/**
 * @param {{ includeDiag?: boolean }} [opts] — includeDiag למסך ניהול בלבד (סיבת כשל)
 * @returns {Promise<{ city: string, temp: string | null, at: number, diag?: string }>}
 */
export async function fetchOpenMeteoCurrent(lat, lon, cityLabel = "", opts = {}) {
  const includeDiag = !!opts.includeDiag;
  const city = cityLabel != null ? String(cityLabel) : "";
  const withDiag = (base, msg) => (includeDiag ? { ...base, diag: msg } : base);

  try {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set("current_weather", "true");
    let signal;
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      signal = AbortSignal.timeout(15000);
    } else {
      const c = new AbortController();
      setTimeout(() => c.abort(), 15000);
      signal = c.signal;
    }
    const r = await fetchImpl(u.toString(), { signal, headers: OPEN_METEO_HEADERS });
    if (!r.ok) {
      const snippet = includeDiag ? (await r.text()).slice(0, 120) : "";
      return withDiag(
        { city, temp: null, at: Date.now() },
        `Open-Meteo HTTP ${r.status}${snippet ? ": " + snippet : ""}`,
      );
    }
    const data = await r.json();
    if (data?.error) {
      const reason = data?.reason != null ? String(data.reason) : "unknown";
      return withDiag({ city, temp: null, at: Date.now() }, `Open-Meteo: ${reason}`);
    }
    const t = data?.current_weather?.temperature;
    if (t == null || !Number.isFinite(Number(t))) {
      return withDiag({ city, temp: null, at: Date.now() }, "אין שדה current_weather.temperature בתשובה");
    }
    const temp = `${Math.round(Number(t))}°C`;
    return { city, temp, at: Date.now() };
  } catch (e) {
    const msg = e?.name === "AbortError" ? "פג תוקף (timeout) — השרת לא השיב ב־15 ש׳" : String(e?.message || e);
    return withDiag({ city, temp: null, at: Date.now() }, `רשת: ${msg}`);
  }
}
