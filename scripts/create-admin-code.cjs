const crypto = require("node:crypto");

const VERSION = "ADM1";
const NONCE_LENGTH = 16;
const SIGNATURE_LENGTH = 20;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function getActivationSecret() {
  const secret = process.env.APP_ACTIVATION_SECRET?.trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置 APP_ACTIVATION_SECRET");
  }
  return "dev-only-activation-secret";
}

function encodeBase32(buffer) {
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

function createNonce() {
  return encodeBase32(crypto.randomBytes(10)).slice(0, NONCE_LENGTH);
}

function createSignature(userId, nonce) {
  return encodeBase32(
    crypto
      .createHmac("sha256", getActivationSecret())
      .update(`admin:${userId}:${VERSION}:${nonce}`)
      .digest()
  ).slice(0, SIGNATURE_LENGTH);
}

function formatCode(code) {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

function parseCount(args) {
  const countFlagIndex = args.findIndex((item) => item === "--count" || item === "-c");
  if (countFlagIndex < 0) {
    return 1;
  }
  const value = Number(args[countFlagIndex + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("--count 必须是 1 到 50 之间的整数");
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const userId = args.find((item, index) => {
    const previous = args[index - 1];
    return item !== "--count" && item !== "-c" && previous !== "--count" && previous !== "-c";
  });

  if (!userId) {
    console.error("Usage: npm run auth:create-admin-code -- <account> [--count 1]");
    process.exit(1);
  }

  const count = parseCount(args);
  for (let index = 0; index < count; index += 1) {
    const nonce = createNonce();
    const signature = createSignature(userId, nonce);
    console.log(formatCode(`${VERSION}${nonce}${signature}`));
  }
}

main();
