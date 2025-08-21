// static/js/streams.js
// Конфигурация трансляций VK для матчей. Минимизируем нагрузку: ленивое подключение iframe.
// Как заполнять: добавьте запись c ключами (home, away, date?) и vkVideoId или vkPostUrl.
// Пример ключа: `${home.toLowerCase()}__${away.toLowerCase()}__${dateYYYYMMDD}`
// Если дата не критична, можно оставить пустой третий сегмент: `${home}__${away}__`.

(function(){
  const DBG = true; // включено подробное логирование потоков
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
  if (DBG) console.debug('[streams] findStream', { keyExact });
  return registry[keyExact] || null;
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


  function ensurePane(mdPane, match){
    if (DBG) console.debug('[streams] ensurePane: enter', { mdKey: mdPane?.getAttribute?.('data-match-key')||null, key: makeKey(match) });
    let pane = document.getElementById('md-pane-stream');
    const body = mdPane.querySelector('.modal-body');

    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'md-pane-stream';
      pane.className = 'md-pane';
      pane.style.display = 'none';
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
      if (body) body.appendChild(pane);
      if (DBG) console.debug('[streams] ensurePane: created');
    } else {
      // Если панель уже существует, убедимся, что она находится в текущем mdPane
      try {
        if (body && pane.parentNode !== body) {
          body.appendChild(pane);
          if (DBG) console.debug('[streams] ensurePane: moved existing pane into current mdPane');
        }
      } catch(_) {}
    }

    // Обнуляем инициализацию при смене матча
    const key = makeKey(match);
    if (pane.getAttribute('data-match-key') !== key) {
      if (DBG) console.debug('[streams] ensurePane: key change -> reset pane', { from: pane.getAttribute('data-match-key'), to: key });
      pane.__inited = false;
      pane.__streamInfo = null;
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
      pane.setAttribute('data-match-key', key);
      // Показываем панель при смене матча, но контролируем видимость через активную вкладку
      pane.style.display = '';
    }
    return pane;
  }

  function ensureTab(subtabs, match){
    let tab = subtabs?.querySelector('[data-mdtab="stream"]');
    if (!tab) {
      tab = document.createElement('div'); tab.className='subtab-item'; tab.setAttribute('data-mdtab','stream'); tab.textContent='Трансляция';
      subtabs.appendChild(tab);
  if (DBG) console.debug('[streams] ensureTab: created');
    }
    if (match) tab.setAttribute('data-match-key', makeKey(match));
    return tab;
  }

  function buildStreamInto(pane, info, match){
    if (!info || pane.__inited) return !!pane.__inited;
  if (DBG) console.debug('[streams] buildStreamInto', { key: pane.getAttribute('data-match-key'), info: { hasVideoId: !!info.vkVideoId, hasPostUrl: !!info.vkPostUrl } });
  const host = document.createElement('div'); host.className = 'stream-wrap';
    const ratio = document.createElement('div'); ratio.className = 'stream-aspect';
    const ifr = document.createElement('iframe');
    // используем vUrl для перебивки кэша версии приложения (если применимо)
    ifr.src = vUrl(buildIframeSrc(info));
    ifr.setAttribute('allowfullscreen','true');
    ifr.setAttribute('webkitallowfullscreen','true');
    ifr.setAttribute('mozallowfullscreen','true');
    ifr.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; screen-wake-lock;';
    ifr.referrerPolicy = 'strict-origin-when-cross-origin';
    
    // Добавляем обработчик двойного тапа для полноэкранного режима на мобильных
    let lastTapTime = 0;
    ifr.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        e.preventDefault();
        // Попытка входа в полноэкранный режим
        try {
          if (ifr.requestFullscreen) {
            ifr.requestFullscreen();
          } else if (ifr.webkitRequestFullscreen) {
            ifr.webkitRequestFullscreen();
          } else if (ifr.mozRequestFullScreen) {
            ifr.mozRequestFullScreen();
          }
        } catch(_) {}
      }
      lastTapTime = now;
    }, { passive: false });
    
    // Кнопка «на весь экран»: улучшенная версия с отладкой для мобильных
    const fsBtn = document.createElement('button');
    fsBtn.className = 'stream-fs-btn';
    fsBtn.type = 'button';
    fsBtn.title = 'На весь экран';
    fsBtn.setAttribute('aria-label', 'На весь экран');
    fsBtn.innerHTML = '&#x26F6;'; // ⛶ или используем ⤢
    
    const enterFs = () => {
      if (DBG) console.debug('[streams] enterFs: trying fullscreen');
      let ok = false;
      // Пробуем разные варианты для мобильных браузеров
      try {
        if (ratio.requestFullscreen) { 
          ratio.requestFullscreen().then(()=>{ if (DBG) console.debug('[streams] fullscreen success'); }).catch(e=>{ if (DBG) console.debug('[streams] fullscreen failed:', e); }); 
          ok = true; 
        }
        else if (ratio.webkitRequestFullscreen) { 
          ratio.webkitRequestFullscreen(); 
          ok = true; 
          if (DBG) console.debug('[streams] webkit fullscreen attempt');
        }
        else if (ratio.mozRequestFullScreen) { 
          ratio.mozRequestFullScreen(); 
          ok = true; 
          if (DBG) console.debug('[streams] moz fullscreen attempt');
        }
        else if (ifr.requestFullscreen) {
          ifr.requestFullscreen().then(()=>{ if (DBG) console.debug('[streams] iframe fullscreen success'); }).catch(e=>{ if (DBG) console.debug('[streams] iframe fullscreen failed:', e); });
          ok = true;
        }
      } catch(e) { 
        if (DBG) console.debug('[streams] fullscreen exception:', e); 
      }
      
      if (!ok) {
        if (DBG) console.debug('[streams] fallback to pseudo-fullscreen');
        // Псевдо-фуллскрин: фиксируем контейнер на весь вьюпорт
        try { 
          pane.classList.add('fs-mode'); 
          document.body.classList.add('allow-landscape'); 
          if (DBG) console.debug('[streams] pseudo-fullscreen enabled');
        } catch(e) { 
          if (DBG) console.debug('[streams] pseudo-fullscreen failed:', e); 
        }
      }
    };
    
    const exitPseudo = () => { 
      try { 
        pane.classList.remove('fs-mode'); 
        if (DBG) console.debug('[streams] pseudo-fullscreen disabled');
      } catch(e) { 
        if (DBG) console.debug('[streams] exit pseudo failed:', e); 
      } 
    };
    
    fsBtn.addEventListener('click', (e)=>{ 
      e.preventDefault(); 
      e.stopPropagation();
      if (DBG) console.debug('[streams] fullscreen button clicked');
      
      try {
        // Проверяем, уже в фуллскрине ли мы
        const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        if (isFullscreen) {
          if (DBG) console.debug('[streams] exiting fullscreen');
          if (document.exitFullscreen) document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
          else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
          return;
        }
      } catch(e) { 
        if (DBG) console.debug('[streams] exit fullscreen failed:', e); 
      }
      
      // Переключаем псевдо-фуллскрин
      if (pane.classList?.contains('fs-mode')) {
        exitPseudo(); 
      } else {
        enterFs();
      }
    });
    
    // Слушаем события изменения фуллскрина для очистки псевдо-режима
    const handleFullscreenChange = () => {
      try {
        const fs = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;
        if (!fs && pane.classList?.contains('fs-mode')) {
          if (DBG) console.debug('[streams] fullscreen ended, keeping pseudo mode');
        } else if (!fs) {
          exitPseudo();
        }
      } catch(e) { 
        if (DBG) console.debug('[streams] fullscreen change handler error:', e); 
      }
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);

    ratio.appendChild(ifr); host.appendChild(ratio); host.appendChild(fsBtn);
  pane.innerHTML='';
  pane.appendChild(host);
    pane.__inited = true;
    try { typeof window.initStreamComments === 'function' && window.initStreamComments(pane, match); } catch(_) {}
    return true;
  }

  async function fetchServerStream(match){
    try{
      let dateStr = (match?.datetime || match?.date || '').toString().slice(0,10);
      if (!dateStr) {
        try {
          const cmk = window.__CURRENT_MATCH_KEY__ || '';
          const parts = cmk.split('__');
          if (parts.length >= 3 && parts[2]) dateStr = parts[2];
        } catch(_) {}
      }
  if (DBG) console.debug('[streams] fetchServerStream: request', { home: match?.home, away: match?.away, dateStr });
  const url = `/api/streams/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}&date=${encodeURIComponent(dateStr)}`;
      const r = await fetch(url, { cache: 'no-store' });
      const ans = await r.json();
      if (DBG) console.debug('[streams] fetchServerStream: response', ans);
      if (ans && ans.available && (ans.vkVideoId || ans.vkPostUrl)) return ans;
    }catch(_){/* noop */}
    return null;
  }

  function setupMatchStream(mdPane, subtabs, match){
    if (DBG) console.debug('[streams] setupMatchStream: enter', { key: makeKey(match), match });
    // Fallback сначала из локального реестра, затем запрос на сервер
    let streamInfo = findStream(match);
    if (streamInfo) {
      const pane = ensurePane(mdPane, match);
      ensureTab(subtabs, match);
      pane.__streamInfo = streamInfo;
      if (DBG) console.debug('[streams] setupMatchStream: local registry hit -> tab added');
      return pane;
    }
    // Асинхронно проверим у сервера и, если есть, добавим вкладку
    const expectedKey = makeKey(match);
    // Маркируем запрос последовательностью, чтобы игнорировать устаревшие ответы
    mdPane.__streamSetupSeq = (mdPane.__streamSetupSeq || 0) + 1;
    const reqId = mdPane.__streamSetupSeq;
    mdPane.__streamSetupKey = expectedKey;
    fetchServerStream(match).then((ans)=>{
      if (!ans) return;
      // Матч всё ещё тот же? (могли уйти на другой экран)
      const currentKey = mdPane.getAttribute('data-match-key') || expectedKey;
      if (currentKey !== expectedKey) { if (DBG) console.debug('[streams] setupMatchStream: stale resp by mdKey', { expectedKey, currentKey }); return; }
      if (mdPane.__streamSetupSeq !== reqId || mdPane.__streamSetupKey !== expectedKey) { if (DBG) console.debug('[streams] setupMatchStream: stale resp by reqId'); return; }
      if (DBG) console.debug('[streams] setupMatchStream: server provided link');
      const pane = ensurePane(mdPane, match);
      const tab = ensureTab(subtabs, match);
      pane.__streamInfo = ans;
      // Если пользователь уже на вкладке «Трансляция», инициализируем немедленно
      try {
        const isActive = tab?.classList?.contains('active') || pane?.style?.display === '';
        if (isActive && !pane.__inited) {
          if (DBG) console.debug('[streams] setupMatchStream: active -> build now');
          buildStreamInto(pane, ans, match);
        }
      } catch(_) {}
    }).catch(()=>{});
    return null; // пока не знаем — не показываем вкладку
  }

  function onStreamTabActivated(pane, match){
    if (!pane) return;
    if (DBG) console.debug('[streams] onStreamTabActivated: click', { paneKey: pane.getAttribute('data-match-key'), matchKey: makeKey(match) });
    // Безопасность: проверяем, что pane относится к текущему матчу
    const key = makeKey(match);
    if (pane.getAttribute('data-match-key') !== key) {
      if (DBG) console.debug('[streams] onStreamTabActivated: mismatch -> reset');
      pane.__inited = false;
      pane.__streamInfo = null;
      pane.setAttribute('data-match-key', key);
    }
    if (!pane.__inited) {
      const info = pane.__streamInfo || findStream(match);
      if (info) {
        if (DBG) console.debug('[streams] onStreamTabActivated: build from cached info');
        setTimeout(()=>buildStreamInto(pane, info, match), 50);
      } else {
        // Попробуем ещё раз спросить сервер и построить
        const expectedKey = key;
        // Пер-запрос маркируем токеном, чтобы игнорировать устаревшие ответы
        pane.__streamTabSeq = (pane.__streamTabSeq || 0) + 1;
        const reqId = pane.__streamTabSeq;
        fetchServerStream(match).then((ans)=>{
          // Проверяем, что мы всё ещё на этом матче
          if (!ans) { if (DBG) console.debug('[streams] onStreamTabActivated: no link on server'); const sk=pane.querySelector('.stream-skeleton'); if (sk) sk.textContent='Трансляция недоступна'; return; }
          const mdKey = (mdPaneFrom(pane)?.getAttribute('data-match-key') || expectedKey);
          if (mdKey !== expectedKey) { if (DBG) console.debug('[streams] onStreamTabActivated: stale resp by mdKey', { expectedKey, mdKey }); return; }
          if (pane.__streamTabSeq !== reqId) { if (DBG) console.debug('[streams] onStreamTabActivated: stale resp by reqId'); return; }
          if (DBG) console.debug('[streams] onStreamTabActivated: server returned link -> build');
          pane.__streamInfo = ans; buildStreamInto(pane, ans, match);
        }).catch(()=>{});
      }
    } else {
      // Уже инициализировано — запустим поллинг комментариев, если есть
      try { typeof pane.__startCommentsPoll === 'function' && pane.__startCommentsPoll(); } catch(_) {}
    }
  }

  function mdPaneFrom(pane){
    try { return pane?.closest('#ufo-match-details'); } catch(_) { return null; }
  }

  window.__STREAMS__ = { findStream, registry };
  // Сброс состояния при выходе с экрана матча (переход по нижним вкладкам/кнопка Назад)
  function resetOnLeave(mdPane){
    try {
      const pane = document.getElementById('md-pane-stream');
      if (!pane) return;
  if (DBG) console.debug('[streams] resetOnLeave');
      // Остановить возможный поллинг комментариев
      try { typeof pane.__stopCommentsPoll === 'function' && pane.__stopCommentsPoll(); } catch(_) {}
      // Поставить видео на паузу / полностью сбросить src iframe
      try { const ifr = pane.querySelector('iframe'); if (ifr) { try { ifr.src = ''; } catch(_) { /* noop */ } } } catch(_) {}
  // Инвалидируем любые ожидающие ответы
  try { mdPane.__streamSetupSeq = (mdPane.__streamSetupSeq || 0) + 1; } catch(_) {}
  try { pane.__streamTabSeq = (pane.__streamTabSeq || 0) + 1; } catch(_) {}
      pane.__inited = false;
      pane.__streamInfo = null;
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';

      // Убираем ключ и отсоединяем панель от старого модала, чтобы при следующем открытии
      // ensurePane корректно поместит её в новый mdPane
      try {
        pane.removeAttribute('data-match-key');
        if (pane.parentNode) pane.parentNode.removeChild(pane);
        if (DBG) console.debug('[streams] resetOnLeave: detached pane from old mdPane');
      } catch(_) {}
    } catch(_) {}
  }

  window.Streams = { setupMatchStream, onStreamTabActivated, resetOnLeave };
})();
