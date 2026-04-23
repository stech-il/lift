import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR?.trim();
const dbPath =
  process.env.DB_PATH?.trim() ||
  (dataDir ? path.join(dataDir, "pirsum.db") : path.join(__dirname, "..", "data", "pirsum.db"));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS elevators (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    rss_url TEXT DEFAULT '',
    latitude REAL DEFAULT 32.0853,
    longitude REAL DEFAULT 34.7818,
    city_label TEXT DEFAULT 'תל אביב',
    side_ticker_text TEXT DEFAULT '',
    media_type TEXT DEFAULT '',
    media_filename TEXT DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS elevator_media (
    id TEXT PRIMARY KEY,
    elevator_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (elevator_id) REFERENCES elevators(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_elevator_media_elev ON elevator_media(elevator_id);

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin'
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`);

(() => {
  const cols = db.prepare(`PRAGMA table_info(elevators)`).all();
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("exit_password")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN exit_password TEXT DEFAULT '12345'`);
  }
  if (!names.has("last_seen_at")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN last_seen_at INTEGER DEFAULT 0`);
  }
  if (!names.has("rss_track_duration_sec")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN rss_track_duration_sec INTEGER DEFAULT 48`);
  }
  if (!names.has("side_ticker_duration_sec")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN side_ticker_duration_sec INTEGER DEFAULT 150`);
  }
  if (!names.has("logo_filename")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN logo_filename TEXT DEFAULT ''`);
  }
  if (!names.has("rss_ticker_text")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN rss_ticker_text TEXT DEFAULT ''`);
  }
  if (!names.has("font_clock_time_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_clock_time_px INTEGER DEFAULT 24`);
  }
  if (!names.has("font_clock_date_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_clock_date_px INTEGER DEFAULT 14`);
  }
  if (!names.has("font_weather_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_weather_px INTEGER DEFAULT 16`);
  }
  if (!names.has("font_brand_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_brand_px INTEGER DEFAULT 20`);
  }
  if (!names.has("logo_max_height_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN logo_max_height_px INTEGER DEFAULT 48`);
  }
  if (!names.has("font_side_ticker_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_side_ticker_px INTEGER DEFAULT 14`);
  }
  if (!names.has("font_rss_px")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN font_rss_px INTEGER DEFAULT 15`);
  }
  if (!names.has("media_scale_percent")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN media_scale_percent INTEGER DEFAULT 100`);
  }
  if (!names.has("background_filename")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN background_filename TEXT DEFAULT ''`);
  }
  if (!names.has("header_phone")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN header_phone TEXT DEFAULT ''`);
  }
  if (!names.has("logo_left_filename")) {
    db.exec(`ALTER TABLE elevators ADD COLUMN logo_left_filename TEXT DEFAULT ''`);
  }
})();

(() => {
  const ucols = db.prepare(`PRAGMA table_info(users)`).all();
  const unames = new Set(ucols.map((c) => c.name));
  if (!unames.has("allowed_elevator_id")) {
    db.exec(`ALTER TABLE users ADD COLUMN allowed_elevator_id TEXT`);
  }
  if (!unames.has("google_sub")) {
    db.exec(`ALTER TABLE users ADD COLUMN google_sub TEXT`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL AND trim(google_sub) != ''`);
  }
  if (!unames.has("display_name")) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT ''`);
  }
})();

(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
  `);
})();

(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      actor_id TEXT,
      actor_email TEXT,
      action TEXT NOT NULL,
      method TEXT,
      path TEXT,
      status_code INTEGER,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  `);
})();

(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
})();

export function getAppSettingsRow(key) {
  return db.prepare(`SELECT value, updated_at FROM app_settings WHERE key = ?`).get(String(key));
}

export function hasAppSettingKey(key) {
  return !!db.prepare(`SELECT 1 FROM app_settings WHERE key = ?`).get(String(key));
}

export function setAppSettingKey(key, value) {
  const k = String(key);
  const v = value === undefined || value === null ? null : String(value);
  const t = Date.now();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(k, v, t);
}

export function deleteAppSettingKey(key) {
  db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(String(key));
}

