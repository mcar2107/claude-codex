/**
 * Виртуальные модули плагина scripts/build.ts: JS-обвязка wasm-bindgen пакета tiktoken и байты его
 * WASM.
 */
declare module 'tiktoken-bindings' {
  export * from 'tiktoken';
  export const __wbg_set_wasm: (exports: WebAssembly.Exports) => void;
}

declare module 'tiktoken-wasm' {
  const bytes: Uint8Array<ArrayBuffer>;
  export default bytes;
}
