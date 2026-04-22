import { XMLParser } from "fast-xml-parser";
import nodeFetch from "node-fetch";

/** Node 16 ללא fetch גלובלי — חובה ל-RSS */
const fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : nodeFetch;

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
});

function normalizeRssUrl(url) {
  let u = String(url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) {
    u = "https://" + u.replace(/^\/+/, "");
  }
  return u;
}

function textFromMaybe(val) {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  if (typeof val === "object") {
    if (val["#text"] != null) return String(val["#text"]);
    if (val.__text != null) return String(val.__text);
  }
  return "";
}

function pickLink(it) {
  if (typeof it.link === "string") return it.link;
  if (it.link?.["#text"]) return String(it.link["#text"]);
  if (it.link?.["@_href"]) return String(it.link["@_href"]);
  if (Array.isArray(it.link)) {
    const alt = it.link.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") || it.link[0];
    return alt?.["@_href"] ? String(alt["@_href"]) : "";
  }
  if (typeof it.id === "string" && it.id.startsWith("http")) return it.id;
  return "";
}

function collectItems(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) {
    const out = [];
    for (const el of obj) {
      out.push(...collectItems(el, depth + 1));
    }
    return out;
  }
  if (obj.item) {
    const arr = Array.isArray(obj.item) ? obj.item : [obj.item];
    if (arr.length) return arr;
  }
  if (obj.entry) {
    const arr = Array.isArray(obj.entry) ? obj.entry : [obj.entry];
    if (arr.length) return arr;
  }
  for (const k of Object.keys(obj)) {
    const r = collectItems(obj[k], depth + 1);
    if (r.length) return r;
  }
  return [];
}

function extractItems(raw) {
  if (!raw || typeof raw !== "object") return [];

  let channel = raw.rss?.channel;
  if (Array.isArray(channel)) channel = channel[0];
  if (!channel && raw.feed) channel = raw.feed;
  if (!channel && raw.RDF) channel = raw.RDF.channel || raw.RDF;
  if (!channel && raw["rdf:RDF"]) {
    const rdf = raw["rdf:RDF"];
    channel = rdf.channel || rdf;
  }

  let items = [];
  if (channel && typeof channel === "object") {
    if (channel.item) items = Array.isArray(channel.item) ? channel.item : [channel.item];
    else if (channel.entry) items = Array.isArray(channel.entry) ? channel.entry : [channel.entry];
  }
  if (!items.length) {
    items = collectItems(raw);
  }

  if (!items.length) return [];

  return items.map((it) => {
    const title = textFromMaybe(it.title) || textFromMaybe(it["dc:title"]) || "(ללא כותרת)";
    const link = pickLink(it);
    const pubDate = textFromMaybe(it.pubDate) || textFromMaybe(it.published) || textFromMaybe(it.updated) || "";
    return { title: String(title).trim() || "(ללא כותרת)", link: String(link).trim(), pubDate: String(pubDate) };
  });
}

export async function fetchRssItems(url, limit = 30) {
  const normalized = normalizeRssUrl(url);
  if (!normalized || !/^https?:\/\//i.test(normalized)) return [];

  const res = await fetchImpl(normalized, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; PirsumElevator/1.0; +https://rss.example) AppleWebKit/537.36 (KHTML, like Gecko)",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    },
    signal: timeoutSignal(20000),
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const items = extractItems(parsed).slice(0, limit);
  return items;
}
