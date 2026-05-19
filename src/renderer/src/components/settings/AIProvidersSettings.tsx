import {
    useEffect,
    useState,
    type CSSProperties,
    type ChangeEvent,
    type ReactNode,
} from "react";

import { SectionLabel } from "./primitives";
import {
    AI_PROVIDER_DEFINITIONS,
    buildSecretPatch,
    createClearSecretDraft,
    createEmptySecretDraft,
    getProviderMethod,
    isMethodIdForProvider,
    normalizeNullableText,
    type AiProviderAuthMethodById,
    type AiProviderAuthMethodId,
    type AiProviderDiagnosticEntry,
    type AiProviderDiagnosticsState,
    type AiProviderId,
    type AiProviderMethodDefinition,
    type AiProviderRuntimeSettingsInput,
    type AiProviderRuntimeSettingsMap,
    type AiProviderRuntimeStatus,
    type AiProviderRuntimeStatusMap,
    type AiProviderSecretDraft,
    type ClaudeProviderAuthMethodId,
    type CodexProviderAuthMethodId,
    type GeminiProviderAuthMethodId,
    type KiloProviderAuthMethodId,
} from "./aiProviderSettingsModel";

export interface AIProvidersSettingsProps {
    readonly busyProviderId?: AiProviderId | null;
    readonly defaultExpandedProviderIds?: readonly AiProviderId[];
    readonly diagnostics?: AiProviderDiagnosticsState | null;
    readonly disabled?: boolean;
    readonly errorByProviderId?: Partial<Record<AiProviderId, string | null>>;
    readonly onDisconnectAuth?: (runtimeId: AiProviderId) => Promise<void> | void;
    readonly onLaunchAuth?: (
        runtimeId: AiProviderId,
        authMethod: AiProviderAuthMethodId,
    ) => Promise<void> | void;
    readonly onLogoutAuth?: (runtimeId: AiProviderId) => Promise<void> | void;
    readonly onRefreshDiagnostics?: () => Promise<void> | void;
    readonly onSaveProviderSettings?: (
        runtimeId: AiProviderId,
        settings: AiProviderRuntimeSettingsInput,
    ) => Promise<void> | void;
    readonly onVerifyRuntime?: (runtimeId: AiProviderId) => Promise<void> | void;
    readonly runtimeSettings?: AiProviderRuntimeSettingsMap;
    readonly runtimeStatuses?: AiProviderRuntimeStatusMap;
}

interface ProviderDrafts {
    readonly claude: ClaudeProviderDraft;
    readonly codex: CodexProviderDraft;
    readonly gemini: GeminiProviderDraft;
    readonly kilo: KiloProviderDraft;
}

interface CodexProviderDraft {
    readonly authMethod: CodexProviderAuthMethodId | null;
    readonly binaryPath: string;
    readonly codexApiKey: AiProviderSecretDraft;
    readonly openAiApiKey: AiProviderSecretDraft;
}

interface ClaudeProviderDraft {
    readonly anthropicApiKey: AiProviderSecretDraft;
    readonly authMethod: ClaudeProviderAuthMethodId | null;
    readonly bedrockGatewayBaseUrl: string;
    readonly binaryPath: string;
    readonly gatewayAuthToken: AiProviderSecretDraft;
    readonly gatewayBaseUrl: string;
    readonly gatewayCustomHeaders: AiProviderSecretDraft;
}

interface GeminiProviderDraft {
    readonly authMethod: GeminiProviderAuthMethodId | null;
    readonly binaryPath: string;
    readonly geminiApiKey: AiProviderSecretDraft;
    readonly googleApiKey: AiProviderSecretDraft;
    readonly googleCloudLocation: string;
    readonly googleCloudProject: string;
}

interface KiloProviderDraft {
    readonly authMethod: KiloProviderAuthMethodId | null;
    readonly binaryPath: string;
    readonly kiloApiKey: AiProviderSecretDraft;
}

const PROVIDER_CARD_STYLE: CSSProperties = {
    borderBottom:
        "1px solid color-mix(in srgb, var(--color-border) 60%, transparent)",
    padding: "14px 0",
};

const PANEL_STYLE: CSSProperties = {
    backgroundColor: "color-mix(in srgb, var(--color-bg-secondary) 70%, transparent)",
    border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
    borderRadius: 10,
    display: "grid",
    gap: 12,
    marginTop: 12,
    padding: 12,
};

const FIELD_STYLE: CSSProperties = {
    backgroundColor: "var(--color-bg-tertiary)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    color: "var(--color-text-primary)",
    fontFamily: "inherit",
    fontSize: 12,
    outline: "none",
    padding: "7px 9px",
    width: "100%",
};

const TEXTAREA_STYLE: CSSProperties = {
    ...FIELD_STYLE,
    minHeight: 72,
    resize: "vertical",
};

