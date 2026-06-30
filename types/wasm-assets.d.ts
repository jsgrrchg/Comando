// Shared modules can import WASM assets through Vite's `?url` loader even when
// they are type-checked by the Node config, which does not include vite/client.
declare module "*?url" {
    const url: string;
    export default url;
}
