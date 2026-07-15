const { execFileSync } = require("node:child_process");

exports.default = function signMacApp(options) {
    const entitlements = options.optionsForFile(options.app).entitlements;

    if (!options.identity || !entitlements) {
        throw new Error("macOS signing identity or entitlements are unavailable.");
    }

    const args = [
        "--force",
        "--deep",
        "--sign",
        options.identity,
        "--timestamp",
        "--options",
        "runtime",
        "--entitlements",
        entitlements,
    ];

    if (options.keychain) {
        args.push("--keychain", options.keychain);
    }

    args.push(options.app);

    execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
};