export function AIProvidersSettings({
    busyProviderId = null,
    defaultExpandedProviderIds = ["codex"],
    diagnostics = null,
    disabled = false,
    errorByProviderId,
    onDisconnectAuth,
    onLaunchAuth,
    onLogoutAuth,
    onRefreshDiagnostics,
    onSaveProviderSettings,
    onVerifyRuntime,
    runtimeSettings,
    runtimeStatuses,
}: AIProvidersSettingsProps) {
    const [drafts, setDrafts] = useState<ProviderDrafts>(() =>
        createInitialDrafts(runtimeSettings),
    );
    const [expandedProviderIds, setExpandedProviderIds] = useState<
        ReadonlySet<AiProviderId>
    >(() => new Set(defaultExpandedProviderIds));
    const [localBusyProviderId, setLocalBusyProviderId] =
        useState<AiProviderId | null>(null);
    const [localErrors, setLocalErrors] = useState<
        Partial<Record<AiProviderId, string | null>>
    >({});

    useEffect(() => {
        setDrafts(createInitialDrafts(runtimeSettings));
    }, [runtimeSettings]);

    const runProviderAction = (
        providerId: AiProviderId,
        action: () => Promise<void> | void,
    ) => {
        void (async () => {
            setLocalErrors((current) => ({ ...current, [providerId]: null }));
            setLocalBusyProviderId(providerId);

            try {
                await action();
            } catch (error) {
                setLocalErrors((current) => ({
                    ...current,
                    [providerId]: getErrorMessage(error),
                }));
            } finally {
                setLocalBusyProviderId(null);
            }
        })();
    };

    const toggleExpanded = (providerId: AiProviderId) => {
        setExpandedProviderIds((current) => {
            const next = new Set(current);

            if (next.has(providerId)) {
                next.delete(providerId);
            } else {
                next.add(providerId);
            }

            return next;
        });
    };

    const saveCodex = () => {
        runProviderAction("codex", async () => {
            await onSaveProviderSettings?.("codex", {
                authMethod: drafts.codex.authMethod,
                binaryPath: normalizeNullableText(drafts.codex.binaryPath),
                codexApiKey: buildSecretPatch(drafts.codex.codexApiKey),
                openaiApiKey: buildSecretPatch(drafts.codex.openAiApiKey),
            });
            setDrafts((current) => ({
                ...current,
                codex: {
                    ...current.codex,
                    codexApiKey: createEmptySecretDraft(),
                    openAiApiKey: createEmptySecretDraft(),
                },
            }));
        });
    };

    const saveClaude = () => {
        runProviderAction("claude", async () => {
            await onSaveProviderSettings?.("claude", {
                anthropicApiKey: buildSecretPatch(
                    drafts.claude.anthropicApiKey,
                ),
                authMethod: drafts.claude.authMethod,
                bedrockGatewayBaseUrl: normalizeNullableText(
                    drafts.claude.bedrockGatewayBaseUrl,
                ),
                binaryPath: normalizeNullableText(drafts.claude.binaryPath),
                gatewayAuthToken: buildSecretPatch(
                    drafts.claude.gatewayAuthToken,
                ),
                gatewayBaseUrl: normalizeNullableText(
                    drafts.claude.gatewayBaseUrl,
                ),
                gatewayCustomHeaders: buildSecretPatch(
                    drafts.claude.gatewayCustomHeaders,
                ),
            });
            setDrafts((current) => ({
                ...current,
                claude: {
                    ...current.claude,
                    anthropicApiKey: createEmptySecretDraft(),
                    gatewayAuthToken: createEmptySecretDraft(),
                    gatewayCustomHeaders: createEmptySecretDraft(),
                },
            }));
        });
    };

    const saveGemini = () => {
        runProviderAction("gemini", async () => {
            await onSaveProviderSettings?.("gemini", {
                authMethod: drafts.gemini.authMethod,
                binaryPath: normalizeNullableText(drafts.gemini.binaryPath),
                geminiApiKey: buildSecretPatch(drafts.gemini.geminiApiKey),
                googleApiKey: buildSecretPatch(drafts.gemini.googleApiKey),
                googleCloudLocation: normalizeNullableText(
                    drafts.gemini.googleCloudLocation,
                ),
                googleCloudProject: normalizeNullableText(
                    drafts.gemini.googleCloudProject,
                ),
            });
            setDrafts((current) => ({
                ...current,
                gemini: {
                    ...current.gemini,
                    geminiApiKey: createEmptySecretDraft(),
                    googleApiKey: createEmptySecretDraft(),
                },
            }));
        });
    };

    const saveKilo = () => {
        runProviderAction("kilo", async () => {
            await onSaveProviderSettings?.("kilo", {
                authMethod: drafts.kilo.authMethod,
                binaryPath: normalizeNullableText(drafts.kilo.binaryPath),
                kiloApiKey: buildSecretPatch(drafts.kilo.kiloApiKey),
            });
            setDrafts((current) => ({
                ...current,
                kilo: {
                    ...current.kilo,
                    kiloApiKey: createEmptySecretDraft(),
                },
            }));
        });
    };

    const renderActions = <TProviderId extends AiProviderId>({
        methodId,
        providerId,
        save,
    }: {
        readonly methodId: AiProviderAuthMethodById[TProviderId] | null;
        readonly providerId: TProviderId;
        readonly save: () => void;
    }) => {
        const status = runtimeStatuses?.[providerId] ?? null;
        const method = getProviderMethod(providerId, methodId);
        const isBusy =
            disabled ||
            busyProviderId === providerId ||
            localBusyProviderId === providerId;

        return (
            <ProviderActions
                canDisconnect={Boolean(status?.canDisconnectAuth)}
                canLaunchTerminal={Boolean(method?.terminalAuth)}
                canLogout={Boolean(status?.canLogoutAuth)}
                disabled={isBusy}
                hasDisconnectAction={Boolean(onDisconnectAuth)}
                hasLaunchAction={Boolean(onLaunchAuth)}
                hasLogoutAction={Boolean(onLogoutAuth)}
                hasSaveAction={Boolean(onSaveProviderSettings)}
                hasVerifyAction={Boolean(onVerifyRuntime)}
                onDisconnect={() =>
                    runProviderAction(providerId, () =>
                        onDisconnectAuth?.(providerId),
                    )
                }
                onLaunch={() => {
                    if (!methodId) {
                        return;
                    }

                    runProviderAction(providerId, () =>
                        onLaunchAuth?.(providerId, methodId),
                    );
                }}
                onLogout={() =>
                    runProviderAction(providerId, () =>
                        onLogoutAuth?.(providerId),
                    )
                }
                onSave={save}
                onVerify={() =>
                    runProviderAction(providerId, () =>
                        onVerifyRuntime?.(providerId),
                    )
                }
            />
        );
    };

    return (
        <section aria-label="AI provider settings">
            <SectionLabel>AI Providers</SectionLabel>
            <div>
                <ProviderCard
                    error={errorByProviderId?.codex ?? localErrors.codex}
                    expanded={expandedProviderIds.has("codex")}
                    methodId={resolveMethodId(
                        "codex",
                        drafts.codex.authMethod,
                        runtimeStatuses?.codex,
                    )}
                    providerId="codex"
                    status={runtimeStatuses?.codex ?? null}
                    onToggle={() => toggleExpanded("codex")}
                >
                    <CommonFields
                        binaryPath={drafts.codex.binaryPath}
                        binaryPathPlaceholder="Custom Codex runtime path, for example codex-acp"
                        notice={getRuntimeNotice(runtimeStatuses?.codex)}
                        onBinaryPathChange={(binaryPath) =>
                            setDrafts((current) => ({
                                ...current,
                                codex: { ...current.codex, binaryPath },
                            }))
                        }
                    />
                    <MethodPicker
                        methods={AI_PROVIDER_DEFINITIONS.codex.methods}
                        value={resolveMethodId(
                            "codex",
                            drafts.codex.authMethod,
                            runtimeStatuses?.codex,
                        )}
                        onChange={(authMethod) =>
                            setDrafts((current) => ({
                                ...current,
                                codex: { ...current.codex, authMethod },
                            }))
                        }
                    />
                    {resolveMethodId(
                        "codex",
                        drafts.codex.authMethod,
                        runtimeStatuses?.codex,
                    ) !== "chatgpt" ? (
                        <div style={twoColumnGridStyle}>
                            <SecretField
                                draft={drafts.codex.codexApiKey}
                                label="Codex API key"
                                placeholder="Optional CODEX_API_KEY"
                                stored={Boolean(
                                    runtimeSettings?.codex?.hasCodexApiKey,
                                )}
                                onChange={(codexApiKey) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        codex: {
                                            ...current.codex,
                                            codexApiKey,
                                        },
                                    }))
                                }
                            />
                            <SecretField
                                draft={drafts.codex.openAiApiKey}
                                label="OpenAI API key"
                                placeholder="Optional OPENAI_API_KEY"
                                stored={Boolean(
                                    runtimeSettings?.codex?.hasOpenAiApiKey,
                                )}
                                onChange={(openAiApiKey) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        codex: {
                                            ...current.codex,
                                            openAiApiKey,
                                        },
                                    }))
                                }
                            />
                        </div>
                    ) : null}
                    {renderActions({
                        methodId: resolveMethodId(
                            "codex",
                            drafts.codex.authMethod,
                            runtimeStatuses?.codex,
                        ),
                        providerId: "codex",
                        save: saveCodex,
                    })}
                </ProviderCard>

                <ProviderCard
                    error={errorByProviderId?.claude ?? localErrors.claude}
                    expanded={expandedProviderIds.has("claude")}
                    methodId={resolveMethodId(
                        "claude",
                        drafts.claude.authMethod,
                        runtimeStatuses?.claude,
                    )}
                    providerId="claude"
                    status={runtimeStatuses?.claude ?? null}
                    onToggle={() => toggleExpanded("claude")}
                >
                    <CommonFields
                        binaryPath={drafts.claude.binaryPath}
                        binaryPathPlaceholder="Custom Claude runtime path, for example claude-agent-acp"
                        notice={getRuntimeNotice(runtimeStatuses?.claude)}
                        onBinaryPathChange={(binaryPath) =>
                            setDrafts((current) => ({
                                ...current,
                                claude: { ...current.claude, binaryPath },
                            }))
                        }
                    />
                    <MethodPicker
                        methods={AI_PROVIDER_DEFINITIONS.claude.methods}
                        value={resolveMethodId(
                            "claude",
                            drafts.claude.authMethod,
                            runtimeStatuses?.claude,
                        )}
                        onChange={(authMethod) =>
                            setDrafts((current) => ({
                                ...current,
                                claude: { ...current.claude, authMethod },
                            }))
                        }
                    />
                    <ClaudeConditionalFields
                        draft={drafts.claude}
                        methodId={resolveMethodId(
                            "claude",
                            drafts.claude.authMethod,
                            runtimeStatuses?.claude,
                        )}
                        settings={runtimeSettings?.claude}
                        onChange={(claude) =>
                            setDrafts((current) => ({ ...current, claude }))
                        }
                    />
                    {renderActions({
                        methodId: resolveMethodId(
                            "claude",
                            drafts.claude.authMethod,
                            runtimeStatuses?.claude,
                        ),
                        providerId: "claude",
                        save: saveClaude,
                    })}
                </ProviderCard>

                <ProviderCard
                    error={errorByProviderId?.gemini ?? localErrors.gemini}
                    expanded={expandedProviderIds.has("gemini")}
                    methodId={resolveMethodId(
                        "gemini",
                        drafts.gemini.authMethod,
                        runtimeStatuses?.gemini,
                    )}
                    providerId="gemini"
                    status={runtimeStatuses?.gemini ?? null}
                    onToggle={() => toggleExpanded("gemini")}
                >
                    <CommonFields
                        binaryPath={drafts.gemini.binaryPath}
                        binaryPathPlaceholder="Custom Gemini runtime path, for example gemini"
                        notice={getRuntimeNotice(runtimeStatuses?.gemini)}
                        onBinaryPathChange={(binaryPath) =>
                            setDrafts((current) => ({
                                ...current,
                                gemini: { ...current.gemini, binaryPath },
                            }))
                        }
                    />
                    <MethodPicker
                        methods={AI_PROVIDER_DEFINITIONS.gemini.methods}
                        value={resolveMethodId(
                            "gemini",
                            drafts.gemini.authMethod,
                            runtimeStatuses?.gemini,
                        )}
                        onChange={(authMethod) =>
                            setDrafts((current) => ({
                                ...current,
                                gemini: { ...current.gemini, authMethod },
                            }))
                        }
                    />
                    <GeminiFields
                        draft={drafts.gemini}
                        settings={runtimeSettings?.gemini}
                        onChange={(gemini) =>
                            setDrafts((current) => ({ ...current, gemini }))
                        }
                    />
                    {renderActions({
                        methodId: resolveMethodId(
                            "gemini",
                            drafts.gemini.authMethod,
                            runtimeStatuses?.gemini,
                        ),
                        providerId: "gemini",
                        save: saveGemini,
                    })}
                </ProviderCard>

                <ProviderCard
                    error={errorByProviderId?.kilo ?? localErrors.kilo}
                    expanded={expandedProviderIds.has("kilo")}
                    methodId={resolveMethodId(
                        "kilo",
                        drafts.kilo.authMethod,
                        runtimeStatuses?.kilo,
                    )}
                    providerId="kilo"
                    status={runtimeStatuses?.kilo ?? null}
                    onToggle={() => toggleExpanded("kilo")}
                >
                    <CommonFields
                        binaryPath={drafts.kilo.binaryPath}
                        binaryPathPlaceholder="Custom Kilo runtime path, for example kilo"
                        notice={getRuntimeNotice(runtimeStatuses?.kilo)}
                        onBinaryPathChange={(binaryPath) =>
                            setDrafts((current) => ({
                                ...current,
                                kilo: { ...current.kilo, binaryPath },
                            }))
                        }
                    />
                    <MethodPicker
                        methods={AI_PROVIDER_DEFINITIONS.kilo.methods}
                        value={resolveMethodId(
                            "kilo",
                            drafts.kilo.authMethod,
                            runtimeStatuses?.kilo,
                        )}
                        onChange={(authMethod) =>
                            setDrafts((current) => ({
                                ...current,
                                kilo: { ...current.kilo, authMethod },
                            }))
                        }
                    />
                    {resolveMethodId(
                        "kilo",
                        drafts.kilo.authMethod,
                        runtimeStatuses?.kilo,
                    ) === "kilo-api-key" ? (
                        <SecretField
                            draft={drafts.kilo.kiloApiKey}
                            label="Kilo API key"
                            placeholder="Optional KILO_API_KEY"
                            stored={Boolean(runtimeSettings?.kilo?.hasKiloApiKey)}
                            onChange={(kiloApiKey) =>
                                setDrafts((current) => ({
                                    ...current,
                                    kilo: { ...current.kilo, kiloApiKey },
                                }))
                            }
                        />
                    ) : (
                        <InfoNote>
                            Kilo uses the local CLI login state for this method.
                            Open the system terminal to run the sign-in command,
                            then verify the runtime again.
                        </InfoNote>
                    )}
                    {renderActions({
                        methodId: resolveMethodId(
                            "kilo",
                            drafts.kilo.authMethod,
                            runtimeStatuses?.kilo,
                        ),
                        providerId: "kilo",
                        save: saveKilo,
                    })}
                </ProviderCard>
            </div>

            {diagnostics ? (
                <DiagnosticsPanel
                    diagnostics={diagnostics}
                    onRefresh={onRefreshDiagnostics}
                />
            ) : null}
        </section>
    );
}

