const crypto = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const usersPath =
  process.env.APP_USERS_PATH || path.resolve(__dirname, "../data/users.json");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const key = crypto.scryptSync(password, salt, 32).toString("base64url");
  return `scrypt$${salt}$${key}`;
}

function readUsers() {
  if (!existsSync(usersPath)) {
    return { users: [] };
  }
  const data = JSON.parse(readFileSync(usersPath, "utf8"));
  return {
    users: Array.isArray(data.users) ? data.users : []
  };
}

function toPersistedUser(user) {
  return {
    id: user.id,
    passwordHash: user.passwordHash,
    ...(user.activation ? { activation: user.activation } : {})
  };
}

function main() {
  const [id, password] = process.argv.slice(2);
  if (!id || !password) {
    console.error("Usage: npm run auth:create-user -- <account> <password>");
    process.exit(1);
  }

  const data = readUsers();
  const index = data.users.findIndex((item) => item.id === id);
  if (index >= 0) {
    data.users[index] = {
      ...data.users[index],
      id,
      passwordHash: hashPassword(password)
    };
  } else {
    data.users.push({
      id,
      passwordHash: hashPassword(password)
    });
  }

  mkdirSync(path.dirname(usersPath), { recursive: true });
  data.users = data.users.map(toPersistedUser);
  writeFileSync(usersPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`Saved user ${id} to ${usersPath}`);
}

main();
