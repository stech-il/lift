import { OAuth2Client } from "google-auth-library";
import { getAppSettingsRow } from "./db.js";

/** מזהה לקוח Web (Google Cloud) — ב-DB או ב־GOOGLE_CLIENT_ID (סביבה). */
export function getGoogleClientId() {
  const row = getAppSettingsRow("google_client_id");
  if (row && row.value != null && String(row.value).trim() !== "") {
    return String(row.value).trim();
  }
  return (process.env.GOOGLE_CLIENT_ID || "").trim();
}

export async function verifyGoogleIdToken(idToken) {
  const cid = getGoogleClientId();
  if (!cid) {
    const err = new Error("Google OAuth לא מוגדר בשרת");
    err.code = "GOOGLE_NOT_CONFIGURED";
    throw err;
  }
  const client = new OAuth2Client(cid);
  const ticket = await client.verifyIdToken({ idToken, audience: cid });
  const p = ticket.getPayload();
  if (!p?.email) {
    const err = new Error("לא התקבל אימייל מחשבון Google");
    err.code = "NO_EMAIL";
    throw err;
  }
  return {
    sub: String(p.sub),
    email: String(p.email).toLowerCase().trim(),
    emailVerified: p.email_verified === true,
  };
}