function ProviderCard({
    children,
    error,
    expanded,
    methodId,
    onToggle,
    providerId,
    status,
}: {
    readonly children: ReactNode;
    readonly error?: string | null;
    readonly expanded: boolean;
    readonly methodId: AiProviderAuthMethodId | null;
    readonly onToggle: () => void;
    readonly providerId: AiProviderId;
    readonly status: AiProviderRuntimeStatus | null;
}) {
    const provider = AI_PROVIDER_DEFINITIONS[providerId];
    const statusTone = getProviderStatusTone(status);
    const method = getProviderMethod(providerId, methodId);
    const sourceLabel = buildProviderSourceLabel(status, method?.label);

    return (
        <article style={PROVIDER_CARD_STYLE}>
            <button
                aria-expanded={expanded}
                onClick={onToggle}
                style={{
                    alignItems: "center",
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    cursor: "pointer",
                    display: "flex",
                    fontFamily: "inherit",
                    gap: 12,
                    justifyContent: "space-between",
                    padding: 0,
                    textAlign: "left",
                    width: "100%",
                }}
                type="button"
            >
                <span
                    style={{
                        alignItems: "center",
                        display: "flex",
                        gap: 10,
                        minWidth: 0,
                    }}
                >
                    <span
                        aria-hidden="true"
                        style={{
                            color: "var(--color-text-secondary)",
                            display: "inline-block",
                            fontSize: 12,
                            transform: expanded ? "rotate(90deg)" : "none",
                            transition: "transform 120ms ease",
                            width: 10,
                        }}
                    >
                        {'>'}
                    </span>
                    <StatusDot tone={statusTone.tone} />
                    <span style={{ minWidth: 0 }}>
                        <span
                            style={{
                                color: "var(--color-text-primary)",
                                display: "block",
                                fontSize: 13,
                                fontWeight: 600,
                            }}
                        >
                            {provider.name}
                        </span>
                        <span
                            style={{
                                color: "var(--color-text-secondary)",
                                display: "block",
                                fontSize: 11,
                                lineHeight: 1.4,
                                marginTop: 2,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {sourceLabel ?? provider.description}
                        </span>
                    </span>
                </span>
                <StatusPill label={statusTone.label} tone={statusTone.tone} />
            </button>

            {expanded ? (
                <div style={PANEL_STYLE}>
                    {status?.authStorageMessage ? (
                        <InfoNote>{status.authStorageMessage}</InfoNote>
                    ) : null}
                    {children}
                    {status?.command ? (
                        <RuntimeDetails
                            lines={[
                                ["Command", status.command],
                                status.source ? ["Source", status.source] : null,
                                status.checkedAt
                                    ? ["Checked", status.checkedAt]
                                    : null,
                            ]}
                        />
                    ) : null}
                    {error ? <ErrorNote>{error}</ErrorNote> : null}
                </div>
            ) : null}
        </article>
    );
}

function CommonFields({
    binaryPath,
    binaryPathPlaceholder,
    notice,
    onBinaryPathChange,
}: {
    readonly binaryPath: string;
    readonly binaryPathPlaceholder: string;
    readonly notice: string | null;
    readonly onBinaryPathChange: (value: string) => void;
}) {
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) => onBinaryPathChange(event.target.value)}
                placeholder={binaryPathPlaceholder}
                spellCheck={false}
                style={FIELD_STYLE}
                value={binaryPath}
            />
            {notice ? <InfoNote>{notice}</InfoNote> : null}
        </div>
    );
}

