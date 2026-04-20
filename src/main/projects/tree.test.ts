import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    createProjectEntry,
    deleteProjectEntry,
    listProjectTreeChildren,
    readProjectFile,
    renameProjectEntry,
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
