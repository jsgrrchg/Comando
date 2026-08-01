import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { _electron } from "@playwright/test";

const SWITCH_COUNT = readNumberArgument("switches", 100);
const IDLE_SAMPLE_MS = readNumberArgument("idle-ms", 5_000);
const SOAK_DURATION_MS = process.env.RUN_WORKSPACE_SOAK
    ? readNumberArgument("duration-ms", 30 * 60_000)
    : 0;
const CATALOG_SCOPE_COUNT = readNumberArgument("catalog-scopes", 500);
const RESIDENT_SCOPE_COUNT = readNumberArgument("resident-scopes", 8);
const DENSE_TAB_COUNT = readNumberArgument("dense-tabs", 120);
const POLL_ATTEMPTS = 300;
const POLL_INTERVAL_MS = 100;
const repositoryRoot = process.cwd();
const nativeBackendPath = path.join(
    repositoryRoot,
    "target",
    "debug",
    "comando-native-backend",
);

if (!existsSync(nativeBackendPath)) {
    throw new Error(
        "The native backend is missing. Run pnpm run native:dev before the workspace soak.",
    );
}

const result = await runWorkspaceSoak();
console.log(JSON.stringify(result, null, 2));
assertGate(result);

async function runWorkspaceSoak() {
    const temporaryRoot = mkdtempSync(
        path.join(os.tmpdir(), "comando-workspace-soak-"),
    );
    const userDataPath = path.join(temporaryRoot, "user-data");
    const projectPaths = Array.from({ length: RESIDENT_SCOPE_COUNT }, (_, index) => {
        const projectPath = path.join(temporaryRoot, `project-${index}`);
        mkdirSync(projectPath, { recursive: true });
        return projectPath;
    });
    let electronApp;
    try {
        const startupStartedAt = performance.now();
        electronApp = await launchApp(userDataPath);
        let hostPage = await electronApp.firstWindow();
        await waitForHostBridge(hostPage);
        const startupMs = performance.now() - startupStartedAt;

        const added = await hostPage.evaluate(
            (paths) => window.comando.addProjectPaths(paths),
            projectPaths,
        );
        if (added.projects.length !== RESIDENT_SCOPE_COUNT) {
            throw new Error(
                `Expected ${RESIDENT_SCOPE_COUNT} projects, registered ${added.projects.length}.`,
            );
        }
        await hostPage.waitForTimeout(1_000);
        const registry = createRegistry(added.projects);
        await hostPage.evaluate(
            (snapshot) => window.comando.initializeWorkspaceSurfaces(snapshot),
            registry,
        );
        await waitForActiveScope(hostPage, registry.activeScopeKey);
        const startupDiagnostics =
            await getWorkspaceDiagnostics(hostPage);
        if (residentCount(startupDiagnostics) !== 1) {
            throw new Error("Startup hydrated an inactive workspace layout.");
        }

        const residentWorkspaces = registry.workspaces.slice(
            0,
            RESIDENT_SCOPE_COUNT,
        );
        for (let index = 0; index < residentWorkspaces.length; index += 1) {
            const workspace = residentWorkspaces[index];
            await requestScopeActivation(
                electronApp,
                residentWorkspaces[Math.max(0, index - 1)].scopeKey,
                workspace.projectId,
            );
            await waitForActiveScope(hostPage, workspace.scopeKey);
            await setSurfaceLease(electronApp, workspace.scopeKey, true);
        }
        // Registration mutates each surface store and can supersede synthetic leases.
        // A second pass runs after topology stabilizes and retains every heavy renderer.
        for (const workspace of residentWorkspaces) {
            await activateStableScope(hostPage, workspace.scopeKey);
            await setSurfaceLease(electronApp, workspace.scopeKey, true);
        }
        const leasedDiagnostics = await getWorkspaceDiagnostics(hostPage);
        if (residentCount(leasedDiagnostics) !== RESIDENT_SCOPE_COUNT) {
            throw new Error(
                `Explicit leases retained ${residentCount(leasedDiagnostics)} of ${RESIDENT_SCOPE_COUNT} workspaces.`,
            );
        }

        const warmScopeKeys = registry.workspaces
            .slice(0, RESIDENT_SCOPE_COUNT)
            .map((workspace) => workspace.scopeKey);
        const switchSamples = await switchRapidly(
            hostPage,
            warmScopeKeys,
            SWITCH_COUNT,
        );
        await resizeBurst(electronApp);
        const firstCheckpoint = await sampleCheckpoint(
            electronApp,
            hostPage,
            warmScopeKeys.at(-1),
        );

        const soakStartedAt = performance.now();
        let soakSwitches = 0;
        while (performance.now() - soakStartedAt < SOAK_DURATION_MS) {
            await switchRapidly(hostPage, warmScopeKeys, warmScopeKeys.length);
            await resizeBurst(electronApp);
            soakSwitches += warmScopeKeys.length;
        }

        for (const scopeKey of warmScopeKeys) {
            await setSurfaceLease(electronApp, scopeKey, false);
        }
        await hostPage.evaluate(
            (scopeKey) => window.comando.activateWorkspaceSurface(scopeKey),
            warmScopeKeys[0],
        );
        const budgetDiagnostics = await getWorkspaceDiagnostics(hostPage);
        const coldScopeKey = warmScopeKeys[1];
        await crashSurface(electronApp, coldScopeKey);
        await waitForColdScope(hostPage, coldScopeKey);
        const immediateClose = await hostPage.evaluate(async (scopeKey) => {
            const activation = window.comando.activateWorkspaceSurface(scopeKey);
            const close = await window.comando.closeWorkspaceSurface(scopeKey);
            const activationResult = await activation;
            return { activationResult, close };
        }, coldScopeKey);
        if (
            immediateClose.activationResult.status !== "activated" ||
            immediateClose.close.status !== "blocked"
        ) {
            throw new Error("Immediate close did not preserve the in-flight restore.");
        }

        await crashSurface(electronApp, coldScopeKey);
        await waitForColdScope(hostPage, coldScopeKey);
        await hostPage.evaluate(
            (scopeKey) => window.comando.activateWorkspaceSurface(scopeKey),
            coldScopeKey,
        );
        await waitForActiveScope(hostPage, coldScopeKey);

        const secondCheckpoint = await sampleCheckpoint(
            electronApp,
            hostPage,
            coldScopeKey,
        );
        await electronApp.close();
        electronApp = undefined;

        const restoreStartedAt = performance.now();
        electronApp = await launchApp(userDataPath);
        hostPage = await electronApp.firstWindow();
        await waitForHostBridge(hostPage);
        await waitForCatalogSize(hostPage, RESIDENT_SCOPE_COUNT);
        const restoreMs = performance.now() - restoreStartedAt;
        const restoredCatalog = await hostPage.evaluate(() =>
            window.comando.getWorkspaceCatalog(),
        );

        return {
            capturedAt: new Date().toISOString(),
            configuration: {
                catalogScopeCount: CATALOG_SCOPE_COUNT,
                denseTabCount: DENSE_TAB_COUNT,
                idleSampleMs: IDLE_SAMPLE_MS,
                residentScopeCount: RESIDENT_SCOPE_COUNT,
                soakDurationMs: SOAK_DURATION_MS,
                soakSwitches,
                switchCount: SWITCH_COUNT,
            },
            gate: {
                budgetExceptionCount: Math.max(
                    0,
                    residentCount(budgetDiagnostics) -
                        (budgetDiagnostics.maxWarmSurfaces + 1),
                ),
                budgetResidentCount: residentCount(budgetDiagnostics),
                catalogPeakScopeCount:
                    secondCheckpoint.diagnostics.performance
                        .catalogPeakScopeCount,
                durableWorkspaceCount: restoredCatalog.workspaces.length,
                maxAllowedResidents: budgetDiagnostics.maxWarmSurfaces + 1,
                rendererGrowth:
                    secondCheckpoint.residentCount - firstCheckpoint.residentCount,
                restoreMs,
                safetyBlocks:
                    budgetDiagnostics.performance.hibernationsAvoided,
                startupMs,
            },
            metrics: secondCheckpoint.diagnostics.performance,
            process: {
                hiddenCpuPercent: secondCheckpoint.hiddenCpuPercent,
                totalWorkingSetKb: secondCheckpoint.totalWorkingSetKb,
                workingSetGrowthKb:
                    secondCheckpoint.totalWorkingSetKb -
                    firstCheckpoint.totalWorkingSetKb,
            },
            warmSwitch: summarize(switchSamples),
        };
    } finally {
        await electronApp?.close().catch(() => undefined);
        // The prefix guard keeps cleanup recoverable from future path refactors.
        if (!path.basename(temporaryRoot).startsWith("comando-workspace-soak-")) {
            throw new Error(`Refusing to clean unexpected path: ${temporaryRoot}`);
        }
        rmSync(temporaryRoot, { force: true, recursive: true });
    }
}

