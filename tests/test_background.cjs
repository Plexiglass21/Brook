'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
let onMessage;
let downloaded;
let nativeMessage;
const store = new Map();
const event = callback => ({addListener(fn) { if (callback) callback(fn); }});
const chrome = {
  action: {setBadgeBackgroundColor:async()=>{},setBadgeText:async()=>{}},
  webRequest: {onBeforeRequest:event(),onHeadersReceived:event()},
  tabs: {onUpdated:event(),onRemoved:event()},
  downloads: {download: async opts => { downloaded = opts; return 5; }},
  storage: {session: {
    async get(keys) {const result = {};for(const key of Array.isArray(keys) ? keys : [keys]) result[key] = store.get(key);return result;},
    async set(obj) {for(const [key,value] of Object.entries(obj)) store.set(key,value);},
    async remove(keys) {for(const key of keys) store.delete(key);}
  }},
  runtime: {
    onMessage:event(fn=>{onMessage=fn;}),
    connectNative: () => {
      const port = {onMessage: event(),onDisconnect: event(),postMessage(message) {nativeMessage=message;},disconnect(){}};
      return port;
    }
  }
};
const source = fs.readFileSync(path.join(__dirname,'..','extension','background.js'),'utf8');
vm.runInNewContext(source,{chrome,crypto:webcrypto,URL,Map,Promise,console});
function send(message) {return new Promise(resolve=>onMessage(message,{},resolve));}
(async()=>{
  let result = await send({type:'direct',tabId:12,item:{url:'https://example.com/video.webm',kind:'video'},fileName:'Il mio video',askWhere:true});
  assert.equal(result.ok,true);
  assert.equal(downloaded.filename,'Il mio video.webm');
  assert.equal(downloaded.saveAs,true);
  result = await send({type:'direct',tabId:12,item:{url:'https://example.com/video.webm',kind:'video'},fileName:'Titolo',askWhere:false});
  assert.equal(result.ok,true);
  assert.equal(downloaded.filename,'Brook/Titolo.webm');
  assert.equal(downloaded.saveAs,false);
  result = await send({type:'download',tabId:12,item:{url:'https://example.com/master.m3u8',kind:'hls',pageUrl:'https://example.com/'},fileName:'Film',askWhere:true});
  assert.equal(result.ok,true);
  assert.equal(result.via,'native');
  assert.equal(nativeMessage.fileName,'Film');
  assert.equal(nativeMessage.askWhere,true);
  assert.equal(nativeMessage.referer,'https://example.com/');
  console.log('OK: direct saveAs + filename, default folder, native message');
})().catch(error=>{console.error(error);process.exit(1);});
