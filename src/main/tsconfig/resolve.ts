import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type {
    TsconfigCompilerOptionsSnapshot,
    TsconfigModuleResolution,
    TsconfigResolutionSnapshot,
} from "@shared/ipc";

const TYPESCRIPT_UNRESOLVED_MODULE_DIAGNOSTIC_CODE = 2307;
const requireFromTsconfigResolver = createRequire(import.meta.url);

interface JsonObject {
    readonly [key: string]: unknown;
}

interface LoadedTsconfig {
    readonly compilerOptions: JsonObject;
    readonly configPath: string;
    readonly include: readonly string[] | null;
    readonly references: readonly string[];
}

interface TsconfigDependencySnapshot {
    readonly mtimeMs: number;
    readonly path: string;
    readonly size: number;
}

interface TsconfigCacheEntry {
    readonly dependencies: readonly TsconfigDependencySnapshot[];
    readonly snapshot: TsconfigResolutionSnapshot;
}

interface ResolveTsconfigForPathInput {
    readonly filePath: string;
    readonly projectRootPath: string | null;
}

const tsconfigCache = new Map<string, TsconfigCacheEntry>();

export function createEmptyTsconfigResolution(
    projectRootPath: string | null,
    errors: readonly string[] = [],
): TsconfigResolutionSnapshot {
    return {
        aliasPatterns: [],
        compilerOptions: null,
        configPath: null,
        diagnosticCodesToIgnore: [],
        errors,
        projectRootPath,
    };
}

function normalizePathForMatch(value: string): string {
    return path.resolve(value);
}

function getTsconfigCacheKey(configPath: string, filePath: string): string {
    return `${path.resolve(configPath)}\0${path.resolve(filePath)}`;
}

function isPathInside(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(
        normalizePathForMatch(rootPath),
        normalizePathForMatch(candidatePath),
    );

    return (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    );
}

function stripJsonCommentsAndTrailingCommas(source: string): string {
    let output = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < source.length; index += 1) {
        const character = source[index] ?? "";
        const nextCharacter = source[index + 1] ?? "";

        if (inString) {
            output += character;
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === "\"") {
                inString = false;
            }
            continue;
        }

        if (character === "\"") {
            inString = true;
            output += character;
            continue;
        }

        if (character === "/" && nextCharacter === "/") {
            while (index < source.length && source[index] !== "\n") {
                index += 1;
            }
            output += "\n";
            continue;
        }

        if (character === "/" && nextCharacter === "*") {
            index += 2;
            while (
                index < source.length &&
                !(source[index] === "*" && source[index + 1] === "/")
            ) {
                index += 1;
            }
            index += 1;
            continue;
        }

        output += character;
    }

    return output.replace(/,\s*([}\]])/g, "$1");
}

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getJsonObject(value: unknown): JsonObject {
    return isJsonObject(value) ? value : {};
}

function getStringArray(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length === value.length ? strings : null;
}

