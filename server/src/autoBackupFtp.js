import fs from "fs";
import cron from "node-cron";
import { Client } from "basic-ftp";
import { getAppSettingsRow, setAppSettingKey, insertAuditLog } from "./db.js";
import { writeFullBackupZipToFile } from "./backupZip.js";

const CONFIG_KEY = "auto_backup_config";

const defaultConfig = () => ({
  enabled: false,
  cron: "0 0 * * *",
  timezone: "Asia/Jerusalem",
  targets: [],
});

function parseConfigRaw(raw) {
  if (!raw || !String(raw).trim()) return defaultConfig();
  try {
    const o = JSON.parse(String(raw));
    if (!o || typeof o !== "object") return defaultConfig();
    return {
      enabled: Boolean(o.enabled),
      cron: typeof o.cron === "string" && o.cron.trim() ? o.cron.trim() : "0 0 * * *",
      timezone: typeof o.timezone === "string" && o.timezone.trim() ? o.timezone.trim() : "Asia/Jerusalem",
      targets: Array.isArray(o.targets) ? o.targets : [],
    };
  } catch {
    return defaultConfig();
  }
}

function getStoredConfig() {
  const row = getAppSettingsRow(CONFIG_KEY);
  return parseConfigRaw(row?.value);
}

function applyEnvOverride(base) {
  if (String(process.env.AUTO_BACKUP_DISABLE || "").toLowerCase() === "1" || process.env.AUTO_BACKUP_DISABLE === "true") {
    return { ...base, enabled: false };
  }
  const j = process.env.AUTO_BACKUP_FTP_CONFIG?.trim();
  if (j) {
    try {
      return parseConfigRaw(j);
    } catch (e) {
      console.error("AUTO_BACKUP_FTP_CONFIG", e);
    }
  }
  return base;
}

/**
 * @returns {ReturnType<defaultConfig> & { targets: Array<{host,port,user,path,secure,pass}> } }
 */
export function getEffectiveAutoBackupConfig() {
  const base = getStoredConfig();
  const c = applyEnvOverride(base);
  c.targets = (c.targets || [])
    .map((t) => ({
      host: String(t.host || "").trim(),
      port: Math.min(65535, Math.max(1, parseInt(String(t.port || 21), 10) || 21)),
      user: String(t.user || "").trim(),
      pass: t.pass == null ? "" : String(t.pass),
      path: (() => {
        const p = String(t.path || "/").trim() || "/";
        return p.startsWith("/") ? p : `/${p}`;
      })(),
      secure: t.secure === true || t.secure === "1" || String(t.secure) === "true",
    }))
    .filter((t) => t.host && t.user);
  return c;
}

function targetsForResponse(config) {
  return (config.targets || []).map((t) => ({
    host: t.host,
    port: t.port,
    user: t.user,
    path: t.path,
    secure: t.secure,
    passSet: Boolean(t.pass && String(t.pass).length > 0),
  }));
}

export function getAutoBackupForAdmin() {
  const c = getEffectiveAutoBackupConfig();
  return {
    enabled: c.enabled,
    cron: c.cron,
    timezone: c.timezone,
    targets: targetsForResponse(c),
  };
}

/**
 * @param {object} body — מגוף PUT /api/admin/settings
 * @param {object | null} existing — before merge, from getEffectiveAutoBackupConfig
 */
export function saveAutoBackupFromRequest(body) {
  const ab = body?.autoBackup;
  if (!ab || typeof ab !== "object") return null;
  const stored = getStoredConfig();
  const prev = { ...defaultConfig(), ...stored, targets: stored.targets || [] };
  const next = { ...defaultConfig() };
  next.enabled = typeof ab.enabled === "boolean" ? ab.enabled : prev.enabled;
  next.cron = typeof ab.cron === "string" && ab.cron.trim() ? ab.cron.trim() : prev.cron;
  next.timezone = typeof ab.timezone === "string" && ab.timezone.trim() ? ab.timezone.trim() : prev.timezone;
  if (!cron.validate(next.cron)) {
    const err = new Error("ביטוי cron לא תקין (בדקו חמש שדות: דקה שעה יום בחודש שבוע)");
    err.code = "INVALID_CRON";
    throw err;
  }
  if (Array.isArray(ab.targets)) {
    const prevT = (prev.targets || []).slice();
    next.targets = ab.targets
      .slice(0, 20)
      .map((t, i) => {
        const old = prevT[i];
        const pIn = t && t.pass;
        const pass = typeof pIn === "string" && pIn.length > 0 ? pIn : (old && old.pass) || "";
        return {
          host: String(t.host || "").trim(),
          port: Math.min(65535, Math.max(1, parseInt(String(t.port != null && t.port !== "" ? t.port : 21), 10) || 21)),
          user: String(t.user || "").trim(),
          pass,
          path: (() => {
            let p = String(t.path == null || t.path === "" ? "/" : t.path).trim() || "/";
            if (!p.startsWith("/")) p = `/${p}`;
            return p.replace(/\/$/, "") || "/";
          })(),
          secure: t.secure === true || t.secure === "1" || String(t.secure) === "true",
        };
      })
      .filter((t) => t.host && t.user);
  } else {
    next.targets = prev.targets || [];
  }
  setAppSettingKey(CONFIG_KEY, JSON.stringify(next));
  return next;
}

