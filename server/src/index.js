import "dotenv/config";
import http from "http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";
import {
  listElevators,
  createElevator,
  getElevatorByToken,
  getElevatorById,
  updateElevator,
  deleteElevator,
  addMediaForElevator,
  deleteMediaById,
  listMediaForElevator,
  listAllMediaWithElevators,
  mediaBelongsToElevator,
  reorderMediaForElevator,
  deleteAllMediaForElevator,
  duplicateElevator,
  touchLastSeen,
  countUsers,
  createUser,
  getUserById,
  getUserByEmailForAuth,
  listUsersSafe,
  deleteUserById,
  updateUser,
  insertAuditLog,
  listAuditLogs,
  insertPasswordReset,
  consumePasswordReset,
  deletePasswordResetsForUser,
  setUserGoogleSub,
  getUserByGoogleSub,
  deleteAppSettingKey,
  setAppSettingKey,
} from "./db.js";
import {
  hashPassword,
  verifyPassword,
  signUserToken,
  verifyUserToken,
  validateEmail,
  validatePassword,
} from "./auth.js";
import { fetchRssItems } from "./rss.js";
import { attachRealtime, notifyElevator } from "./realtime.js";
import {
  parseWeatherCoord,
  DEFAULT_WEATHER_LAT,
  DEFAULT_WEATHER_LON,
  elevatorWeatherCoords,
  fetchOpenMeteoCurrent,
  normalizeWeatherCoords,
} from "./weather.js";
import { sendMail, isMailConfigured, getEffectiveSmtpForAdmin, resetMailTransporter, SMTP_KEYS } from "./mail.js";
import { verifyGoogleIdToken, getGoogleClientId } from "./googleAuth.js";

