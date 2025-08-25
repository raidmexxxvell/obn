// error-overlay.js
// Простая панель отладки: перехват глобальных ошибок и показ поверх приложения.
(function(){
  if (window.__ERROR_OVERLAY__) return;
  const maxEntries = 20;
  let errors = [];
  function ensureEl(){
    let host = document.getElementById('error-overlay');
    if (!host){
      host = document.createElement('div');
      host.id='error-overlay';
      host.style.cssText='position:fixed;top:0;left:0;right:0;max-height:40%;overflow:auto;z-index:4000;font:12px/1.4 monospace;background:rgba(0,0,0,.85);color:#f88;padding:6px 8px;display:none;';
      const bar=document.createElement('div');
      bar.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:4px;';
      const title=document.createElement('div'); title.textContent='JS Errors'; title.style.fontWeight='700';
      const btnHide=document.createElement('button'); btnHide.textContent='×'; btnHide.style.cssText='background:#400;border:1px solid #a44;color:#fff;border-radius:4px;cursor:pointer;padding:2px 6px;font-size:12px;'; btnHide.onclick=()=>{ host.style.display='none'; };
      const btnClear=document.createElement('button'); btnClear.textContent='Очистить'; btnClear.style.cssText='background:#222;border:1px solid #555;color:#ddd;border-radius:4px;cursor:pointer;padding:2px 6px;font-size:12px;'; btnClear.onclick=()=>{ errors=[]; list.innerHTML=''; };
      const btnCopy=document.createElement('button'); btnCopy.textContent='Копировать'; btnCopy.style.cssText=btnClear.style.cssText; btnCopy.onclick=()=>{ try { navigator.clipboard.writeText(errors.map(e=>e.raw).join('\n')); } catch(_) {} };
      const btnToggle=document.createElement('button'); btnToggle.textContent='▼'; btnToggle.style.cssText=btnClear.style.cssText; btnToggle.onclick=()=>{ list.style.display = (list.style.display==='none'?'block':'none'); };
      bar.append(title, btnHide, btnClear, btnCopy, btnToggle);
      const list=document.createElement('div'); list.id='error-overlay-list'; list.style.cssText='font-size:11px;white-space:pre-wrap;word-break:break-word;';
      host.append(bar, list); document.documentElement.appendChild(host);
    }
    return host;
  }
  function addError(entry){
    const host=ensureEl(); const list=host.querySelector('#error-overlay-list');
    errors.push(entry); if (errors.length>maxEntries) errors.shift();
    const line=document.createElement('div');
    line.innerHTML = '<span style="color:#888">'+entry.time+'</span> '+entry.msg + (entry.stack?'\n<code style="color:#aaa">'+entry.stack.replace(/[<>]/g,'')+'</code>':'');
    list.appendChild(line); host.style.display='block';
  }
  window.addEventListener('error', (e)=>{
    try { addError({ time:new Date().toISOString().split('T')[1].replace('Z',''), msg:e.message+' @'+e.filename+':'+e.lineno+':'+e.colno, stack:e.error && e.error.stack || '', raw:(e.message||'') }); } catch(_) {}
  });
  window.addEventListener('unhandledrejection', (e)=>{
    let msg='unhandledrejection'; let stack='';
    try { const r=e.reason; if (r){ msg += ': '+(r.message||r.status||r.toString()); stack=r.stack||''; } } catch(_) {}
    addError({ time:new Date().toISOString().split('T')[1].replace('Z',''), msg, stack, raw:msg+' '+stack });
  });
  // Тестовая отметка
  console.log('[error-overlay] initialized');
  window.__ERROR_OVERLAY__ = true;
  // Помечаем, что скрипт загружен
  try { window.__ERROR_OVERLAY_LOADED__ = true; } catch(_){}
})();
