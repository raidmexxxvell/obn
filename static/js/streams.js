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

  function isAdmin(){
    try {
      const adminId = document.body.getAttribute('data-admin');
      const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
      return !!(adminId && currentId && String(adminId) === currentId);
    } catch(_) { return false; }
  }

  function buildAdminControls(pane, match, currentInfo){
    if (!isAdmin()) return null;
    const wrap = document.createElement('div');
    wrap.className = 'stream-admin';
    wrap.style.display = 'grid';
    wrap.style.gridTemplateColumns = '1fr auto auto';
    wrap.style.gap = '8px';
    wrap.style.margin = '8px 0 10px';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Вставьте ссылку VK Live или iframe';
    input.style.width = '100%';
    try {
      if (currentInfo) {
        input.value = currentInfo.vkVideoId ? `https://vk.com/video${currentInfo.vkVideoId}` : (currentInfo.vkPostUrl || '');
      }
    } catch(_) {}

    const btnSave = document.createElement('button');
    btnSave.textContent = 'Подтвердить';
    btnSave.className = 'details-btn';

    const btnReset = document.createElement('button');
    btnReset.textContent = 'Сбросить';
    btnReset.className = 'details-btn';
    btnReset.style.background = 'rgba(255,80,80,0.15)';
    btnReset.style.borderColor = 'rgba(255,80,80,0.35)';

    const note = document.createElement('div');
    note.className = 'stream-admin-note';
    note.style.gridColumn = '1 / -1';
    note.style.fontSize = '12px';
    note.style.color = 'var(--gray)';

    const getDateIso = () => (match?.datetime || match?.date || '').toString().slice(0,10);

    btnSave.addEventListener('click', async () => {
      try {
        const val = (input.value || '').trim();
        if (!val) { note.textContent = 'Введите ссылку'; note.style.color = '#ff9090'; return; }
        btnSave.disabled = true; const o = btnSave.textContent; btnSave.textContent = '...';
        const fd = new FormData();
        fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
        fd.append('home', match.home || '');
        fd.append('away', match.away || '');
        // backend принимает datetime; используем полную строку если есть
        const dtRaw = (match?.datetime || (getDateIso() ? (getDateIso() + 'T00:00:00') : ''));
        fd.append('datetime', dtRaw);
        fd.append('vk', val);
        const r = await fetch('/api/streams/set', { method: 'POST', body: fd });
        const d = await r.json().catch(()=>({}));
        if (!r.ok) throw new Error(d?.error || 'Не удалось сохранить');
        note.textContent = 'Ссылка сохранена'; note.style.color = '#9ee7a4';
        // Обновляем информацию и перестраиваем iframe
        const info = { vkVideoId: d.vkVideoId || '', vkPostUrl: d.vkPostUrl || '', autoplay: 0 };
        pane.__streamInfo = info; pane.__inited = false;
        buildStreamInto(pane, info, match);
      } catch (e) {
        note.textContent = e?.message || 'Ошибка сохранения'; note.style.color = '#ff9090';
      } finally {
        btnSave.disabled = false; btnSave.textContent = 'Подтвердить';
      }
    });

    btnReset.addEventListener('click', async () => {
      try {
        const ok = confirm('Сбросить ссылку трансляции для этого матча?');
        if (!ok) return;
        btnReset.disabled = true; const o = btnReset.textContent; btnReset.textContent = '...';
        const fd = new FormData();
        fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
        fd.append('home', match.home || '');
        fd.append('away', match.away || '');
        fd.append('date', getDateIso());
        const r = await fetch('/api/streams/reset', { method: 'POST', body: fd });
        const d = await r.json().catch(()=>({}));
        if (!r.ok) throw new Error(d?.error || 'Ошибка сброса');
        note.textContent = 'Ссылка сброшена'; note.style.color = '#9ee7a4';
        // Сбрасываем плеер
        pane.__streamInfo = null; pane.__inited = false;
        pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция недоступна</div></div>';
      } catch (e) {
        note.textContent = e?.message || 'Ошибка'; note.style.color = '#ff9090';
      } finally {
        btnReset.disabled = false; btnReset.textContent = 'Сбросить';
      }
    });

    wrap.append(input, btnSave, btnReset, note);
    return wrap;
  }

  function ensurePane(mdPane, match){
    let pane = document.getElementById('md-pane-stream');
    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'md-pane-stream';
      pane.className = 'md-pane';
      pane.style.display = 'none';
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
      // Вставляем в контейнер модалки рядом с другими pane, чтобы не выпадало ниже составов
      const body = mdPane.querySelector('.modal-body');
      if (body) body.appendChild(pane);
    }
    // Обнуляем инициализацию при смене матча
    const key = makeKey(match);
    if (pane.getAttribute('data-match-key') !== key) {
      pane.__inited = false;
      pane.__streamInfo = null;
      pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
      pane.setAttribute('data-match-key', key);
    }
    return pane;
  }

  function ensureTab(subtabs, match){
    let tab = subtabs?.querySelector('[data-mdtab="stream"]');
    if (!tab) {
      tab = document.createElement('div'); tab.className='subtab-item'; tab.setAttribute('data-mdtab','stream'); tab.textContent='Трансляция';
      subtabs.appendChild(tab);
    }
    if (match) tab.setAttribute('data-match-key', makeKey(match));
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
  pane.innerHTML='';
  const admin = buildAdminControls(pane, match, info);
  if (admin) pane.appendChild(admin);
  pane.appendChild(host);
    pane.__inited = true;
    try { typeof window.initStreamComments === 'function' && window.initStreamComments(pane, match); } catch(_) {}
    return true;
  }

  async function fetchServerStream(match){
    try{
      const dateStr = (match?.datetime || match?.date || '').toString().slice(0,10);
  const url = `/api/streams/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}&date=${encodeURIComponent(dateStr)}`;
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
      const pane = ensurePane(mdPane, match);
      ensureTab(subtabs, match);
      pane.__streamInfo = streamInfo;
      return pane;
    }
    // Асинхронно проверим у сервера и, если есть, добавим вкладку
    const expectedKey = makeKey(match);
    fetchServerStream(match).then((ans)=>{
      if (!ans) return;
      // Матч всё ещё тот же? (могли уйти на другой экран)
      const currentKey = mdPane.getAttribute('data-match-key') || expectedKey;
      if (currentKey !== expectedKey) return;
      const pane = ensurePane(mdPane, match);
      const tab = ensureTab(subtabs, match);
      pane.__streamInfo = ans;
      // Если пользователь уже на вкладке «Трансляция», инициализируем немедленно
      try {
        const isActive = tab?.classList?.contains('active') || pane?.style?.display === '';
        if (isActive && !pane.__inited) {
          buildStreamInto(pane, ans, match);
        }
      } catch(_) {}
    }).catch(()=>{});
    return null; // пока не знаем — не показываем вкладку
  }

  function onStreamTabActivated(pane, match){
    if (!pane) return;
    // Безопасность: проверяем, что pane относится к текущему матчу
    const key = makeKey(match);
    if (pane.getAttribute('data-match-key') !== key) {
      pane.__inited = false;
      pane.__streamInfo = null;
      pane.setAttribute('data-match-key', key);
    }
    if (!pane.__inited) {
      const info = pane.__streamInfo || findStream(match);
      if (info) {
        setTimeout(()=>buildStreamInto(pane, info, match), 50);
      } else {
        // Попробуем ещё раз спросить сервер и построить
        const expectedKey = key;
        fetchServerStream(match).then((ans)=>{
          // Проверяем, что мы всё ещё на этом матче
          if (!ans) { const sk=pane.querySelector('.stream-skeleton'); if (sk) sk.textContent='Трансляция недоступна'; return; }
          if ((mdPaneFrom(pane)?.getAttribute('data-match-key') || expectedKey) !== expectedKey) return;
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
  window.Streams = { setupMatchStream, onStreamTabActivated };
})();