function hashPasswordResetToken(token) {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_SECRET || "change-me-in-production";
  return createHash("sha256").update(secret).update(String(token)).digest("hex");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const dataDir = process.env.DATA_DIR?.trim();
const uploadsRoot = process.env.UPLOADS_DIR?.trim()
  ? path.resolve(process.env.UPLOADS_DIR.trim())
  : dataDir
    ? path.join(dataDir, "uploads")
    : path.join(root, "uploads");
const publicDir = path.join(root, "public");
const downloadsDir = process.env.CLIENT_DOWNLOADS_DIR?.trim()
  ? path.resolve(process.env.CLIENT_DOWNLOADS_DIR.trim())
  : path.join(publicDir, "downloads");

fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(downloadsDir, { recursive: true });

/** תאימות לאחור: אם מוגדר, אפשר עדיין X-Admin-Token */
const ADMIN_SECRET = process.env.ADMIN_SECRET || "change-me-in-production";
const PORT = Number(process.env.PORT) || 3840;

function adminAuth(req, res, next) {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (bearer) {
    try {
      const payload = verifyUserToken(bearer);
      const user = getUserById(payload.sub);
      if (user) {
        req.adminUser = user;
        return next();
      }
    } catch {
      /* נסה legacy */
    }
  }
  const legacy = req.headers["x-admin-token"];
  if (legacy && ADMIN_SECRET && legacy === ADMIN_SECRET) {
    req.adminUser = { id: "legacy", email: "legacy@admin", role: "admin", allowed_elevator_id: null };
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

function canManageUsers(req) {
  if (req.adminUser?.id === "legacy") return true;
  return (req.adminUser?.role || "admin") === "admin";
}

function canEditElevators(req) {
  if (req.adminUser?.id === "legacy") return true;
  const r = req.adminUser?.role || "admin";
  return r === "admin" || r === "editor";
}

/** מנהלים: גישה לכל המתקנים. עורך/צופה: אופציונלי רק למתקן אחד (allowed_elevator_id). */
function getScopedElevatorId(req) {
  const u = req.adminUser;
  if (!u || u.id === "legacy") return null;
  if (u.role === "admin") return null;
  const aid = u.allowed_elevator_id;
  if (aid == null || String(aid).trim() === "") return null;
  return String(aid).trim();
}

function canAccessElevator(req, elevatorId) {
  const scoped = getScopedElevatorId(req);
  if (scoped == null) return true;
  return scoped === elevatorId;
}

function requireElevatorAccess(req, res, next) {
  const elevatorId = req.params.id;
  if (!elevatorId) return next();
  if (!canAccessElevator(req, elevatorId)) {
    return res.status(403).json({ error: "אין גישה למתקן זה" });
  }
  next();
}

function requireElevatorEdit(req, res, next) {
  if (!canEditElevators(req)) return res.status(403).json({ error: "אין הרשאה לעריכה" });
  next();
}

function requireAdminOnly(req, res, next) {
  if (!canManageUsers(req)) return res.status(403).json({ error: "נדרשת הרשאת מנהל מערכת" });
  next();
}

function normalizeAllowedElevatorId(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/** אובייקט משתמש לתגובות JSON (ללא סודות) */
function userPublicJson(u) {
  if (!u) return null;
  const name =
    u.display_name != null && String(u.display_name).trim() !== "" ? String(u.display_name).trim() : "";
  return {
    id: u.id,
    email: u.email,
    name,
    role: u.role,
    allowed_elevator_id: u.allowed_elevator_id || null,
  };
}

function playerAuth(req, res, next) {
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.query.token ||
    "";
  const row = getElevatorByToken(token);
  if (!row) return res.status(401).json({ error: "Invalid token" });
  req.elevator = row;
  next();
}

const app = express();

/** מאחורי Render / nginx — כדי ש־req.protocol ו־Host ישקפו HTTPS ודומיין ציבורי */
if (process.env.TRUST_PROXY === "false" || process.env.TRUST_PROXY === "0") {
  app.set("trust proxy", false);
} else {
  const n = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isFinite(n) && n >= 0 ? n : 1);
}

const enforceHttps =
  process.env.ENFORCE_HTTPS === "true" ||
  (process.env.NODE_ENV === "production" && String(process.env.PUBLIC_BASE_URL || "").startsWith("https://"));

if (enforceHttps && process.env.ENFORCE_HTTPS !== "false") {
  app.use((req, res, next) => {
    const xf = req.get("x-forwarded-proto");
    if (xf === "http") {
      const host = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
      if (host) {
        return res.redirect(301, `https://${host}${req.originalUrl}`);
      }
    }
    next();
  });
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function getClientIp(req) {
  const x = req.headers["x-forwarded-for"];
  if (typeof x === "string" && x.trim()) return x.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || "";
}

function safeAuditBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (/password|token|secret|hash|authorization|cookie/i.test(k)) continue;
    if (typeof v === "string") out[k] = v.length > 500 ? `${v.slice(0, 500)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (v === null) out[k] = null;
    else if (typeof v === "object") out[k] = "[object]";
    else out[k] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

const AUDIT_ROLE_HE = {
  admin: "מנהל מערכת",
  editor: "עורך תוכן",
  viewer: "צופה",
};

const AUDIT_ELEV_FIELD_HE = {
  name: "שם המתקן",
  rss_url: "כתובת RSS",
  latitude: "קו רוחב",
  longitude: "קו אורך",
  city_label: "תווית עיר",
  side_ticker_text: "טקסט גלילה בצד",
  rss_ticker_text: "טקסט פס חדשות",
  exit_password: "סיסמת יציאה לנגן",
  rss_track_duration_sec: "משך מסלול RSS",
  side_ticker_duration_sec: "משך גלילת צד",
  logo_filename: "קובץ לוגו",
  background_filename: "רקע",
  header_phone: "טלפון בכותרת",
  logo_left_filename: "לוגו שמאלי",
  font_clock_time_px: "גודל גופן שעה",
  font_clock_date_px: "גודל גופן תאריך",
  font_weather_px: "גודל גופן מזג אוויר",
  font_brand_px: "גודל גופן שם מותג",
  logo_max_height_px: "גובה לוגו מקסימלי",
  font_side_ticker_px: "גודל גופן גלילת צד",
  font_rss_px: "גודל גופן RSS",
  media_scale_percent: "קנה מידה מדיה",
};

const AUDIT_USER_FIELD_HE = {
  email: "אימייל",
  name: "שם",
  role: "תפקיד",
  allowed_elevator_id: "הגבלה למתקן",
};

function buildAuditActionHebrew(req) {
  const m = req.method;
  const p = req.path;
  if (p === "/api/auth/login" && m === "POST") return "התחברות לממשק הניהול";
  if (p === "/api/auth/google" && m === "POST") return "התחברות עם Google";
  if (p === "/api/auth/register-first" && m === "POST") return "הקמת מנהל ראשון (הרשמה ראשונה במערכת)";
  if (p === "/api/users" && m === "POST") return "יצירת משתמש חדש";
  if (m === "PATCH" && /^\/api\/users\/[^/]+$/.test(p)) return "עדכון פרטי משתמש";
  if (m === "DELETE" && /^\/api\/users\/[^/]+$/.test(p)) return "מחיקת משתמש";
  if (p === "/api/elevators" && m === "POST") return "יצירת מתקן (מסך) חדש";
  if (m === "PATCH" && /^\/api\/elevators\/[^/]+$/.test(p)) return "עדכון הגדרות מתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+$/.test(p)) return "מחיקת מתקן";
  if (m === "POST" && /^\/api\/elevators\/[^/]+\/duplicate$/.test(p)) return "שכפול מתקן (מסך)";
  if (m === "POST" && /^\/api\/elevators\/[^/]+\/media$/.test(p)) return "העלאת קבצי מדיה למתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+\/media$/.test(p)) return "מחיקת כל קבצי המדיה במתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+\/media\/[^/]+$/.test(p)) return "מחיקת פריט מדיה מהפלייליסט";
  if (m === "PATCH" && /^\/api\/elevators\/[^/]+\/media-order$/.test(p)) return "שינוי סדר פריטי המדיה";
  if (m === "POST" && /^\/api\/elevators\/[^/]+\/logo$/.test(p)) return "העלאת לוגו למתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+\/logo$/.test(p)) return "הסרת לוגו מהמתקן";
  if (m === "POST" && /^\/api\/elevators\/[^/]+\/background$/.test(p)) return "העלאת תמונת רקע למתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+\/background$/.test(p)) return "הסרת תמונת רקע מהמתקן";
  if (m === "POST" && /^\/api\/elevators\/[^/]+\/logo-left$/.test(p)) return "העלאת לוגו שמאלי למתקן";
  if (m === "DELETE" && /^\/api\/elevators\/[^/]+\/logo-left$/.test(p)) return "הסרת לוגו שמאלי מהמתקן";
  if (p === "/api/admin/client-downloads" && m === "POST") return "העלאת קובץ התקנה (נגן) לשרת ההורדות";
  if (m === "DELETE" && /^\/api\/admin\/client-downloads\/[^/]+$/.test(p)) return "מחיקת קובץ התקנה מהשרת";
  if (p === "/api/admin/weather-preview" && m === "POST") return "תצוגה מקדימה של מזג אוויר (ניהול)";
  if (p === "/api/admin/audit-log/email" && m === "POST") return "שליחת לוג פעולות במייל";
  if (p === "/api/admin/settings" && m === "PUT") return "עדכון הגדרות מערכת (מייל/שרת)";
  if (p === "/api/admin/settings/mail-test" && m === "POST") return "בדיקת שליחת מייל (SMTP)";
  return `${m} ${p}`;
}

function describeUserBodyFields(sb) {
  const parts = [];
  if (sb.email) parts.push(`אימייל: ${sb.email}`);
  if (sb.name != null && String(sb.name).trim() !== "") {
    parts.push(`שם: ${String(sb.name).trim()}`);
  }
  if (sb.role != null && sb.role !== "") {
    const r = String(sb.role);
    parts.push(`תפקיד: ${AUDIT_ROLE_HE[r] || r}`);
  }
  if (sb.allowed_elevator_id != null && String(sb.allowed_elevator_id).trim() !== "") {
    const eid = String(sb.allowed_elevator_id).trim();
    try {
      const el = getElevatorById(eid);
      parts.push(el?.name ? `גישה למתקן: ${el.name}` : `מזהה מתקן מורשה: ${eid}`);
    } catch {
      parts.push(`מזהה מתקן מורשה: ${eid}`);
    }
  }
  return parts;
}

function describeElevatorPatchFields(sb) {
  const keys = Object.keys(sb);
  if (!keys.length) return [];
  const labels = keys
    .map((k) => AUDIT_ELEV_FIELD_HE[k] || k)
    .filter(Boolean);
  return labels.length ? [`שדות שעודכנו: ${labels.join(", ")}`] : [];
}

function buildAuditDetailHebrew(req) {
  const parts = [];
  const p = req.path;
  const pid = req.params?.id;
  const mediaId = req.params?.mediaId;

  try {
    if (pid && /^\/api\/(elevators|users)\//.test(p)) {
      if (p.startsWith("/api/elevators/")) {
        const e = getElevatorById(pid);
        if (e?.name) parts.push(`מתקן: ${e.name}`);
        else parts.push(`מזהה מתקן: ${pid}`);
      } else if (p.startsWith("/api/users/")) {
        const u = getUserById(pid);
        if (u?.email) parts.push(`משתמש: ${u.email}`);
        else parts.push(`מזהה משתמש: ${pid}`);
      }
    }
  } catch {
    /* skip */
  }

  if (mediaId) parts.push(`מזהה פריט מדיה: ${mediaId}`);

  if (req.params?.filename) {
    try {
      parts.push(`קובץ: ${decodeURIComponent(String(req.params.filename))}`);
    } catch {
      parts.push(`קובץ: ${req.params.filename}`);
    }
  }

  const sb = safeAuditBody(req.body);
  if (sb) {
    if (p === "/api/elevators" && req.method === "POST" && sb.name) {
      parts.push(`שם המתקן: ${sb.name}`);
    }
    if (req.method === "POST" && /^\/api\/elevators\/[^/]+\/duplicate$/.test(p) && sb && sb.name != null && String(sb.name).trim() !== "") {
      parts.push(`שם לעותק: ${String(sb.name).trim()}`);
    }
    if (p === "/api/users" && req.method === "POST") {
      parts.push(...describeUserBodyFields(sb));
    }
    if (req.method === "PATCH" && /^\/api\/users\/[^/]+$/.test(p)) {
      const extra = describeUserBodyFields(sb);
      parts.push(...extra);
    }
    if (req.method === "PATCH" && /^\/api\/elevators\/[^/]+$/.test(p)) {
      parts.push(...describeElevatorPatchFields(sb));
    }
    if ((p === "/api/auth/login" || p === "/api/auth/register-first") && sb.email) {
      parts.push(`אימייל: ${sb.email}`);
    }
  }

  if (req.method === "PATCH" && /^\/api\/elevators\/[^/]+\/media-order$/.test(p) && Array.isArray(req.body?.order)) {
    parts.push(`מספר פריטים בפלייליסט אחרי שינוי הסדר: ${req.body.order.length}`);
  }

  try {
    if (req.file?.originalname) parts.push(`קובץ שהועלה: ${req.file.originalname}`);
    if (Array.isArray(req.files) && req.files.length) parts.push(`מספר קבצים: ${req.files.length}`);
  } catch {
    /* multer */
  }

  return parts.length ? parts.join(" · ") : "אין פרטים נוספים.";
}

function auditMutationLogger(req, res, next) {
  if (!req.path.startsWith("/api")) return next();
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (req.path.startsWith("/api/player/")) return next();
  if (req.path === "/api/health") return next();
  if (req.path === "/api/auth/forgot-password" || req.path === "/api/auth/reset-password") return next();

  res.on("finish", () => {
    try {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const actor = req.adminUser;
      let actorId = actor?.id != null ? String(actor.id) : null;
      let actorEmail = actor?.email != null ? String(actor.email) : null;
      if (actorId === "legacy") {
        actorEmail = actorEmail || "legacy@admin";
      }
      if (!actor && req.path === "/api/auth/login" && req.body && req.body.email) {
        actorEmail = String(req.body.email).toLowerCase().trim();
        actorId = null;
      }
      if (!actor && req.path === "/api/auth/register-first" && req.body && req.body.email) {
        actorEmail = String(req.body.email).toLowerCase().trim();
        actorId = null;
      }
      const pathStr = (req.originalUrl && req.originalUrl.split("?")[0]) || req.path;
      insertAuditLog({
        actorId,
        actorEmail: actorEmail || "—",
        action: buildAuditActionHebrew(req),
        method: req.method,
        path: pathStr,
        statusCode: res.statusCode,
        detail: buildAuditDetailHebrew(req),
        ip: getClientIp(req),
      });
    } catch (e) {
      console.error("audit log error", e);
    }
  });
  next();
}

app.use(auditMutationLogger);

/** בסיס ציבורי לכתובות מדיה/לוגו (אופציונלי — דורס ניחוש מ־req מאחורי פרוקסי) */
function publicOrigin(req) {
  const env = process.env.PUBLIC_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

function elevatorUploadDir(id) {
  const dir = path.join(uploadsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const id = req.params.id;
    cb(null, elevatorUploadDir(id));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname) || "";
    const safe = `media_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 12)}${ext}`;
    cb(null, safe);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 120 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov)$/i.test(file.originalname);
    if (!ok) return cb(new Error("סוג קובץ לא נתמך"));
    cb(null, true);
  },
});

function uploadMediaFlexible(req, res, next) {
  upload.array("files", 40)(req, res, (err) => {
    if (err) return next(err);
    if (req.files?.length) return next();
    upload.single("file")(req, res, next);
  });
}

const logoStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, elevatorUploadDir(req.params.id));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || ".png";
    const safeExt = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext) ? ext : ".png";
    cb(null, `logo_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}${safeExt}`);
  },
});

const uploadLogo = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("לוגו: רק תמונה (png, jpg, webp, gif, svg)"));
  },
});

const backgroundStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, elevatorUploadDir(req.params.id));
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    const safeExt = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ? ext : ".jpg";
    cb(null, `bg_${Date.now()}_${randomUUID().replace(/-/g, "").slice(0, 8)}${safeExt}`);
  },
});

const uploadBackground = multer({
  storage: backgroundStorage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (/\.(png|jpg|jpeg|gif|webp)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("רקע: רק תמונה (png, jpg, webp, gif)"));
  },
});

/** סיומות קבצי התקנה/הפצה בנגן (Windows + Android). */
const CLIENT_DOWNLOAD_EXT_RE = /\.(exe|msi|zip|apk)$/i;

/** שם בטוח לקובץ התקנת נגן בתיקיית ההורדות (בלי נתיב). */
function safeClientDownloadBasename(name) {
  const base = path.basename(String(name || "").trim());
  if (!base || base.length > 200) return null;
  if (base !== String(name || "").trim()) return null;
  if (!CLIENT_DOWNLOAD_EXT_RE.test(base)) return null;
  return base;
}

const clientDownloadStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, downloadsDir);
  },
  filename(req, file, cb) {
    const safe = safeClientDownloadBasename(file.originalname);
    if (!safe) return cb(new Error("רק exe, msi, zip או apk; שם קובץ לא תקין"));
    cb(null, safe);
  },
});

const uploadClientDownload = multer({
  storage: clientDownloadStorage,
  limits: { fileSize: 400 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (safeClientDownloadBasename(file.originalname)) cb(null, true);
    else cb(new Error("רק קבצי התקנה/הפצה: exe, msi, zip, apk"));
  },
});

app.use("/admin", express.static(publicDir));

app.get("/api/client-downloads", (req, res) => {
  try {
    const entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    const files = entries
      .filter((d) => d.isFile() && CLIENT_DOWNLOAD_EXT_RE.test(d.name))
      .map((d) => ({
        name: d.name,
        url: "/downloads/" + encodeURIComponent(d.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    res.json({ files });
  } catch {
    res.status(500).json({ files: [], error: "list_failed" });
  }
});

app.use(
  "/downloads",
  express.static(downloadsDir, {
    setHeaders(res, filePath) {
      if (CLIENT_DOWNLOAD_EXT_RE.test(filePath)) {
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }),
);

app.get("/", (req, res) => res.redirect(302, "/admin/index.html"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/auth/status", (req, res) => {
  const n = countUsers();
  res.json({ needsSetup: n === 0, hasUsers: n > 0 });
});

/** הגדרות ציבוריות לדף ההתחברות (ללא סודות) */
app.get("/api/auth/public-config", (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.json({
    googleClientId: getGoogleClientId(),
    mailConfigured: isMailConfigured(),
  });
});

app.post("/api/auth/register-first", (req, res) => {
  try {
    if (countUsers() > 0) return res.status(403).json({ error: "נרשמו כבר משתמשים" });
    const email = String(req.body?.email || "").trim();
    const password = req.body?.password;
    if (!validateEmail(email)) return res.status(400).json({ error: "אימייל לא תקין" });
    if (!validatePassword(password)) return res.status(400).json({ error: "סיסמה: 8–128 תווים" });
    const name = String(req.body?.name || "").trim().slice(0, 200);
    const user = createUser({ email, passwordHash: hashPassword(password), role: "admin", display_name: name || null });
    const token = signUserToken(user);
    res.status(201).json({
      token,
      user: userPublicJson(getUserById(user.id)),
    });
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "האימייל כבר רשום" });
    }
    throw e;
  }
});

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = req.body?.password;
  const row = getUserByEmailForAuth(email);
  if (!row) {
    return res.status(401).json({ error: "אימייל או סיסמה שגויים" });
  }
  if (row.password_hash == null || String(row.password_hash).trim() === "") {
    return res.status(401).json({ error: "לחשבון זה אין סיסמה — התחבר עם Google" });
  }
  if (!verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "אימייל או סיסמה שגויים" });
  }
  const user = getUserById(row.id);
  const token = signUserToken(user);
  res.json({
    token,
    user: userPublicJson(user),
  });
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const credential = String(req.body?.credential || "").trim();
    if (!credential) return res.status(400).json({ error: "חסר אסימון Google" });
    const g = await verifyGoogleIdToken(credential);
    if (!g.emailVerified) {
      return res.status(403).json({ error: "יש לאמת את כתובת האימייל בחשבון Google" });
    }
    let row = getUserByGoogleSub(g.sub);
    if (!row) {
      row = getUserByEmailForAuth(g.email);
      if (!row) {
        return res.status(403).json({ error: "אין חשבון למייל זה. פנה למנהל המערכת ליצירת משתמש." });
      }
      if (row.google_sub && row.google_sub !== g.sub) {
        return res.status(403).json({ error: "חשבון Google לא תואם למשתמש זה" });
      }
      if (!row.google_sub) {
        setUserGoogleSub(row.id, g.sub);
        row = getUserByEmailForAuth(g.email);
      }
    } else if (String(row.email).toLowerCase() !== g.email) {
      return res.status(403).json({ error: "אימייל Google לא תואם לחשבון" });
    }
    const user = getUserById(row.id);
    const token = signUserToken(user);
    res.json({
      token,
      user: userPublicJson(user),
    });
  } catch (e) {
    const code = e.code || "";
    if (code === "GOOGLE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "התחברות Google לא הוגדרה בשרת" });
    }
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post("/api/auth/forgot-password", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const okMsg = { ok: true, message: "אם כתובת האימייל קיימת במערכת, יישלח אליה קישור לאיפוס סיסמה." };
  if (!validateEmail(email)) {
    return res.json(okMsg);
  }
  const row = getUserByEmailForAuth(email);
  if (!row || row.password_hash == null || String(row.password_hash).trim() === "") {
    return res.json(okMsg);
  }
  if (!isMailConfigured()) {
    console.warn("forgot-password: SMTP לא מוגדר");
    return res.json(okMsg);
  }
  const raw = randomBytes(32).toString("hex");
  const tokenHash = hashPasswordResetToken(raw);
  const passwordResetTtlMin = 5;
  const expires = Date.now() + passwordResetTtlMin * 60 * 1000;
  insertPasswordReset(row.id, tokenHash, expires);
  const base = publicOrigin(req);
  const link = `${base}/admin/?reset=${encodeURIComponent(raw)}`;
  const sent = await sendMail({
    to: email,
    subject: "איפוס סיסמה — Pirsum",
    text: `שלום,\n\nנפתחה בקשה לאיפוס הסיסמה לממשק הניהול.\n\nלחץ על הקישור (הקישור בתוקף ${passwordResetTtlMin} דקות בלבד):\n${link}\n\nאם לא ביקשת — התעלם מהודעה זו.\n`,
  });
  if (!sent.ok) console.warn("forgot-password mail failed", sent.error);
  res.json(okMsg);
});

app.post("/api/auth/reset-password", (req, res) => {
  const token = String(req.body?.token || "").trim();
  const password = req.body?.password;
  if (!token || !validatePassword(password)) {
    return res.status(400).json({ error: "קישור לא תקין או סיסמה חלשה (8–128 תווים)" });
  }
  const tokenHash = hashPasswordResetToken(token);
  const userId = consumePasswordReset(tokenHash);
  if (!userId) {
    return res.status(400).json({ error: "הקישור פג תוקף או כבר נוצל" });
  }
  updateUser(userId, { password_hash: hashPassword(password) });
  res.json({ ok: true, message: "הסיסמה עודכנה. ניתן להתחבר." });
});

app.get("/api/auth/me", adminAuth, (req, res) => {
  const u = getUserById(req.adminUser.id);
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  res.json({ user: userPublicJson(u) });
});

app.get("/api/users", adminAuth, (req, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: "אין הרשאה" });
  res.json(listUsersSafe());
});

app.post("/api/users", adminAuth, (req, res) => {
  try {
    if (!canManageUsers(req)) return res.status(403).json({ error: "אין הרשאה" });
    const email = String(req.body?.email || "").trim();
    const password = req.body?.password;
    const roleRaw = String(req.body?.role || "editor").toLowerCase();
    const role = ["admin", "editor", "viewer"].includes(roleRaw) ? roleRaw : "editor";
    if (!validateEmail(email)) return res.status(400).json({ error: "אימייל לא תקין" });
    if (!validatePassword(password)) return res.status(400).json({ error: "סיסמה: 8–128 תווים" });
    if (getUserByEmailForAuth(email)) return res.status(409).json({ error: "האימייל כבר רשום" });
    let allowed_elevator_id = null;
    if (role !== "admin") {
      allowed_elevator_id = normalizeAllowedElevatorId(req.body?.allowed_elevator_id);
      if (allowed_elevator_id && !getElevatorById(allowed_elevator_id)) {
        return res.status(400).json({ error: "מתקן לא קיים" });
      }
    }
    const name = String(req.body?.name || "").trim().slice(0, 200);
    const user = createUser({
      email,
      passwordHash: hashPassword(password),
      role,
      allowed_elevator_id,
      display_name: name || null,
    });
    const safe = getUserById(user.id);
    if (isMailConfigured()) {
      const origin = publicOrigin(req);
      const roleHe = { admin: "מנהל מערכת", editor: "עורך תוכן", viewer: "צופה" }[role] || role;
      sendMail({
        to: email,
        subject: "נוצר חשבון Pirsum",
        text: `שלום,\n\nנוצר עבורך חשבון בממשק ניהול Pirsum.\n\nאימייל: ${email}\nתפקיד: ${roleHe}\n\nכתובת הממשק:\n${origin}/admin/\n\nהסיסמה הראשונית הוגדרה על ידי המנהל — קבל אותה ממנו בערוץ מאובטח.\n`,
      }).catch((err) => console.warn("welcome mail failed", err));
    }
    res.status(201).json(safe);
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "האימייל כבר רשום" });
    }
    throw e;
  }
});

app.patch("/api/users/:id", adminAuth, (req, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: "אין הרשאה" });
  const id = req.params.id;
  if (!getUserById(id)) return res.status(404).json({ error: "not found" });
  const body = req.body || {};
  const updates = {};
  if (typeof body.email === "string") {
    const em = body.email.trim().toLowerCase();
    if (!validateEmail(em)) return res.status(400).json({ error: "אימייל לא תקין" });
    const other = getUserByEmailForAuth(em);
    if (other && other.id !== id) return res.status(409).json({ error: "האימייל תפוס" });
    updates.email = em;
  }
  if (body.password !== undefined && body.password !== "") {
    if (!validatePassword(body.password)) return res.status(400).json({ error: "סיסמה: 8–128 תווים" });
    updates.password_hash = hashPassword(body.password);
    deletePasswordResetsForUser(id);
  }
  if (body.role !== undefined) {
    const r = String(body.role).toLowerCase();
    if (!["admin", "editor", "viewer"].includes(r)) return res.status(400).json({ error: "תפקיד לא תקין" });
    updates.role = r;
    if (r === "admin") updates.allowed_elevator_id = null;
  }
  if (body.allowed_elevator_id !== undefined) {
    const current = getUserById(id);
    const effRole = updates.role !== undefined ? updates.role : current?.role;
    if (effRole === "admin") {
      updates.allowed_elevator_id = null;
    } else {
      const aid = normalizeAllowedElevatorId(body.allowed_elevator_id);
      if (aid && !getElevatorById(aid)) return res.status(400).json({ error: "מתקן לא קיים" });
      updates.allowed_elevator_id = aid;
    }
  }
  if (body.name !== undefined) {
    updates.display_name = String(body.name).trim().slice(0, 200);
  }
  if (!Object.keys(updates).length) return res.json(getUserById(id));
  const u = updateUser(id, updates);
  res.json(u);
});

app.delete("/api/users/:id", adminAuth, (req, res) => {
  if (!canManageUsers(req)) return res.status(403).json({ error: "אין הרשאה" });
  const id = req.params.id;
  if (!getUserById(id)) return res.status(404).json({ error: "not found" });
  if (countUsers() <= 1) return res.status(400).json({ error: "לא ניתן למחוק את המשתמש האחרון" });
  if (req.adminUser.id === id) return res.status(400).json({ error: "לא ניתן למחוק את עצמך" });
  deleteUserById(id);
  res.json({ ok: true });
});

/** כל קבצי המדיה בכל המתקנים — רק מנהל (פאנל ניהול גלובלי) */
app.get("/api/admin/all-media", adminAuth, requireAdminOnly, (req, res) => {
  res.json(listAllMediaWithElevators());
});

/** לוג פעולות — רק מנהל מערכת */
app.get("/api/admin/audit-log", adminAuth, requireAdminOnly, (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "100"), 10) || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
  res.json(listAuditLogs(limit, offset));
});

/** שליחת לוג פעולות למייל — רק מנהל מערכת */
app.post("/api/admin/audit-log/email", adminAuth, requireAdminOnly, async (req, res) => {
  if (!isMailConfigured()) {
    return res.status(503).json({ error: "שליחת מייל לא מוגדרת בשרת (SMTP)" });
  }
  const toRaw = String(req.body?.to || "").trim().toLowerCase();
  const actor = getUserById(req.adminUser.id);
  const to = validateEmail(toRaw) ? toRaw : actor?.email;
  if (!validateEmail(to)) {
    return res.status(400).json({ error: "כתובת יעד לא תקינה" });
  }
  const { rows, total } = listAuditLogs(500, 0);
  const lines = rows.map((r) => {
    const d = new Date(r.created_at).toISOString();
    return `${d}\t${r.actor_email || "—"}\t${r.action || ""}\t${r.detail || ""}\t${r.ip || ""}`;
  });
  const bodyText = `לוג פעולות Pirsum (מקס׳ 500 רשומות אחרונות מתוך ${total} בסך הכל)\n\n${lines.join("\n")}`;
  const sent = await sendMail({
    to,
    subject: `לוג פעולות Pirsum — ${new Date().toISOString().slice(0, 10)}`,
    text: bodyText,
  });
  if (!sent.ok) return res.status(500).json({ error: sent.error || "שליחה נכשלה" });
  res.json({ ok: true, to });
});

/** הגדרות גלובליות (DB) — רק מנהל מערכת */
app.get("/api/admin/settings", adminAuth, requireAdminOnly, (req, res) => {
  const smtp = getEffectiveSmtpForAdmin();
  res.json({
    smtp: {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      from: smtp.from,
      smtpPassConfigured: smtp.smtpPassConfigured,
    },
    googleClientId: getGoogleClientId(),
  });
});

app.put("/api/admin/settings", adminAuth, requireAdminOnly, (req, res) => {
  if (req.body && req.body.clearFromDatabase === true) {
    for (const k of SMTP_KEYS) deleteAppSettingKey(k);
    resetMailTransporter();
    return res.json({ ok: true, smtp: getEffectiveSmtpForAdmin(), googleClientId: getGoogleClientId() });
  }
  const sm = req.body?.smtp;
  const hasSmtp = sm && typeof sm === "object" && !Array.isArray(sm);
  const gRaw = req.body?.googleClientId;
  const hasGoogle = typeof gRaw === "string";
  if (!hasSmtp && !hasGoogle) {
    return res.status(400).json({ error: "חסר smtp או googleClientId" });
  }
  if (hasSmtp) {
    if (typeof sm.host === "string") setAppSettingKey("smtp_host", sm.host);
    if (sm.port != null && sm.port !== "") {
      const p = parseInt(String(sm.port), 10);
      if (!Number.isFinite(p) || p < 1 || p > 65535) {
        return res.status(400).json({ error: "פורט SMTP לא תקין" });
      }
      setAppSettingKey("smtp_port", String(p));
    }
    if (typeof sm.secure === "boolean") setAppSettingKey("smtp_secure", sm.secure ? "1" : "0");
    if (typeof sm.user === "string") setAppSettingKey("smtp_user", sm.user);
    if (typeof sm.from === "string") setAppSettingKey("mail_from", sm.from);
    if (sm.smtpPassClear === true) {
      setAppSettingKey("smtp_pass", "");
    } else if (typeof sm.pass === "string" && sm.pass.length > 0) {
      setAppSettingKey("smtp_pass", sm.pass);
    }
    resetMailTransporter();
  }
  if (hasGoogle) {
    setAppSettingKey("google_client_id", gRaw.trim());
  }
  res.json({ ok: true, smtp: getEffectiveSmtpForAdmin(), googleClientId: getGoogleClientId() });
});

app.post("/api/admin/settings/mail-test", adminAuth, requireAdminOnly, async (req, res) => {
  if (!isMailConfigured()) {
    return res.status(503).json({ error: "שליחת מייל לא מוגדרת (חסר host או מען)" });
  }
  const actor = getUserById(req.adminUser.id);
  const toRaw = String(req.body?.to || actor?.email || "").trim().toLowerCase();
  const to = validateEmail(toRaw) ? toRaw : "";
  if (!to) {
    return res.status(400).json({ error: "כתובת יעד לבדיקה לא תקינה" });
  }
  const sent = await sendMail({
    to,
    subject: "בדיקת Pirsum — SMTP",
    text: "זוהי הודעת בדיקה מממשק הניהול. אם קיבלת אותה, שליחת המייל מוגדרת כראוי.\n",
  });
  if (sent.skipped) return res.status(503).json({ error: "שליחת מייל לא מוגדרת" });
  if (!sent.ok) return res.status(500).json({ error: sent.error || "שליחה נכשלה" });
  res.json({ ok: true, to });
});

/** תצוגת מזג אוויר מהשדות בטופס (Open-Meteo) — כל משתמש מחובר */
app.post("/api/admin/weather-preview", adminAuth, async (req, res) => {
  const city = String(req.body?.city_label ?? req.body?.city ?? "").trim();
  const { lat, lon } = normalizeWeatherCoords(req.body?.latitude, req.body?.longitude);
  const out = await fetchOpenMeteoCurrent(lat, lon, city, { includeDiag: true });
  res.json({ ...out, lat, lon, source: "open-meteo.com" });
});

app.post("/api/admin/client-downloads", adminAuth, requireAdminOnly, (req, res, next) => {
  uploadClientDownload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "העלאה נכשלה" });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: "לא נבחר קובץ" });
  const name = req.file.filename;
  res.status(201).json({
    ok: true,
    file: { name, url: "/downloads/" + encodeURIComponent(name) },
  });
});

app.delete("/api/admin/client-downloads/:filename", adminAuth, requireAdminOnly, (req, res) => {
  const name = safeClientDownloadBasename(decodeURIComponent(String(req.params.filename || "")));
  if (!name) return res.status(400).json({ error: "שם קובץ לא תקין" });
  const full = path.join(downloadsDir, name);
  const resolvedDir = path.resolve(downloadsDir);
  const resolvedFile = path.resolve(full);
  if (!resolvedFile.startsWith(resolvedDir + path.sep) && resolvedFile !== resolvedDir) {
    return res.status(400).json({ error: "נתיב לא תקין" });
  }
  try {
    if (!fs.existsSync(full)) return res.status(404).json({ error: "הקובץ לא נמצא" });
    fs.unlinkSync(full);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "מחיקה נכשלה" });
  }
});

app.get("/api/elevators", adminAuth, (req, res) => {
  const all = listElevators();
  const scoped = getScopedElevatorId(req);
  if (scoped == null) return res.json(all);
  res.json(all.filter((e) => e.id === scoped));
});

app.post("/api/elevators", adminAuth, requireElevatorEdit, (req, res) => {
  if (getScopedElevatorId(req)) return res.status(403).json({ error: "אין הרשאה ליצור מתקן" });
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const row = createElevator({ name });
  res.status(201).json(row);
});

app.post("/api/elevators/:id/duplicate", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  if (getScopedElevatorId(req)) return res.status(403).json({ error: "אין הרשאה לשכפל מתקן" });
  const sourceId = req.params.id;
  if (!getElevatorById(sourceId)) return res.status(404).json({ error: "not found" });
  const nameRaw = req.body?.name;
  const name = nameRaw != null && String(nameRaw).trim() !== "" ? String(nameRaw).trim() : null;
  try {
    const row = duplicateElevator(sourceId, { name, uploadsRoot });
    if (!row) return res.status(404).json({ error: "not found" });
    notifyElevator(row.id, { reason: "config" });
    res.status(201).json(row);
  } catch (e) {
    console.error("duplicateElevator", e);
    res.status(500).json({ error: "שכפול המתקן נכשל" });
  }
});

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampFontPx(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

app.patch("/api/elevators/:id", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  const body = { ...(req.body || {}) };
  if (typeof body.rss_url === "string") body.rss_url = body.rss_url.trim();
  if (typeof body.rss_ticker_text === "string") body.rss_ticker_text = body.rss_ticker_text;
  if (typeof body.exit_password === "string") body.exit_password = body.exit_password.trim();
  if (typeof body.header_phone === "string") body.header_phone = body.header_phone.trim();
  if (body.rss_track_duration_sec !== undefined) {
    body.rss_track_duration_sec = clampInt(body.rss_track_duration_sec, 15, 600, 48);
  }
  if (body.side_ticker_duration_sec !== undefined) {
    body.side_ticker_duration_sec = clampInt(body.side_ticker_duration_sec, 20, 900, 150);
  }
  if (body.font_clock_time_px !== undefined) {
    body.font_clock_time_px = clampFontPx(body.font_clock_time_px, 14, 72, 24);
  }
  if (body.font_clock_date_px !== undefined) {
    body.font_clock_date_px = clampFontPx(body.font_clock_date_px, 10, 42, 14);
  }
  if (body.font_weather_px !== undefined) {
    body.font_weather_px = clampFontPx(body.font_weather_px, 10, 42, 16);
  }
  if (body.font_brand_px !== undefined) {
    body.font_brand_px = clampFontPx(body.font_brand_px, 12, 56, 20);
  }
  if (body.logo_max_height_px !== undefined) {
    body.logo_max_height_px = clampFontPx(body.logo_max_height_px, 24, 120, 48);
  }
  if (body.font_side_ticker_px !== undefined) {
    body.font_side_ticker_px = clampFontPx(body.font_side_ticker_px, 8, 36, 14);
  }
  if (body.font_rss_px !== undefined) {
    body.font_rss_px = clampFontPx(body.font_rss_px, 8, 36, 15);
  }
  if (body.media_scale_percent !== undefined) {
    body.media_scale_percent = clampInt(body.media_scale_percent, 50, 150, 100);
  }
  if (body.latitude !== undefined) {
    let lat = parseWeatherCoord(body.latitude, DEFAULT_WEATHER_LAT);
    if (lat < -90 || lat > 90) lat = DEFAULT_WEATHER_LAT;
    body.latitude = lat;
  }
  if (body.longitude !== undefined) {
    let lon = parseWeatherCoord(body.longitude, DEFAULT_WEATHER_LON);
    if (lon < -180 || lon > 180) lon = DEFAULT_WEATHER_LON;
    body.longitude = lon;
  }
  const row = updateElevator(id, body);
  notifyElevator(id, { reason: "config" });
  res.json(row);
});

app.delete("/api/elevators/:id", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  if (getScopedElevatorId(req)) return res.status(403).json({ error: "אין הרשאה למחוק מתקן" });
  const id = req.params.id;
  const row = getElevatorById(id);
  if (!row) return res.status(404).json({ error: "not found" });
  deleteElevator(id);
  const dir = path.join(uploadsRoot, id);
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

function removeMediaFile(elevatorId, filename) {
  if (!filename) return;
  const dir = path.resolve(uploadsRoot, elevatorId);
  const fp = path.resolve(dir, path.basename(filename));
  if (!fp.startsWith(dir)) return;
  fs.rmSync(fp, { force: true });
}

function buildMediaUrl(req, e, filename) {
  const base = publicOrigin(req);
  const tokenQ = `token=${encodeURIComponent(e.token)}`;
  return `${base}/api/player/media/${encodeURIComponent(filename)}?${tokenQ}`;
}

app.post("/api/elevators/:id/media", adminAuth, requireElevatorAccess, requireElevatorEdit, uploadMediaFlexible, (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  const files = req.files?.length ? req.files : req.file ? [req.file] : [];
  if (!files.length) return res.status(400).json({ error: "file required" });
  for (const f of files) {
    const ext = path.extname(f.filename).toLowerCase();
    const video = [".mp4", ".webm", ".mov"].includes(ext);
    addMediaForElevator(id, f.filename, video ? "video" : "image");
  }
  notifyElevator(id, { reason: "media" });
  res.json(listElevators().find((x) => x.id === id));
});

app.delete("/api/elevators/:id/media/:mediaId", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  const mediaId = req.params.mediaId;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  if (!mediaBelongsToElevator(mediaId, id)) return res.status(404).json({ error: "not found" });
  const row = deleteMediaById(mediaId);
  if (row) removeMediaFile(row.elevator_id, row.filename);
  notifyElevator(id, { reason: "media_deleted" });
  res.json(listElevators().find((x) => x.id === id));
});

app.delete("/api/elevators/:id/media", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  const rows = deleteAllMediaForElevator(id);
  for (const r of rows) {
    removeMediaFile(id, r.filename);
  }
  notifyElevator(id, { reason: "media_deleted" });
  res.json(listElevators().find((x) => x.id === id));
});

app.patch("/api/elevators/:id/media-order", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  const order = req.body?.order;
  if (!Array.isArray(order)) return res.status(400).json({ error: "order array required" });
  const current = listMediaForElevator(id).map((m) => m.id);
  const valid = order.every((mid) => current.includes(mid)) && order.length === current.length;
  if (!valid) return res.status(400).json({ error: "invalid order" });
  reorderMediaForElevator(id, order);
  notifyElevator(id, { reason: "media_order" });
  res.json(listElevators().find((x) => x.id === id));
});

app.get("/api/elevators/:id/logo", adminAuth, requireElevatorAccess, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e?.logo_filename) return res.status(404).json({ error: "no logo" });
  const root = path.resolve(elevatorUploadDir(id));
  const fp = path.resolve(root, path.basename(e.logo_filename));
  if (!fp.startsWith(root) || !fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

app.post("/api/elevators/:id/logo", adminAuth, requireElevatorAccess, requireElevatorEdit, uploadLogo.single("file"), (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  if (!req.file) return res.status(400).json({ error: "file required" });
  const e = getElevatorById(id);
  if (e.logo_filename) removeMediaFile(id, e.logo_filename);
  updateElevator(id, { logo_filename: req.file.filename });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.delete("/api/elevators/:id/logo", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e) return res.status(404).json({ error: "not found" });
  if (e.logo_filename) removeMediaFile(id, e.logo_filename);
  updateElevator(id, { logo_filename: "" });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.get("/api/elevators/:id/background", adminAuth, requireElevatorAccess, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e?.background_filename) return res.status(404).json({ error: "no background" });
  const root = path.resolve(elevatorUploadDir(id));
  const fp = path.resolve(root, path.basename(e.background_filename));
  if (!fp.startsWith(root) || !fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

app.post("/api/elevators/:id/background", adminAuth, requireElevatorAccess, requireElevatorEdit, uploadBackground.single("file"), (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  if (!req.file) return res.status(400).json({ error: "file required" });
  const e = getElevatorById(id);
  if (e.background_filename) removeMediaFile(id, e.background_filename);
  updateElevator(id, { background_filename: req.file.filename });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.delete("/api/elevators/:id/background", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e) return res.status(404).json({ error: "not found" });
  if (e.background_filename) removeMediaFile(id, e.background_filename);
  updateElevator(id, { background_filename: "" });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.get("/api/elevators/:id/logo-left", adminAuth, requireElevatorAccess, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e?.logo_left_filename) return res.status(404).json({ error: "no logo" });
  const root = path.resolve(elevatorUploadDir(id));
  const fp = path.resolve(root, path.basename(e.logo_left_filename));
  if (!fp.startsWith(root) || !fs.existsSync(fp)) return res.status(404).end();
  res.sendFile(fp);
});

app.post("/api/elevators/:id/logo-left", adminAuth, requireElevatorAccess, requireElevatorEdit, uploadLogo.single("file"), (req, res) => {
  const id = req.params.id;
  if (!getElevatorById(id)) return res.status(404).json({ error: "not found" });
  if (!req.file) return res.status(400).json({ error: "file required" });
  const e = getElevatorById(id);
  if (e.logo_left_filename) removeMediaFile(id, e.logo_left_filename);
  updateElevator(id, { logo_left_filename: req.file.filename });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.delete("/api/elevators/:id/logo-left", adminAuth, requireElevatorAccess, requireElevatorEdit, (req, res) => {
  const id = req.params.id;
  const e = getElevatorById(id);
  if (!e) return res.status(404).json({ error: "not found" });
  if (e.logo_left_filename) removeMediaFile(id, e.logo_left_filename);
  updateElevator(id, { logo_left_filename: "" });
  notifyElevator(id, { reason: "config" });
  res.json(listElevators().find((x) => x.id === id));
});

app.get("/api/player/config", playerAuth, (req, res) => {
  const e = req.elevator;
  const items = listMediaForElevator(e.id).map((m) => ({
    id: m.id,
    media_type: m.media_type,
    media_url: buildMediaUrl(req, e, m.filename),
  }));
  const exitPwd = e.exit_password != null && String(e.exit_password).length > 0 ? String(e.exit_password) : "12345";
  const rssDur = e.rss_track_duration_sec != null ? clampInt(e.rss_track_duration_sec, 15, 600, 48) : 48;
  const sideDur = e.side_ticker_duration_sec != null ? clampInt(e.side_ticker_duration_sec, 20, 900, 150) : 150;
  res.json({
    elevatorId: e.id,
    name: e.name,
    logo_url: e.logo_filename ? buildMediaUrl(req, e, e.logo_filename) : null,
    logo_left_url: e.logo_left_filename ? buildMediaUrl(req, e, e.logo_left_filename) : null,
    background_url: e.background_filename ? buildMediaUrl(req, e, e.background_filename) : null,
    header_phone: e.header_phone != null ? String(e.header_phone) : "",
    rss_url: e.rss_url || "",
    latitude: e.latitude,
    longitude: e.longitude,
    city_label: e.city_label || "",
    side_ticker_text: e.side_ticker_text || "",
    rss_ticker_text: e.rss_ticker_text || "",
    rss_track_duration_sec: rssDur,
    side_ticker_duration_sec: sideDur,
    media_items: items,
    updated_at: e.updated_at,
    exit_password: exitPwd,
    font_clock_time_px: clampFontPx(e.font_clock_time_px, 14, 72, 24),
    font_clock_date_px: clampFontPx(e.font_clock_date_px, 10, 42, 14),
    font_weather_px: clampFontPx(e.font_weather_px, 10, 42, 16),
    font_brand_px: clampFontPx(e.font_brand_px, 12, 56, 20),
    logo_max_height_px: clampFontPx(e.logo_max_height_px, 24, 120, 48),
    font_side_ticker_px: clampFontPx(e.font_side_ticker_px, 8, 36, 14),
    font_rss_px: clampFontPx(e.font_rss_px, 8, 36, 15),
    media_scale_percent: clampInt(e.media_scale_percent, 50, 150, 100),
  });
});

app.post("/api/player/ping", playerAuth, (req, res) => {
  touchLastSeen(req.elevator.id);
  res.json({ ok: true, at: Date.now() });
});

app.get("/api/player/rss", playerAuth, async (req, res) => {
  try {
    const url = req.elevator.rss_url;
    const items = await fetchRssItems(url, 40);
    res.json({ items });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err), items: [] });
  }
});

/** מזג אוויר דרך השרת — הנגן לא פונה ישירות ל־Open-Meteo (CSP / WebView / רשת) */
app.get("/api/player/weather", playerAuth, async (req, res) => {
  const e = req.elevator;
  const { lat, lon } = elevatorWeatherCoords(e);
  const city = e.city_label || "";
  const out = await fetchOpenMeteoCurrent(lat, lon, city);
  res.json(out);
});

app.get("/api/player/media/:filename", playerAuth, (req, res) => {
  const filename = req.params.filename;
  const dir = path.join(uploadsRoot, req.elevator.id);
  const filePath = path.join(dir, path.basename(filename));
  if (!filePath.startsWith(dir)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.sendFile(filePath);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

const server = http.createServer(app);
attachRealtime(server, {
  getElevatorByToken,
  onPlayerConnected: (elevatorId) => touchLastSeen(elevatorId),
});

server.listen(PORT, () => {
  const pub = process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/$/, "");
  if (pub) {
    const ws = pub.replace(/^https/i, "wss");
    console.log(`Pirsum ציבורי: ${pub}`);
    console.log(`ניהול: ${pub}/admin/`);
    console.log(`WebSocket נגנים: ${ws}/ws`);
  } else {
    console.log(`Pirsum מקומי: http://localhost:${PORT}`);
    console.log(`ניהול: http://localhost:${PORT}/admin/`);
    console.log(`WebSocket נגנים: ws://localhost:${PORT}/ws`);
  }
});