function MethodPicker<TMethodId extends AiProviderAuthMethodId>({
    methods,
    onChange,
    value,
}: {
    readonly methods: readonly AiProviderMethodDefinition<TMethodId>[];
    readonly onChange: (value: TMethodId) => void;
    readonly value: TMethodId | null;
}) {
    return (
        <div style={{ display: "grid", gap: 8 }}>
            <FieldCaption>Authentication method</FieldCaption>
            <div
                style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                }}
            >
                {methods.map((method) => {
                    const selected = method.id === value;

                    return (
                        <button
                            className="app-no-drag"
                            key={method.id}
                            onClick={() => onChange(method.id)}
                            style={{
                                backgroundColor: selected
                                    ? "color-mix(in srgb, var(--color-accent) 14%, var(--color-bg-tertiary))"
                                    : "var(--color-bg-tertiary)",
                                border: selected
                                    ? "1px solid var(--color-accent)"
                                    : "1px solid var(--color-border)",
                                borderRadius: 8,
                                color: selected
                                    ? "var(--color-text-primary)"
                                    : "var(--color-text-secondary)",
                                cursor: "pointer",
                                fontFamily: "inherit",
                                minHeight: 58,
                                padding: "9px 10px",
                                textAlign: "left",
                            }}
                            title={method.description}
                            type="button"
                        >
                            <span
                                style={{
                                    display: "block",
                                    fontSize: 12,
                                    fontWeight: selected ? 650 : 550,
                                }}
                            >
                                {method.label}
                            </span>
                            <span
                                style={{
                                    display: "block",
                                    fontSize: 10,
                                    lineHeight: 1.35,
                                    marginTop: 3,
                                }}
                            >
                                {method.terminalAuth
                                    ? "Terminal sign-in"
                                    : "Stored securely"}
                            </span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

function ClaudeConditionalFields({
    draft,
    methodId,
    onChange,
    settings,
}: {
    readonly draft: ClaudeProviderDraft;
    readonly methodId: ClaudeProviderAuthMethodId | null;
    readonly onChange: (draft: ClaudeProviderDraft) => void;
    readonly settings?: AiProviderRuntimeSettingsMap["claude"];
}) {
    if (methodId === "anthropic-api-key") {
        return (
            <SecretField
                draft={draft.anthropicApiKey}
                label="Anthropic API key"
                placeholder="Optional ANTHROPIC_API_KEY"
                stored={Boolean(settings?.hasAnthropicApiKey)}
                onChange={(anthropicApiKey) =>
                    onChange({ ...draft, anthropicApiKey })
                }
            />
        );
    }

    if (methodId === "gateway") {
        return (
            <div style={{ display: "grid", gap: 10 }}>
                <GatewayFields
                    authTokenDraft={draft.gatewayAuthToken}
                    baseUrl={draft.gatewayBaseUrl}
                    baseUrlLabel="Gateway base URL"
                    customHeadersDraft={draft.gatewayCustomHeaders}
                    hasStoredAuthToken={Boolean(settings?.hasGatewayAuthToken)}
                    hasStoredCustomHeaders={Boolean(
                        settings?.hasGatewayCustomHeaders,
                    )}
                    tokenPlaceholder="Optional gateway auth token"
                    onAuthTokenChange={(gatewayAuthToken) =>
                        onChange({ ...draft, gatewayAuthToken })
                    }
                    onBaseUrlChange={(gatewayBaseUrl) =>
                        onChange({ ...draft, gatewayBaseUrl })
                    }
                    onCustomHeadersChange={(gatewayCustomHeaders) =>
                        onChange({ ...draft, gatewayCustomHeaders })
                    }
                />
                <ActionButton
                    label="Clear gateway settings"
                    onClick={() =>
                        onChange({
                            ...draft,
                            gatewayAuthToken: createClearSecretDraft(),
                            gatewayBaseUrl: "",
                            gatewayCustomHeaders: createClearSecretDraft(),
                        })
                    }
                />
            </div>
        );
    }

    if (methodId === "gateway-bedrock") {
        return (
            <div style={{ display: "grid", gap: 10 }}>
                <LabeledTextField
                    label="Bedrock gateway base URL"
                    placeholder="https://bedrock-gateway.example.com"
                    value={draft.bedrockGatewayBaseUrl}
                    onChange={(bedrockGatewayBaseUrl) =>
                        onChange({ ...draft, bedrockGatewayBaseUrl })
                    }
                />
                <InfoNote>
                    Bedrock gateway uses the configured base URL and does not
                    require an Anthropic auth token in Comando.
                </InfoNote>
                <ActionButton
                    label="Clear gateway settings"
                    onClick={() =>
                        onChange({
                            ...draft,
                            bedrockGatewayBaseUrl: "",
                        })
                    }
                />
            </div>
        );
    }

    return (
        <InfoNote>
            This method uses the provider CLI login. Comando opens the system
            terminal for sign-in and never asks you to paste the session token.
        </InfoNote>
    );
}

function GeminiFields({
    draft,
    onChange,
    settings,
}: {
    readonly draft: GeminiProviderDraft;
    readonly onChange: (draft: GeminiProviderDraft) => void;
    readonly settings?: AiProviderRuntimeSettingsMap["gemini"];
}) {
    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={twoColumnGridStyle}>
                <SecretField
                    draft={draft.geminiApiKey}
                    label="Gemini API key"
                    placeholder="Optional GEMINI_API_KEY"
                    stored={Boolean(settings?.hasGeminiApiKey)}
                    onChange={(geminiApiKey) =>
                        onChange({ ...draft, geminiApiKey })
                    }
                />
                <SecretField
                    draft={draft.googleApiKey}
                    label="Google API key"
                    placeholder="Optional GOOGLE_API_KEY"
                    stored={Boolean(settings?.hasGoogleApiKey)}
                    onChange={(googleApiKey) =>
                        onChange({ ...draft, googleApiKey })
                    }
                />
            </div>
            <div style={twoColumnGridStyle}>
                <LabeledTextField
                    label="Google Cloud project"
                    placeholder="Optional Google Cloud project"
                    value={draft.googleCloudProject}
                    onChange={(googleCloudProject) =>
                        onChange({ ...draft, googleCloudProject })
                    }
                />
                <LabeledTextField
                    label="Google Cloud location"
                    placeholder="Optional Google Cloud location"
                    value={draft.googleCloudLocation}
                    onChange={(googleCloudLocation) =>
                        onChange({ ...draft, googleCloudLocation })
                    }
                />
            </div>
        </div>
    );
}

function GatewayFields({
    authTokenDraft,
    baseUrl,
    baseUrlLabel,
    customHeadersDraft,
    hasStoredAuthToken,
    hasStoredCustomHeaders,
    onAuthTokenChange,
    onBaseUrlChange,
    onCustomHeadersChange,
    tokenPlaceholder,
}: {
    readonly authTokenDraft: AiProviderSecretDraft;
    readonly baseUrl: string;
    readonly baseUrlLabel: string;
    readonly customHeadersDraft: AiProviderSecretDraft;
    readonly hasStoredAuthToken: boolean;
    readonly hasStoredCustomHeaders: boolean;
    readonly onAuthTokenChange: (draft: AiProviderSecretDraft) => void;
    readonly onBaseUrlChange: (value: string) => void;
    readonly onCustomHeadersChange: (draft: AiProviderSecretDraft) => void;
    readonly tokenPlaceholder: string;
}) {
    return (
        <div style={{ display: "grid", gap: 10 }}>
            <LabeledTextField
                label={baseUrlLabel}
                placeholder="https://gateway.example.com"
                value={baseUrl}
                onChange={onBaseUrlChange}
            />
            <SecretField
                draft={authTokenDraft}
                label="Auth token"
                placeholder={tokenPlaceholder}
                stored={hasStoredAuthToken}
                multiline
                onChange={onAuthTokenChange}
            />
            <SecretField
                draft={customHeadersDraft}
                label="Custom headers JSON"
                placeholder='Optional custom headers, for example {"x-api-key":"..."}'
                stored={hasStoredCustomHeaders}
                multiline
                onChange={onCustomHeadersChange}
            />
        </div>
    );
}

function SecretField({
    draft,
    label,
    multiline = false,
    onChange,
    placeholder,
    stored,
}: {
    readonly draft: AiProviderSecretDraft;
    readonly label: string;
    readonly multiline?: boolean;
    readonly onChange: (draft: AiProviderSecretDraft) => void;
    readonly placeholder: string;
    readonly stored: boolean;
}) {
    const hasDraft = draft.value.trim().length > 0;
    const canClear = stored || hasDraft || draft.clear;
    const clearLabel = draft.clear
        ? "Undo clear"
        : hasDraft
          ? "Discard draft"
          : "Clear stored value";
    const statusLabel = hasDraft
        ? "New value pending"
        : draft.clear
          ? "Marked for removal"
          : stored
            ? "Stored"
            : "Not stored";
    const sharedProps = {
        autoCapitalize: "off",
        autoCorrect: "off",
        className: "ide-input app-no-drag",
        onChange: (
            event:
                | ChangeEvent<HTMLInputElement>
                | ChangeEvent<HTMLTextAreaElement>,
        ) =>
            onChange({
                clear: false,
                value: event.target.value,
            }),
        placeholder:
            stored && !draft.clear
                ? "Stored - enter a new value to replace"
                : placeholder,
        spellCheck: false,
        value: draft.value,
    } as const;

    return (
        <label style={{ display: "grid", gap: 6 }}>
            <span
                style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 8,
                    justifyContent: "space-between",
                }}
            >
                <span>
                    <FieldCaption>{label}</FieldCaption>
                    <span
                        style={{
                            color: draft.clear
                                ? "var(--diff-remove)"
                                : "var(--color-text-secondary)",
                            display: "block",
                            fontSize: 10,
                            lineHeight: 1.4,
                            marginTop: 1,
                        }}
                    >
                        {statusLabel}
                    </span>
                </span>
                <button
                    className="app-no-drag"
                    disabled={!canClear}
                    onClick={(event) => {
                        event.preventDefault();

                        if (draft.clear) {
                            onChange(createEmptySecretDraft());
                            return;
                        }

                        if (hasDraft) {
                            onChange(createEmptySecretDraft());
                            return;
                        }

                        onChange({
                            clear: true,
                            value: "",
                        });
                    }}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: canClear
                            ? "var(--color-text-secondary)"
                            : "color-mix(in srgb, var(--color-text-secondary) 45%, transparent)",
                        cursor: canClear ? "pointer" : "not-allowed",
                        flexShrink: 0,
                        fontFamily: "inherit",
                        fontSize: 10,
                        padding: 0,
                    }}
                    type="button"
                >
                    {clearLabel}
                </button>
            </span>
            {multiline ? (
                <textarea {...sharedProps} style={TEXTAREA_STYLE} />
            ) : (
                <input {...sharedProps} style={FIELD_STYLE} type="password" />
            )}
        </label>
    );
}

