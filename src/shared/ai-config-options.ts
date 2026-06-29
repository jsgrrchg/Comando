import type { AiSessionConfigOption } from "./ipc";

const REASONING_EFFORT_CONFIG_OPTION_IDS = new Set([
    "effort",
    "reasoning_effort",
    "thought_level",
]);

function hasSelectConfigValue(
    option: AiSessionConfigOption,
    value: string,
): boolean {
    return (
        option.type === "select" &&
        option.options.some((candidate) => candidate.value === value)
    );
}

export function applyModelIdToConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
    modelId: string | null,
): readonly AiSessionConfigOption[] {
    if (!modelId) {
        return configOptions;
    }

    return configOptions.map((option) =>
        option.type === "select" &&
        (option.category === "model" || option.id.toLowerCase() === "model") &&
        hasSelectConfigValue(option, modelId)
            ? {
                  ...option,
                  value: modelId,
              }
            : option,
    );
}

export function applyReasoningEffortToConfigOptions(
    configOptions: readonly AiSessionConfigOption[],
    reasoningEffort: string | null,
): readonly AiSessionConfigOption[] {
    if (!reasoningEffort) {
        return configOptions;
    }

    return configOptions.map((option) =>
        option.type === "select" &&
        (option.category === "reasoning" ||
            REASONING_EFFORT_CONFIG_OPTION_IDS.has(option.id.toLowerCase())) &&
        hasSelectConfigValue(option, reasoningEffort)
            ? {
                  ...option,
                  value: reasoningEffort,
              }
            : option,
    );
}
