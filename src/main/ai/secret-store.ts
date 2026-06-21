export interface SecretStoreGateway {
    cacheSecretPatches?(secrets: readonly SecretRecordPatch[]): void;
    deleteSecrets?(
        secrets: readonly {
            readonly namespace: string;
            readonly secretId: string;
        }[],
    ): Promise<void> | void;
    getStorageStatus?(): SecretStorageStatus;
    loadSecret(namespace: string, secretId: string): string | null;
    saveSecret(
        namespace: string,
        secretId: string,
        value: string | null,
    ): Promise<void> | void;
}

export interface SecretRecordPatch {
    readonly key: string;
    readonly value: string | null;
}

export interface SecretStorageStatus {
    readonly encryptionAvailable: boolean;
    readonly isWeakBackend: boolean;
    readonly message: string | null;
    readonly platform: NodeJS.Platform;
    readonly selectedBackend: string | null;
}

export function buildSecretStorageKey(
    namespace: string,
    secretId: string,
): string {
    return `secret.${namespace}.${secretId}`;
}