function LabeledTextField({
    label,
    onChange,
    placeholder,
    value,
}: {
    readonly label: string;
    readonly onChange: (value: string) => void;
    readonly placeholder: string;
    readonly value: string;
}) {
    return (
        <label style={{ display: "grid", gap: 6 }}>
            <FieldCaption>{label}</FieldCaption>
            <input
                autoCapitalize="off"
                autoCorrect="off"
                className="ide-input app-no-drag"
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                style={FIELD_STYLE}
                value={value}
            />
        </label>
    );
}

function ProviderActions({
    canDisconnect,
    canLaunchTerminal,
    canLogout,
    disabled,
    hasDisconnectAction,
    hasLaunchAction,
    hasLogoutAction,
    hasSaveAction,
    hasVerifyAction,
    onDisconnect,
    onLaunch,
    onLogout,
    onSave,
    onVerify,
}: {
    readonly canDisconnect: boolean;
    readonly canLaunchTerminal: boolean;
    readonly canLogout: boolean;
    readonly disabled: boolean;
    readonly hasDisconnectAction: boolean;
    readonly hasLaunchAction: boolean;
    readonly hasLogoutAction: boolean;
    readonly hasSaveAction: boolean;
    readonly hasVerifyAction: boolean;
    readonly onDisconnect: () => void;
    readonly onLaunch: () => void;
    readonly onLogout: () => void;
    readonly onSave: () => void;
    readonly onVerify: () => void;
}) {
    return (
        <div
            style={{
                alignItems: "center",
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
            }}
        >
            <ActionButton
                disabled={disabled || !hasVerifyAction}
                label="Verify"
                onClick={onVerify}
            />
            <ActionButton
                disabled={disabled || !hasSaveAction}
                label="Save"
                primary
                onClick={onSave}
            />
            {canLaunchTerminal ? (
                <ActionButton
                    disabled={disabled || !hasLaunchAction}
                    label="Open sign-in terminal"
                    onClick={onLaunch}
                />
            ) : null}
            {canLogout ? (
                <ActionButton
                    disabled={disabled || !hasLogoutAction}
                    label="Log out"
                    onClick={onLogout}
                />
            ) : null}
            {canDisconnect ? (
                <ActionButton
                    danger
                    disabled={disabled || !hasDisconnectAction}
                    label="Disconnect"
                    onClick={onDisconnect}
                />
            ) : null}
        </div>
    );
}

