import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const electronCli = path.join(repoRoot, "node_modules", "electron", "cli.js");

const runtimeCheck = String.raw`
const nativeChecks = [
    {
        name: "better-sqlite3",
        run() {
            const Database = require("better-sqlite3");
            const db = new Database(":memory:");
            db.prepare("select 1 as ok").get();
            db.close();
        },
    },
    {
        name: "node-pty",
        run() {
            const pty = require("node-pty");
            if (typeof pty.spawn !== "function") {
                throw new Error("node-pty did not expose spawn()");
            }
        },
    },
];

for (const check of nativeChecks) {
    try {
        check.run();
    } catch (error) {
        console.error("[check:native] " + check.name + " failed inside Electron.");
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    }
}
`;

export function checkNativeModules() {
    const result = spawnSync(process.execPath, [electronCli, "-e", runtimeCheck], {
        cwd: repoRoot,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
        },
        encoding: "utf8",
    });

    if (result.error) {
        console.error("[check:native] Failed to run Electron native module check.");
        console.error(result.error.message);
        process.exit(1);
    }

    if (result.status !== 0) {
        if (result.stdout.trim()) {
            console.error(result.stdout.trim());
        }
        if (result.stderr.trim()) {
            console.error(result.stderr.trim());
        }
        console.error(
            "[check:native] Native modules are not compatible with the current Electron runtime. Run pnpm run rebuild:native.",
        );
        process.exit(result.status ?? 1);
    }

    console.log("[check:native] Native modules are compatible with Electron.");
}

checkNativeModules();
