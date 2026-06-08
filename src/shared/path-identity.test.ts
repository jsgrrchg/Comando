import path from "node:path";
import { describe, expect, it } from "vitest";

import {
    isSameOrInsidePath,
    normalizePathKey,
    toDisplayRelativePath,
} from "./path-identity";

describe("normalizePathKey", () => {
    it("normalizes Windows drive letters, dot segments, separators, and casing", () => {
        const filePath = path.win32.join(
            "C:\\Workspace",
            "Comando",
            "src",
            "..",
            "README.md",
        );

        expect(normalizePathKey(filePath, { platform: "win32" })).toBe(
            "c:/workspace/comando/readme.md",
        );
    });

    it("normalizes mixed Windows separators", () => {
        expect(
            normalizePathKey("C:/Workspace\\Comando/./src\\File.ts", {
                platform: "win32",
            }),
        ).toBe("c:/workspace/comando/src/file.ts");
    });

    it("infers Windows semantics from relative backslash paths", () => {
        expect(normalizePathKey("src\\Feature\\File.ts")).toBe(
            "src/feature/file.ts",
        );
    });

    it("keeps UNC roots intact while normalizing casing", () => {
        expect(
            normalizePathKey("\\\\Server\\Share\\Comando\\SRC\\File.ts", {
                platform: "win32",
            }),
        ).toBe("//server/share/comando/src/file.ts");
    });

    it("normalizes extended Windows UNC paths", () => {
        expect(
            normalizePathKey("\\\\?\\UNC\\Server\\Share\\Comando\\File.ts", {
                platform: "win32",
            }),
        ).toBe("//server/share/comando/file.ts");
    });

    it("keeps POSIX casing significant", () => {
        expect(
            normalizePathKey("/Users/example/Comando/SRC/../File.ts", {
                platform: "posix",
            }),
        ).toBe("/Users/example/Comando/File.ts");
    });
});

describe("isSameOrInsidePath", () => {
    it("treats Windows paths with different casing as the same location", () => {
        expect(
            isSameOrInsidePath("C:\\Workspace\\Comando", "c:/workspace/comando", {
                platform: "win32",
            }),
        ).toBe(true);
    });

    it("matches Windows descendants with mixed separators and casing", () => {
        expect(
            isSameOrInsidePath(
                "C:/WORKSPACE\\Comando\\src\\File.ts",
                "c:\\workspace\\comando",
                { platform: "win32" },
            ),
        ).toBe(true);
    });

    it("does not treat Windows siblings as descendants", () => {
        expect(
            isSameOrInsidePath(
                "C:\\Workspace\\Comando-other\\src\\File.ts",
                "C:\\Workspace\\Comando",
                { platform: "win32" },
            ),
        ).toBe(false);
    });

    it("keeps POSIX containment case-sensitive", () => {
        expect(
            isSameOrInsidePath(
                "/Users/example/Comando/src",
                "/users/example/comando",
                {
                    platform: "posix",
                },
            ),
        ).toBe(false);
    });
});

describe("toDisplayRelativePath", () => {
    it("returns a Windows relative display path while preserving candidate casing", () => {
        expect(
            toDisplayRelativePath(
                "C:\\WORKSPACE\\Comando\\Src\\File.ts",
                "c:/workspace/comando",
                { platform: "win32" },
            ),
        ).toBe("Src/File.ts");
    });

    it("returns an empty string for the same Windows path", () => {
        expect(
            toDisplayRelativePath(
                "C:\\Workspace\\Comando",
                "c:/workspace/comando",
                { platform: "win32" },
            ),
        ).toBe("");
    });

    it("supports UNC relative paths", () => {
        expect(
            toDisplayRelativePath(
                "\\\\SERVER\\Share\\Comando\\src\\File.ts",
                "\\\\server\\share\\comando",
                { platform: "win32" },
            ),
        ).toBe("src/File.ts");
    });

    it("falls back to a normalized display path when outside the container", () => {
        expect(
            toDisplayRelativePath(
                "C:\\Workspace\\Other\\File.ts",
                "C:\\Workspace\\Comando",
                { platform: "win32" },
            ),
        ).toBe("C:/Workspace/Other/File.ts");
    });
});