function DiagnosticsPanel({
    diagnostics,
    onRefresh,
}: {
    readonly diagnostics: AiProviderDiagnosticsState;
    readonly onRefresh?: () => Promise<void> | void;
}) {
    const [visible, setVisible] = useState(false);

    return (
        <section style={{ padding: "16px 0 0" }}>
            <div
                style={{
                    alignItems: "center",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                }}
            >
                <div>
                    <SectionLabel>Diagnostics</SectionLabel>
                    <p
                        style={{
                            color: "var(--color-text-secondary)",
                            fontSize: 11,
                            lineHeight: 1.4,
                            margin: 0,
                        }}
                    >
                        Runtime, credential, and storage checks for provider
                        setup.
                    </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                    <ActionButton
                        label={visible ? "Hide" : "Show"}
                        onClick={() => setVisible((value) => !value)}
                    />
                    <ActionButton
                        disabled={diagnostics.loading || !onRefresh}
                        label={diagnostics.loading ? "Refreshing" : "Refresh"}
                        onClick={() => {
                            void onRefresh?.();
                        }}
                    />
                </div>
            </div>

            {visible ? (
                <div style={PANEL_STYLE}>
                    {diagnostics.error ? (
                        <ErrorNote>{diagnostics.error}</ErrorNote>
                    ) : null}
                    {diagnostics.updatedAt ? (
                        <InfoNote>Last checked {diagnostics.updatedAt}</InfoNote>
                    ) : null}
                    {diagnostics.entries.length > 0 ? (
                        <div style={{ display: "grid", gap: 8 }}>
                            {diagnostics.entries.map((entry) => (
                                <DiagnosticRow entry={entry} key={entry.id} />
                            ))}
                        </div>
                    ) : (
                        <InfoNote>No diagnostics have been reported yet.</InfoNote>
                    )}
                </div>
            ) : null}
        </section>
    );
}

