import {
    useState,
    type CSSProperties,
    type ReactNode,
} from "react";

import type {
    AiRuntimeStatus,
    CustomAcpRuntimeDefinition,
    CustomAcpRuntimeDefinitionInput,
    CustomAcpRuntimeId,
    DeleteCustomAcpRuntimeResult,
} from "@shared/ipc";

import { SectionLabel } from "./primitives";

export interface CustomAcpRuntimesSettingsProps {
    readonly definitions?: readonly CustomAcpRuntimeDefinition[];
    readonly deletedDefinitions?: readonly CustomAcpRuntimeDefinition[];
    readonly disabled?: boolean;
    readonly onCreate?: (
        input: CustomAcpRuntimeDefinitionInput,
    ) => Promise<CustomAcpRuntimeDefinition> | CustomAcpRuntimeDefinition;
    readonly onDelete?: (
        id: CustomAcpRuntimeId,
    ) => Promise<DeleteCustomAcpRuntimeResult> | DeleteCustomAcpRuntimeResult;
    readonly onUpdate?: (
        id: CustomAcpRuntimeId,
        input: CustomAcpRuntimeDefinitionInput,
    ) => Promise<CustomAcpRuntimeDefinition> | CustomAcpRuntimeDefinition;
    readonly onRestore?: (
        id: CustomAcpRuntimeId,
    ) => Promise<CustomAcpRuntimeDefinition> | CustomAcpRuntimeDefinition;
    readonly onVerify?: (
        input: CustomAcpRuntimeDefinitionInput,
    ) => Promise<AiRuntimeStatus> | AiRuntimeStatus;
    readonly statuses?: Partial<
        Record<CustomAcpRuntimeId, AiRuntimeStatus | null>
    >;
}

interface RuntimeDraft {
    readonly argsText: string;
    readonly command: string;
    readonly displayName: string;
    readonly envText: string;
}

interface EditorState {
    readonly definition: CustomAcpRuntimeDefinition | null;
    readonly draft: RuntimeDraft;
}

const EMPTY_DRAFT: RuntimeDraft = {
    argsText: "",
    command: "",
    displayName: "",
    envText: "",
};

const FIELD_STYLE: CSSProperties = {
    backgroundColor:
        "color-mix(in srgb, var(--color-bg-tertiary) 58%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 72%, transparent)",
    borderRadius: 4,
    color: "var(--color-text-primary)",
    fontFamily: "inherit",
    fontSize: 11,
    outline: "none",
    padding: "7px 8px",
    width: "100%",
};

const BUTTON_STYLE: CSSProperties = {
    background: "var(--color-bg-tertiary)",
    border: "1px solid var(--color-border)",
    borderRadius: 4,
    color: "var(--color-text-primary)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 11,
    padding: "6px 10px",
};

