export interface AppIdentity {
    readonly id: 'comando';
    readonly name: 'Comando';
    readonly productName: 'Comando';
    readonly bundleIdPlaceholder: 'com.placeholder.comando';
    readonly windowTitle: 'Comando';
    readonly iconPlaceholderPaths: {
        readonly macos: 'resources/icons/macos-placeholder.icns';
        readonly windows: 'resources/icons/windows-placeholder.ico';
        readonly png: 'resources/icons/app-placeholder.png';
    };
}
export declare const appIdentity: AppIdentity;