function DiagnosticRow({ entry }: { readonly entry: AiProviderDiagnosticEntry }) {
    return (
        <div
            style={{
                alignItems: "flex-start",
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid color-mix(in srgb, var(--color-border) 70%, transparent)",
                borderRadius: 8,
                display: "grid",
                gap: 4,
                padding: "8px 10px",
            }}
        >
            <div
                style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 8,
                }}
            >
                <StatusDot tone={diagnosticTone(entry.status)} />
                <span
                    style={{
                        color: "var(--color-text-primary)",
                        fontSize: 12,
                        fontWeight: 600,
                    }}
                >
                    {entry.label}
                </span>
                {entry.providerId ? (
                    <span
                        style={{
                            color: "var(--color-text-secondary)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 10,
                            textTransform: "uppercase",
                        }}
                    >
                        {entry.providerId}
                    </span>
                ) : null}
            </div>
            {entry.message ? (
                <span
                    style={{
                        color: "var(--color-text-secondary)",
                        fontSize: 11,
                        lineHeight: 1.45,
                    }}
                >
                    {entry.message}
                </span>
            ) : null}
            {entry.details ? (
                <pre
                    style={{
                        backgroundColor: "var(--color-bg-secondary)",
                        borderRadius: 6,
                        color: "var(--color-text-secondary)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        lineHeight: 1.45,
                        margin: 0,
                        overflow: "auto",
                        padding: "6px 8px",
                        whiteSpace: "pre-wrap",
                    }}
                >
                    {entry.details}
                </pre>
            ) : null}
        </div>
    );
}