export function insertAuditLog({ actorId, actorEmail, action, method, path, statusCode, detail, ip }) {
  const id = randomUUID();
  const created = Date.now();
  const em = actorEmail != null && String(actorEmail).trim() !== "" ? String(actorEmail).trim() : "—";
  const det = detail != null ? String(detail).slice(0, 12000) : "";
  db.prepare(
    `INSERT INTO audit_log (id, created_at, actor_id, actor_email, action, method, path, status_code, detail, ip) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, created, actorId || null, em, action, method || "", path || "", statusCode ?? null, det, ip || "");
}

export function listAuditLogs(limit, offset) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_log`).get().c;
  const rows = db
    .prepare(
      `SELECT id, created_at, actor_id, actor_email, action, method, path, status_code, detail, ip FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(lim, off);
  return { rows, total, limit: lim, offset: off };
}

function migrateLegacyMedia() {
  const rows = db
    .prepare(
      `SELECT id, media_filename, media_type FROM elevators WHERE media_filename IS NOT NULL AND trim(media_filename) != ''`
    )
    .all();
  for (const r of rows) {
    const n = db.prepare(`SELECT COUNT(*) as c FROM elevator_media WHERE elevator_id = ?`).get(r.id).c;
    if (n > 0) continue;
    const id = randomUUID();
    const type = r.media_type === "video" ? "video" : "image";
    const max = -1;
    const sort = max + 1;
    const created = Date.now();
    db.prepare(
      `INSERT INTO elevator_media (id, elevator_id, filename, media_type, sort_order, created_at) VALUES (?,?,?,?,?,?)`
    ).run(id, r.id, r.media_filename, type, sort, created);
    db.prepare(`UPDATE elevators SET updated_at = ? WHERE id = ?`).run(Date.now(), r.id);
  }
}

migrateLegacyMedia();

export function touchElevator(id) {
  db.prepare(`UPDATE elevators SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function listMediaForElevator(elevatorId) {
  return db
    .prepare(
      `SELECT id, filename, media_type, sort_order, created_at FROM elevator_media WHERE elevator_id = ? ORDER BY sort_order ASC, created_at ASC`
    )
    .all(elevatorId);
}

/** רשימת כל קבצי המדיה בכל המתקנים — לפאנל מנהל */
export function listAllMediaWithElevators() {
  return db
    .prepare(
      `SELECT m.id, m.elevator_id, m.filename, m.media_type, m.sort_order, m.created_at,
              e.name AS elevator_name
       FROM elevator_media m
       INNER JOIN elevators e ON e.id = m.elevator_id
       ORDER BY e.name COLLATE NOCASE ASC, m.sort_order ASC, m.created_at ASC`
    )
    .all();
}

export function listElevators() {
  const rows = db
    .prepare(
      `SELECT id, name, token, rss_url, latitude, longitude, city_label, side_ticker_text, rss_ticker_text, updated_at, exit_password, last_seen_at, rss_track_duration_sec, side_ticker_duration_sec, logo_filename, background_filename, header_phone, logo_left_filename,
       font_clock_time_px, font_clock_date_px, font_weather_px, font_brand_px, logo_max_height_px, font_side_ticker_px, font_rss_px, media_scale_percent FROM elevators ORDER BY name`
    )
    .all();
  for (const e of rows) {
    e.media = listMediaForElevator(e.id);
  }
  return rows;
}

export function touchLastSeen(elevatorId) {
  db.prepare(`UPDATE elevators SET last_seen_at = ? WHERE id = ?`).run(Date.now(), elevatorId);
}

export function getElevatorByToken(token) {
  return db.prepare(`SELECT * FROM elevators WHERE token = ?`).get(token);
}

export function getElevatorById(id) {
  return db.prepare(`SELECT * FROM elevators WHERE id = ?`).get(id);
}

export function createElevator({ name }) {
  const id = randomUUID();
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "").slice(0, 8);
  const updated_at = Date.now();
  db.prepare(`INSERT INTO elevators (id, name, token, updated_at) VALUES (?, ?, ?, ?)`).run(id, name, token, updated_at);
  const row = getElevatorById(id);
  row.media = [];
  return row;
}

export function updateElevator(id, fields) {
  const allowed = [
    "name",
    "rss_url",
    "latitude",
    "longitude",
    "city_label",
    "side_ticker_text",
    "rss_ticker_text",
    "exit_password",
    "rss_track_duration_sec",
    "side_ticker_duration_sec",
    "logo_filename",
    "background_filename",
    "header_phone",
    "logo_left_filename",
    "font_clock_time_px",
    "font_clock_date_px",
    "font_weather_px",
    "font_brand_px",
    "logo_max_height_px",
    "font_side_ticker_px",
    "font_rss_px",
    "media_scale_percent",
  ];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getElevatorById(id);
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  db.prepare(`UPDATE elevators SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getElevatorById(id);
}

export function deleteElevator(id) {
  db.prepare(`DELETE FROM elevators WHERE id = ?`).run(id);
}

function copyUploadFileIfExists(sourceDir, destDir, filename) {
  if (filename == null) return;
  const base = String(filename).trim();
  if (!base) return;
  const b = path.basename(base);
  const from = path.join(sourceDir, b);
  const to = path.join(destDir, b);
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * שכפול מתקן: הגדרות (טוקן חדש) + מדיה ולוגואים – קבצים מועתקים לתיקיית היעד.
 * @param {string} sourceId
 * @param {{ name?: string | null, uploadsRoot: string }} opts
 */
export function duplicateElevator(sourceId, { name, uploadsRoot } = {}) {
  if (!uploadsRoot || typeof uploadsRoot !== "string") {
    throw new Error("uploadsRoot required");
  }
  const src = getElevatorById(sourceId);
  if (!src) return null;
  const nameTrim = name != null ? String(name).trim() : "";
  const newName = nameTrim
    ? nameTrim.slice(0, 200)
    : `${String(src.name || "מתקן").trim()} (העתק)`.slice(0, 200);

  let n = null;
  try {
    n = createElevator({ name: newName });
    const newId = n.id;
    const fields = {
      name: newName,
      rss_url: src.rss_url,
      latitude: src.latitude,
      longitude: src.longitude,
      city_label: src.city_label,
      side_ticker_text: src.side_ticker_text,
      rss_ticker_text: src.rss_ticker_text,
      exit_password: src.exit_password,
      rss_track_duration_sec: src.rss_track_duration_sec,
      side_ticker_duration_sec: src.side_ticker_duration_sec,
      logo_filename: src.logo_filename,
      background_filename: src.background_filename,
      header_phone: src.header_phone,
      logo_left_filename: src.logo_left_filename,
      font_clock_time_px: src.font_clock_time_px,
      font_clock_date_px: src.font_clock_date_px,
      font_weather_px: src.font_weather_px,
      font_brand_px: src.font_brand_px,
      logo_max_height_px: src.logo_max_height_px,
      font_side_ticker_px: src.font_side_ticker_px,
      font_rss_px: src.font_rss_px,
      media_scale_percent: src.media_scale_percent,
    };
    updateElevator(newId, fields);
    const srcU = path.join(uploadsRoot, sourceId);
    const dstU = path.join(uploadsRoot, newId);
    fs.mkdirSync(dstU, { recursive: true });
    for (const fn of [src.logo_filename, src.background_filename, src.logo_left_filename]) {
      copyUploadFileIfExists(srcU, dstU, fn);
    }
    const mediaList = listMediaForElevator(sourceId);
    for (const m of mediaList) {
      const b = path.basename(m.filename);
      copyUploadFileIfExists(srcU, dstU, b);
      addMediaForElevator(newId, b, m.media_type);
    }
    const row = getElevatorById(newId);
    row.media = listMediaForElevator(newId);
    return row;
  } catch (e) {
    if (n?.id) {
      try {
        deleteElevator(n.id);
        const dir = path.join(uploadsRoot, n.id);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}

export function addMediaForElevator(elevatorId, filename, mediaType) {
  const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) as m FROM elevator_media WHERE elevator_id = ?`).get(elevatorId);
  const sort = maxRow.m + 1;
  const mid = randomUUID();
  const created = Date.now();
  db.prepare(
    `INSERT INTO elevator_media (id, elevator_id, filename, media_type, sort_order, created_at) VALUES (?,?,?,?,?,?)`
  ).run(mid, elevatorId, filename, mediaType, sort, created);
  touchElevator(elevatorId);
  return mid;
}

export function deleteMediaById(mediaId) {
  const row = db.prepare(`SELECT * FROM elevator_media WHERE id = ?`).get(mediaId);
  if (!row) return null;
  db.prepare(`DELETE FROM elevator_media WHERE id = ?`).run(mediaId);
  touchElevator(row.elevator_id);
  return row;
}

export function getMediaById(mediaId) {
  return db.prepare(`SELECT * FROM elevator_media WHERE id = ?`).get(mediaId);
}

export function mediaBelongsToElevator(mediaId, elevatorId) {
  const r = db.prepare(`SELECT 1 FROM elevator_media WHERE id = ? AND elevator_id = ?`).get(mediaId, elevatorId);
  return !!r;
}

export function reorderMediaForElevator(elevatorId, orderedIds) {
  const stmt = db.prepare(`UPDATE elevator_media SET sort_order = ? WHERE id = ? AND elevator_id = ?`);
  orderedIds.forEach((mid, i) => {
    stmt.run(i, mid, elevatorId);
  });
  touchElevator(elevatorId);
}

export function deleteAllMediaForElevator(elevatorId) {
  const rows = db.prepare(`SELECT filename FROM elevator_media WHERE elevator_id = ?`).all(elevatorId);
  db.prepare(`DELETE FROM elevator_media WHERE elevator_id = ?`).run(elevatorId);
  touchElevator(elevatorId);
  return rows;
}

export function countUsers() {
  return db.prepare(`SELECT COUNT(*) as c FROM users`).get().c;
}

function normalizeDisplayName(raw) {
  if (raw == null) return "";
  return String(raw).trim().slice(0, 200);
}

export function createUser({ email, passwordHash, role = "editor", allowed_elevator_id = null, display_name = null }) {
  const id = randomUUID();
  const em = String(email).toLowerCase().trim();
  const created = Date.now();
  const r = ["admin", "editor", "viewer"].includes(role) ? role : "editor";
  let aid = null;
  if (r === "admin") {
    aid = null;
  } else if (allowed_elevator_id != null && String(allowed_elevator_id).trim() !== "") {
    aid = String(allowed_elevator_id).trim();
  }
  const dname = normalizeDisplayName(display_name);
  db.prepare(
    `INSERT INTO users (id, email, password_hash, created_at, role, allowed_elevator_id, display_name) VALUES (?,?,?,?,?,?,?)`
  ).run(id, em, passwordHash, created, r, aid, dname);
  return getUserById(id);
}

export function updateUser(id, fields) {
  const allowed = ["email", "password_hash", "role", "allowed_elevator_id", "display_name"];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(fields[k]);
    }
  }
  if (!sets.length) return getUserById(id);
  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getUserById(id);
}