function createRegistry(projects) {
    const residentWorkspaces = projects.map((project, projectIndex) =>
        createWorkspace(project.id, projectIndex, DENSE_TAB_COUNT),
    );
    const coldMetadata = Array.from(
        { length: CATALOG_SCOPE_COUNT - residentWorkspaces.length },
        (_, index) =>
            createWorkspace(
                projects[0].id,
                index + residentWorkspaces.length,
                DENSE_TAB_COUNT,
                `synthetic-${index}`,
            ),
    );
    return {
        activeScopeKey: residentWorkspaces[0].scopeKey,
        workspaces: [...residentWorkspaces, ...coldMetadata],
    };
}

function createWorkspace(projectId, index, tabCount, worktreeId = null) {
    const scopeKey = `${projectId}::${worktreeId ?? "__primary__"}`;
    const tabs = Array.from({ length: tabCount }, (_, tabIndex) => {
        const common = {
            createdAt: "2026-08-01T00:00:00.000Z",
            id: `${scopeKey}:tab-${tabIndex}`,
            projectId,
            title: `Heavy tab ${index}-${tabIndex}`,
            worktreeId,
        };
        switch (tabIndex % 5) {
            case 0:
                return {
                    ...common,
                    draft: "x".repeat(4_096),
                    kind: "chat",
                    runtimeId: "codex",
                    sessionId: `${scopeKey}:chat-${tabIndex}`,
                };
            case 1:
                return { ...common, kind: "git_worktree_diff" };
            case 2:
                return { ...common, kind: "git" };
            case 3:
                return {
                    ...common,
                    kind: "terminal",
                    sessionId: `${scopeKey}:terminal-${tabIndex}`,
                };
            default:
                return {
                    ...common,
                    kind: "file",
                    relativePath: `tree/${tabIndex}/fixture-${tabIndex}.ts`,
                };
        }
    });
    return {
        initialLayout: {
            activePaneId: `pane-${scopeKey}`,
            rootNode: {
                activeTabId: tabs[0]?.id ?? null,
                id: `pane-${scopeKey}`,
                tabIds: tabs.map((tab) => tab.id),
                type: "pane",
            },
            tabs,
        },
        lastActivatedAt: new Date(Date.now() - index * 1_000).toISOString(),
        projectId,
        scopeKey,
        worktreeId,
    };
}