let /** @type {import("node-cron").ScheduledTask | null} */ scheduledTask = null;
let runCtx = null;

export function stopAutoBackupScheduler() {
  if (scheduledTask) {
    try {
      scheduledTask.stop();
    } catch {
      /* */
    }
    scheduledTask = null;
  }
}

/**
 * @param {{uploadsRoot: string, downloadsDir: string}} ctx
 */
export function startAutoBackupScheduler(ctx) {
  stopAutoBackupScheduler();
  runCtx = ctx;
  const c = getEffectiveAutoBackupConfig();
  if (!c.enabled || !c.targets.length) {
    console.log("Pirsum auto-backup: כבוי או בלי שרתי FTP");
    return;
  }
  if (!cron.validate(c.cron)) {
    console.error("Pirsum auto-backup: cron לא תקין, דילוג", c.cron);
    return;
  }
  const tz = c.timezone || "Asia/Jerusalem";
  console.log("Pirsum auto-backup: תזמון", c.cron, tz, `(${c.targets.length} יעדים)`);
  scheduledTask = cron.schedule(
    c.cron,
    () => {
      runAutoBackupFtpJob().catch((e) => console.error("Pirsum auto-backup", e));
    },
    { scheduled: true, timezone: tz }
  );
}

export function restartAutoBackupScheduler(ctx) {
  startAutoBackupScheduler(ctx);
}

/**
 * @param {{ force?: boolean }} opts — force: הרצה מבדיקה גם אם auto כבוי
 * @returns {Promise<{ ok: boolean, remoteResults: Array, skipped?: boolean }>}
 */
export async function runAutoBackupFtpJob(opts = {}) {
  if (!runCtx) {
    return { ok: false, remoteResults: [], skipped: true };
  }
  const c = getEffectiveAutoBackupConfig();
  if (!opts.force && (!c.enabled || !c.targets.length)) {
    return { ok: false, remoteResults: [], skipped: true };
  }
  if (!c.targets.length) {
    return { ok: false, remoteResults: [], skipped: true };
  }
  let zipPath;
  try {
    zipPath = await writeFullBackupZipToFile({ uploadsRoot: runCtx.uploadsRoot, downloadsDir: runCtx.downloadsDir });
  } catch (e) {
    try {
      insertAuditLog({
        actorId: null,
        actorEmail: "—",
        action: "גיבוי אוטומטי FTP (כשל — יצירת ZIP)",
        method: "CRON",
        path: "/auto-backup",
        statusCode: 500,
        detail: e.message || String(e),
        ip: "—",
      });
    } catch {
      /* */
    }
    throw e;
  }
  const baseName = `pirsum-backup-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.zip`;
  const results = [];
  for (const t of c.targets) {
    if (!t.pass) {
      results.push({ host: t.host, ok: false, error: "חסרה סיסמה" });
      continue;
    }
    const cClient = new Client(120_000);
    cClient.ftp.verbose = false;
    try {
      await cClient.access({
        host: t.host,
        port: t.port,
        user: t.user,
        password: t.pass,
        secure: t.secure,
      });
      const dir = t.path === "" || t.path === "/" ? "/" : t.path.replace(/\/$/, "");
      if (dir !== "/") {
        await cClient.ensureDir(dir);
        await cClient.cd(dir);
      }
      await cClient.uploadFrom(zipPath, baseName);
      const remoteFile = dir === "/" ? `/${baseName}` : `${dir}/${baseName}`;
      results.push({ host: t.host, ok: true, remoteFile });
    } catch (e) {
      results.push({ host: t.host, ok: false, error: e.message || String(e) });
    } finally {
      cClient.close();
    }
  }
  const ok = results.some((r) => r.ok);
  try {
    insertAuditLog({
      actorId: null,
      actorEmail: "—",
      action: "גיבוי אוטומטי → FTP",
      method: "CRON",
      path: "/auto-backup",
      statusCode: ok ? 200 : 500,
      detail: results.map((r) => `${r.host}: ${r.ok ? "ok" : r.error || "×"}`).join(" · "),
      ip: "—",
    });
  } catch {
    /* */
  } finally {
    try {
      if (zipPath) fs.unlinkSync(zipPath);
    } catch {
      /* */
    }
  }
  return { ok, remoteResults: results };
}
