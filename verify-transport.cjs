const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const root = __dirname;
const state = path.join(root, '.runtime');
const dir = fs.mkdtempSync(path.join(state, 'probe-'));
const fakeAuth = { access_token: `x.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.x`, account_id: 'test-account' };
process.env.CLAUDE_GPT_STATE_DIR = dir;
process.env.CCR_CODEX_AUTH_FILE = path.join(dir, 'codex_auth.json');
for (const name of ['CLAUDE_GPT_MODEL','CLAUDE_GPT_EFFORT']) delete process.env[name];
const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json')));
config.APIKEY = 'local-test-key';
config.LOG = false;
fs.writeFileSync(path.join(dir, 'config.json'),JSON.stringify(config));
fs.writeFileSync(path.join(dir, 'codex_auth.json'),JSON.stringify(fakeAuth), {mode:0o600});
let source = fs.readFileSync(path.join(state, 'cli.js'),'utf8');
source = require('./bridge.cjs').sessionBundle(source, dir);
assert(source.includes('sje().catch(console.error);'));
source = source.replace('sje().catch(console.error);','module.exports = { getServer: sY.getServer };');
fs.writeFileSync(path.join(dir,'probe.cjs'),source);
fs.symlinkSync(path.join(state,'tiktoken_bg.wasm'),path.join(dir,'tiktoken_bg.wasm'));
let captured;
global.fetch = async (url, opts) => {
 if (!String(url).includes('chatgpt.com/backend-api/codex/responses')) throw new Error(`Network disabled in test: ${url}`);
 captured = JSON.parse(opts.body);
 const response = { id: 'resp_test', object: 'response', status: 'completed', model: captured.model, output: [{id:'msg_test',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'ok',annotations:[]}]}], usage:{input_tokens:10,output_tokens:1,total_tokens:11} };
 return new Response(`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response})}\n\n`, {headers:{'Content-Type':'text/event-stream'}});
};
(async()=>{
 let server;
 try {
  server = await require(path.join(dir, 'probe.cjs')).getServer();
  await server.registerNamespace('/');
  for (const [model,effort] of [['gpt-6.1-sol','xhigh'],['gpt-6-astra','max'],['gpt-6.1-terra','low'],['gpt-6-luna','high']]) {
   fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({model,reasoningEffort:effort}));
   const response = await server.app.inject({method:'POST',url:'/v1/messages',headers:{'x-api-key':'local-test-key','anthropic-version':'2023-06-01'},payload:{model:'codex,gpt-6.1-sol',max_tokens:1024,stream:false,output_config:{effort:'high'},messages:[{role:'user',content:'Reply ok'}],tools:[{name:'read_file',description:'Read a file',input_schema:{type:'object',properties:{path:{type:'string'}}}}]}});
   assert.equal(response.statusCode,200,response.body.slice(0,600));
   assert.equal(captured.model,model);
   assert.equal(captured.reasoning.effort,effort);
   assert.equal(captured.store,false);
   assert.equal(captured.stream,true);
   assert.equal(captured.input[0].type,'additional_tools');
   assert.equal(response.json().content[0].text,'ok');
  }
  console.log('PASS: real CCR Anthropic → live settings → Responses Lite → mocked Codex → Anthropic, including tools and changing models/effort without restart.');
 } finally { if(server) await server.app.close(); fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
