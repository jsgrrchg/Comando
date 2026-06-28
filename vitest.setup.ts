import { beforeAll } from "vitest";

import { initReviewEngine } from "@shared/ai-review-engine/reviewEngine";

// Review diff/patch computation lives in the Rust/WASM engine. Initialize it
// before any test runs so tests exercise the real engine, not the JS fallback.
beforeAll(async () => {
    await initReviewEngine();
});
