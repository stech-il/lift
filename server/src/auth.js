import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const JWT_SECRET = process.env.JWT_SECRET || process.env.ADMIN_SECRET || "change-me-in-production";

const SALT_ROUNDS = 12;

export function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), SALT_ROUNDS);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(String(plain), String(hash));
}

export function signUserToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: "8h" });
}

export function verifyUserToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function validateEmail(email) {
  const s = String(email || "").trim();
  if (s.length < 3 || s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function validatePassword(password) {
  const p = String(password || "");
  return p.length >= 8 && p.length <= 128;
}
