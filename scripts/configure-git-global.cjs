const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const configPath =
  process.env.APP_CONFIG_PATH || path.resolve(__dirname, "../data/app.config.json");

function runGitConfig(args) {
  execFileSync("git", args, {
    stdio: "ignore"
  });
}

function main() {
  const homeDir = process.env.HOME || os.homedir() || "/root";
  if (!existsSync(configPath)) {
    console.warn(
      `[docker-entrypoint] skip git global auth init: config file not found at ${configPath}`
    );
    return;
  }

  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const remoteUrl = String(config?.repo?.remoteUrl ?? "").trim();
  const username = String(config?.repo?.auth?.username ?? "").trim();
  const password = String(config?.repo?.auth?.password ?? "").trim();

  if (!remoteUrl || !username || !password) {
    console.log("[docker-entrypoint] skip git global auth init: missing remoteUrl or auth");
    return;
  }

  const url = new URL(remoteUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.log("[docker-entrypoint] skip git global auth init: unsupported protocol");
    return;
  }

  url.username = username;
  url.password = password;

  mkdirSync(homeDir, { recursive: true });
  writeFileSync(path.join(homeDir, ".git-credentials"), `${url.toString()}\n`, "utf8");

  runGitConfig(["config", "--global", "credential.helper", "store"]);
  runGitConfig(["config", "--global", "credential.useHttpPath", "true"]);

  console.log(
    `[docker-entrypoint] configured git global credentials for ${url.host} with user ${username}`
  );
}

try {
  main();
} catch (error) {
  console.warn(
    "[docker-entrypoint] failed to configure git global credentials:",
    error instanceof Error ? error.message : error
  );
}
