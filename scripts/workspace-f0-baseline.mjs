import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { _electron } from "@playwright/test";

const STARTUP_SAMPLE_COUNT = 5;
const WARM_SWITCH_SAMPLE_COUNT = 100;
const IDLE_SAMPLE_MS = 5_000;
const RESTORE_POLL_ATTEMPTS = 120;
const RESTORE_POLL_INTERVAL_MS = 100;

const repositoryRoot = process.cwd();
const projectPath = path.resolve(process.argv[2] ?? repositoryRoot);
const nativeBackendPath = path.join(
    repositoryRoot,
    "target",
    "debug",
    "comando-native-backend",
);

const startup = await measureColdStartup();
const workspace = await measureWorkspaceLifecycle();

console.log(
    JSON.stringify(
        {
            capturedAt: new Date().toISOString(),
            idleSampleMs: IDLE_SAMPLE_MS,
            startup,
            warmSwitchSampleCount: WARM_SWITCH_SAMPLE_COUNT,
            workspace,
        },
        null,
        2,
    ),
);

async function measureColdStartup() {
    const samplesMs = [];
    for (let index = 0; index < STARTUP_SAMPLE_COUNT; index += 1) {
        const userDataPath = createTemporaryUserDataPath("startup");
        let electronApp;
        try {
            const startedAt = performance.now();
            electronApp = await launchApp(userDataPath);
            const hostPage = await electronApp.firstWindow();
            await waitForHostReady(hostPage, true);
            samplesMs.push(performance.now() - startedAt);
        } finally {
            await electronApp?.close().catch(() => undefined);
            removeTemporaryUserDataPath(userDataPath);
        }
    }

    const sorted = samplesMs.toSorted((left, right) => left - right);
    return {
        maxMs: sorted.at(-1),
        medianMs: percentile(sorted, 0.5),
        minMs: sorted[0],
        samplesMs,
    };
}

async function measureWorkspaceLifecycle() {
    const userDataPath = createTemporaryUserDataPath("lifecycle");
    let electronApp;
    try {
        electronApp = await launchApp(userDataPath);
        let hostPage = await electronApp.firstWindow();
        await waitForHostReady(hostPage, true);

        const added = await hostPage.evaluate(
            (targetPath) => window.comando.addProjectPaths([targetPath]),
            projectPath,
        );
        const project = added.projects[0];
        if (!project) {
            throw new Error("The baseline project could not be registered.");
        }

        const worktrees = await hostPage.evaluate(
            (projectId) =>
                window.comando.listGitWorktrees({
                    projectId,
                    worktreeId: null,
                }),
            project.id,
        );
        const secondaryWorktree = worktrees.find(
            (worktree) => !worktree.isPrimary,
        );
        if (!secondaryWorktree) {
            throw new Error(
                "The baseline requires a project with at least one secondary worktree.",
            );
        }

        await hostPage.waitForTimeout(500);
        await hostPage
            .getByRole("button", { name: "Open project or worktree" })
            .click();
        await hostPage
            .locator("button")
            .filter({ hasText: project.name })
            .first()
            .click();
        await hostPage.waitForTimeout(1_200);

        let surfacePages = workspaceSurfacePages(electronApp);
        if (surfacePages.length !== 1) {
            throw new Error(
                `Expected one resident surface, found ${surfacePages.length}.`,
            );
        }

        await surfacePages[0].evaluate(
            (input) => window.comando.requestWorkspaceSurfaceContext(input),
            {
                projectId: project.id,
                worktreeId: secondaryWorktree.id,
            },
        );
        await hostPage.waitForFunction(
            async (expectedCount) =>
                (await window.comando.listOpenWorkspaceLocations()).length ===
                expectedCount,
            2,
        );
        await hostPage.waitForTimeout(1_200);

        surfacePages = workspaceSurfacePages(electronApp);
        if (surfacePages.length !== 2) {
            throw new Error(
                `Expected two resident surfaces, found ${surfacePages.length}.`,
            );
        }

        const locations = await hostPage.evaluate(() =>
            window.comando.listOpenWorkspaceLocations(),
        );
        const primary = locations.find((location) => location.worktreeId === null);
        const secondary = locations.find(
            (location) => location.worktreeId !== null,
        );
        if (!primary || !secondary) {
            throw new Error("Both workspace scopes must be resident.");
        }

        const warmSwitch = await hostPage.evaluate(
            async ({ primaryKey, sampleCount, secondaryKey }) => {
                const samplesMs = [];
                for (let index = 0; index < sampleCount; index += 1) {
                    const contextKey =
                        index % 2 === 0 ? secondaryKey : primaryKey;
                    const startedAt = performance.now();
                    await window.comando.activateWorkspaceSurface(contextKey);
                    samplesMs.push(performance.now() - startedAt);
                }
                return samplesMs;
            },
            {
                primaryKey: primary.contextKey,
                sampleCount: WARM_SWITCH_SAMPLE_COUNT,
                secondaryKey: secondary.contextKey,
            },
        );
        const sortedWarmSwitch = warmSwitch.toSorted(
            (left, right) => left - right,
        );

        await hostPage.evaluate(
            (contextKey) =>
                window.comando.activateWorkspaceSurface(contextKey),
            primary.contextKey,
        );
        const surfaceProcesses = await resolveSurfaceProcesses(
            electronApp,
            surfacePages,
        );

        await electronApp.evaluate(({ app }) => app.getAppMetrics());
        await new Promise((resolve) => setTimeout(resolve, IDLE_SAMPLE_MS));
        const idleMetrics = await electronApp.evaluate(({ app }) =>
            app.getAppMetrics().map((metric) => ({
                cpuPercent: metric.cpu.percentCPUUsage,
                memoryKb: metric.memory.workingSetSize,
                pid: metric.pid,
                type: metric.type,
            })),
        );
        const hiddenSurface = surfaceProcesses.find(
            (surface) => surface.worktreeId !== null,
        );

        const closeStartedAt = performance.now();
        await electronApp.close();
        const gracefulCloseMs = performance.now() - closeStartedAt;
        electronApp = undefined;

        const restoreStartedAt = performance.now();
        electronApp = await launchApp(userDataPath);
        hostPage = await electronApp.firstWindow();
        await waitForHostReady(hostPage, false);
        await waitForRestoredSurfaces(electronApp, hostPage, 2);
        const restoreTwoSurfacesMs = performance.now() - restoreStartedAt;
        const restoredLocations = await hostPage.evaluate(() =>
            window.comando.listOpenWorkspaceLocations(),
        );

        return {
            gracefulCloseMs,
            hiddenSurfaceCpuPercent: idleMetrics.find(
                (metric) => metric.pid === hiddenSurface?.pid,
            )?.cpuPercent,
            processMetrics: idleMetrics,
            restoreTwoSurfacesMs,
            restoredScopeCount: restoredLocations.length,
            restoredSurfaceCount: workspaceSurfacePages(electronApp).length,
            totalWorkingSetKb: idleMetrics.reduce(
                (total, metric) => total + metric.memoryKb,
                0,
            ),
            warmSwitch: {
                maxMs: sortedWarmSwitch.at(-1),
                medianMs: percentile(sortedWarmSwitch, 0.5),
                minMs: sortedWarmSwitch[0],
                p95Ms: percentile(sortedWarmSwitch, 0.95),
            },
        };
    } finally {
        await electronApp?.close().catch(() => undefined);
        removeTemporaryUserDataPath(userDataPath);
    }
}

