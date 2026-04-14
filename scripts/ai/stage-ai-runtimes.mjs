import { pathToFileURL } from "node:url";

import { stageClaudeRuntime } from "./stage-claude-runtime.mjs";
import { stageCodexRuntime } from "./stage-codex-runtime.mjs";

export function stageAiRuntimes() {
    stageCodexRuntime();
    stageClaudeRuntime();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    stageAiRuntimes();
}
