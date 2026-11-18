/* Brook v1.1 — estensione personale per media non protetti. */
'use strict';
const HOST = 'com.streamscout.personal';
const BROOK_VERSION = '1.1.0';
const activeByTab = new Map();
const jobQueues = new Map();
const MAX_ITEMS = 40;
const queues = new Map();
const activePorts = new Map();
const allowedProtocols = /^https?:\/\//i;

function getKind(url, mime = '') {
  const u = String(url || '');
  if (!allowedProtocols.test(u)) return null;
  let path = '';
  try { path = new URL(u).pathname.toLowerCase(); } catch { return null; }
  const ct = String(mime).toLowerCase().split(';')[0].trim();
  if (/\.(?:m3u8)(?:$)/i.test(path) || ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl'].includes(ct)) return 'hls';
  if (/\.mpd$/i.test(path) || ct === 'application/dash+xml') return 'dash';
  if (/\.(?:mp4|m4v|webm|mov|mkv|ogv)$/i.test(path) || /^(video\/)(?:mp4|webm|quicktime|x-matroska|ogg)$/i.test(ct)) return 'video';
  if (/\.(?:mp3|m4a|aac|ogg|opus|flac)$/i.test(path) || ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/aac', 'audio/flac'].includes(ct)) return 'audio';
  return null;
}

function isJunk(url) {
  // No segments or thumbnails; streams have independent manifest URLs.
  let path;
  try { path = new URL(url).pathname.toLowerCase(); } catch { return true; }
  return /\.(?:ts|m4s|cmfv|cmfa|vtt|srt|jpg|jpeg|png|gif|webp|avif)$/i.test(path);
}

function friendlyName(url, title) {
  if (title && String(title).trim()) return String(title).trim().slice(0, 140);
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'Video rilevato'; }
  catch { return 'Video rilevato'; }
}

function safeFileStem(raw) {
  const result = String(raw || 'Video').replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '').slice(0, 105);
  if (!result) return 'Video';
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(result) ? `_${result}` : result;
}

function mediaExtHint(url, mime) {
  try {
    const match = new URL(url).pathname.match(/\.(mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|opus|flac)$/i);
    if (match) return match[1].toLowerCase();
  } catch { /* Ignore */ }
  const ct = String(mime || '').split(';')[0].trim().toLowerCase();
  return ({'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov',
           'video/x-matroska':'mkv','video/ogg':'ogv','audio/mp4':'m4a',
           'audio/mpeg':'mp3','audio/ogg':'ogg','audio/aac':'aac',
           'audio/flac':'flac'})[ct] || null;
}

function mediaExt(item) {
  try {
    const match = new URL(item.url).pathname.match(/\.(mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|opus|flac)$/i);
    if (match) return match[1].toLowerCase();
  } catch { /* Unknown extension. */ }
  const ext = String(item.ext || '').toLowerCase();
  return /^(?:mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|opus|flac)$/.test(ext) ? ext : (item.kind === 'audio' ? 'mp3' : 'mp4');
}

function enqueue(tabId, fn) {
  const prev = queues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function badge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({tabId, color: '#6c907f'});
    await chrome.action.setBadgeText({tabId, text: count > 0 ? String(count) : ''});
  } catch { /* Tab might have closed. */ }
}

async function addCandidate(tabId, data) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  if (!data || typeof data.url !== 'string' || data.url.length > 10000) return;
  if (isJunk(data.url)) return;
  const kind = getKind(data.url, data.mime);
  if (!kind) return;
  await enqueue(tabId, async () => {
    const key = `items_${tabId}`;
    const stored = (await chrome.storage.session.get(key))[key] || [];
    const existing = stored.findIndex(x => x.url === data.url);
    if (existing !== -1) {
      // A DOM observation may provide the full iframe URL as Referer and the video title,
      // whereas a network observation may have seen only the URL a moment earlier.
      const old = stored[existing];
      const improved = {...old};
      if (allowedProtocols.test(data.pageUrl || '') && (!old.pageUrl || old.pageUrl.length < data.pageUrl.length)) improved.pageUrl = data.pageUrl;
      if (data.mime && !improved.ext) improved.ext = mediaExtHint(data.url, data.mime);
      if (data.source === 'DOM') {
        improved.source = 'DOM';
        if (data.title) improved.title = friendlyName(data.url, data.title);
        if (Number.isInteger(data.height) && data.height > 0) improved.height = data.height;
      }
      if (JSON.stringify(improved) !== JSON.stringify(old)) {
        stored[existing] = improved;
        await chrome.storage.session.set({[key]: stored});
      }
      return;
    }
    const item = {
      id: crypto.randomUUID(), url: data.url, kind,
      title: friendlyName(data.url, data.title), source: String(data.source || 'network'),
      pageUrl: allowedProtocols.test(data.pageUrl || '') ? data.pageUrl : '',
      height: Number.isInteger(data.height) && data.height > 0 ? data.height : null,
      ext: mediaExtHint(data.url, data.mime),
      discoveredAt: Date.now()
    };
    const items = [item, ...stored].slice(0, MAX_ITEMS);
    await chrome.storage.session.set({[key]: items});
    await badge(tabId, items.length);
  });
}

