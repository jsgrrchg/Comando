export function createSafeGitEnvironment(
    overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...overrides,
    };

    // simple-git blocks pager variables for safety, and programmatic calls
    // should never need interactive paging.
    delete env.GIT_PAGER;
    delete env.PAGER;

    return env;
}
