const { spawn } = require("node:child_process");

try {
  require("/app/scripts/configure-git-global.cjs");
} catch (error) {
  console.error(
    "[docker-entrypoint] failed before app start:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
}

const command = process.argv.slice(2);

if (!command.length) {
  console.error("[docker-entrypoint] missing startup command");
  process.exit(1);
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit"
});

child.on("error", (error) => {
  console.error(
    "[docker-entrypoint] failed to start app:",
    error instanceof Error ? error.message : error
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
