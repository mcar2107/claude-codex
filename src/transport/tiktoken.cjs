// Embed the exact upstream WASM in both npm and standalone builds.
const bindings = require('tiktoken-bindings');
const bytes = require('tiktoken-wasm');
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { './tiktoken_bg.js': bindings });
bindings.__wbg_set_wasm(instance.exports);
module.exports = bindings;
