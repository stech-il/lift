import nodemailer from "nodemailer";
import { getAppSettingsRow } from "./db.js";

const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_secure", "smtp_user", "smtp_pass", "mail_from"];

function envPort() {
  const p = parseInt(String(process.env.SMTP_PORT || "587"), 10);
  return Number.isFinite(p) ? p : 587;
}

function envSecure() {
  const s = String(process.env.SMTP_SECURE || "").toLowerCase();
  if (s === "true" || s === "1") return true;
  if (s === "false" || s === "0") return false;
  return envPort() === 465;
}

function valueForKey(key) {
  const row = getAppSettingsRow(key);
  if (row) return row.value == null ? "" : String(row.value);
  if (key === "smtp_host") return (process.env.SMTP_HOST || "").trim();
  if (key === "smtp_port") return String(envPort());
  if (key === "smtp_secure") return envSecure() ? "1" : "0";
  if (key === "smtp_user") return (process.env.SMTP_USER || "").trim();
  if (key === "smtp_pass") return (process.env.SMTP_PASS || "").trim();
  if (key === "mail_from") return (process.env.MAIL_FROM || "").trim();
  return "";
}

/**
 * איפוס transporter אחרי שמירת הגדרות (DB).
 */
let transporter = null;

export function resetMailTransporter() {
  transporter = null;
}

export function getEffectiveSmtpForAdmin() {
  const host = valueForKey("smtp_host").trim();
  const from = valueForKey("mail_from").trim();
  const user = valueForKey("smtp_user").trim();
  const passRaw = valueForKey("smtp_pass");
  const portS = valueForKey("smtp_port").trim();
  const p = parseInt(portS || "587", 10);
  const port = Number.isFinite(p) && p > 0 ? p : 587;
  const secS = valueForKey("smtp_secure").trim().toLowerCase();
  let secure;
  if (secS === "1" || secS === "true" || secS === "yes") secure = true;
  else if (secS === "0" || secS === "false" || secS === "no" || secS === "") secure = false;
  else secure = port === 465;
  const smtpPassConfigured = String(passRaw).trim().length > 0;
  return { host, port, secure, user, from, smtpPassConfigured };
}

export function isMailConfigured() {
  const { host, from } = getEffectiveSmtpForAdmin();
  return !!(host && from);
}

function getTransporter() {
  if (!isMailConfigured()) return null;
  if (!transporter) {
    const { host, port, secure, user, pass } = (() => {
      const h = valueForKey("smtp_host").trim();
      const portS = valueForKey("smtp_port").trim();
      const p = parseInt(portS || "587", 10);
      const pr = Number.isFinite(p) && p > 0 ? p : 587;
      const secS = valueForKey("smtp_secure").trim().toLowerCase();
      let s;
      if (secS === "1" || secS === "true" || secS === "yes") s = true;
      else if (secS === "0" || secS === "false" || secS === "no" || secS === "") s = false;
      else s = pr === 465;
      const u = valueForKey("smtp_user").trim();
      const pa = valueForKey("smtp_pass").trim();
      return { host: h, port: pr, secure: s, user: u, pass: pa };
    })();
    const auth = user && pass ? { user, pass } : undefined;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth,
    });
  }
  return transporter;
}

/**
 * @param {{ to: string; subject: string; text: string; html?: string }} opts
 * @returns {Promise<{ ok: boolean; skipped?: boolean; error?: string }>}
 */
export async function sendMail(opts) {
  const t = getTransporter();
  if (!t) {
    console.warn("mail: SMTP לא מוגדר — דילוג על שליחה");
    return { ok: false, skipped: true };
  }
  const from = valueForKey("mail_from").trim();
  try {
    await t.sendMail({
      from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html || opts.text.replace(/\n/g, "<br/>"),
    });
    return { ok: true };
  } catch (e) {
    console.error("mail send error", e);
    return { ok: false, error: String(e.message || e) };
  }
}

export { SMTP_KEYS };
