import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const electronViteCli = path.join(
    repoRoot,
    "node_modules",
    "electron-vite",
    "bin",
    "electron-vite.js",
);

const child = spawn(process.execPath, [electronViteCli, "dev"], {
    cwd: repoRoot,
    env: {
        ...process.env,
        COMANDO_APP_CHANNEL: "dev",
    },
    stdio: "inherit",
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 1);
});

child.on("error", (error) => {
    console.error("[dev] Failed to start electron-vite:", error);
    process.exit(1);
});
