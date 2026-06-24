import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PROJECT_ROOT } from "./config";

export interface StoredAdminActivation {
  version: "ADM1";
  nonce: string;
  signature: string;
  activatedAt: string;
}

interface ActivationRedemption {
  codeHash: string;
  usedBy: string;
  usedAt: string;
}

interface ActivationRedemptionsFile {
  redemptions: ActivationRedemption[];
}

const VERSION = "ADM1";
const NONCE_LENGTH = 16;
const SIGNATURE_LENGTH = 20;
const NORMALIZED_CODE_LENGTH = VERSION.length + NONCE_LENGTH + SIGNATURE_LENGTH;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_PATTERN = new RegExp(
  `^${VERSION}[${ALPHABET}]{${NONCE_LENGTH + SIGNATURE_LENGTH}}$`
);
const redemptionsPath =
  process.env.APP_ACTIVATION_REDEMPTIONS_PATH ||
  path.resolve(PROJECT_ROOT, "data/activation-redemptions.json");

function getActivationSecret(): string {
  const secret = process.env.APP_ACTIVATION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 APP_ACTIVATION_SECRET");
  }
  return "dev-only-activation-secret";
}

function encodeBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function getExpectedSignature(userId: string, nonce: string): string {
  const digest = crypto
    .createHmac("sha256", getActivationSecret())
    .update(`admin:${userId}:${VERSION}:${nonce}`)
    .digest();
  return encodeBase32(digest).slice(0, SIGNATURE_LENGTH);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function normalizeActivationCode(code: string): string {
  return code.replace(/[\s-]+/g, "").toUpperCase();
}

export function formatActivationCode(code: string): string {
  const normalized = normalizeActivationCode(code);
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

export function parseValidActivationCodeForUser(
  userId: string,
  code: string
): Omit<StoredAdminActivation, "activatedAt"> {
  const normalized = normalizeActivationCode(code);
  if (normalized.length !== NORMALIZED_CODE_LENGTH || !CODE_PATTERN.test(normalized)) {
    throw new Error("激活码格式不正确");
  }

  const nonce = normalized.slice(VERSION.length, VERSION.length + NONCE_LENGTH);
  const signature = normalized.slice(VERSION.length + NONCE_LENGTH);
  const expectedSignature = getExpectedSignature(userId, nonce);
  if (!timingSafeStringEqual(signature, expectedSignature)) {
    throw new Error("激活码无效");
  }

  return {
    version: VERSION,
    nonce,
    signature
  };
}

export function verifyStoredAdminActivation(
  userId: string,
  activation: StoredAdminActivation | undefined
): boolean {
  if (
    !activation ||
    activation.version !== VERSION ||
    !new RegExp(`^[${ALPHABET}]{${NONCE_LENGTH}}$`).test(activation.nonce) ||
    !new RegExp(`^[${ALPHABET}]{${SIGNATURE_LENGTH}}$`).test(activation.signature)
  ) {
    return false;
  }

  return timingSafeStringEqual(activation.signature, getExpectedSignature(userId, activation.nonce));
}

export function hashActivationCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeActivationCode(code)).digest("base64url");
}

export async function loadActivationRedemptions(): Promise<ActivationRedemption[]> {
  try {
    const raw = await readFile(redemptionsPath, "utf8");
    const data = JSON.parse(raw) as ActivationRedemptionsFile;
    return Array.isArray(data.redemptions) ? data.redemptions : [];
  } catch {
    await mkdir(path.dirname(redemptionsPath), { recursive: true });
    await writeFile(
      redemptionsPath,
      JSON.stringify(
        {
          redemptions: []
        },
        null,
        2
      ),
      "utf8"
    );
    return [];
  }
}

export async function saveActivationRedemptions(
  redemptions: ActivationRedemption[]
): Promise<void> {
  await mkdir(path.dirname(redemptionsPath), { recursive: true });
  await writeFile(
    redemptionsPath,
    `${JSON.stringify(
      {
        redemptions
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
