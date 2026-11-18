/* Isolated content script. Reads public DOM / performance metadata; never captures credentials. */
(() => {
  'use strict';
  const seen = new Map();
  const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|ogv|mp3|m4a|aac|ogg|opus|flac)(?:[?#]|$)/i;
  let pending = false;
  function emit(raw, title = '', height = 0, source = 'DOM') {
    if (!raw || typeof raw !== 'string' || raw.startsWith('blob:') || raw.startsWith('data:')) return;
    let url;
    try { url = new URL(raw, location.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (!MEDIA_RE.test(url.href)) return;
    const signature = `${title}|${height}|${source}`;
    const old = seen.get(url.href);
    if (old && (old.source === 'DOM' && (source !== 'DOM' || (old.height >= height && old.title === title)))) return;
    if (old && old.signature === signature) return;
    seen.set(url.href, {signature, title, height, source});
    chrome.runtime.sendMessage({type:'found',item:{url:url.href,title,pageUrl:location.href,source,height}}).catch(() => {});
  }
  function scan() {
    pending = false;
    const title = document.querySelector('meta[property="og:title"]')?.content || document.querySelector('h1')?.textContent?.trim() || document.title;
    document.querySelectorAll('video, audio').forEach(el => {
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || title;
      const height = Number(el.videoHeight) || 0;
      emit(el.currentSrc || '', label, height);
      emit(el.src || '', label, height);
      el.querySelectorAll('source').forEach(source => emit(source.src || '', label, height));
    });
    document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[name="twitter:player:stream"]').forEach(meta => emit(meta.content || '', document.title));
    for (const perf of performance.getEntriesByType('resource')) emit(perf.name, '', 0, 'performance');
  }
  function scheduleScan() {
    if (pending) return;
    pending = true;
    setTimeout(scan, 300);
  }
  new MutationObserver(scheduleScan).observe(document, {subtree:true,childList:true,attributes:true,attributeFilter:['src','content']});
  document.addEventListener('play', scheduleScan, true);
  document.addEventListener('loadedmetadata', scheduleScan, true);
  try { new PerformanceObserver(list => { for(const entry of list.getEntries()) emit(entry.name, '', 0, 'performance'); }).observe({type:'resource',buffered:true}); } catch { /* Ignore on older pages. */ }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleScan, {once:true});
  scheduleScan();
})();