function getStringRecordArray(
    value: unknown,
): Readonly<Record<string, readonly string[]>> | null {
    if (!isJsonObject(value)) {
        return null;
    }

    const entries = Object.entries(value).flatMap(([key, item]) => {
        const strings = getStringArray(item);
        return strings ? [[key, strings] as const] : [];
    });

    return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function resolveExtendsPath(
    extendsValue: unknown,
    configDirectory: string,
): string | null {
    if (typeof extendsValue !== "string" || extendsValue.trim().length === 0) {
        return null;
    }

    if (
        extendsValue.startsWith(".") ||
        path.isAbsolute(extendsValue)
    ) {
        const resolvedPath = path.resolve(configDirectory, extendsValue);
        return path.extname(resolvedPath)
            ? resolvedPath
            : `${resolvedPath}.json`;
    }

    const packageCandidates = [
        extendsValue,
        path.extname(extendsValue) ? null : `${extendsValue}.json`,
        path.join(extendsValue, "tsconfig.json"),
    ].filter((candidate): candidate is string => candidate !== null);

    for (const packageCandidate of packageCandidates) {
        try {
            return requireFromTsconfigResolver.resolve(packageCandidate, {
                paths: [configDirectory],
            });
        } catch {
            // Try the next TypeScript-compatible package config shape.
        }
    }

    return null;
}

function resolveReferencePath(
    referenceValue: unknown,
    configDirectory: string,
): string | null {
    if (!isJsonObject(referenceValue) || typeof referenceValue.path !== "string") {
        return null;
    }

    const resolvedPath = path.resolve(configDirectory, referenceValue.path);
    return path.extname(resolvedPath)
        ? resolvedPath
        : path.join(resolvedPath, "tsconfig.json");
}

function normalizeModuleResolution(
    value: unknown,
): TsconfigModuleResolution | null {
    if (typeof value === "number") {
        if (value === 1) return "classic";
        if (value === 2) return "node";
        if (value === 3) return "node16";
        if (value === 99) return "nodenext";
        if (value === 100) return "bundler";
    }

    if (typeof value !== "string") {
        return null;
    }

    const normalizedValue = value.trim().toLowerCase();
    if (normalizedValue === "node" || normalizedValue === "node10") {
        return "node";
    }
    if (
        normalizedValue === "classic" ||
        normalizedValue === "node16" ||
        normalizedValue === "nodenext" ||
        normalizedValue === "bundler"
    ) {
        return normalizedValue;
    }

    return null;
}

function normalizeCompilerOptions(
    compilerOptions: JsonObject,
    configDirectory: string,
): JsonObject {
    const paths = getStringRecordArray(compilerOptions.paths);
    const baseUrl =
        typeof compilerOptions.baseUrl === "string"
            ? path.resolve(configDirectory, compilerOptions.baseUrl)
            : paths
              ? configDirectory
              : null;

    return {
        ...compilerOptions,
        ...(baseUrl ? { baseUrl } : {}),
        ...(paths ? { paths } : {}),
    };
}

function mergeCompilerOptions(
    baseOptions: JsonObject,
    ownOptions: JsonObject,
): JsonObject {
    return {
        ...baseOptions,
        ...ownOptions,
    };
}

async function readConfigFile(
    configPath: string,
    dependencies: TsconfigDependencySnapshot[],
): Promise<JsonObject> {
    const [stats, rawConfig] = await Promise.all([
        fs.stat(configPath),
        fs.readFile(configPath, "utf8"),
    ]);

    dependencies.push({
        mtimeMs: stats.mtimeMs,
        path: configPath,
        size: stats.size,
    });

    return getJsonObject(JSON.parse(stripJsonCommentsAndTrailingCommas(rawConfig)));
}

async function loadTsconfig(
    configPath: string,
    dependencies: TsconfigDependencySnapshot[],
    visitedConfigPaths = new Set<string>(),
): Promise<LoadedTsconfig> {
    const resolvedConfigPath = path.resolve(configPath);
    if (visitedConfigPaths.has(resolvedConfigPath)) {
        throw new Error(`Circular tsconfig extends chain at ${resolvedConfigPath}.`);
    }

    visitedConfigPaths.add(resolvedConfigPath);
    const configDirectory = path.dirname(resolvedConfigPath);
    const parsedConfig = await readConfigFile(resolvedConfigPath, dependencies);
    const extendedConfigPath = resolveExtendsPath(
        parsedConfig.extends,
        configDirectory,
    );
    const baseConfig = extendedConfigPath
        ? await loadTsconfig(
              extendedConfigPath,
              dependencies,
              visitedConfigPaths,
          )
        : null;
    const ownCompilerOptions = normalizeCompilerOptions(
        getJsonObject(parsedConfig.compilerOptions),
        configDirectory,
    );
    const references = Array.isArray(parsedConfig.references)
        ? parsedConfig.references.flatMap((reference) => {
              const referencePath = resolveReferencePath(reference, configDirectory);
              return referencePath ? [referencePath] : [];
          })
        : [];
    const include = getStringArray(parsedConfig.include);

    return {
        compilerOptions: mergeCompilerOptions(
            baseConfig?.compilerOptions ?? {},
            ownCompilerOptions,
        ),
        configPath: resolvedConfigPath,
        include,
        references,
    };
}

function includePatternMatchesFile(
    pattern: string,
    relativeFilePath: string,
): boolean {
    const normalizedPattern = pattern.replaceAll("\\", "/");
    const normalizedFilePath = relativeFilePath.replaceAll("\\", "/");
    const globIndex = normalizedPattern.indexOf("*");

    if (globIndex < 0) {
        return (
            normalizedFilePath === normalizedPattern ||
            normalizedFilePath.startsWith(`${normalizedPattern}/`)
        );
    }

    const prefix = normalizedPattern.slice(0, globIndex);
    const suffix = normalizedPattern.slice(
        normalizedPattern.lastIndexOf("*") + 1,
    );

    return (
        normalizedFilePath.startsWith(prefix) &&
        (suffix.length === 0 || normalizedFilePath.endsWith(suffix))
    );
}

function configIncludesFile(config: LoadedTsconfig, filePath: string): boolean {
    if (!config.include || config.include.length === 0) {
        return true;
    }

    const relativeFilePath = path.relative(path.dirname(config.configPath), filePath);
    if (relativeFilePath.startsWith("..") || path.isAbsolute(relativeFilePath)) {
        return false;
    }

    return config.include.some((pattern) =>
        includePatternMatchesFile(pattern, relativeFilePath),
    );
}

async function resolveReferencedConfig(
    config: LoadedTsconfig,
    dependencies: TsconfigDependencySnapshot[],
    filePath: string,
): Promise<LoadedTsconfig> {
    if (config.references.length === 0) {
        return config;
    }

    const referencedConfigs = await Promise.all(
        config.references.map((referencePath) =>
            loadTsconfig(referencePath, dependencies),
        ),
    );
    const matchingConfigs = referencedConfigs.filter((referencedConfig) =>
        configIncludesFile(referencedConfig, filePath),
    );
    const selectedConfigs =
        matchingConfigs.length > 0 ? matchingConfigs : referencedConfigs;
    const mergedOptions = selectedConfigs.reduce(
        (compilerOptions, referencedConfig) =>
            mergeCompilerOptions(compilerOptions, referencedConfig.compilerOptions),
        config.compilerOptions,
    );

    return {
        compilerOptions: mergedOptions,
        configPath: selectedConfigs[0]?.configPath ?? config.configPath,
        include: selectedConfigs[0]?.include ?? config.include,
        references: [],
    };
}

async function findNearestTsconfig(
    startDirectory: string,
    projectRootPath: string,
): Promise<string | null> {
    let currentDirectory = path.resolve(startDirectory);
    const rootDirectory = path.resolve(projectRootPath);

    while (isPathInside(currentDirectory, rootDirectory)) {
        const candidatePath = path.join(currentDirectory, "tsconfig.json");
        try {
            await fs.access(candidatePath);
            return candidatePath;
        } catch {
            // Keep walking toward the project root.
        }

        if (currentDirectory === rootDirectory) {
            return null;
        }
        currentDirectory = path.dirname(currentDirectory);
    }

    return null;
}

async function isCacheEntryFresh(entry: TsconfigCacheEntry): Promise<boolean> {
    for (const dependency of entry.dependencies) {
        try {
            const stats = await fs.stat(dependency.path);
            if (
                stats.mtimeMs !== dependency.mtimeMs ||
                stats.size !== dependency.size
            ) {
                return false;
            }
        } catch {
            return false;
        }
    }

    return true;
}

function createCompilerOptionsSnapshot(
    config: LoadedTsconfig,
): TsconfigCompilerOptionsSnapshot | null {
    const paths = getStringRecordArray(config.compilerOptions.paths);
    const baseUrl =
        typeof config.compilerOptions.baseUrl === "string"
            ? config.compilerOptions.baseUrl
            : paths
              ? path.dirname(config.configPath)
              : null;
    const moduleResolution = normalizeModuleResolution(
        config.compilerOptions.moduleResolution,
    );

    if (!baseUrl && !paths && !moduleResolution) {
        return null;
    }

    return {
        baseUrl,
        moduleResolution,
        paths,
    };
}

function createTsconfigSnapshot(
    config: LoadedTsconfig,
    projectRootPath: string,
    errors: readonly string[] = [],
): TsconfigResolutionSnapshot {
    const compilerOptions = createCompilerOptionsSnapshot(config);
    const aliasPatterns = compilerOptions?.paths
        ? Object.keys(compilerOptions.paths)
        : [];
    const diagnosticCodesToIgnore =
        aliasPatterns.length > 0
            ? [TYPESCRIPT_UNRESOLVED_MODULE_DIAGNOSTIC_CODE]
            : [];

    return {
        aliasPatterns,
        compilerOptions,
        configPath: config.configPath,
        diagnosticCodesToIgnore,
        errors,
        projectRootPath,
    };
}

export async function resolveTsconfigForPath(
    input: ResolveTsconfigForPathInput,
): Promise<TsconfigResolutionSnapshot> {
    if (!input.projectRootPath) {
        return createEmptyTsconfigResolution(null);
    }

    const projectRootPath = path.resolve(input.projectRootPath);
    const filePath = path.resolve(input.filePath);
    if (!isPathInside(filePath, projectRootPath)) {
        return createEmptyTsconfigResolution(projectRootPath, [
            "The requested file is outside the active project root.",
        ]);
    }

    const configPath = await findNearestTsconfig(
        path.dirname(filePath),
        projectRootPath,
    );
    if (!configPath) {
        return createEmptyTsconfigResolution(projectRootPath);
    }

    const cacheKey = getTsconfigCacheKey(configPath, filePath);
    const cacheEntry = tsconfigCache.get(cacheKey);
    if (cacheEntry && (await isCacheEntryFresh(cacheEntry))) {
        return cacheEntry.snapshot;
    }

    const dependencies: TsconfigDependencySnapshot[] = [];
    try {
        const rootConfig = await loadTsconfig(configPath, dependencies);
        const resolvedConfig = await resolveReferencedConfig(
            rootConfig,
            dependencies,
            filePath,
        );
        const snapshot = createTsconfigSnapshot(resolvedConfig, projectRootPath);

        tsconfigCache.set(cacheKey, {
            dependencies,
            snapshot,
        });

        return snapshot;
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : "The active tsconfig could not be resolved.";
        return createEmptyTsconfigResolution(projectRootPath, [message]);
    }
}
