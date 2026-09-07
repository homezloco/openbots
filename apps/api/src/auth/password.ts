import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

/**
 * scrypt via Node's built-in crypto rather than bcrypt/argon2 — those are
 * native modules, and this project already hit repeated Docker build
 * timeouts fetching large native binaries (see docs/adapters.md history).
 * scrypt is a reasonable, dependency-free KDF for this purpose.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const hash = Buffer.from(hashHex, "hex");
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return hash.length === derivedKey.length && timingSafeEqual(hash, derivedKey);
}
