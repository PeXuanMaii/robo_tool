/* Browser doubles for offline tests. No network, real tokens, real task data or browser permissions. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = require('../manifest.json');
function browser() {
    const values = new Map();
    const storage = { getItem:k=>values.has(k)?values.get(k):null, setItem:(k,v)=>values.set(k,String(v)), removeItem:k=>values.delete(k), key:i=>[...values.keys()][i]||null, get length(){return values.size;} };
    const listeners = [], timers = [], requests = [], logs = [];
    const document = { hidden:false, visibilityState:'visible', cookie:'', body:null, documentElement:{clientWidth:1200,clientHeight:900},
        getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[], addEventListener:(...a)=>listeners.push(a), removeEventListener:()=>{} };
    class XHR { open(){} setRequestHeader(){} send(){} abort(){} }
    const console = Object.fromEntries(['log','warn','error','info','debug'].map(k=>[k,(...a)=>logs.push([k,...a])]));
    const context = { document, localStorage:storage, sessionStorage:storage, console, navigator:{}, location:{href:'https://work.tbrain.ai/tasks/test-task',pathname:'/tasks/test-task',origin:'https://work.tbrain.ai'},
        performance:{now:()=>100}, XMLHttpRequest:XHR, Blob, URL, Headers, Request, Response, AbortController, TextDecoder, TextEncoder,
        setTimeout:(fn,ms)=>{timers.push({kind:'timeout',fn,ms});return timers.length;},clearTimeout:()=>{},setInterval:(fn,ms)=>{timers.push({kind:'interval',fn,ms});return timers.length;},clearInterval:()=>{},
        requestAnimationFrame:()=>1, cancelAnimationFrame:()=>{}, addEventListener:(...a)=>listeners.push(a), removeEventListener:()=>{},
        innerWidth:1200,innerHeight:900, atob:s=>Buffer.from(s,'base64').toString('binary'), btoa:s=>Buffer.from(s,'binary').toString('base64'),
        fetch:async(...a)=>{requests.push(a);throw Error('OFFLINE_TEST_NO_NETWORK');}, confirm:()=>false, alert:()=>{}, prompt:()=>null,
        getComputedStyle:()=>({display:'block',visibility:'visible'}), module:{exports:{}}, __listeners:listeners,__timers:timers,__requests:requests,__logs:logs };
    context.window=context;context.unsafeWindow=context;
    return vm.createContext(context);
}
const scripts = new Map();
function loadModules(context=browser()) {
    const modules=Object.create(null);
    for(const entry of manifest.modules){
        context.module={exports:{}};
        if (!scripts.has(entry.file)) scripts.set(entry.file,new vm.Script(fs.readFileSync(path.join(root,entry.file),'utf8'),{filename:entry.file}));
        scripts.get(entry.file).runInContext(context);
        modules[entry.name]=context.module.exports(modules);
    }
    return {modules,context};
}
module.exports={browser,loadModules,root,manifest};
