import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
    buildPosixLoginScript,
    buildWindowsLoginScript,
    quoteShellArg,
    quoteWindowsArg,
} from "./terminal-login";

describe("terminal login helpers", () => {
    it("quotes shell arguments safely", () => {
        expect(quoteShellArg("/tmp/project with spaces")).toBe(
            "'/tmp/project with spaces'",
        );
        expect(quoteShellArg("it's tricky")).toBe("'it'\\''s tricky'");
        expect(quoteShellArg("$(touch nope)")).toBe("'$(touch nope)'");
    });

    it("quotes Windows arguments safely", () => {
        expect(quoteWindowsArg("C:\\Program Files\\Comando")).toBe(
            '"C:\\Program Files\\Comando"',
        );
        expect(quoteWindowsArg('say "hello"')).toBe('"say ^"hello^""');
        expect(quoteWindowsArg("A&B")).toBe('"A^&B"');
        expect(quoteWindowsArg("%TEMP%\\Comando^!")).toBe(
            '"%%TEMP%%\\Comando^^^!"',
        );
    });

    it("builds POSIX login scripts with a unique provider prefix", () => {
        const scriptPath = buildPosixLoginScript({
            commandParts: ["/usr/local/bin/opencode", "auth"],
            cwd: "/tmp/project with spaces",
            scriptPrefix: "comando-test-login",
        });

        try {
            expect(scriptPath).toContain("comando-test-login-");
            expect(scriptPath).toMatch(/\.sh$/);
            expect(fs.readFileSync(scriptPath, "utf8")).toContain(
                "cd '/tmp/project with spaces'\n'/usr/local/bin/opencode' 'auth'",
            );
        } finally {
            fs.rmSync(scriptPath, {
                force: true,
            });
        }
    });

    it("builds Windows login scripts without exposing unsafe paths", () => {
        const scriptPath = buildWindowsLoginScript({
            commandParts: [
                "C:\\Program Files\\Claude\\claude.exe",
                "login",
                'say "hello" & wait',
            ],
            cwd: "C:\\Users\\Me\\%TEMP% Project & Stuff!",
            scriptPrefix: "comando-test-login",
        });

        try {
            expect(scriptPath).toContain("comando-test-login-");
            expect(scriptPath).toMatch(/\.cmd$/);
            expect(fs.readFileSync(scriptPath, "utf8")).toContain(
                'cd /d "C:\\Users\\Me\\%%TEMP%% Project ^& Stuff^!"\r\n"C:\\Program Files\\Claude\\claude.exe" "login" "say ^"hello^" ^& wait"',
            );
        } finally {
            fs.rmSync(scriptPath, {
                force: true,
            });
        }
    });
});
