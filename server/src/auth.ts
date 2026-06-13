import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { NextFunction, Request, Response } from "express";
import { PROJECT_ROOT } from "./config";
import type { AuthUser } from "./types";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface StoredUser extends AuthUser {
  passwordHash: string;
}

interface UsersFile {
  users: StoredUser[];
}

interface SessionRecord {
  userId: string;
  expiresAt: number;
}

const COOKIE_NAME = "sid";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const usersPath = process.env.APP_USERS_PATH || path.resolve(PROJECT_ROOT, "data/users.json");
const sessions = new Map<string, SessionRecord>();
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

function getSessionSecret(): string {
  const secret = process.env.APP_SESSION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 APP_SESSION_SECRET");
  }
  return "dev-only-change-me";
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separatorIndex = item.indexOf("=");
        if (separatorIndex < 0) {
          return [item, ""];
        }
        return [
          decodeURIComponent(item.slice(0, separatorIndex)),
          decodeURIComponent(item.slice(separatorIndex + 1))
        ];
      })
  );
}

function signSessionId(sessionId: string): string {
  const signature = crypto
    .createHmac("sha256", getSessionSecret())
    .update(sessionId)
    .digest("base64url");
  return `${sessionId}.${signature}`;
}

function verifySignedSessionId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const separatorIndex = value.lastIndexOf(".");
  if (separatorIndex < 0) {
    return null;
  }

  const sessionId = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expected = signSessionId(sessionId).slice(separatorIndex + 1);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  return sessionId;
}

function getCookieOptions(maxAgeSeconds: number): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (process.env.APP_COOKIE_SECURE === "true") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function setSessionCookie(response: Response, signedSessionId: string): void {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(signedSessionId)}; ${getCookieOptions(
      Math.floor(SESSION_TTL_MS / 1000)
    )
      .split("; ")
      .slice(1)
      .join("; ")}`
  );
}

function clearSessionCookie(response: Response): void {
  response.setHeader("Set-Cookie", getCookieOptions(0));
}

async function loadUsers(): Promise<StoredUser[]> {
  try {
    const raw = await readFile(usersPath, "utf8");
    const data = JSON.parse(raw) as UsersFile;
    return Array.isArray(data.users) ? data.users : [];
  } catch {
    await mkdir(path.dirname(usersPath), { recursive: true });
    await writeFile(
      usersPath,
      JSON.stringify(
        {
          users: []
        },
        null,
        2
      ),
      "utf8"
    );
    return [];
  }
}

function verifyPassword(password: string, passwordHash: string): boolean {
  const [algorithm, salt, key] = passwordHash.split("$");
  if (algorithm !== "scrypt" || !salt || !key) {
    return false;
  }

  const expected = Buffer.from(key, "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function getFailureKey(request: Request, username: string): string {
  return `${request.ip}:${username.toLowerCase()}`;
}

function assertNotRateLimited(request: Request, username: string): void {
  const failure = loginFailures.get(getFailureKey(request, username));
  if (failure && failure.lockedUntil > Date.now()) {
    throw new Error("登录失败次数过多，请稍后再试");
  }
}

function markLoginFailure(request: Request, username: string): void {
  const key = getFailureKey(request, username);
  const current = loginFailures.get(key) ?? { count: 0, lockedUntil: 0 };
  const count = current.lockedUntil > Date.now() ? current.count : current.count + 1;
  loginFailures.set(key, {
    count,
    lockedUntil: count >= 5 ? Date.now() + 5 * 60 * 1000 : 0
  });
}

function clearLoginFailure(request: Request, username: string): void {
  loginFailures.delete(getFailureKey(request, username));
}

async function findUserById(userId: string): Promise<AuthUser | null> {
  const user = (await loadUsers()).find((item) => item.id === userId);
  if (!user) {
    return null;
  }
  return {
    id: user.id
  };
}

async function getRequestUser(request: Request): Promise<AuthUser | null> {
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = verifySignedSessionId(cookies[COOKIE_NAME]);
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  const user = await findUserById(session.userId);
  if (!user) {
    sessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

export async function login(request: Request, response: Response): Promise<void> {
  const username = String(request.body.username ?? "").trim();
  const password = String(request.body.password ?? "");
  if (!username || !password) {
    response.status(400).json({ error: "请输入账号和密码" });
    return;
  }

  try {
    assertNotRateLimited(request, username);
  } catch (error) {
    response.status(429).json({ error: (error as Error).message });
    return;
  }

  const users = await loadUsers();
  const user = users.find((item) => item.id === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    markLoginFailure(request, username);
    response.status(401).json({ error: "账号或密码错误" });
    return;
  }

  clearLoginFailure(request, username);
  const sessionId = crypto.randomBytes(32).toString("base64url");
  sessions.set(sessionId, {
    userId: user.id,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  setSessionCookie(response, signSessionId(sessionId));
  response.json({
    user: {
      id: user.id
    }
  });
}

export async function logout(request: Request, response: Response): Promise<void> {
  const sessionId = verifySignedSessionId(parseCookies(request.headers.cookie)[COOKIE_NAME]);
  if (sessionId) {
    sessions.delete(sessionId);
  }
  clearSessionCookie(response);
  response.json({ ok: true });
}

export async function me(request: Request, response: Response): Promise<void> {
  const user = await getRequestUser(request);
  if (!user) {
    response.status(401).json({ error: "未登录" });
    return;
  }
  response.json({ user });
}

export async function requireAuth(
  request: Request,
  response: Response,
  next: NextFunction
): Promise<void> {
  try {
    const user = await getRequestUser(request);
    if (!user) {
      response.status(401).json({ error: "未登录" });
      return;
    }
    request.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
