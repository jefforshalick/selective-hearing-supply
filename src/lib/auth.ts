import { env } from 'cloudflare:workers';

const COOKIE_NAME = 'sh-admin-auth';
const SALT = 'sh-supply-admin-2026';

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + SALT);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function verifyPassword(password: string): Promise<string | null> {
  const adminPassword = (env as any).ADMIN_PASSWORD;
  if (!adminPassword || password !== adminPassword) return null;
  return hashPassword(password);
}

export async function isValidToken(token: string): Promise<boolean> {
  const adminPassword = (env as any).ADMIN_PASSWORD;
  if (!adminPassword) return false;
  const expected = await hashPassword(adminPassword);
  return token === expected;
}

export { COOKIE_NAME };
