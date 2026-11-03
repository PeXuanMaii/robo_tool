/* Offline unit/regression tests. Fixtures are synthetic, with expected outputs captured from supplied v23. */
'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {browser,loadModules,root,manifest}=require('./harness.cjs');
const fixtures=require('./regression-fixtures.json');
const serialize=v=>JSON.parse(JSON.stringify(v));
const regressionModules=loadModules().modules;
for(const fixture of fixtures)test('v23 regression: '+fixture.name,()=>{
 const modules=regressionModules;const invoke=()=>modules[fixture.module][fixture.method](...structuredClone(fixture.args));
 if(fixture.error)assert.throws(invoke,e=>e.message===fixture.error);
 else assert.deepEqual(serialize(invoke()),fixture.expected);
});
test('every module factory and exported getter loads without network',()=>{
 const {modules,context}=loadModules();assert.equal(Object.keys(modules).length,manifest.modules.length);
 for(const entry of manifest.modules)for(const item of entry.exports)assert.doesNotThrow(()=>modules[entry.name][item.name]);
 assert.equal(context.__requests.length,0);
});
test('all module dependencies and cross-module API references exist',()=>{
 const {modules}=loadModules();let checked=0;
 for(const entry of manifest.modules){
  for(const name of entry.dependencies)assert(name in modules,entry.name+' -> '+name);
  const source=fs.readFileSync(path.join(root,entry.file),'utf8');
  for(const match of source.matchAll(/\bmodules\.(\w+)\.(\w+)/g)){
   assert(match[1] in modules,entry.name+': '+match[1]);assert(match[2] in modules[match[1]],entry.name+': '+match[1]+'.'+match[2]);checked++;
  }
 }
 assert(checked>600);
});
test('mutable configuration is a live binding, not a stale destructured copy',()=>{
 const {modules}=loadModules();modules.config.POLL_INTERVAL=12345;
 assert.equal(modules.taskMonitor.getAdaptivePollInterval(),12345);
 modules.config.MIN_DURATION_SECONDS=47;assert.equal(modules.config.MIN_DURATION_SECONDS,47);
});
test('readonly module exports reject accidental reassignment',()=>{
 const {modules}=loadModules();assert.throws(()=>{modules.config.AI={};},e=>e.name==='TypeError');
});
test('QC state is not shared between separate app instances',()=>{
 const a=loadModules(),b=loadModules();a.modules.qcStore.state.busy=true;
 assert.equal(b.modules.qcStore.state.busy,false);
});
test('initialization hooks are idempotent and keep original debug helpers',()=>{
 const {modules,context}=loadModules();
 for(const entry of manifest.modules.filter(x=>x.init))modules[entry.name].init();
 const count=context.__listeners.length,fetch=context.fetch;
 for(const entry of manifest.modules.filter(x=>x.init))modules[entry.name].init();
 assert.equal(context.__listeners.length,count);assert.equal(context.fetch,fetch);
 for(const name of ['tbClearCache','tbGroqStats','tbGeminiStats','tbFreeVideo','tbAutoCutDebug','tbQCMappingReport','tbLearnPassCase','tbListPassCases','tbClearPassCases'])assert.equal(typeof context[name],'function',name);
 assert.equal(context.__requests.length,0);
});
test('embedded R2 scanner remains valid JavaScript and uses the suggestion workflow label',()=>{
 const {modules}=loadModules(),scanner=modules.r2Scanner.R2_SCAN_SRC;
 assert.equal(crypto.createHash('sha256').update(scanner).digest('hex'),require('../audit-results.json').r2ScannerSha256);
 assert.match(scanner,/📋 Dán gợi ý/);
 assert.doesNotThrow(()=>new vm.Script(scanner));
});
test('startup is idempotent, registers five named refresh jobs and honors Fetch OFF',async()=>{
 const context=browser();context.localStorage.setItem('tb_fetch_active_state','false');
 const {modules}=loadModules(context);
 for(const entry of manifest.modules.filter(x=>x.init))modules[entry.name].init();
 assert.doesNotThrow(()=>modules.bootstrap.start());
 const count=context.__timers.filter(t=>t.kind==='interval').length;
 modules.bootstrap.start();assert.equal(context.__timers.filter(t=>t.kind==='interval').length,count);assert.equal(count,5);
 assert.equal(modules.taskMonitor.stopped,true);await Promise.resolve();assert.equal(context.__requests.length,0);
});
test('Groq queue remains serial across module boundaries',async()=>{
 const {modules}=loadModules();const events=[];
 const first=modules.gemini.gemEnqueue(async()=>{events.push('a-start');await Promise.resolve();events.push('a-end');return 1;});
 const second=modules.gemini.gemEnqueue(async()=>{events.push('b');return 2;});
 assert.deepEqual(await Promise.all([first,second]),[1,2]);assert.deepEqual(events,['a-start','a-end','b']);
});
test('build is deterministic and bundled startup works with browser doubles',async()=>{
 const {build}=require('../build.cjs');const output=path.join(root,'tbrain_tool_for_labeler.user.js');
 const a=build(output),b=build(output);assert.equal(a,b);assert.doesNotThrow(()=>new vm.Script(a));
 assert.match(a,/^\/\/ @name\s+tbrain_tool_for_labeler/m);
 const context=browser();context.localStorage.setItem('tb_fetch_active_state','false');
 assert.doesNotThrow(()=>vm.runInContext(a,context,{timeout:2000}));await Promise.resolve();
 assert.equal(context.__requests.length,0);assert.equal(typeof context.tbQCMappingReport,'function');
 assert.equal(context.__timers.filter(t=>t.kind==='interval').length,5);
 assert.equal(typeof context.modules,'undefined');assert.equal(typeof context.factories,'undefined');
});