export function CustomAcpRuntimesSettings({
    definitions = [],
    deletedDefinitions = [],
    disabled = false,
    onCreate,
    onDelete,
    onRestore,
    onUpdate,
    onVerify,
    statuses,
}: CustomAcpRuntimesSettingsProps) {
    const [editor, setEditor] = useState<EditorState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [verification, setVerification] = useState<AiRuntimeStatus | null>(
        null,
    );

    const updateDraft = (patch: Partial<RuntimeDraft>) => {
        setError(null);
        setVerification(null);
        setEditor((current) =>
            current
                ? { ...current, draft: { ...current.draft, ...patch } }
                : current,
        );
    };

    const runAction = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch (actionError) {
            setError(getErrorMessage(actionError));
        } finally {
            setBusy(false);
        }
    };

    const save = () => {
        if (!editor) return;
        void runAction(async () => {
            const input = parseCustomAcpRuntimeDraft(
                editor.draft,
                definitions,
                editor.definition,
            );
            if (
                editor.definition &&
                customAcpLaunchContractChanged(editor.definition, input) &&
                !window.confirm(
                    "Change this runtime launch contract?\n\nExisting history keeps its original fingerprint. Continuing an older session will require confirmation, and active sessions keep their current process.",
                )
            ) {
                return;
            }
            if (editor.definition) {
                await onUpdate?.(editor.definition.id, input);
            } else {
                await onCreate?.(input);
            }
            setEditor(null);
            setVerification(null);
        });
    };

    const verify = () => {
        if (!editor) return;
        void runAction(async () => {
            const input = parseCustomAcpRuntimeDraft(
                editor.draft,
                definitions,
                editor.definition,
            );
            const status = await onVerify?.(input);
            if (!status) {
                throw new Error("Executable verification is not available.");
            }
            setVerification(status);
        });
    };

    const deleteDefinition = (definition: CustomAcpRuntimeDefinition) => {
        if (
            !window.confirm(
                `Delete ${definition.displayName}?\n\nSaved history will remain, but it cannot start this runtime after the definition is removed. Active sessions keep their current process.`,
            )
        ) {
            return;
        }
        void runAction(async () => {
            await onDelete?.(definition.id);
        });
    };

    return (
        <section
            aria-label="Custom ACP runtime settings"
            style={{ marginTop: 28 }}
        >
            <div
                style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                }}
            >
                <SectionLabel>Custom ACP runtimes</SectionLabel>
                <button
                    disabled={disabled || busy}
                    style={BUTTON_STYLE}
                    type="button"
                    onClick={() => {
                        setEditor({
                            definition: null,
                            draft: EMPTY_DRAFT,
                        });
                        setError(null);
                        setVerification(null);
                    }}
                >
                    Add runtime
                </button>
            </div>
            <p style={noticeStyle}>
                Custom runtimes execute local programs with your account
                permissions. Comando isolates their environment and does not
                pass provider credentials or support custom secrets.
            </p>

            {definitions.length === 0 ? (
                <p style={mutedStyle}>No custom ACP runtimes configured.</p>
            ) : (
                <div style={{ display: "grid", gap: 8 }}>
                    {definitions.map((definition) => (
                        <article key={definition.id} style={cardStyle}>
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>
                                    {definition.displayName}
                                </div>
                                <div
                                    style={{
                                        ...mutedStyle,
                                        fontFamily: "var(--font-mono)",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap",
                                    }}
                                    title={definition.command}
                                >
                                    {definition.command}
                                </div>
                                <div style={mutedStyle}>
                                    Authentication managed by the runtime ·
                                    revision {definition.revision}
                                </div>
                                <div
                                    aria-label={`${definition.displayName} status`}
                                    style={{
                                        ...mutedStyle,
                                        color:
                                            statuses?.[definition.id]?.state ===
                                            "ready"
                                                ? "var(--color-success, #4ade80)"
                                                : undefined,
                                    }}
                                >
                                    Status:{" "}
                                    {formatRuntimeStatus(
                                        statuses?.[definition.id] ?? null,
                                    )}
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: 6 }}>
                                <button
                                    disabled={disabled || busy}
                                    style={BUTTON_STYLE}
                                    type="button"
                                    onClick={() => {
                                        setEditor({
                                            definition,
                                            draft: draftFromDefinition(definition),
                                        });
                                        setError(null);
                                        setVerification(null);
                                    }}
                                >
                                    Edit
                                </button>
                                <button
                                    disabled={disabled || busy}
                                    style={BUTTON_STYLE}
                                    type="button"
                                    onClick={() => deleteDefinition(definition)}
                                >
                                    Delete
                                </button>
                            </div>
                        </article>
                    ))}
                </div>
            )}

            {deletedDefinitions.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                    <div style={{ ...mutedStyle, marginBottom: 6 }}>
                        Deleted definitions retained for history
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                        {deletedDefinitions.map((definition) => (
                            <article key={definition.id} style={cardStyle}>
                                <div style={{ minWidth: 0 }}>
                                    <div
                                        style={{
                                            fontSize: 12,
                                            fontWeight: 600,
                                        }}
                                    >
                                        {definition.displayName}
                                    </div>
                                    <div style={mutedStyle}>
                                        Unavailable · revision{" "}
                                        {definition.revision}
                                    </div>
                                </div>
                                <button
                                    disabled={disabled || busy}
                                    style={BUTTON_STYLE}
                                    type="button"
                                    onClick={() => {
                                        void runAction(async () => {
                                            await onRestore?.(definition.id);
                                        });
                                    }}
                                >
                                    Restore
                                </button>
                            </article>
                        ))}
                    </div>
                </div>
            ) : null}

            {editor ? (
                <div style={editorStyle}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>
                        {editor.definition ? "Edit runtime" : "Add runtime"}
                    </div>
                    <LabeledField label="Name">
                        <input
                            autoFocus
                            maxLength={80}
                            style={FIELD_STYLE}
                            value={editor.draft.displayName}
                            onChange={(event) =>
                                updateDraft({
                                    displayName: event.currentTarget.value,
                                })
                            }
                        />
                    </LabeledField>
                    <LabeledField
                        label="Command"
                        help="Absolute path or executable name. Commands are never interpreted by a shell."
                    >
                        <input
                            maxLength={4096}
                            spellCheck={false}
                            style={{ ...FIELD_STYLE, fontFamily: "var(--font-mono)" }}
                            value={editor.draft.command}
                            onChange={(event) =>
                                updateDraft({
                                    command: event.currentTarget.value,
                                })
                            }
                        />
                    </LabeledField>
                    <LabeledField
                        label="Arguments"
                        help="One argument per line. Do not include the command."
                    >
                        <textarea
                            spellCheck={false}
                            style={textareaStyle}
                            value={editor.draft.argsText}
                            onChange={(event) =>
                                updateDraft({
                                    argsText: event.currentTarget.value,
                                })
                            }
                        />
                    </LabeledField>
                    <LabeledField
                        label="Environment"
                        help="One NAME=value pair per line. Secret-looking keys and PATH are rejected."
                    >
                        <textarea
                            spellCheck={false}
                            style={textareaStyle}
                            value={editor.draft.envText}
                            onChange={(event) =>
                                updateDraft({
                                    envText: event.currentTarget.value,
                                })
                            }
                        />
                    </LabeledField>
                    <div
                        aria-live="polite"
                        role={error ? "alert" : "status"}
                        style={{
                            color: error
                                ? "var(--color-danger, #f87171)"
                                : verification?.state === "ready"
                                  ? "var(--color-success, #4ade80)"
                                  : "var(--color-text-secondary)",
                            fontSize: 11,
                            minHeight: 16,
                        }}
                    >
                        {error ??
                            (verification
                                ? verification.state === "ready"
                                    ? `Executable verified: ${verification.command ?? editor.draft.command}`
                                    : (verification.message ??
                                      "Executable could not be verified.")
                                : "")}
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button
                            disabled={disabled || busy}
                            style={BUTTON_STYLE}
                            type="button"
                            onClick={verify}
                        >
                            Verify executable
                        </button>
                        <button
                            disabled={disabled || busy}
                            style={BUTTON_STYLE}
                            type="button"
                            onClick={save}
                        >
                            {editor.definition ? "Save changes" : "Add runtime"}
                        </button>
                        <button
                            disabled={busy}
                            style={BUTTON_STYLE}
                            type="button"
                            onClick={() => {
                                setEditor(null);
                                setError(null);
                                setVerification(null);
                            }}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}
        </section>
    );
}