async function switchRapidly(hostPage, scopeKeys, count) {
    return hostPage.evaluate(
        async ({ count: switchCount, keys }) => {
            const samples = [];
            for (let index = 0; index < switchCount; index += 1) {
                const startedAt = performance.now();
                const result = await window.comando.activateWorkspaceSurface(
                    keys[index % keys.length],
                );
                if (result.status !== "activated") {
                    throw new Error(`Workspace switch ended as ${result.status}.`);
                }
                samples.push(performance.now() - startedAt);
            }
            return samples;
        },
        { count, keys: scopeKeys },
    );
}

async function activateStableScope(hostPage, scopeKey) {
    let lastResult;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        lastResult = await hostPage.evaluate(
            (targetScopeKey) =>
                window.comando.activateWorkspaceSurface(targetScopeKey),
            scopeKey,
        );
        if (lastResult.status === "activated") {
            return;
        }
        await hostPage.waitForTimeout(250);
    }
    const diagnostics = await getWorkspaceDiagnostics(hostPage);
    const catalog = await hostPage.evaluate(() =>
        window.comando.getWorkspaceCatalog(),
    );
    throw new Error(
        `Could not activate ${scopeKey}: ${JSON.stringify({
            catalogScopes: catalog.workspaces.map((workspace) => workspace.scopeKey),
            diagnostics: diagnostics.surfaces.map((surface) => ({
                generation: surface.generation,
                scopeKey: surface.scopeKey,
                state: surface.state,
            })),
            lastResult,
        })}.`,
    );
}