export function getUserById(id) {
  return db
    .prepare(`SELECT id, email, created_at, role, allowed_elevator_id, display_name FROM users WHERE id = ?`)
    .get(id);
}

export function getUserByEmailForAuth(email) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).get(String(email).toLowerCase().trim());
}

export function listUsersSafe() {
  return db
    .prepare(
      `SELECT id, email, created_at, role, allowed_elevator_id, display_name FROM users ORDER BY created_at ASC`
    )
    .all();
}

export function deleteUserById(id) {
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

export function deletePasswordResetsForUser(userId) {
  db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(userId);
}

export function insertPasswordReset(userId, tokenHash, expiresAt) {
  const id = randomUUID();
  const now = Date.now();
  deletePasswordResetsForUser(userId);
  db.prepare(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)`
  ).run(id, userId, tokenHash, expiresAt, now);
}

export function consumePasswordReset(tokenHash) {
  const row = db.prepare(`SELECT user_id FROM password_resets WHERE token_hash = ? AND expires_at > ?`).get(tokenHash, Date.now());
  if (!row) return null;
  db.prepare(`DELETE FROM password_resets WHERE token_hash = ?`).run(tokenHash);
  return row.user_id;
}

export function getUserByGoogleSub(sub) {
  const s = String(sub || "").trim();
  if (!s) return null;
  return db.prepare(`SELECT * FROM users WHERE google_sub = ?`).get(s);
}

export function setUserGoogleSub(userId, sub) {
  const s = sub != null ? String(sub).trim() : "";
  db.prepare(`UPDATE users SET google_sub = ? WHERE id = ?`).run(s || null, userId);
  return getUserById(userId);
}

export default db;