function LabeledField({
    children,
    help,
    label,
}: {
    readonly children: ReactNode;
    readonly help?: string;
    readonly label: string;
}) {
    return (
        <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
            {children}
            {help ? <span style={mutedStyle}>{help}</span> : null}
        </label>
    );
}

export function parseCustomAcpRuntimeDraft(
    draft: RuntimeDraft,
    definitions: readonly CustomAcpRuntimeDefinition[],
    current: CustomAcpRuntimeDefinition | null,
): CustomAcpRuntimeDefinitionInput {
    const displayName = draft.displayName.trim();
    const command = draft.command.trim();
    if (!displayName) throw new Error("Runtime name is required.");
    if (!command) throw new Error("Command is required.");
    if (displayName.length > 80) {
        throw new Error("Runtime name must be at most 80 characters.");
    }
    if (command.length > 4096) {
        throw new Error("Command must be at most 4096 characters.");
    }
    if (command.includes("\0")) {
        throw new Error("Command cannot contain NUL characters.");
    }
    if (
        definitions.some(
            (definition) =>
                definition.id !== current?.id &&
                definition.displayName.localeCompare(displayName, undefined, {
                    sensitivity: "accent",
                }) === 0,
        )
    ) {
        throw new Error(`A custom runtime named "${displayName}" already exists.`);
    }

    const args = draft.argsText
        ? draft.argsText.split(/\r?\n/).filter((line) => line.length > 0)
        : [];
    if (args.length > 64) {
        throw new Error("Arguments must contain at most 64 items.");
    }
    if (args.some((arg) => arg.includes("\0") || arg.length > 4096)) {
        throw new Error(
            "Arguments cannot contain NUL characters or exceed 4096 characters.",
        );
    }

    const env: Record<string, string> = {};
    for (const [index, line] of draft.envText.split(/\r?\n/).entries()) {
        if (!line.trim()) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) {
            throw new Error(
                `Environment line ${index + 1} must use NAME=value.`,
            );
        }
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Environment variable "${key}" has an invalid name.`);
        }
        if (key.toUpperCase() === "PATH" || key.toUpperCase() === "PATHEXT") {
            throw new Error(`Environment variable "${key}" is controlled by Comando.`);
        }
        if (
            /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE|SECRET|TOKEN)(?:_|$)/i.test(
                key,
            )
        ) {
            throw new Error(
                `Environment variable "${key}" looks secret and is not supported.`,
            );
        }
        if (Object.hasOwn(env, key)) {
            throw new Error(`Environment variable "${key}" is duplicated.`);
        }
        if (value.includes("\0") || value.length > 8192) {
            throw new Error(
                `Environment variable "${key}" cannot contain NUL characters or exceed 8192 characters.`,
            );
        }
        env[key] = value;
    }
    if (Object.keys(env).length > 32) {
        throw new Error("Environment must contain at most 32 variables.");
    }
    const launchTextLength =
        command.length +
        args.reduce((total, arg) => total + arg.length, 0) +
        Object.entries(env).reduce(
            (total, [key, value]) => total + key.length + value.length,
            0,
        );
    if (launchTextLength > 32768) {
        throw new Error("Custom runtime launch definition is too large.");
    }

    return {
        args,
        authMode: "external",
        command,
        displayName,
        env,
    };
}

export function customAcpLaunchContractChanged(
    definition: CustomAcpRuntimeDefinition,
    input: CustomAcpRuntimeDefinitionInput,
): boolean {
    return (
        definition.command !== input.command ||
        JSON.stringify(definition.args) !== JSON.stringify(input.args) ||
        JSON.stringify(definition.env) !== JSON.stringify(input.env)
    );
}

function draftFromDefinition(
    definition: CustomAcpRuntimeDefinition,
): RuntimeDraft {
    return {
        argsText: definition.args.join("\n"),
        command: definition.command,
        displayName: definition.displayName,
        envText: Object.entries(definition.env)
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatRuntimeStatus(status: AiRuntimeStatus | null): string {
    if (!status) return "Not checked";
    if (status.state === "ready") return "Ready";
    return status.message ?? status.state;
}

const mutedStyle: CSSProperties = {
    color: "var(--color-text-secondary)",
    fontSize: 10,
    lineHeight: 1.45,
    margin: 0,
};

const noticeStyle: CSSProperties = {
    ...mutedStyle,
    borderLeft: "2px solid var(--color-accent)",
    margin: "8px 0 14px",
    padding: "6px 9px",
};

const cardStyle: CSSProperties = {
    alignItems: "center",
    border: "1px solid var(--color-border)",
    borderRadius: 5,
    display: "grid",
    gap: 12,
    gridTemplateColumns: "minmax(0, 1fr) auto",
    padding: "10px 12px",
};

const editorStyle: CSSProperties = {
    border: "1px solid var(--color-border)",
    borderRadius: 5,
    display: "grid",
    gap: 10,
    marginTop: 12,
    padding: 12,
};

const textareaStyle: CSSProperties = {
    ...FIELD_STYLE,
    fontFamily: "var(--font-mono)",
    minHeight: 68,
    resize: "vertical",
};
