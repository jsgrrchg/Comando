import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectEntry, deleteProjectEntry, listProjectTreeChildren, readProjectFile, renameProjectEntry, } from "./tree";
const temporaryDirectories = [];
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
    it("reads text files and preserves the relative path metadata", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "src/main.ts";
        fs.mkdirSync(path.join(rootPath, "src"));
        fs.writeFileSync(path.join(rootPath, relativePath), "console.log('ok');\n");
        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });
        expect(document.relativePath).toBe(relativePath);
        expect(document.isBinary).toBe(false);
        expect(document.content).toContain("console.log");
        expect(document.languageId).toBe("typescript");
        expect(document.languageLabel).toBe("TypeScript");
    });
    it("detects scripts without extension from the shebang", async () => {
        const rootPath = createProjectFixture();
        const relativePath = "scripts/release";
        fs.mkdirSync(path.join(rootPath, "scripts"));
        fs.writeFileSync(path.join(rootPath, relativePath), "#!/usr/bin/env python3\nprint('ship it')\n");
        const document = await readProjectFile({
            projectId: "project-1",
            relativePath,
            rootPath,
        });
        expect(document.languageId).toBe("python");
        expect(document.languageLabel).toBe("Python");
    });
    it("creates, renames and deletes project entries safely", async () => {
        const rootPath = createProjectFixture();
        fs.mkdirSync(path.join(rootPath, "src"));
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
        await deleteProjectEntry({
            relativePath: "src/README.md",
            rootPath,
        });
        await deleteProjectEntry({
            relativePath: "public",
            rootPath,
        });
        expect(fs.existsSync(path.join(rootPath, "src/README.md"))).toBe(false);
        expect(fs.existsSync(path.join(rootPath, "public"))).toBe(false);
    });
    it("rejects invalid entry names", async () => {
        const rootPath = createProjectFixture();
        await expect(createProjectEntry({
            kind: "file",
            name: "../hack.ts",
            parentRelativePath: null,
            rootPath,
        })).rejects.toThrow(/valid file or folder name/i);
    });
});
function createProjectFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comando-tree-"));
    temporaryDirectories.push(directory);
    return directory;
}