async function resizeBurst(electronApp) {
    await electronApp.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows()[0];
        if (!host) {
            return;
        }
        const [width, height] = host.getSize();
        host.setSize(width + 20, height + 20);
        host.setSize(width, height);
    });
}

async function requestScopeActivation(
    electronApp,
    activeScopeKey,
    projectId,
) {
    const activeSurface = await waitForSurfacePage(electronApp, activeScopeKey);
    await activeSurface.evaluate(
        (targetProjectId) =>
            window.comando.requestWorkspaceScopeActivation({
                projectId: targetProjectId,
                worktreeId: null,
            }),
        projectId,
    );
}

async function setSurfaceLease(electronApp, scopeKey, enabled) {
    const surfacePage = await waitForSurfacePage(electronApp, scopeKey);
    await surfacePage.evaluate(
        async ({ enabled: shouldLease, scopeKey: expectedScopeKey }) => {
            const query = new URLSearchParams(window.location.search);
            const binding = {
                generation: query.get("surface"),
                runtimeOwnerId: query.get("runtime-owner"),
                scopeKey: query.get("scope"),
            };
            if (
                !binding.generation ||
                !binding.runtimeOwnerId ||
                binding.scopeKey !== expectedScopeKey
            ) {
                throw new Error("The workspace surface binding is unavailable.");
            }
            await window.comando.reportWorkspaceSurfaceLeases({
                ...binding,
                leases: shouldLease
                    ? [
                          {
                              acquiredAt: new Date().toISOString(),
                              id: `soak:${expectedScopeKey}`,
                              kind: "ai-critical",
                              message: "The performance soak retains this renderer.",
                          },
                      ]
                    : [],
            });
        },
        { enabled, scopeKey },
    );
}

async function crashSurface(electronApp, scopeKey) {
    await electronApp.evaluate(
        ({ webContents }, expectedScopeKey) => {
            const target = webContents
                .getAllWebContents()
                .find((contents) => {
                    const query = new URL(contents.getURL()).searchParams;
                    return (
                        query.get("window") === "workspace-surface" &&
                        query.get("scope") === expectedScopeKey
                    );
                });
            if (!target) {
                throw new Error("The crash target surface is unavailable.");
            }
            target.forcefullyCrashRenderer();
        },
        scopeKey,
    );
}

async function sampleCheckpoint(electronApp, hostPage, activeScopeKey) {
    await electronApp.evaluate(({ app }) => app.getAppMetrics());
    await new Promise((resolve) => setTimeout(resolve, IDLE_SAMPLE_MS));
    const processMetrics = await electronApp.evaluate(({ app }) =>
        app.getAppMetrics().map((metric) => ({
            cpuPercent: metric.cpu.percentCPUUsage,
            memoryKb: metric.memory.workingSetSize,
            pid: metric.pid,
        })),
    );
    const diagnostics = await getWorkspaceDiagnostics(hostPage);
    const surfacePids = await electronApp.evaluate(({ webContents }) =>
        webContents
            .getAllWebContents()
            .filter((contents) =>
                contents.getURL().includes("window=workspace-surface"),
            )
            .map((contents) => ({
                pid: contents.getOSProcessId(),
                scopeKey: new URL(contents.getURL()).searchParams.get("scope"),
            })),
    );
    const hiddenPids = new Set(
        surfacePids
            .filter((surface) => surface.scopeKey !== activeScopeKey)
            .map((surface) => surface.pid),
    );
    return {
        diagnostics,
        hiddenCpuPercent: processMetrics
            .filter((metric) => hiddenPids.has(metric.pid))
            .reduce((total, metric) => total + metric.cpuPercent, 0),
        residentCount: residentCount(diagnostics),
        totalWorkingSetKb: processMetrics.reduce(
            (total, metric) => total + metric.memoryKb,
            0,
        ),
    };
}