async function resolveSurfaceProcesses(electronApp, surfacePages) {
    const targets = await electronApp.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((contents) => ({
            pid: contents.getOSProcessId(),
            url: contents.getURL(),
        })),
    );
    return await Promise.all(
        surfacePages.map(async (surfacePage) => {
            const context = await surfacePage.evaluate(() =>
                window.comando.getWindowContext(),
            );
            return {
                ...context,
                pid: targets.find((target) => target.url === surfacePage.url())
                    ?.pid,
            };
        }),
    );
}

async function waitForRestoredSurfaces(
    electronApp,
    hostPage,
    expectedCount,
) {
    for (let attempt = 0; attempt < RESTORE_POLL_ATTEMPTS; attempt += 1) {
        const locations = await hostPage.evaluate(() =>
            window.comando.listOpenWorkspaceLocations(),
        );
        if (
            locations.length === expectedCount &&
            workspaceSurfacePages(electronApp).length === expectedCount
        ) {
            return;
        }
        await hostPage.waitForTimeout(RESTORE_POLL_INTERVAL_MS);
    }
    throw new Error("Timed out waiting for restored workspace surfaces.");
}

async function waitForHostReady(hostPage, expectWelcome) {
    await hostPage.waitForFunction(
        () => typeof window.comando === "object",
        null,
        { timeout: 30_000 },
    );
    if (expectWelcome) {
        await hostPage
            .getByText("Open a folder to get started.")
            .waitFor({ timeout: 30_000 });
    }
}

function workspaceSurfacePages(electronApp) {
    return electronApp
        .windows()
        .filter((page) => page.url().includes("window=workspace-surface"));
}

function percentile(sortedSamples, ratio) {
    return sortedSamples[
        Math.min(
            sortedSamples.length - 1,
            Math.floor(sortedSamples.length * ratio),
        )
    ];
}

function createTemporaryUserDataPath(suffix) {
    return mkdtempSync(
        path.join(os.tmpdir(), `comando-workspace-f0-${suffix}-`),
    );
}

function removeTemporaryUserDataPath(userDataPath) {
    // The prefix check prevents a future refactor from deleting an arbitrary path.
    if (!path.basename(userDataPath).startsWith("comando-workspace-f0-")) {
        throw new Error(`Refusing to remove unexpected path: ${userDataPath}`);
    }
    rmSync(userDataPath, { force: true, recursive: true });
}

function launchApp(userDataPath) {
    return _electron.launch({
        args: [repositoryRoot, `--user-data-dir=${userDataPath}`],
        cwd: repositoryRoot,
        env: {
            ...process.env,
            COMANDO_APP_CHANNEL: "release",
            COMANDO_NATIVE_BACKEND_PATH: nativeBackendPath,
        },
        timeout: 30_000,
    });
}
