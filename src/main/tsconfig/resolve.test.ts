import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveTsconfigForPath } from "./resolve";

const tempRoots: string[] = [];

async function createTempProject(): Promise<string> {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "comando-tsconfig-"));
    tempRoots.push(rootPath);
    return rootPath;
}

async function writeFile(
    rootPath: string,
    relativePath: string,
    content: string,
): Promise<string> {
    const filePath = path.join(rootPath, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
}

describe("resolveTsconfigForPath", () => {
    afterEach(async () => {
        await Promise.all(
            tempRoots.splice(0).map((rootPath) =>
                fs.rm(rootPath, { force: true, recursive: true }),
            ),
        );
    });

    it("resolves JSONC compiler options from the active project root", async () => {
        const rootPath = await createTempProject();
        const filePath = await writeFile(
            rootPath,
            "src/App.tsx",
            "export const App = () => null;\n",
        );

        await writeFile(
            rootPath,
            "tsconfig.json",
            [
                "{",
                "  // Comando should tolerate JSONC here.",
                "  \"compilerOptions\": {",
                "    \"baseUrl\": \".\",",
                "    \"moduleResolution\": \"Bundler\",",
                "    \"paths\": {",
                "      \"@shared/*\": [\"src/shared/*\"],",
                "    },",
                "  },",
                "}",
            ].join("\n"),
        );

        const snapshot = await resolveTsconfigForPath({
            filePath,
            projectRootPath: rootPath,
        });

        expect(snapshot.configPath).toBe(path.join(rootPath, "tsconfig.json"));
        expect(snapshot.compilerOptions).toEqual({
            baseUrl: rootPath,
            moduleResolution: "bundler",
            paths: {
                "@shared/*": ["src/shared/*"],
            },
        });
        expect(snapshot.aliasPatterns).toEqual(["@shared/*"]);
        expect(snapshot.diagnosticCodesToIgnore).toEqual([2307]);
        expect(snapshot.errors).toEqual([]);
    });

    it("merges extends and project references that match the file", async () => {
        const rootPath = await createTempProject();
        const filePath = await writeFile(
            rootPath,
            "src/renderer/App.tsx",
            "export const App = () => null;\n",
        );

        await writeFile(
            rootPath,
            "tsconfig.json",
            JSON.stringify({
                files: [],
                references: [{ path: "./tsconfig.web.json" }],
            }),
        );
        await writeFile(
            rootPath,
            "tsconfig.base.json",
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@renderer/*": ["src/renderer/*"],
                        "@shared/*": ["src/shared/*"],
                    },
                },
            }),
        );
        await writeFile(
            rootPath,
            "tsconfig.web.json",
            JSON.stringify({
                extends: "./tsconfig.base.json",
                compilerOptions: {
                    moduleResolution: "node",
                },
                include: ["src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
            }),
        );

        const snapshot = await resolveTsconfigForPath({
            filePath,
            projectRootPath: rootPath,
        });

        expect(snapshot.configPath).toBe(path.join(rootPath, "tsconfig.web.json"));
        expect(snapshot.compilerOptions).toEqual({
            baseUrl: rootPath,
            moduleResolution: "node",
            paths: {
                "@renderer/*": ["src/renderer/*"],
                "@shared/*": ["src/shared/*"],
            },
        });
    });

    it("keeps cached project-reference snapshots specific to the requested file", async () => {
        const rootPath = await createTempProject();
        const webFilePath = await writeFile(
            rootPath,
            "src/web/App.tsx",
            "export const App = () => null;\n",
        );
        const mainFilePath = await writeFile(
            rootPath,
            "src/main/index.ts",
            "export const main = true;\n",
        );

        await writeFile(
            rootPath,
            "tsconfig.json",
            JSON.stringify({
                files: [],
                references: [
                    { path: "./tsconfig.main.json" },
                    { path: "./tsconfig.web.json" },
                ],
            }),
        );
        await writeFile(
            rootPath,
            "tsconfig.main.json",
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@main/*": ["src/main/*"],
                    },
                },
                include: ["src/main/**/*.ts"],
            }),
        );
        await writeFile(
            rootPath,
            "tsconfig.web.json",
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@web/*": ["src/web/*"],
                    },
                },
                include: ["src/web/**/*.tsx"],
            }),
        );

        await expect(
            resolveTsconfigForPath({
                filePath: webFilePath,
                projectRootPath: rootPath,
            }),
        ).resolves.toMatchObject({
            aliasPatterns: ["@web/*"],
            configPath: path.join(rootPath, "tsconfig.web.json"),
        });
        await expect(
            resolveTsconfigForPath({
                filePath: mainFilePath,
                projectRootPath: rootPath,
            }),
        ).resolves.toMatchObject({
            aliasPatterns: ["@main/*"],
            configPath: path.join(rootPath, "tsconfig.main.json"),
        });
    });

    it("resolves package-based tsconfig extends from the active project", async () => {
        const rootPath = await createTempProject();
        const filePath = await writeFile(
            rootPath,
            "src/App.ts",
            "export const value = 1;\n",
        );

        await writeFile(
            rootPath,
            "node_modules/@fixture/tsconfig/tsconfig.json",
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@fixture/*": ["src/fixture/*"],
                    },
                },
            }),
        );
        await writeFile(
            rootPath,
            "tsconfig.json",
            JSON.stringify({
                extends: "@fixture/tsconfig/tsconfig.json",
                compilerOptions: {
                    moduleResolution: "node16",
                },
            }),
        );

        const snapshot = await resolveTsconfigForPath({
            filePath,
            projectRootPath: rootPath,
        });
        const packageConfigDirectory = await fs.realpath(
            path.join(rootPath, "node_modules/@fixture/tsconfig"),
        );

        expect(snapshot.compilerOptions).toEqual({
            baseUrl: packageConfigDirectory,
            moduleResolution: "node16",
            paths: {
                "@fixture/*": ["src/fixture/*"],
            },
        });
    });

    it("invalidates the cache when tsconfig changes on disk", async () => {
        const rootPath = await createTempProject();
        const filePath = await writeFile(
            rootPath,
            "src/App.ts",
            "export const value = 1;\n",
        );
        const configPath = await writeFile(
            rootPath,
            "tsconfig.json",
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@old/*": ["src/old/*"],
                    },
                },
            }),
        );

        await expect(
            resolveTsconfigForPath({ filePath, projectRootPath: rootPath }),
        ).resolves.toMatchObject({
            aliasPatterns: ["@old/*"],
        });

        await fs.writeFile(
            configPath,
            JSON.stringify({
                compilerOptions: {
                    paths: {
                        "@new/*": ["src/new/*"],
                    },
                },
            }) + "\n\n",
        );

        await expect(
            resolveTsconfigForPath({ filePath, projectRootPath: rootPath }),
        ).resolves.toMatchObject({
            aliasPatterns: ["@new/*"],
        });
    });

    it("returns an empty snapshot when the file is outside the active project", async () => {
        const rootPath = await createTempProject();
        const outsideRootPath = await createTempProject();
        const filePath = await writeFile(
            outsideRootPath,
            "src/App.tsx",
            "export const App = () => null;\n",
        );

        const snapshot = await resolveTsconfigForPath({
            filePath,
            projectRootPath: rootPath,
        });

        expect(snapshot.configPath).toBeNull();
        expect(snapshot.compilerOptions).toBeNull();
        expect(snapshot.errors).toEqual([
            "The requested file is outside the active project root.",
        ]);
    });
});
