'use strict';
// Brook v1.1 — minimal presentation, conservative media grouping, local preview.
const $ = id => document.getElementById(id);
const element = (tag, className='', text='') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const ICON = {
  play:'<path d="m9 6 10 6-10 6z"/>',
  save:'<path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3"/>',
  film:'<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>'
};
function svg(name){const ns='http://www.w3.org/2000/svg';const el=document.createElementNS(ns,'svg');el.setAttribute('viewBox','0 0 24 24');el.setAttribute('aria-hidden','true');el.innerHTML=ICON[name];return el;}
let tab=null;
let items=[];
let probe=null;
let job=null;
let groups=[];
let engineReady=false;
let autoRunning=false;
let activeSave=null;
let activePreview=null;
let previewBlobUrl=null;
let saveBusy=false;
let askWhereDefault=true;
const request=(type,data={}) => chrome.runtime.sendMessage({type,tabId:tab.id,...data});
const isStream=i=>['hls','dash','page'].includes(i.kind);
const directVideo=i=>i.kind==='video';
const host=url=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return '';}};
function friendly(raw){
  let s=String(raw||'').trim();
  try{s=decodeURIComponent(s);}catch{}
  return s.replace(/\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|mp3|m4a)$/i,'')
    .replace(/[_]+/g,' ').replace(/\s+/g,' ').trim();
}
function opaque(s){return !s||/^(?:master|index|playlist|manifest|stream|video|media|file|watch|play|source|download|output)(?:[\s-]*\d+)?$/i.test(s)||/^\d{4,}$/.test(s)||/^[0-9a-f]{16,}$/i.test(s)||/^[a-z0-9_\-]{30,}$/i.test(s);}
function pageName(){const name=friendly(tab?.title);return !opaque(name)?name:'Video della pagina';}
function titleFor(item){
  const preferred = item.check?.title || (item.source === 'DOM'?item.title:'');
  const choices=[preferred,item.title, (()=>{try{return new URL(item.url).pathname.split('/').pop();}catch{return '';}})()];
  for(const choice of choices){const value=friendly(choice);if(!opaque(value)&&value.length>4&&value.length<115)return value;}
  return pageName();
}
function quality(item){const height=Number(item.check?.height||item.height);return height>=144&&height<=8640?`${height}p`:'';}
function timeText(seconds){if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<1)return '';const s=Math.round(seconds);return `${Math.floor(s/3600)?`${Math.floor(s/3600)}:`:''}${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function showNotice(message,good=false){const el=$('notice');el.textContent=message;el.classList.toggle('success',good);el.hidden=!message;}
function groupSources(all){
  const map=new Map(all.map((i,n)=>[i.url,n]));
  const parent=all.map((_,n)=>n);
  const find=n=>parent[n]===n?n:(parent[n]=find(parent[n]));
  const link=(a,b)=>{const x=find(a),y=find(b);if(x!==y)parent[y]=x;};
  const normalized=u=>{try{const x=new URL(u);return `${x.origin}${x.pathname}`;}catch{return null;}};
  for(let n=0;n<all.length;n++){
    const refs=all[n].check?.relatedUrls || [];
    for(const ref of refs){
      let index=map.get(ref);
      // Only link URLs EXPLICITLY referenced by a manifest. Query changes
      // (e.g. signed CDN links) are tolerated if hostname+pathname match.
      if(index===undefined){const key=normalized(ref);index=all.findIndex(item=>normalized(item.url)===key);}
      if(index!==undefined && index>=0 && index!==n)link(n,index);
    }
  }
  const buckets=new Map();
  all.forEach((item,n)=>{const root=find(n);if(!buckets.has(root))buckets.set(root,[]);buckets.get(root).push(item);});
  return [...buckets.values()].map(members=>{
    const inspectedMaster=members.find(x=>x.check?.relatedUrls?.length>0 && x.check?.status!=='audio_only');
    const primary=inspectedMaster || [...members].sort((a,b)=>score(b)-score(a))[0];
    const hasVideo=members.some(x=>(x.kind==='video'&&x.check?.status!=='audio_only')||x.kind==='page'||x.check?.status==='video_audio'||x.check?.status==='video_only'||(['hls','dash'].includes(x.kind)&&x.check?.status!=='audio_only'));
    const relatedAudio=members.filter(x=>x.check?.status==='audio_only'||x.kind==='audio');
    return {primary,members,hasVideo,relatedAudio};
  }).sort((a,b)=>score(b.primary)-score(a.primary));
}
function score(item){
  const status=item.check?.status;
  return (status==='video_audio'?500:status==='video_only'?280:status==='audio_only'?-600:status==='unknown'?15:80)
    +(item.check?.relatedUrls?.length?130:0)+(item.kind==='page'?75:0)+(item.source==='DOM'?25:0)
    +(quality(item)?15:0)+(item.kind==='video'?40:0);
}
function chosenTitle(group){return titleFor(group.primary);}
function groupInfo(group){
  const item=group.primary,check=item.check||{};
  const q=quality(item);
  const duration=timeText(check.duration);
  const site=host(item.pageUrl||item.url);
  return [q, duration, site].filter(Boolean).join(' · ');
}
const JOB_RUNNING=new Set(['starting','selecting','downloading','merging','converting']);
function jobBelongs(group, value){
  return Boolean(value?.sourceUrl && group.members.some(x=>x.url===value.sourceUrl));
}
function progressLabel(value){
  const labels={starting:'Preparo…',selecting:'Scegli la cartella…',downloading:'Scarico…',merging:'Unisco audio e video…',converting:'Ottimizzo…',done:'Salvato',error:'Riprova',cancelled:'Scarica'};
  if(value.status==='downloading' && Number.isFinite(Number(value.percent)))return `Scarico ${Math.max(0,Math.min(100,Number(value.percent)))}%`;
  return labels[value.status]||'Scarica';
}
function renderCard(group){
  const item=group.primary;
  const card=element('article','media-card');
  const top=element('div','media-top');
  const thumb=element('div','media-thumb');thumb.append(svg('film'));
  const info=element('div','media-info');
  const name=element('div','media-name',chosenTitle(group));name.title=chosenTitle(group);
  info.append(name,element('div','media-sub',groupInfo(group)||'Video rilevato'));
  top.append(thumb,info);card.append(top);
  const actions=element('div','media-actions');
  const preview=element('button','play-button');preview.title='Guarda prima di scaricare';preview.setAttribute('aria-label',`Anteprima: ${chosenTitle(group)}`);preview.append(svg('play'));
  preview.addEventListener('click',()=>void openPreview(group));
  const save=element('button','download-button');
  const current=jobBelongs(group,job)?job:null;
  if(current){
    save.classList.add('has-job',`job-${current.status||'starting'}`);
    if(JOB_RUNNING.has(current.status)){
      save.disabled=true;
      const fill=element('span','download-progress-fill');
      const percent=Number(current.percent);
      if(current.status==='downloading' && Number.isFinite(percent) && percent>=0 && percent<=100) fill.style.width=`${percent}%`;
      else save.classList.add('indeterminate');
      save.append(fill);
    }
    const label=element('span','download-progress-label',progressLabel(current));
    save.append(label);
    save.title=current.message||'';
  }else save.append(svg('save'),document.createTextNode('Scarica'));
  save.addEventListener('click',()=>openSave(group));
  actions.append(preview,save);card.append(actions);
  if(current && (current.status==='error'||current.status==='done'||current.status==='cancelled')){
    const message=element('div','media-status'+(current.status==='done'?' good':''),current.message||'');
    card.append(message);
  }
  if(item.check?.status==='video_only' && !group.relatedAudio.length){
    card.append(element('div','media-status','Audio non rilevato. Puoi abbinarlo nel salvataggio, se disponibile.'));
  }
  if(item.check?.status==='unknown')card.append(element('div','media-status','Sorgente non verificabile: il download potrebbe non riuscire.'));
  return card;
}
function renderRaw(){
  const raw=$('rawSources');raw.replaceChildren();
  $('advancedCount').textContent=items.length?`${items.length} sorgenti`:'';
  for(const item of items){
    const row=element('div','raw-row');const left=element('div','raw-left');
    const kind={hls:'Streaming HLS',dash:'Streaming DASH',video:'Video',audio:'Audio',page:'Pagina'}[item.kind]||'Risorsa';
    left.append(element('div','raw-title',titleFor(item)));
    const status={video_audio:'video + audio',video_only:'solo video',audio_only:'solo audio',unknown:'non verificata'}[item.check?.status] || 'da analizzare';
    left.append(element('div','raw-detail',`${kind} · ${status}`));
    const actions=element('div','raw-actions');
    const copy=element('button','tiny-button','Copia');copy.addEventListener('click',()=>void navigator.clipboard.writeText(item.url).then(()=>showNotice('Indirizzo copiato.',true)).catch(()=>showNotice('Non riesco a copiare.')));
    const inspect=element('button','tiny-button','Verifica');inspect.disabled=!!item.check;
    inspect.addEventListener('click',async()=>{inspect.disabled=true;await verifyOne(item);});
    actions.append(copy,inspect);row.append(left,actions);raw.append(row);
  }
  $('checkSources').disabled=autoRunning||!items.some(i=>!i.check);
}
function render(){
  const actual=groupSources([...items,...(probe?[probe]:[])]);
  groups=actual;
  const main=actual.filter(g=>g.hasVideo);
  $('results').replaceChildren();
  for(const group of main)$('results').append(renderCard(group));
  $('empty').hidden=main.length>0;
  $('summary').textContent=main.length?`${main.length} ${main.length===1?'video trovato':'video trovati'}`:'Avvia il video per trovarlo qui.';
  renderRaw();renderActivity(job,actual);
}
function renderActivity(value, allGroups=[]){
  const show=value && !allGroups.some(group=>jobBelongs(group,value));
  $('activity').hidden=!show;
  if(!show)return;
  $('activityLabel').textContent=({starting:'Preparazione',selecting:'Scelta della cartella',downloading:'Download in corso',merging:'Unione delle tracce',converting:'Ottimizzazione MP4',done:'Salvataggio completato',error:'Download non riuscito',cancelled:'Annullato'})[value.status]||'Download';
  $('activityTitle').textContent=value.title||'Video';
  $('activityText').textContent=value.message||'';
  const p=Number(value.percent);const has=Number.isFinite(p)&&p>=0&&p<=100&&value.status==='downloading';
  $('activityTrack').hidden=!has;$('activityPercent').textContent=has?`${p}%`:'';$('activityFill').style.width=has?`${p}%`:'0';
}
async function refresh(){
  if(!tab)return;
  try{
    const r=await request('get');if(!r?.ok)throw Error(r?.error||'Errore nel caricamento');
    items=r.items||[];probe=r.probe||null;job=r.job||null;render();
  }catch(e){showNotice(e.message||String(e));}
}
async function verifyOne(item){
  try{
    const r=await request('verify',{url:item.url});
    if(!r?.ok)throw Error(r.error||'Sorgente non verificabile');
    await refresh();
  }catch(e){showNotice(String(e.message||e));}
}
async function verifyPending(limit=8){
  if(autoRunning||!engineReady)return;
  const pending=items.filter(i=>!i.check && i.kind!=='audio').slice(0,limit);
  if(!pending.length)return;
  autoRunning=true;$('checkSources').disabled=true;
  try{
    for(const item of pending){await verifyOne(item);}
    // Once a master manifest references audio children, checking the children
    // helps the UI distinguish them. Keep this bounded for responsiveness.
    const children=items.filter(i=>!i.check && i.kind==='audio').slice(0,2);
    for(const item of children)await verifyOne(item);
  }finally{autoRunning=false;renderRaw();}
}
function safeStem(text){return String(text||'Video').replace(/[\x00-\x1f<>:"/\\|?*]/g,' ').replace(/\.(mp4|mkv|webm|m3u8|mpd)$/i,'').replace(/\s+/g,' ').trim().replace(/^[. ]+|[. ]+$/g,'').slice(0,104);}
function option(select,value,label){const el=document.createElement('option');el.value=value;el.textContent=label;select.append(el);}
function availableAudio(group){
  const existing=new Set(group.relatedAudio.map(x=>x.url));
  return [...group.relatedAudio,...items.filter(x=>(x.kind==='audio'||x.check?.status==='audio_only')&&!existing.has(x.url))];
}
function openSave(group){
  activeSave=group;
  $('filename').value=safeStem(chosenTitle(group));
  $('quality').replaceChildren();option($('quality'),'','Migliore disponibile');
  const qualities=group.primary.check?.qualities||[];
  for(const q of qualities)option($('quality'),String(q),`${q}p`);
  $('qualityWrap').hidden=!isStream(group.primary)||!qualities.length;
  $('language').replaceChildren();option($('language'),'','Predefinita');
  const languages=group.primary.check?.languages||[];
  for(const l of languages)option($('language'),l,l.toUpperCase());
  $('languageWrap').hidden=!languages.length;
  $('pairAudio').replaceChildren();option($('pairAudio'),'','Automatico / nessuna traccia aggiuntiva');
  const audio=availableAudio(group).filter(x=>x.url!==group.primary.url);
  audio.forEach((i,n)=>option($('pairAudio'),i.url,`${titleFor(i)} · audio ${n+1}`));
  $('pairWrap').hidden=!audio.length||group.primary.check?.status==='video_audio';
  $('silentWrap').hidden=group.primary.check?.status!=='video_only';
  $('allowSilent').checked=false;
  $('askWhere').checked=askWhereDefault;
  // Chrome saves direct media in its original format; the container selector
  // applies only to streams processed by the local engine.
  $('containerWrap').hidden=directVideo(group.primary);
  $('container').value='mp4';
  $('saveError').hidden=true;$('saveOverlay').hidden=false;
  $('filename').focus();$('filename').select();
}
function closeSave(){if(saveBusy)return;$('saveOverlay').hidden=true;activeSave=null;}
async function beginDownload(){
  if(!activeSave||saveBusy)return;
  const fileName=safeStem($('filename').value);
  if(!fileName){$('saveError').textContent='Scrivi un nome per il video.';$('saveError').hidden=false;return;}
  const item=activeSave.primary;
  const askWhere=$('askWhere').checked;
  const container=$('container').value;
  const audioUrl=$('pairAudio').value||'';
  const quality=$('quality').value?Number($('quality').value):null;
  const audioLanguage=$('language').value||'';
  const allowSilent=$('allowSilent').checked;
  saveBusy=true;$('startDownload').disabled=true;
  try{
    await chrome.storage.local.set({askWhere});askWhereDefault=askWhere;
    let r;
    if(directVideo(item) && !audioUrl && !audioLanguage && quality===null){
      // Direct media needs no Python host: Chrome handles download and save-as.
      r=await request('direct',{item,fileName,askWhere});
    }else{
      r=await request('download',{item,fileName,askWhere,windowsMp4:container==='mp4',container,quality,audioLanguage,audioUrl,
        expectAudio:item.check?.status==='video_audio',allowSilent});
    }
    if(!r?.ok)throw Error(r?.error||'Non riesco ad avviare il download.');
    closeSaveImmediately();
    showNotice(r.via==='native' ? 'Il download appare nella scheda del video.' : 'Download avviato in Chrome.',true);
    await refresh();
  }catch(e){$('saveError').textContent=String(e.message||e);$('saveError').hidden=false;}
  finally{saveBusy=false;$('startDownload').disabled=false;}
}
function closeSaveImmediately(){$('saveOverlay').hidden=true;activeSave=null;}
function cleanPreview(){const video=$('previewVideo');video.pause();video.removeAttribute('src');video.load();if(previewBlobUrl){URL.revokeObjectURL(previewBlobUrl);previewBlobUrl=null;}}
function closePreview(){cleanPreview();$('previewOverlay').hidden=true;activePreview=null;}
function previewError(message){
  $('previewVideo').hidden=true;$('previewLoading').hidden=false;
  $('previewLoading').replaceChildren(element('p','',message));
  $('previewNote').textContent='Puoi comunque provare a scaricare il contenuto.';
  $('openPage').hidden=!(activePreview?.primary.pageUrl || tab?.url);
}
function showPlayer(src,temporary=false){
  const video=$('previewVideo');$('previewLoading').hidden=true;video.hidden=false;video.src=src;
  if(temporary)$('previewNote').textContent='Estratto di 5 secondi creato sul tuo computer. Non è il file completo.';
  video.load();video.play().catch(()=>{});
}
function base64Blob(payload){
  const binary=atob(payload);const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return new Blob([bytes],{type:'video/mp4'});
}
async function generatePreview(group){
  try{
    // Pair audio only if it is explicitly linked to this group's manifest.
    const knownAudio=group.relatedAudio.length===1 ? group.relatedAudio[0] : null;
    const linked=knownAudio && group.members.some(m=>m.check?.relatedUrls?.includes(knownAudio.url));
    const audioUrl=linked && !group.primary.check?.relatedUrls?.length ? knownAudio.url : '';
    const result=await request('preview',{item:group.primary,audioUrl});
    if(activePreview!==group)return;
    if(!result?.ok||!result.data)throw Error(result?.error||'Anteprima non disponibile');
    previewBlobUrl=URL.createObjectURL(base64Blob(result.data));showPlayer(previewBlobUrl,true);
  }catch(e){if(activePreview===group){const msg=String(e.message||'Anteprima non disponibile');previewError(/comando sconosciuto|comando non riconosciuto/i.test(msg)?'Anteprima non disponibile: estensione e motore locale non sono allineati. Ricarica Brook da chrome://extensions e riavvia Chrome.':msg);}}
}
async function openPreview(group){
  cleanPreview();activePreview=group;
  $('previewTitle').textContent=chosenTitle(group);
  $('previewLoading').replaceChildren(element('span','spinner'),element('p','','Preparo un’anteprima…'),element('small','','Per gli streaming può richiedere qualche secondo.'));
  $('previewLoading').hidden=false;$('previewVideo').hidden=true;$('openPage').hidden=true;
  $('previewNote').textContent='L’anteprima non scarica il file completo.';$('previewOverlay').hidden=false;
  const item=group.primary;
  if(directVideo(item)){
    showPlayer(item.url);
    // The media element may fail on websites restricting hotlinking.
    $('previewVideo').onerror=()=>{if(activePreview===group){cleanPreview();$('previewVideo').onerror=null;void generatePreview(group);}};
  }else{await generatePreview(group);}
}
async function probePage(){
  if(!tab?.url?.startsWith('http'))return showNotice('Questa pagina non può essere analizzata.');
  $('analyzePage').disabled=true;$('emptyAnalyze').disabled=true;
  showNotice('Cerco un video nella pagina…');
  try{
    const r=await request('probe',{url:tab.url});
    if(!r?.ok)throw Error(r?.error||'Nessun video individuato');
    showNotice('Pagina analizzata.',true);await refresh();
  }catch(e){showNotice(String(e.message||e));}
  finally{$('analyzePage').disabled=false;$('emptyAnalyze').disabled=false;}
}
$('refresh').addEventListener('click',()=>void refresh());
$('emptyAnalyze').addEventListener('click',()=>void probePage());
$('analyzePage').addEventListener('click',()=>void probePage());
$('checkSources').addEventListener('click',()=>void verifyPending(12));
$('clear').addEventListener('click',async()=>{await request('clear');probe=null;showNotice('Elenco pulito.',true);await refresh();});
$('closeSave').addEventListener('click',closeSave);$('cancelSave').addEventListener('click',closeSave);
$('startDownload').addEventListener('click',()=>void beginDownload());
$('filename').addEventListener('keydown',event=>{if(event.key==='Enter')void beginDownload();});
$('closePreview').addEventListener('click',closePreview);
$('openPage').addEventListener('click',async()=>{const url=activePreview?.primary.pageUrl||tab?.url;if(url?.startsWith('http'))await chrome.tabs.create({url});});
$('saveOverlay').addEventListener('click',event=>{if(event.target===$('saveOverlay'))closeSave();});
$('previewOverlay').addEventListener('click',event=>{if(event.target===$('previewOverlay'))closePreview();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePreview();closeSave();}});
(async()=>{
  const [current]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!current)return;
  tab=current;
  $('pageTitle').textContent=pageName();$('domain').textContent=host(tab.url)||'Pagina attuale';
  try{const saved=await chrome.storage.local.get(['askWhere']);askWhereDefault=saved.askWhere!==false;}catch{}
  await refresh();
  try{
    const r=await request('ping');
    const aligned=r?.extensionVersion==='1.1.0'&&r?.version==='1.1.0';
    engineReady=!!r?.ok&&!!r.ytDlpInstalled&&!!r.ffmpegReady&&aligned;
    $('connectionText').textContent=engineReady?'Pronto':(!r?.ok?'Motore offline':(!aligned?'Aggiornamento richiesto':'Motore offline'));
    if(r?.ok && !aligned)showNotice('Le versioni dell’estensione e del motore locale non coincidono. Ricarica Brook da chrome://extensions e reinstalla il motore dalla stessa versione del progetto.');
    else if(r?.ok && !r.ffmpegReady)showNotice('FFmpeg non disponibile nel motore locale: non posso unire audio e video. Riavvia Chrome dopo aver installato FFmpeg.');
    $('connection').classList.toggle('offline',!engineReady);
    if(engineReady)void verifyPending(5);
  }catch{
    $('connectionText').textContent='Motore offline';$('connection').classList.add('offline');
  }
  // Keep observing newly arriving video resources while the popup stays open.
  setInterval(()=>void refresh(),1200);
})().catch(e=>showNotice(e.message||String(e)));
