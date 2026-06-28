import initWasm, {
    initSync as initWasmSync,
    build_text_range_patch_from_texts_json,
    compute_diff_hunks_json,
    derive_line_patch_from_text_ranges_json,
    resolve_tracked_file_hunks_json,
} from "./wasm/comando_diff";
import wasmUrl from "./wasm/comando_diff_bg.wasm?url";

import type { AiDiffHunk, AiTrackedFile } from "../ipc";

// Canonical offset-based units owned by the Rust engine (UTF-16 offsets). These
// mirror the comando-diff crate so review work — diff/patch/keep/reject — lives
// in Rust/WASM, not TypeScript.
export interface AgentTextSpan {
    readonly baseFrom: number;
    readonly baseTo: number;
    readonly currentFrom: number;
    readonly currentTo: number;
}

export interface TextRangePatch {
    readonly spans: readonly AgentTextSpan[];
}

export interface LineEdit {
    readonly oldStart: number;
    readonly oldEnd: number;
    readonly newStart: number;
    readonly newEnd: number;
}

export interface LinePatch {
    readonly edits: readonly LineEdit[];
}

// The engine round-trips through JSON. The Rust side is the schema authority, so
// the parsed shape is trusted at the boundary.
function parseJson<T>(json: string): T {
    return JSON.parse(json) as T;
}

let ready = false;
let initPromise: Promise<void> | null = null;

function isTestEnv(): boolean {
    return (
        typeof import.meta !== "undefined" &&
        (import.meta as { env?: { MODE?: string } }).env?.MODE === "test"
    );
}

function hasNode(): boolean {
    return (
        typeof process !== "undefined" &&
        Boolean((process as { versions?: { node?: string } }).versions?.node)
    );
}

function isNodeRuntime(): boolean {
    // The main process and the test runner (even under jsdom) are Node and read
    // the wasm bytes from disk; only the real browser renderer fetches the asset.
    return hasNode() && (typeof window === "undefined" || isTestEnv());
}

async function loadEngine(): Promise<void> {
    // The renderer (browser) fetches and instantiates the wasm asynchronously.
    // The main process and the test runner are Node, where `wasmUrl` resolves to
    // a filesystem path/URL: read the bytes and instantiate synchronously.
    if (isNodeRuntime()) {
        // The main-process bundle inlines the wasm as a `data:` URL.
        if (wasmUrl.startsWith("data:")) {
            const { Buffer } = await import(/* @vite-ignore */ "node:buffer");
            const base64 = wasmUrl.slice(wasmUrl.indexOf(",") + 1);
            initWasmSync({ module: Buffer.from(base64, "base64") });
            return;
        }

        if (/^https?:/.test(wasmUrl)) {
            const response = await fetch(wasmUrl);
            initWasmSync({ module: new Uint8Array(await response.arrayBuffer()) });
            return;
        }

        let filePath: string = wasmUrl;
        if (/^file:/.test(wasmUrl)) {
            const { fileURLToPath } = await import(/* @vite-ignore */ "node:url");
            filePath = fileURLToPath(wasmUrl);
        } else if (wasmUrl.startsWith("/@fs/")) {
            filePath = wasmUrl.slice("/@fs".length);
        } else if (wasmUrl.startsWith("/")) {
            // Vite resolves `?url` to a root-relative path; anchor it to cwd.
            const { join } = await import(/* @vite-ignore */ "node:path");
            filePath = join(process.cwd(), wasmUrl.replace(/^\/+/, ""));
        }
        const { readFile } = await import(/* @vite-ignore */ "node:fs/promises");
        initWasmSync({ module: await readFile(filePath) });
        return;
    }

    await initWasm({ module_or_path: wasmUrl });
}

/**
 * Initialize the Rust/WASM review engine. Call once at process start (main and
 * renderer). Idempotent and safe to await concurrently.
 */
export async function initReviewEngine(): Promise<void> {
    if (ready) {
        return;
    }
    if (!initPromise) {
        initPromise = loadEngine()
            .then(() => {
                ready = true;
            })
            .catch((error) => {
                initPromise = null;
                throw error;
            });
    }
    await initPromise;
}

export function isReviewEngineReady(): boolean {
    return ready;
}

function assertEngineReady(): void {
    if (!ready) {
        throw new Error(
            "Review engine is not initialized; await initReviewEngine() at startup before computing review diffs.",
        );
    }
}

export function engineComputeDiffHunks(
    oldText: string,
    newText: string,
    seed: string,
): readonly AiDiffHunk[] {
    assertEngineReady();
    return parseJson(compute_diff_hunks_json(oldText, newText, seed));
}

export function engineBuildTextRangePatch(
    oldText: string,
    newText: string,
    linePatch?: LinePatch,
): TextRangePatch {
    assertEngineReady();
    return parseJson(
        build_text_range_patch_from_texts_json(
            oldText,
            newText,
            linePatch ? JSON.stringify(linePatch) : undefined,
        ),
    );
}

export function engineDeriveLinePatchFromSpans(
    baseText: string,
    currentText: string,
    spans: readonly AgentTextSpan[],
): LinePatch {
    assertEngineReady();
    return parseJson(
        derive_line_patch_from_text_ranges_json(
            baseText,
            currentText,
            JSON.stringify(spans),
        ),
    );
}

export function engineResolveTrackedFileHunks(
    file: AiTrackedFile,
    hunkIds: readonly string[],
    decision: "keep" | "reject",
    updatedAt: string,
): AiTrackedFile | null {
    assertEngineReady();
    return parseJson<AiTrackedFile | null>(
        resolve_tracked_file_hunks_json(
            JSON.stringify(file),
            JSON.stringify(hunkIds),
            decision,
            updatedAt,
        ),
    );
}