async function clearTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  await enqueue(tabId, async () => {
    await chrome.storage.session.remove([`items_${tabId}`, `probe_${tabId}`]);
    await badge(tabId, 0);
  });
}

// Listener MUST be registered at top-level in Manifest V3.
chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0 || details.type === 'main_frame' || details.type === 'sub_frame') return;
  if (!getKind(details.url)) return;
  void addCandidate(details.tabId, {url: details.url, pageUrl: details.initiator || '', source: 'network'});
}, {urls: ['http://*/*', 'https://*/*']});

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.type === 'main_frame' || details.type === 'sub_frame') return;
  const ct = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value || '';
  if (!getKind(details.url, ct)) return;
  void addCandidate(details.tabId, {url: details.url, mime: ct, pageUrl: details.initiator || '', source: 'content-type'});
}, {urls: ['http://*/*', 'https://*/*']}, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) void clearTab(tabId);
});
chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove([`items_${tabId}`, `probe_${tabId}`, `job_${tabId}`]);
});

function isHttpUrl(url) { return typeof url === 'string' && url.length <= 10000 && allowedProtocols.test(url); }

function setJob(tabId, item) {
  const prev=jobQueues.get(tabId)||Promise.resolve();
  const next=prev.catch(()=>{}).then(()=>chrome.storage.session.set({[`job_${tabId}`]:{...item,updatedAt:Date.now()}}));
  jobQueues.set(tabId,next);
  void next.finally(()=>{if(jobQueues.get(tabId)===next)jobQueues.delete(tabId);}).catch(()=>{});
  return next;
}

