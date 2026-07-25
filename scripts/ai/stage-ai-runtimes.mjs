import { pathToFileURL } from "node:url";

import { stageClaudeRuntime } from "./stage-claude-runtime.mjs";
import { stageCodexRuntime } from "./stage-codex-runtime.mjs";

export async function stageAiRuntimes() {
    stageCodexRuntime();
    await stageClaudeRuntime();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    await stageAiRuntimes();
}
