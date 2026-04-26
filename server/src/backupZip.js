import fs from "fs";
import path from "path";
import { tmpdir } from "os";
import archiver from "archiver";
import { writeDatabaseBackupTo } from "./db.js";

export function walkDirRelFiles(absoluteDir, relativePrefix = "") {
  const out = [];
  if (!fs.existsSync(absoluteDir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const rel = relativePrefix ? `${relativePrefix}/${ent.name}` : ent.name;
    const full = path.join(absoluteDir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkDirRelFiles(full, rel));
    } else if (ent.isFile()) {
      out.push({ full, rel: rel.split(path.sep).join("/") });
    }
  }
  return out;
}

export function getBackupManifest() {
  return {
    format: "pirsum-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    databaseFile: "pirsum.db",
    includes: ["uploads", "client-downloads"],
    restoreHintHe:
      "עצור את השרת. חלץ את ה־ZIP. אם הוגדרו DATA_DIR/UPLOADS_DIR/CLIENT_DOWNLOADS_DIR — העתק לשם: pirsum.db, תיקיית uploads, תיקיית client-downloads. אחרת: pirsum.db ליד קובץ המסד של השרת, uploads/ ל־data/uploads, client-downloads/ ל־public/downloads או לנתיב הורדות הלקוח. בשרת שונה עדכן גם GOOGLE Client ID origins ו־PUBLIC_BASE_URL. הפעל מחדש.",
  };
}

/**
 * @param {import("archiver").Archiver} archive
 */
export function appendPirsumBackupToArchive(archive, { dbCopyPath, uploadsRoot, downloadsDir }) {
  archive.append(JSON.stringify(getBackupManifest(), null, 2), { name: "backup-manifest.json" });
  archive.file(dbCopyPath, { name: "pirsum.db" });
  for (const { full, rel } of walkDirRelFiles(uploadsRoot)) {
    archive.file(full, { name: `uploads/${rel}` });
  }
  for (const { full, rel } of walkDirRelFiles(downloadsDir)) {
    archive.file(full, { name: `client-downloads/${rel}` });
  }
}

/**
 * @param {{uploadsRoot: string, downloadsDir: string}} paths
 * @returns {Promise<string>} path to zip file; caller should unlink when done
 */
export async function writeFullBackupZipToFile(paths) {
  const { uploadsRoot, downloadsDir } = paths;
  const workDir = path.join(tmpdir(), `pirsum-backup-zip-${process.pid}-${Date.now()}`);
  const dbCopyPath = path.join(workDir, "pirsum.db");
  const outPath = path.join(tmpdir(), `pirsum-backup-out-${Date.now()}.zip`);
  fs.mkdirSync(workDir, { recursive: true });
  await writeDatabaseBackupTo(dbCopyPath);
  const out = fs.createWriteStream(outPath);
  const archive = archiver("zip", { zlib: { level: 6 } });
  await new Promise((resolve, reject) => {
    out.once("close", resolve);
    out.once("error", reject);
    archive.once("error", reject);
    archive.pipe(out);
    appendPirsumBackupToArchive(archive, { dbCopyPath, uploadsRoot, downloadsDir });
    archive.finalize().catch(reject);
  });
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* */
  }
  return outPath;
}
