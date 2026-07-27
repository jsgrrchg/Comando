import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    outputDir: "test-results",
    testDir: "./tests",
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? "github" : "list",
    use: {
        baseURL: "http://localhost:5181",
        launchOptions: {
            // The cycle gate measures only post-GC heap, not allocator noise.
            args: ["--js-flags=--expose-gc"],
        },
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "pnpm exec vite --config e2e/vite.harness.config.ts --port 5181",
        cwd: "..",
        url: "http://localhost:5181",
        reuseExistingServer: !process.env.CI,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
    },
});
