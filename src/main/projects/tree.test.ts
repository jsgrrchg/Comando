import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    copyExternalProjectEntries,
    copyProjectEntries,
    createProjectEntry,
    deleteProjectEntry,
    listProjectTreeChildren,
    readProjectFile,
    renameProjectEntry,
    resolveProjectPath,
    writeProjectFile,
} from "./tree";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { force: true, recursive: true });
    }
});

describe("project tree helpers", () => {
    it("filters noisy directories and sorts folders before files", () => {
        const rootPath = createProjectFixture();

        fs.mkdirSync(path.join(rootPath, "src"));
        fs.mkdirSync(path.join(rootPath, "node_modules"));
        fs.writeFileSync(path.join(rootPath, "README.md"), "# hi\n");
        fs.writeFileSync(path.join(rootPath, ".DS_Store"), "");

        const nodes = listProjectTreeChildren({
            gitSnapshot: {
                changedPaths: [],
                exactBadges: new Map(),
            },
            parentRelativePath: null,
            projectId: "project-1",
            rootPath,
        });

        expect(nodes.map((node) => node.name)).toEqual(["src", "README.md"]);
        expect(nodes[0]).toMatchObject({
            hasChildren: false,
            kind: "directory",
        });
    });

    it("returns an empty result when a requested directory disappears", () => {
        const rootPath = createProjectFixture();

        const nodes = listProjectTreeChildren({
            gitSnapshot: {
                changedPaths: [],
                exactBadges: new Map(),
            },
            parentRelativePath: "assets",
            projectId: "project-1",
            rootPath,
        });

        expect(nodes).toEqual([]);
    });

    it("resolves file operation paths inside the project root", () => {
        const rootPath = createProjectFixture();

        expect(resolveProjectPath(rootPath, "src/../README.md")).toBe(
            path.join(rootPath, "README.md"),
        );
    });

    it("rejects file operation paths outside the project root", () => {
        const rootPath = createProjectFixture();

        expect(() => resolveProjectPath(rootPath, "../outside.txt")).toThrow(
            /outside of the project root/i,
        );
    });

    it("reads text files and preserves the relative path metadata", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "src/main.ts";

        fs.mkdirSync(path.join(rootPath, "src"));
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "console.log('ok');\n",
        );

        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        expect(document.relativePath).toBe(relativePath);
        expect(document.isBinary).toBe(false);
        expect(document.content).toContain("console.log");
        expect(document.kind).toBe("text");
        expect(document.languageId).toBe("typescript");
        expect(document.languageLabel).toBe("TypeScript");
        expect(document.imageDataBase64).toBeNull();
        expect(document.modifiedAtMs).toBeGreaterThan(0);
    });

    it("detects scripts without extension from the shebang", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "scripts/release";

        fs.mkdirSync(path.join(rootPath, "scripts"));
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "#!/usr/bin/env python3\nprint('ship it')\n",
        );

        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        expect(document.languageId).toBe("python");
        expect(document.languageLabel).toBe("Python");
    });

    it("keeps 10MB JSON files within the inline editor budget", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "large.json";
        const content = JSON.stringify({
            payload: "x".repeat(10 * 1024 * 1024),
        });

        fs.writeFileSync(path.join(rootPath, relativePath), content);

        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        expect(document.isTooLarge).toBe(false);
        expect(document.content.length).toBe(content.length);
        expect(document.languageId).toBe("json");
    });

    it("reads images with inline preview metadata", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "assets/logo.png";

        fs.mkdirSync(path.join(rootPath, "assets"));
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            Buffer.from(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0J8AAAAASUVORK5CYII=",
                "base64",
            ),
        );

        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        expect(document.kind).toBe("image");
        expect(document.mimeType).toBe("image/png");
        expect(document.imageDataBase64).toMatch(/^iVBORw0KGgo/);
        expect(document.isBinary).toBe(false);
    });

    it("creates, renames and deletes project entries safely", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src"));
        fs.mkdirSync(path.join(rootPath, "docs"));

        const createdFile = await createProjectEntry({
            kind: "file",
            name: "notes.md",
            parentRelativePath: "src",
            rootPath,
        });
        const createdDirectory = await createProjectEntry({
            kind: "directory",
            name: "assets",
            parentRelativePath: null,
            rootPath,
        });

        expect(createdFile.relativePath).toBe("src/notes.md");
        expect(createdDirectory.relativePath).toBe("assets");
        expect(fs.existsSync(path.join(rootPath, "src/notes.md"))).toBe(true);
        expect(fs.existsSync(path.join(rootPath, "assets"))).toBe(true);

        const renamedFile = await renameProjectEntry({
            nextName: "README.md",
            relativePath: "src/notes.md",
            rootPath,
        });
        const renamedDirectory = await renameProjectEntry({
            nextName: "public",
            relativePath: "assets",
            rootPath,
        });

        expect(renamedFile.relativePath).toBe("src/README.md");
        expect(renamedDirectory.relativePath).toBe("public");
        expect(fs.existsSync(path.join(rootPath, "src/README.md"))).toBe(true);
        expect(fs.existsSync(path.join(rootPath, "public"))).toBe(true);

        const movedFile = await renameProjectEntry({
            nextName: "README.md",
            nextParentRelativePath: "docs",
            relativePath: "src/README.md",
            rootPath,
        });

        expect(movedFile.relativePath).toBe("docs/README.md");
        expect(fs.existsSync(path.join(rootPath, "docs/README.md"))).toBe(true);
        expect(fs.existsSync(path.join(rootPath, "src/README.md"))).toBe(false);

        await deleteProjectEntry({
            relativePath: "docs/README.md",
            rootPath,
        });
        await deleteProjectEntry({
            relativePath: "public",
            rootPath,
        });

        expect(fs.existsSync(path.join(rootPath, "docs/README.md"))).toBe(
            false,
        );
        expect(fs.existsSync(path.join(rootPath, "public"))).toBe(false);
    });

    it("rejects moving a folder inside itself", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src"));
        fs.mkdirSync(path.join(rootPath, "src/components"), {
            recursive: true,
        });

        await expect(
            renameProjectEntry({
                nextName: "src",
                nextParentRelativePath: "src/components",
                relativePath: "src",
                rootPath,
            }),
        ).rejects.toThrow(/inside itself/i);
    });

    it("copies a file into a destination folder", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src"));
        fs.mkdirSync(path.join(rootPath, "docs"));
        fs.writeFileSync(path.join(rootPath, "src/notes.md"), "hello\n");

        const copiedEntries = await copyProjectEntries({
            destinationParentRelativePath: "docs",
            rootPath,
            sourceRelativePaths: ["src/notes.md"],
        });

        expect(copiedEntries).toEqual([
            {
                kind: "file",
                name: "notes.md",
                parentRelativePath: "docs",
                relativePath: "docs/notes.md",
            },
        ]);
        expect(fs.readFileSync(path.join(rootPath, "docs/notes.md"), "utf8")).toBe(
            "hello\n",
        );
    });

    it("copies a folder recursively", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src/components"), {
            recursive: true,
        });
        fs.mkdirSync(path.join(rootPath, "backup"));
        fs.writeFileSync(
            path.join(rootPath, "src/components/Button.tsx"),
            "export const Button = () => null;\n",
        );

        const copiedEntries = await copyProjectEntries({
            destinationParentRelativePath: "backup",
            rootPath,
            sourceRelativePaths: ["src"],
        });

        expect(copiedEntries[0]).toMatchObject({
            kind: "directory",
            name: "src",
            parentRelativePath: "backup",
            relativePath: "backup/src",
        });
        expect(
            fs.readFileSync(
                path.join(rootPath, "backup/src/components/Button.tsx"),
                "utf8",
            ),
        ).toContain("Button");
    });

    it("resolves duplicate copied names like Finder", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "docs"));
        fs.writeFileSync(path.join(rootPath, "notes.md"), "one\n");
        fs.writeFileSync(path.join(rootPath, "notes copy.md"), "two\n");

        const firstCopy = await copyProjectEntries({
            destinationParentRelativePath: null,
            rootPath,
            sourceRelativePaths: ["notes.md"],
        });
        const secondCopy = await copyProjectEntries({
            destinationParentRelativePath: null,
            rootPath,
            sourceRelativePaths: ["docs"],
        });

        expect(firstCopy[0]?.relativePath).toBe("notes copy 2.md");
        expect(secondCopy[0]?.relativePath).toBe("docs copy");
        expect(fs.existsSync(path.join(rootPath, "notes copy 2.md"))).toBe(
            true,
        );
        expect(fs.existsSync(path.join(rootPath, "docs copy"))).toBe(true);
    });

    it("rejects copying a folder into itself or a descendant", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src/components"), {
            recursive: true,
        });

        await expect(
            copyProjectEntries({
                destinationParentRelativePath: "src",
                rootPath,
                sourceRelativePaths: ["src"],
            }),
        ).rejects.toThrow(/inside itself/i);

        await expect(
            copyProjectEntries({
                destinationParentRelativePath: "src/components",
                rootPath,
                sourceRelativePaths: ["src"],
            }),
        ).rejects.toThrow(/inside itself/i);
    });

    it("copies external files and folders into a destination folder", async () => {
        const rootPath = createProjectFixture();
        const externalRoot = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "imports"));
        fs.mkdirSync(path.join(externalRoot, "assets"), { recursive: true });
        fs.writeFileSync(path.join(externalRoot, "notes.md"), "external\n");
        fs.writeFileSync(
            path.join(externalRoot, "assets", "logo.svg"),
            "<svg />\n",
        );

        const copiedEntries = await copyExternalProjectEntries({
            destinationParentRelativePath: "imports",
            rootPath,
            sourcePaths: [
                path.join(externalRoot, "notes.md"),
                path.join(externalRoot, "assets"),
            ],
        });

        expect(copiedEntries).toEqual([
            {
                kind: "file",
                name: "notes.md",
                parentRelativePath: "imports",
                relativePath: "imports/notes.md",
            },
            {
                kind: "directory",
                name: "assets",
                parentRelativePath: "imports",
                relativePath: "imports/assets",
            },
        ]);
        expect(
            fs.readFileSync(path.join(rootPath, "imports", "notes.md"), "utf8"),
        ).toBe("external\n");
        expect(
            fs.readFileSync(
                path.join(rootPath, "imports", "assets", "logo.svg"),
                "utf8",
            ),
        ).toBe("<svg />\n");
    });

    it("resolves duplicate names when copying external entries", async () => {
        const rootPath = createProjectFixture();
        const externalRoot = createProjectFixture();
        fs.writeFileSync(path.join(rootPath, "notes.md"), "one\n");
        fs.writeFileSync(path.join(externalRoot, "notes.md"), "two\n");

        const copiedEntries = await copyExternalProjectEntries({
            destinationParentRelativePath: null,
            rootPath,
            sourcePaths: [path.join(externalRoot, "notes.md")],
        });

        expect(copiedEntries[0]?.relativePath).toBe("notes copy.md");
        expect(
            fs.readFileSync(path.join(rootPath, "notes copy.md"), "utf8"),
        ).toBe("two\n");
    });

    it("rejects copying an external folder into itself", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src", "components"), {
            recursive: true,
        });

        await expect(
            copyExternalProjectEntries({
                destinationParentRelativePath: "src/components",
                rootPath,
                sourcePaths: [path.join(rootPath, "src")],
            }),
        ).rejects.toThrow(/inside itself/i);
    });

    it("rejects invalid entry names", async () => {
        const rootPath = createProjectFixture();

        await expect(
            createProjectEntry({
                kind: "file",
                name: "../hack.ts",
                parentRelativePath: null,
                rootPath,
            }),
        ).rejects.toThrow(/valid file or folder name/i);
    });

    it("rejects stale writes when the file changed on disk", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "src/main.ts";

        fs.mkdirSync(path.join(rootPath, "src"));
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "console.log(1);\n",
        );

        const opened = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "console.log(2);\n",
        );
        const conflictTime = new Date(Date.now() + 60_000);
        fs.utimesSync(
            path.join(rootPath, relativePath),
            conflictTime,
            conflictTime,
        );

        await expect(
            writeProjectFile({
                content: "console.log(3);\n",
                expectedModifiedAtMs: opened.modifiedAtMs,
                projectId: "project-1",
                relativePath,
                rootPath,
            }),
        ).rejects.toThrow(/changed on disk/i);
    });

    it("allows forced writes without the expected modified timestamp", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "src/main.ts";

        fs.mkdirSync(path.join(rootPath, "src"));
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "console.log(1);\n",
        );
        fs.writeFileSync(
            path.join(rootPath, relativePath),
            "console.log(2);\n",
        );
        const forcedTime = new Date(Date.now() + 60_000);
        fs.utimesSync(
            path.join(rootPath, relativePath),
            forcedTime,
            forcedTime,
        );

        const document = await writeProjectFile({
            content: "console.log(3);\n",
            projectId: "project-1",
            relativePath,
            rootPath,
        });

        expect(document.content).toContain("console.log(3)");
    });
});

function createProjectFixture(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comando-tree-"));
    temporaryDirectories.push(directory);
    return directory;
}