async function startNativeDownload(tabId, item, options = {}) {
  const url = item?.url;
  if (!isHttpUrl(url)) return Promise.resolve({ok:false,error:'Indirizzo video non valido.'});
  if (activeByTab.has(tabId)) return {ok:false,error:'Un download è già in corso per questa scheda.'};
  const portKey = crypto.randomUUID();
  const askWhere = options.askWhere !== false;
  const fileName = safeFileStem(options.fileName || item.title || 'Video');
  const windowsMp4 = options.windowsMp4 !== false;
  try {
    const port = chrome.runtime.connectNative(HOST);
    activePorts.set(portKey, port);
    activeByTab.set(tabId, portKey);
    await setJob(tabId, {status:askWhere?'selecting':'starting',title:fileName,sourceUrl:url,jobId:portKey,message:askWhere?'Scegli la cartella nella finestra di Windows…':'Avvio download…'});
    port.onMessage.addListener(msg => {
      if (msg?.type === 'progress') {
        void setJob(tabId, {status:msg.status || 'downloading',title:fileName,message:msg.message||'Download in corso', percent:msg.percent ?? null,sourceUrl:url,jobId:portKey});
      } else if (msg?.type === 'done') {
        void setJob(tabId, {status:msg.cancelled?'cancelled':(msg.ok?'done':'error'),title:fileName,sourceUrl:url,jobId:portKey,message:msg.message || (msg.ok?'Download completato':'Download non riuscito')});
        activePorts.delete(portKey);
        activeByTab.delete(tabId);
        port.disconnect();
      } else if (msg?.type === 'error') {
        void setJob(tabId, {status:'error',title:fileName,sourceUrl:url,jobId:portKey,message:msg.message||'Errore durante il download'});
      }
    });
    port.onDisconnect.addListener(() => {
      const wasActive = activePorts.delete(portKey);
      if (wasActive) {
        activeByTab.delete(tabId);
        void setJob(tabId, {status:'error',title:fileName,sourceUrl:url,jobId:portKey,message:chrome.runtime.lastError?.message || 'Collegamento al motore locale interrotto'});
      }
    });
    port.postMessage({action:'download',url,referer:item.pageUrl || '',title:item.title || '',fileName,askWhere,windowsMp4,
      quality:options.quality ?? null,audioLanguage:options.audioLanguage||'',audioUrl:options.audioUrl||'',container:options.container||'mp4',
      kind:item.kind||'',expectAudio:options.expectAudio===true,allowSilent:options.allowSilent===true});
    return {ok:true,via:'native'};
  } catch (e) {
    activeByTab.delete(tabId);
    activePorts.delete(portKey);
    void setJob(tabId, {status:'error',title:fileName,sourceUrl:url,jobId:portKey,message:String(e.message||e)});
    return {ok:false,error:String(e.message||e)};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === 'found' && sender.tab?.id != null) {
      const tab = sender.tab;
      await addCandidate(tab.id, {...message.item, pageUrl: message.item?.pageUrl || tab.url});
      return {ok:true};
    }
    const tabId = message?.tabId;
    if (!Number.isInteger(tabId) || tabId < 0) return {ok:false,error:'Scheda non valida'};
    if (message.type === 'get') {
      const keys = [`items_${tabId}`, `probe_${tabId}`, `job_${tabId}`];
      const data = await chrome.storage.session.get(keys);
      return {ok:true,items:data[keys[0]]||[],probe:data[keys[1]]||null,job:data[keys[2]]||null};
    }
    if (message.type === 'clear') {
      await clearTab(tabId);
      return {ok:true};
    }
    if (message.type === 'verify') {
      const url = message.url;
      if (!isHttpUrl(url)) return {ok:false,error:'Sorgente non valida'};
      const key = `items_${tabId}`;
      const items = (await chrome.storage.session.get(key))[key] || [];
      if (!items.some(x => x.url === url)) return {ok:false,error:'Sorgente non presente nella scheda'};
      let reply;
      try {
        reply = await chrome.runtime.sendNativeMessage(HOST,{action:'inspect',url,referer:items.find(x=>x.url===url)?.pageUrl||''});
      } catch (e) { return {ok:false,error:`Verifica non disponibile: ${e.message||e}`}; }
      await enqueue(tabId, async () => {
        const latest = (await chrome.storage.session.get(key))[key] || [];
        const item = latest.find(x => x.url === url);
        if (!item) return;
        item.check = {status:reply?.status||'unknown',height:reply?.height||null,
          qualities:Array.isArray(reply?.qualities)?reply.qualities:[],
          languages:Array.isArray(reply?.languages)?reply.languages:[],
          relatedUrls:Array.isArray(reply?.relatedUrls)?reply.relatedUrls:[],
          duration:reply?.duration??null,title:reply?.title||'',
          message:reply?.message||'',checkedAt:Date.now()};
        await chrome.storage.session.set({[key]:latest});
      });
      return {ok:true,check:reply};
    }
    if (message.type === 'probe') {
      if (!isHttpUrl(message.url)) return {ok:false,error:'Indirizzo pagina non valido'};
      try {
        const reply = await chrome.runtime.sendNativeMessage(HOST, {action:'probe',url:message.url});
        if (reply?.ok) await chrome.storage.session.set({[`probe_${tabId}`]:reply.item});
        return reply || {ok:false,error:'Nessuna risposta dal motore locale'};
      } catch (e) { return {ok:false,error:`Motore locale non disponibile: ${e.message||e}`}; }
    }
    if (message.type === 'download') {
      const audioUrl = message.audioUrl || '';
      if (audioUrl) {
        const items = (await chrome.storage.session.get(`items_${tabId}`))[`items_${tabId}`] || [];
        if (!items.some(x => x.url === audioUrl && (x.kind === 'audio' || x.check?.status === 'audio_only' || x.kind === 'hls' || x.kind === 'dash'))) {
          return {ok:false,error:'Traccia audio non presente tra le sorgenti della pagina'};
        }
      }
      return await startNativeDownload(tabId, message.item, {fileName:message.fileName,askWhere:message.askWhere,windowsMp4:message.windowsMp4,
        quality:message.quality,audioLanguage:message.audioLanguage,audioUrl,container:message.container,
        expectAudio:message.expectAudio,allowSilent:message.allowSilent});
    }
    if (message.type === 'direct') {
      if (!isHttpUrl(message.item?.url)) return {ok:false,error:'URL non valido'};
      try {
        const name = safeFileStem(message.fileName || message.item.title || 'Video');
        const filename = `${message.askWhere === false ? 'Brook/' : ''}${name}.${mediaExt(message.item)}`;
        const id = await chrome.downloads.download({url:message.item.url,filename,saveAs:message.askWhere !== false,conflictAction:'uniquify'});
        return {ok:true,id};
      } catch(e) { return {ok:false,error:String(e.message||e)}; }
    }
    if (message.type === 'preview') {
      if (!isHttpUrl(message.item?.url)) return {ok:false,error:'Sorgente non valida'};
      try { return await chrome.runtime.sendNativeMessage(HOST,{action:'preview',url:message.item.url,
        audioUrl:message.audioUrl||'',referer:message.item.pageUrl||''}); }
      catch(e) { return {ok:false,error:`Anteprima non disponibile: ${e.message||e}`}; }
    }
    if (message.type === 'ping') {
      try { return {...(await chrome.runtime.sendNativeMessage(HOST,{action:'ping'})),extensionVersion:BROOK_VERSION,previewSupported:true}; }
      catch(e) { return {ok:false,error:String(e.message||e)}; }
    }
    return {ok:false,error:'Comando sconosciuto'};
  })().then(sendResponse).catch(e => sendResponse({ok:false,error:String(e.message||e)}));
  return true;
});
