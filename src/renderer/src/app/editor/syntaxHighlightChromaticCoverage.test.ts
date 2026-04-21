import { describe, expect, it } from "vitest";

import {
    measureBaselineChromaticCoverage,
    type ChromaticCoverageOptions,
    type ChromaticCoverageResult,
} from "./syntaxHighlightChromaticCoverage";

// Minimum number of distinct foreground color ids emitted by the TextMate
// tokenizer for each language in SYNTAX_HIGHLIGHT_BASELINE_FIXTURES. These
// thresholds were calibrated against the actual chromatic output of the
// Comando palette on April 2026. They must only be tightened (never relaxed)
// without a separate investigation — a drop below these numbers means the
// palette regressed, a grammar stopped loading, or a theme scope mapping was
// deleted.
//
// The check is per-language: if a language has several fixtures (for example
// shell has both script.sh and dotfiles), the assertion runs against the
// fixture that emitted the most colors, so dotfile fixtures do not gate the
// canonical grammar coverage.
//
// Plaintext has no TextMate grammar so it is not listed. It remains part of
// the fixture set for structural coverage tests.
const MINIMUM_DISTINCT_FOREGROUND_BY_LANGUAGE = {
    css: 5,
    graphql: 6,
    html: 5,
    javascript: 6,
    json: 4,
    jsonc: 5,
    jsx: 7,
    markdown: 7,
    prisma: 5,
    python: 6,
    rust: 5,
    scss: 7,
    shell: 7,
    sql: 4,
    svelte: 8,
    tsx: 9,
    typescript: 7,
    vue: 8,
    yaml: 4,
} as const satisfies Readonly<Record<string, number>>;

const MINIMUM_AGGREGATE_DISTINCT_FOREGROUNDS = 12;

function bestCoverageByLanguage(
    coverage: readonly ChromaticCoverageResult[],
): Map<string, ChromaticCoverageResult> {
    const best = new Map<string, ChromaticCoverageResult>();

    for (const result of coverage) {
        const current = best.get(result.languageId);
        if (
            !current ||
            result.distinctForegroundCount > current.distinctForegroundCount
        ) {
            best.set(result.languageId, result);
        }
    }

    return best;
}

function collectAggregateDistinctForegrounds(
    coverage: readonly ChromaticCoverageResult[],
): Set<number> {
    const aggregate = new Set<number>();

    for (const result of coverage) {
        for (const id of result.distinctForegroundIds) {
            // The editor default foreground is encoded as id 0. It is a
            // meaningful token signal (no override emitted), but to assert
            // palette richness we only count explicit color picks, which
            // start at id 1 in the indexed color map.
            if (id !== 0) {
                aggregate.add(id);
            }
        }
    }

    return aggregate;
}

async function runBaseline(
    themeName: ChromaticCoverageOptions["themeName"],
): Promise<readonly ChromaticCoverageResult[]> {
    return measureBaselineChromaticCoverage({ themeName });
}

describe("syntax highlight chromatic coverage", () => {
    it("meets per-language minimum distinct foreground counts on comando-dark", async () => {
        const coverage = await runBaseline("comando-dark");
        const best = bestCoverageByLanguage(coverage);
        const failures: string[] = [];

        for (const [languageId, threshold] of Object.entries(
            MINIMUM_DISTINCT_FOREGROUND_BY_LANGUAGE,
        )) {
            const result = best.get(languageId);
            if (!result) {
                failures.push(
                    `missing baseline fixture for ${languageId} in dark theme`,
                );
                continue;
            }

            if (result.distinctForegroundCount < threshold) {
                failures.push(
                    `dark ${languageId}: ${result.distinctForegroundCount} < ${threshold} (ids=[${result.distinctForegroundIds.join(",")}])`,
                );
            }
        }

        expect(failures).toEqual([]);
    }, 60_000);

    it("meets per-language minimum distinct foreground counts on comando-light", async () => {
        const coverage = await runBaseline("comando-light");
        const best = bestCoverageByLanguage(coverage);
        const failures: string[] = [];

        for (const [languageId, threshold] of Object.entries(
            MINIMUM_DISTINCT_FOREGROUND_BY_LANGUAGE,
        )) {
            const result = best.get(languageId);
            if (!result) {
                failures.push(
                    `missing baseline fixture for ${languageId} in light theme`,
                );
                continue;
            }

            if (result.distinctForegroundCount < threshold) {
                failures.push(
                    `light ${languageId}: ${result.distinctForegroundCount} < ${threshold} (ids=[${result.distinctForegroundIds.join(",")}])`,
                );
            }
        }

        expect(failures).toEqual([]);
    }, 60_000);

    it("paints at least the 12 anchor colors across the dark baseline", async () => {
        const coverage = await runBaseline("comando-dark");
        const aggregate = collectAggregateDistinctForegrounds(coverage);

        expect(aggregate.size).toBeGreaterThanOrEqual(
            MINIMUM_AGGREGATE_DISTINCT_FOREGROUNDS,
        );
    }, 60_000);

    it("paints at least the 12 anchor colors across the light baseline", async () => {
        const coverage = await runBaseline("comando-light");
        const aggregate = collectAggregateDistinctForegrounds(coverage);

        expect(aggregate.size).toBeGreaterThanOrEqual(
            MINIMUM_AGGREGATE_DISTINCT_FOREGROUNDS,
        );
    }, 60_000);

    it("returns non-empty token counts for every non-plaintext fixture", async () => {
        const coverage = await runBaseline("comando-dark");
        const emptyFixtures = coverage.filter(
            (result) =>
                result.languageId !== "plaintext" && result.tokenCount === 0,
        );

        expect(emptyFixtures).toEqual([]);
    }, 60_000);
});
