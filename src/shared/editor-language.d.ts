export interface ResolvedEditorLanguage {
    readonly id: string;
    readonly label: string;
}
export declare function resolveEditorLanguage(options: {
    readonly filePath: string;
    readonly probeContent?: string;
}): ResolvedEditorLanguage;
export declare function shouldWrapEditorLanguage(languageId: string): boolean;
