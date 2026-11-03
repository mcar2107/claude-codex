/**
 * WASM upstream встраивается байт в байт — и в npm-, и в standalone-сборку.
 */
const bindings = require('tiktoken-bindings');
const bytes = require('tiktoken-wasm');
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
  './tiktoken_bg.js': bindings,
});

bindings.__wbg_set_wasm(instance.exports);
module.exports = bindings;
