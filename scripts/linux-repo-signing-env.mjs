export function resolveLinuxRepoGpgPassphrase(env = process.env) {
    return env.LINUX_REPO_GPG_PASSPHRASE || env.APT_REPO_GPG_PASSPHRASE || "";
}
