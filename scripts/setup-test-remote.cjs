const { execFileSync } = require("node:child_process");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const seedPath = path.resolve(projectRoot, "data/test-seed");
const remotePath = path.resolve(projectRoot, "data/test-remote.git");
const repoPath = path.resolve(projectRoot, "data/repo");
const configPath = path.resolve(projectRoot, "data/app.config.json");

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    ...options
  });
}

function main() {
  rmSync(seedPath, { recursive: true, force: true });
  rmSync(remotePath, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });

  const configDir = path.join(
    seedPath,
    "nacos-config/config/dev/finagent-tob-dev"
  );
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "application.properties"),
    "test.setting=initial\n",
    "utf8"
  );

  run("git", ["init", "-b", "main"], { cwd: seedPath });
  run("git", ["config", "user.name", "Seed"], { cwd: seedPath });
  run("git", ["config", "user.email", "seed@local"], { cwd: seedPath });
  run("git", ["add", "."], { cwd: seedPath });
  run("git", ["commit", "-m", "seed config"], { cwd: seedPath });
  run("git", ["clone", "--bare", seedPath, remotePath], { cwd: projectRoot });

  const appConfig = {
    server: {
      port: 8090
    },
    repo: {
      localPath: "./data/repo",
      remoteUrl: remotePath,
      branch: "main",
      configRoot: "nacos-config/config",
      allowedExtensions: [
        "",
        ".json",
        ".yaml",
        ".yml",
        ".toml",
        ".ini",
        ".conf",
        ".properties",
        ".env",
        ".xml",
        ".txt",
        ".md"
      ],
      auth: {
        username: "",
        password: ""
      },
      commitMessagePrefix: "config: ",
      cloneOnStart: true
    }
  };

  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(appConfig, null, 2)}\n`, "utf8");

  console.log(`Test remote ready: ${remotePath}`);
  console.log(`App config updated: ${configPath}`);
}

main();
