// static/js/streams.js
// Конфигурация трансляций VK для матчей. Минимизируем нагрузку: ленивое подключение iframe.
// Как заполнять: добавьте запись c ключами (home, away, date?) и vkVideoId или vkPostUrl.
// Пример ключа: `${home.toLowerCase()}__${away.toLowerCase()}__${dateYYYYMMDD}`
// Если дата не критична, можно оставить пустой третий сегмент: `${home}__${away}__`.

(function(){
  // Хранилище соответствий: ключ → объект трансляции (локальный fallback)
  const registry = {
    // 'дождь__звезда__2025-08-16': { vkVideoId: '123456789_987654321', autoplay: 0 },
    // 'дождь__звезда__': { vkPostUrl: 'https://vk.com/video-123456_654321', autoplay: 0 },
  };
  function makeKey(match){
    const h = (match?.home||'').toLowerCase().trim();
    const a = (match?.away||'').toLowerCase().trim();
    let d = '';
    try{
      const raw = match?.date ? String(match.date) : (match?.datetime ? String(match.datetime) : '');
      d = raw ? raw.slice(0,10) : '';
    }catch(_){ d=''; }
    return `${h}__${a}__${d}`;
  }
  function findStream(match){
    const keyExact = makeKey(match);
    const keyDateAgnostic = `${(match?.home||'').toLowerCase().trim()}__${(match?.away||'').toLowerCase().trim()}__`;
    return registry[keyExact] || registry[keyDateAgnostic] || null;
  }

  function vUrl(u){
    try { const v = Number(localStorage.getItem('appVersion:lastSeen')||'0')||0; return v? (u + (u.includes('?')?'&':'?') + 'v='+v): u; } catch(_) { return u; }
  }

  function buildIframeSrc(info){
    if (!info) return '';
    if (info.vkVideoId) {
      const [oid, vid] = String(info.vkVideoId).split('_');
      return `https://vk.com/video_ext.php?oid=${encodeURIComponent(oid||'')}&id=${encodeURIComponent(vid||'')}&hd=2&autoplay=${info.autoplay?1:0}`;
    }
    if (info.vkPostUrl) {
      try {
        const m = String(info.vkPostUrl).match(/\/video(-?\d+_\d+)/);
        if (m && m[1]) {
          const [oid, vid] = m[1].split('_');
          return `https://vk.com/video_ext.php?oid=${encodeURIComponent(oid||'')}&id=${encodeURIComponent(vid||'')}&hd=2&autoplay=${info.autoplay?1:0}`;
        }
      } catch(_) {}
      return info.vkPostUrl;
    }
    return '';
  }

  function ensurePane(mdPane){
    let pane = document.getElementById('md-pane-stream');
    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'md-pane-stream';
      pane.className = 'md-pane';
      pane.style.display = 'none';
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
      mdPane.querySelector('.modal-body')?.appendChild(pane);
    }
    return pane;
  }

  function ensureTab(subtabs){
    let tab = subtabs?.querySelector('[data-mdtab="stream"]');
    if (!tab) {
      tab = document.createElement('div'); tab.className='subtab-item'; tab.setAttribute('data-mdtab','stream'); tab.textContent='Трансляция';
      subtabs.appendChild(tab);
    }
    return tab;
  }

  function buildStreamInto(pane, info, match){
    if (!info || pane.__inited) return !!pane.__inited;
    const host = document.createElement('div'); host.className = 'stream-wrap';
    const ratio = document.createElement('div'); ratio.className = 'stream-aspect';
    const ifr = document.createElement('iframe');
    ifr.src = buildIframeSrc(info);
    ifr.setAttribute('allowfullscreen','true');
    ifr.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; screen-wake-lock;';
    ifr.referrerPolicy = 'strict-origin-when-cross-origin';
    ratio.appendChild(ifr); host.appendChild(ratio);
    pane.innerHTML=''; pane.appendChild(host);
    pane.__inited = true;
    try { typeof window.initStreamComments === 'function' && window.initStreamComments(pane, match); } catch(_) {}
    return true;
  }

  async function fetchServerStream(match){
    try{
      const dateStr = (match?.datetime || match?.date || '').toString().slice(0,10);
      const url = `/api/streams/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}&date=${encodeURIComponent(dateStr)}&window=60`;
      const r = await fetch(url, { cache: 'no-store' });
      const ans = await r.json();
      if (ans && ans.available && (ans.vkVideoId || ans.vkPostUrl)) return ans;
    }catch(_){/* noop */}
    return null;
  }

  function setupMatchStream(mdPane, subtabs, match){
    // Fallback сначала из локального реестра, затем запрос на сервер
    let streamInfo = findStream(match);
    if (streamInfo) {
      const pane = ensurePane(mdPane);
      ensureTab(subtabs);
      pane.__streamInfo = streamInfo;
      return pane;
    }
    // Асинхронно проверим у сервера и, если есть, добавим вкладку
    fetchServerStream(match).then((ans)=>{
      if (ans) {
        const pane = ensurePane(mdPane);
        ensureTab(subtabs);
        pane.__streamInfo = ans;
      }
    }).catch(()=>{});
    return null; // пока не знаем — не показываем вкладку
  }

  function onStreamTabActivated(pane, match){
    if (!pane) return;
    if (!pane.__inited) {
      const info = pane.__streamInfo || findStream(match);
      if (info) {
        setTimeout(()=>buildStreamInto(pane, info, match), 50);
      } else {
        // Попробуем ещё раз спросить сервер и построить
        fetchServerStream(match).then((ans)=>{ if (ans) { pane.__streamInfo = ans; buildStreamInto(pane, ans, match); } else { const sk=pane.querySelector('.stream-skeleton'); if (sk) sk.textContent='Трансляция недоступна'; } }).catch(()=>{});
      }
    } else {
      // Уже инициализировано — запустим поллинг комментариев, если есть
      try { typeof pane.__startCommentsPoll === 'function' && pane.__startCommentsPoll(); } catch(_) {}
    }
  }

  window.__STREAMS__ = { findStream, registry };
  window.Streams = { setupMatchStream, onStreamTabActivated };
})();
