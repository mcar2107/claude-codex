/**
 * WASM upstream встраивается байт в байт — и в бандл, и в standalone-бинарник. Модули
 * `tiktoken-bindings` и `tiktoken-wasm` отдаёт плагин scripts/build.ts из файлов пакета tiktoken.
 */
import * as bindings from 'tiktoken-bindings';
import bytes from 'tiktoken-wasm';

const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  './tiktoken_bg.js': bindings,
});

bindings.__wbg_set_wasm(instance.exports);

export * from 'tiktoken-bindings';