async function getWorkspaceDiagnostics(hostPage) {
    return hostPage.evaluate(() =>
        window.comando.getWorkspaceSurfaceDiagnostics(),
    );
}

async function waitForHostBridge(hostPage) {
    await hostPage.waitForFunction(
        () => typeof window.comando?.getWorkspaceCatalog === "function",
        null,
        { timeout: 30_000 },
    );
}

async function waitForActiveScope(hostPage, scopeKey) {
    await hostPage.waitForFunction(
        async (expectedScopeKey) => {
            const diagnostics =
                await window.comando.getWorkspaceSurfaceDiagnostics();
            return (
                diagnostics.activeScopeKey === expectedScopeKey &&
                diagnostics.surfaces.find(
                    (surface) => surface.scopeKey === expectedScopeKey,
                )?.state === "active"
            );
        },
        scopeKey,
        { timeout: 30_000 },
    );
}

async function waitForColdScope(hostPage, scopeKey) {
    await hostPage.waitForFunction(
        async (expectedScopeKey) => {
            const diagnostics =
                await window.comando.getWorkspaceSurfaceDiagnostics();
            return (
                diagnostics.surfaces.find(
                    (surface) => surface.scopeKey === expectedScopeKey,
                )?.generation === null
            );
        },
        scopeKey,
        { timeout: 30_000 },
    );
}

async function waitForCatalogSize(hostPage, minimumCount) {
    await hostPage.waitForFunction(
        async (expectedCount) =>
            (await window.comando.getWorkspaceCatalog()).workspaces.length >=
            expectedCount,
        minimumCount,
        { timeout: 30_000 },
    );
}

async function waitForSurfacePage(electronApp, scopeKey) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        const page = electronApp.windows().find((candidate) => {
            if (!candidate.url().includes("window=workspace-surface")) {
                return false;
            }
            return new URL(candidate.url()).searchParams.get("scope") === scopeKey;
        });
        if (page) {
            return page;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out waiting for surface ${scopeKey}.`);
}

function residentCount(diagnostics) {
    return diagnostics.surfaces.filter(
        (surface) => surface.generation !== null,
    ).length;
}

function summarize(samples) {
    const sorted = samples.toSorted((left, right) => left - right);
    return {
        maxMs: sorted.at(-1) ?? 0,
        medianMs: percentile(sorted, 0.5),
        minMs: sorted[0] ?? 0,
        p95Ms: percentile(sorted, 0.95),
    };
}

function percentile(sortedSamples, ratio) {
    if (sortedSamples.length === 0) {
        return 0;
    }
    return sortedSamples[
        Math.min(
            sortedSamples.length - 1,
            Math.floor(sortedSamples.length * ratio),
        )
    ];
}

function assertGate(result) {
    const failures = [];
    if (result.gate.budgetExceptionCount > result.gate.safetyBlocks) {
        failures.push("resident renderers exceed the calibrated warm budget");
    }
    if (result.gate.catalogPeakScopeCount < CATALOG_SCOPE_COUNT) {
        failures.push("the large catalog scenario was not observed");
    }
    if (result.gate.rendererGrowth > 1) {
        failures.push("renderer count grows across checkpoints");
    }
    if (result.gate.durableWorkspaceCount < RESIDENT_SCOPE_COUNT) {
        failures.push("durable workspaces were lost after restart");
    }
    if (result.process.hiddenCpuPercent > 5) {
        failures.push("hidden renderer CPU exceeds 5 percent");
    }
    if (failures.length > 0) {
        throw new Error(`Workspace performance gate failed: ${failures.join("; ")}.`);
    }
}

function readNumberArgument(name, fallback) {
    const prefix = `--${name}=`;
    const raw = process.argv.find((argument) => argument.startsWith(prefix));
    if (!raw) {
        return fallback;
    }
    const value = Number(raw.slice(prefix.length));
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid ${prefix} argument.`);
    }
    return Math.floor(value);
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