function RuntimeDetails({
    lines,
}: {
    readonly lines: readonly (readonly [string, string] | null)[];
}) {
    const visibleLines = lines.filter(
        (line): line is readonly [string, string] => Boolean(line),
    );

    if (visibleLines.length === 0) {
        return null;
    }

    return (
        <div
            style={{
                backgroundColor: "var(--color-bg-tertiary)",
                border: "1px solid color-mix(in srgb, var(--color-border) 65%, transparent)",
                borderRadius: 8,
                display: "grid",
                gap: 4,
                padding: "7px 9px",
            }}
        >
            {visibleLines.map(([label, value]) => (
                <div
                    key={label}
                    style={{
                        color: "var(--color-text-secondary)",
                        display: "grid",
                        fontSize: 11,
                        gap: 6,
                        gridTemplateColumns: "70px minmax(0, 1fr)",
                    }}
                >
                    <span>{label}</span>
                    <span
                        style={{
                            color: "var(--color-text-primary)",
                            fontFamily: "var(--font-mono)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                        title={value}
                    >
                        {value}
                    </span>
                </div>
            ))}
        </div>
    );
}

function ActionButton({
    danger = false,
    disabled = false,
    label,
    onClick,
    primary = false,
}: {
    readonly danger?: boolean;
    readonly disabled?: boolean;
    readonly label: string;
    readonly onClick: () => void;
    readonly primary?: boolean;
}) {
    return (
        <button
            className="app-no-drag"
            disabled={disabled}
            onClick={onClick}
            style={{
                backgroundColor: primary
                    ? "var(--color-accent)"
                    : danger
                      ? "transparent"
                      : "var(--color-bg-tertiary)",
                border: danger
                    ? "1px solid color-mix(in srgb, var(--diff-remove) 62%, transparent)"
                    : "1px solid var(--color-border)",
                borderRadius: 6,
                color: primary
                    ? "#fff"
                    : danger
                      ? "var(--diff-remove)"
                      : "var(--color-text-primary)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                opacity: disabled ? 0.45 : 1,
                padding: "5px 10px",
            }}
            type="button"
        >
            {label}
        </button>
    );
}

function StatusDot({ tone }: { readonly tone: ProviderStatusTone }) {
    const color =
        tone === "connected"
            ? "#10b981"
            : tone === "error"
              ? "var(--diff-remove)"
              : tone === "warning"
                ? "#f59e0b"
                : "var(--color-text-secondary)";

    return (
        <span
            aria-hidden="true"
            style={{
                backgroundColor: color,
                borderRadius: "50%",
                boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 16%, transparent)`,
                display: "inline-block",
                flexShrink: 0,
                height: 7,
                width: 7,
            }}
        />
    );
}

function StatusPill({
    label,
    tone,
}: {
    readonly label: string;
    readonly tone: ProviderStatusTone;
}) {
    const color =
        tone === "connected"
            ? "#10b981"
            : tone === "error"
              ? "var(--diff-remove)"
              : tone === "warning"
                ? "#f59e0b"
                : "var(--color-text-secondary)";

    return (
        <span
            style={{
                backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
                border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
                borderRadius: 999,
                color,
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                padding: "3px 7px",
                textTransform: "uppercase",
            }}
        >
            {label}
        </span>
    );
}

function FieldCaption({ children }: { readonly children: ReactNode }) {
    return (
        <span
            style={{
                color: "var(--color-text-secondary)",
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.2,
            }}
        >
            {children}
        </span>
    );
}

function InfoNote({ children }: { readonly children: ReactNode }) {
    return (
        <div
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--color-text-secondary) 7%, transparent)",
                borderRadius: 7,
                color: "var(--color-text-secondary)",
                fontSize: 11,
                lineHeight: 1.5,
                padding: "7px 9px",
            }}
        >
            {children}
        </div>
    );
}

function ErrorNote({ children }: { readonly children: ReactNode }) {
    return (
        <div
            style={{
                backgroundColor:
                    "color-mix(in srgb, var(--diff-remove) 10%, transparent)",
                border: "1px solid color-mix(in srgb, var(--diff-remove) 28%, transparent)",
                borderRadius: 7,
                color: "var(--diff-remove)",
                fontSize: 11,
                lineHeight: 1.5,
                padding: "7px 9px",
            }}
        >
            {children}
        </div>
    );
}

const twoColumnGridStyle: CSSProperties = {
    display: "grid",
    gap: 10,
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
};

function createInitialDrafts(
    settings: AiProviderRuntimeSettingsMap | undefined,
): ProviderDrafts {
    return {
        claude: {
            anthropicApiKey: createEmptySecretDraft(),
            authMethod:
                settings?.claude?.authMethod ??
                AI_PROVIDER_DEFINITIONS.claude.defaultMethodId,
            bedrockGatewayBaseUrl: settings?.claude?.bedrockGatewayBaseUrl ?? "",
            binaryPath: settings?.claude?.binaryPath ?? "",
            gatewayAuthToken: createEmptySecretDraft(),
            gatewayBaseUrl: settings?.claude?.gatewayBaseUrl ?? "",
            gatewayCustomHeaders: createEmptySecretDraft(),
        },
        codex: {
            authMethod:
                settings?.codex?.authMethod ??
                AI_PROVIDER_DEFINITIONS.codex.defaultMethodId,
            binaryPath: settings?.codex?.binaryPath ?? "",
            codexApiKey: createEmptySecretDraft(),
            openAiApiKey: createEmptySecretDraft(),
        },
        gemini: {
            authMethod:
                settings?.gemini?.authMethod ??
                AI_PROVIDER_DEFINITIONS.gemini.defaultMethodId,
            binaryPath: settings?.gemini?.binaryPath ?? "",
            geminiApiKey: createEmptySecretDraft(),
            googleApiKey: createEmptySecretDraft(),
            googleCloudLocation: settings?.gemini?.googleCloudLocation ?? "",
            googleCloudProject: settings?.gemini?.googleCloudProject ?? "",
        },
        kilo: {
            authMethod:
                settings?.kilo?.authMethod ??
                AI_PROVIDER_DEFINITIONS.kilo.defaultMethodId,
            binaryPath: settings?.kilo?.binaryPath ?? "",
            kiloApiKey: createEmptySecretDraft(),
        },
    };
}

function resolveMethodId<TProviderId extends AiProviderId>(
    providerId: TProviderId,
    draftMethodId: AiProviderAuthMethodById[TProviderId] | null,
    status: AiProviderRuntimeStatus | null | undefined,
): AiProviderAuthMethodById[TProviderId] {
    if (isMethodIdForProvider(providerId, draftMethodId)) {
        return draftMethodId;
    }

    if (isMethodIdForProvider(providerId, status?.authMethod)) {
        return status.authMethod;
    }

    return AI_PROVIDER_DEFINITIONS[providerId]
        .defaultMethodId as AiProviderAuthMethodById[TProviderId];
}

type ProviderStatusTone = "connected" | "error" | "neutral" | "warning";

function getProviderStatusTone(
    status: AiProviderRuntimeStatus | null,
): { readonly label: string; readonly tone: ProviderStatusTone } {
    if (!status) {
        return {
            label: "Not checked",
            tone: "neutral",
        };
    }

    if (status.state === "error") {
        return {
            label: "Error",
            tone: "error",
        };
    }

    if (status.authReady) {
        return {
            label: "Connected",
            tone: "connected",
        };
    }

    if (status.onboardingRequired || status.state === "missing") {
        return {
            label: "Not configured",
            tone: "warning",
        };
    }

    return {
        label: "Not configured",
        tone: "neutral",
    };
}

function buildProviderSourceLabel(
    status: AiProviderRuntimeStatus | null,
    methodLabel: string | undefined,
): string | null {
    const parts = [
        methodLabel,
        status?.authCredentialSourceLabel,
        status?.source,
    ].filter((part): part is string => Boolean(part));

    if (parts.length === 0) {
        return null;
    }

    return parts.join(" / ");
}

function getRuntimeNotice(
    status: AiProviderRuntimeStatus | null | undefined,
): string | null {
    return (
        status?.authSessionMessage ??
        status?.message ??
        status?.authStorageMessage ??
        null
    );
}

function diagnosticTone(
    status: AiProviderDiagnosticEntry["status"],
): ProviderStatusTone {
    if (status === "ok") {
        return "connected";
    }

    if (status === "error") {
        return "error";
    }

    if (status === "warning" || status === "pending") {
        return "warning";
    }

    return "neutral";
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    return "Unexpected provider settings error.";
}
