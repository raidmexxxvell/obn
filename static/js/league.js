// static/js/league.js
// League module: batched DOM rendering for league tables, schedule, results.
// Exposes window.League with helpers used by profile.js

(function(){
  const raf = (cb) => (window.requestAnimationFrame || window.setTimeout)(cb, 0);
  const rIC = window.requestIdleCallback || function (cb) { return setTimeout(() => cb({ timeRemaining: () => 0 }), 0); };

  function batchAppend(parent, nodes, batchSize = 20) {
    let i = 0;
    function step() {
      if (i >= nodes.length) return;
      const frag = document.createDocumentFragment();
      for (let k = 0; k < batchSize && i < nodes.length; k++, i++) frag.appendChild(nodes[i]);
      parent.appendChild(frag);
      raf(step);
    }
    step();
  }

  function setUpdatedLabelSafely(labelEl, newIso) {
    try {
      const prevIso = labelEl.getAttribute('data-updated-iso');
      const prevTs = prevIso ? Date.parse(prevIso) : 0;
      const nextTs = Date.parse(newIso);
      if (!Number.isFinite(nextTs)) return;
      if (nextTs >= prevTs) {
        labelEl.setAttribute('data-updated-iso', newIso);
        const d = new Date(newIso);
        labelEl.textContent = `Обновлено: ${d.toLocaleString()}`;
      }
    } catch(_) {}
  }

  function renderLeagueTable(tableEl, updatedTextEl, data) {
    if (!tableEl) return;
    const tbody = tableEl.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const rows = data?.values || [];
    const nodes = [];
    for (let i = 0; i < 10; i++) {
      const r = rows[i] || [];
      const tr = document.createElement('tr');
      for (let j = 0; j < 8; j++) {
        const td = document.createElement('td');
        td.textContent = (r[j] ?? '').toString();
        tr.appendChild(td);
      }
      nodes.push(tr);
    }
    batchAppend(tbody, nodes, 10);
    raf(() => {
      try {
        const trs = tbody.querySelectorAll('tr');
        trs.forEach((rowEl, idx) => {
          if (idx === 1) rowEl.classList.add('rank-1');
          if (idx === 2) rowEl.classList.add('rank-2');
          if (idx === 3) rowEl.classList.add('rank-3');
        });
      } catch(_) {}
      if (updatedTextEl && data?.updated_at) setUpdatedLabelSafely(updatedTextEl, data.updated_at);
    });
  }

  function renderStatsTable(tableEl, updatedEl, data) {
    if (!tableEl) return;
    const tbody = tableEl.querySelector('tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const rows = data?.values || [];
    const nodes = [];
    for (let i = 0; i < 11; i++) {
      const r = rows[i] || [];
      const tr = document.createElement('tr');
      for (let j = 0; j < 7; j++) {
        const td = document.createElement('td');
        td.textContent = (r[j] ?? '').toString();
        tr.appendChild(td);
      }
      nodes.push(tr);
    }
    batchAppend(tbody, nodes, 10);
    raf(() => {
      try {
        const trs = tbody.querySelectorAll('tr');
        trs.forEach((rowEl, idx) => {
          if (idx === 1) rowEl.classList.add('rank-1');
          if (idx === 2) rowEl.classList.add('rank-2');
          if (idx === 3) rowEl.classList.add('rank-3');
        });
      } catch(_) {}
      try { if (updatedEl && data?.updated_at) updatedEl.textContent = `Обновлено: ${new Date(data.updated_at).toLocaleString()}`; } catch(_) {}
    });
  }

  function loadTeamLogo(imgEl, teamName) {
    const base = '/static/img/team-logos/';
    const name = (teamName || '').trim();
    const candidates = [];
    if (name) {
      const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
      candidates.push(base + encodeURIComponent(norm + '.png') + `?v=${Date.now()}`);
    }
    candidates.push(base + 'default.png' + `?v=${Date.now()}`);
    let idx = 0;
    const tryNext = () => { if (idx >= candidates.length) return; imgEl.onerror = () => { idx++; tryNext(); }; imgEl.src = candidates[idx]; };
    tryNext();
  }

  function renderSchedule(pane, data) {
    if (!pane) return;
    const ds = data?.tours ? data : (data?.data || {});
    const tours = ds?.tours || [];
    if (!tours.length) { pane.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>'; return; }
    pane.innerHTML = '';
    const nodes = [];

    // helper from profile.js
    const withTeamCount = window.withTeamCount || ((n)=>n);

    // Виртуализация: создаём блоки туров с ленивой отрисовкой матчей
    const MAX_RENDERED_TOURS = 4; // держим в DOM не больше 4 туров одновременно
    const INITIAL_RENDER = Math.min(2, tours.length);

    function createMatchCard(m) {
      const card = document.createElement('div');
      card.className = 'match-card';
      const header = document.createElement('div'); header.className = 'match-header';
      const dateStr = (() => { try { if (m.date) { const d = new Date(m.date); return d.toLocaleDateString(); } } catch(_) {} return ''; })();
      const timeStr = m.time || '';
      let isLive = false;
      try {
        if (m.datetime) { const dt = new Date(m.datetime); const dtEnd = new Date(dt.getTime() + 2*60*60*1000); const now = new Date(); isLive = now >= dt && now < dtEnd; }
        else if (m.date && m.time) { const dt = new Date(m.date + 'T' + (m.time.length===5? m.time+':00': m.time)); const dtEnd = new Date(dt.getTime() + 2*60*60*1000); const now = new Date(); isLive = now >= dt && now < dtEnd; }
      } catch(_) {}
      const headerText = document.createElement('span'); headerText.textContent = `${dateStr}${timeStr ? ' ' + timeStr : ''}`; header.appendChild(headerText);
      if (isLive) { const live = document.createElement('span'); live.className='live-badge'; const dot=document.createElement('span'); dot.className='live-dot'; const lbl=document.createElement('span'); lbl.textContent='В ЭФИРЕ'; live.append(dot,lbl); header.appendChild(live); }
      card.appendChild(header);

      const center = document.createElement('div'); center.className='match-center';
      const home = document.createElement('div'); home.className='team home';
      const hImg = document.createElement('img'); hImg.className='logo'; hImg.alt = m.home || ''; loadTeamLogo(hImg, m.home || '');
      const hName = document.createElement('div'); hName.className='team-name'; hName.setAttribute('data-team-name', m.home || ''); hName.textContent = withTeamCount(m.home || '');
      home.append(hImg, hName);
      const score = document.createElement('div'); score.className = 'score'; score.textContent = 'VS';
      const away = document.createElement('div'); away.className='team away';
      const aImg = document.createElement('img'); aImg.className='logo'; aImg.alt = m.away || ''; loadTeamLogo(aImg, m.away || '');
      const aName = document.createElement('div'); aName.className='team-name'; aName.setAttribute('data-team-name', m.away || ''); aName.textContent = withTeamCount(m.away || '');
      away.append(aImg, aName);
      center.append(home, score, away);
      card.appendChild(center);

      // Голосование (П1/X/П2) — показываем только если матч входит в ставочные туры
      try {
        const toursCache = (() => { try { return JSON.parse(localStorage.getItem('betting:tours') || 'null'); } catch(_) { return null; } })();
        const mkKey = (obj) => { try { const h=(obj?.home||'').toLowerCase().trim(); const a=(obj?.away||'').toLowerCase().trim(); const raw=obj?.date?String(obj.date):(obj?.datetime?String(obj.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; } catch(_) { return `${(obj?.home||'').toLowerCase()}__${(obj?.away||'').toLowerCase()}__`; } };
        const tourMatches = new Set();
        try { const tours=toursCache?.data?.tours || toursCache?.tours || []; tours.forEach(t => (t.matches||[]).forEach(x => tourMatches.add(mkKey(x)))); } catch(_) {}
        if (tourMatches.has(mkKey(m))) {
          const wrap = document.createElement('div'); wrap.className = 'vote-inline';
          const title = document.createElement('div'); title.className = 'vote-title'; title.textContent = 'Голосование';
          const bar = document.createElement('div'); bar.className = 'vote-strip';
          const segH = document.createElement('div'); segH.className = 'seg seg-h';
          const segD = document.createElement('div'); segD.className = 'seg seg-d';
          const segA = document.createElement('div'); segA.className = 'seg seg-a';
          bar.append(segH, segD, segA);
          const legend = document.createElement('div'); legend.className = 'vote-legend'; legend.innerHTML = '<span>П1</span><span>X</span><span>П2</span>';
          const btns = document.createElement('div'); btns.className = 'vote-inline-btns';
          const mkBtn = (code, text) => {
            const b = document.createElement('button'); b.className = 'details-btn'; b.textContent = text;
            b.addEventListener('click', async () => {
              try {
                const fd = new FormData();
                fd.append('initData', window.Telegram?.WebApp?.initData || '');
                fd.append('home', m.home || '');
                fd.append('away', m.away || '');
                const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
                fd.append('date', dkey);
                fd.append('choice', code);
                const r = await fetch('/api/vote/match', { method: 'POST', body: fd });
                if (!r.ok) throw 0;
                btns.querySelectorAll('button').forEach(x => x.disabled = true);
                await loadAgg(true);
              } catch (_) {}
            });
            return b;
          };
          btns.append(mkBtn('home','За П1'), mkBtn('draw','За X'), mkBtn('away','За П2'));
          wrap.append(title, bar, legend, btns);
          card.appendChild(wrap);

          async function loadAgg(withInit){
            try {
              const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
              const params = new URLSearchParams({ home: m.home||'', away: m.away||'', date: dkey });
              if (withInit) params.append('initData', (window.Telegram?.WebApp?.initData || ''));
              const agg = await fetch(`/api/vote/match-aggregates?${params.toString()}`).then(r=>r.json());
              const h = Number(agg?.home||0), d = Number(agg?.draw||0), a = Number(agg?.away||0);
              const sum = Math.max(1, h+d+a);
              const ph = Math.round(h*100/sum), pd = Math.round(d*100/sum), pa = Math.round(a*100/sum);
              segH.style.width = ph+'%'; segD.style.width = pd+'%'; segA.style.width = pa+'%';
              if (agg && agg.my_choice) { btns.querySelectorAll('button').forEach(x=>x.disabled=true); }
            } catch(_){ segH.style.width='33%'; segD.style.width='34%'; segA.style.width='33%'; }
          }
          loadAgg(true);
        }
      } catch(_) {}

      // Кнопка «Детали» и админ-«⭐ На главную» из прежней логики
      const footer = document.createElement('div'); footer.className='match-footer';
      try {
        const adminId = document.body.getAttribute('data-admin');
        const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
        if (adminId && currentId && adminId === currentId) {
          const star = document.createElement('button');
          star.className = 'details-btn'; star.textContent = '⭐ На главную'; star.style.marginRight='8px';
          star.addEventListener('click', async () => {
            try {
              star.disabled = true; const orig = star.textContent; star.textContent = '...';
              const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
              fd.append('home', m.home || ''); fd.append('away', m.away || '');
              if (m.date) fd.append('date', String(m.date).slice(0,10)); if (m.datetime) fd.append('datetime', String(m.datetime));
              const r = await fetch('/api/feature-match/set', { method: 'POST', body: fd }); const j = await r.json().catch(()=>({}));
              if (!r.ok) throw new Error(j?.error || 'Ошибка'); star.textContent = 'Назначено';
              try { window.renderTopMatchOfWeek?.(); } catch(_) {}
              try { document.dispatchEvent(new CustomEvent('feature-match:set', { detail: { match: m } })); } catch(_) {}
            } catch(_) { try { window.Telegram?.WebApp?.showAlert?.('Не удалось назначить матч недели'); } catch(_) {} }
          });
          footer.appendChild(star);
        }
      } catch(_) {}

      const btnDetails = document.createElement('button'); btnDetails.className='details-btn'; btnDetails.textContent='Детали'; btnDetails.setAttribute('data-throttle','800');
      btnDetails.addEventListener('click', () => {
        const original = btnDetails.textContent; btnDetails.disabled = true; btnDetails.textContent = 'Загрузка контента...';
        const params = new URLSearchParams({ home: m.home || '', away: m.away || '' });
        const cacheKey = `md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`;
        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
        const fetchWithETag = (etag) => fetch(`/api/match-details?${params.toString()}`, { headers: etag ? { 'If-None-Match': etag } : {} })
          .then(async r => { if (r.status === 304 && cached) return cached; const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; const toStore = { data, version, ts: Date.now() }; try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_) {} return toStore; });
        const go = (store) => { try { window.openMatchScreen?.({ home: m.home, away: m.away, date: m.date, time: m.time }, store?.data || store); } catch(_) {} btnDetails.disabled=false; btnDetails.textContent=original; };
        const FRESH_TTL = 10 * 60 * 1000;
        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
        else if (cached && cached.version) { fetchWithETag(cached.version).then(go).catch(() => { go(cached); }); }
        else if (cached) { go(cached); }
        else { fetchWithETag(null).then(go).catch(()=>{ btnDetails.disabled=false; btnDetails.textContent=original; }); }
      });
      footer.appendChild(btnDetails);
      card.appendChild(footer);
      return card;
    }

    function renderMatchesInto(container, matches) {
      const nodes = matches.map(createMatchCard);
      batchAppend(container, nodes, 12);
    }

    const holders = tours.map((t, i) => {
      const tourEl = document.createElement('div'); tourEl.className='tour-block';
      const title = document.createElement('div'); title.className='tour-title'; title.textContent = t.title || `Тур ${t.tour || ''}`;
      const body = document.createElement('div'); body.className='tour-body';
      tourEl.append(title, body);
      tourEl.__matches = (t.matches||[]).slice();
      tourEl.__rendered = false;
      return tourEl;
    });

    // Начальный рендер первых N туров
    holders.slice(0, INITIAL_RENDER).forEach(h => { renderMatchesInto(h.querySelector('.tour-body'), h.__matches); h.__rendered = true; });
    batchAppend(pane, holders, 1);

    // Ленивая отрисовка дальнейших туров
    if ('IntersectionObserver' in window) {
      const visible = new Set(holders.slice(0, INITIAL_RENDER));
      const io = new IntersectionObserver((entries) => {
        entries.forEach(ent => {
          const el = ent.target;
          if (ent.isIntersecting && !el.__rendered) {
            renderMatchesInto(el.querySelector('.tour-body'), el.__matches);
            el.__rendered = true; visible.add(el);
            // Контроль количества отрисованных туров
            if (visible.size > MAX_RENDERED_TOURS) {
              // Удалим самый дальний от текущего viewport
              const arr = Array.from(visible);
              // Сортируем по расстоянию от viewport top
              arr.sort((a,b)=> {
                const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
                return Math.abs(ra.top) - Math.abs(rb.top);
              });
              // Удалим «самый дальний» в конце массива
              const toRemove = arr[arr.length-1];
              if (toRemove && toRemove !== el) {
                const body = toRemove.querySelector('.tour-body'); if (body) body.innerHTML='';
                toRemove.__rendered = false; visible.delete(toRemove);
              }
            }
          }
        });
      }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
      holders.forEach(h => io.observe(h));
    } else {
      // Фолбэк: уже отрисовали первые INITIAL_RENDER, остальные дорисуем партиями по скроллу
      let next = INITIAL_RENDER;
      const onScroll = () => {
        if (next >= holders.length) { window.removeEventListener('scroll', onScroll); return; }
        const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600;
        if (nearBottom) {
          const end = Math.min(holders.length, next + 1);
          for (let i=next; i<end; i++) { const h = holders[i]; renderMatchesInto(h.querySelector('.tour-body'), h.__matches); h.__rendered = true; }
          next = end;
        }
      };
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    pane.dataset.hasContent = '1';
  }

  function renderResults(pane, data) {
    if (!pane) return;
    const withTeamCount = window.withTeamCount || ((n)=>n);
    const all = data?.results || data?.data?.results || [];
    if (!all.length) { pane.innerHTML = '<div class="schedule-empty">Нет прошедших матчей</div>'; return; }
    pane.innerHTML = '';
    const byTour = new Map();
    all.forEach(m => { const t = m.tour || 0; if (!byTour.has(t)) byTour.set(t, []); byTour.get(t).push(m); });
    const tourList = Array.from(byTour.keys()).sort((a,b)=>b-a);
    const container = document.createElement('div'); container.className='results-container';
    const pager = document.createElement('div'); pager.className='results-pager';
    const prev = document.createElement('button'); prev.className='pager-btn'; prev.textContent='←';
    const title = document.createElement('div'); title.className='pager-title';
    const next = document.createElement('button'); next.className='pager-btn'; next.textContent='→';
    pager.append(prev, title, next);
    const listWrap = document.createElement('div'); listWrap.className='results-list';
    container.append(pager, listWrap);
    pane.appendChild(container);

    let idx = 0;
    const renderPage = () => {
      const tour = tourList[idx];
      title.textContent = `${tour} Тур`;
      listWrap.innerHTML = '';
      const matches = (byTour.get(tour) || []).slice();
      matches.sort((m1,m2)=>{ const d1 = m1.datetime || m1.date || ''; const d2 = m2.datetime || m2.date || ''; return (d2 > d1) ? 1 : (d2 < d1 ? -1 : 0); });
      const nodes = [];
      matches.forEach(m => {
        const card = document.createElement('div'); card.className='match-card result';
        const header = document.createElement('div'); header.className='match-header';
        const dateStr = (() => { try { if (m.date) { const d = new Date(m.date); return d.toLocaleDateString(); } } catch(_) {} return ''; })();
        header.textContent = `${dateStr}${m.time ? ' ' + m.time : ''}`; card.appendChild(header);
        const center = document.createElement('div'); center.className='match-center';
        const home = document.createElement('div'); home.className='team home';
        const hImg = document.createElement('img'); hImg.className='logo'; hImg.alt = m.home || ''; loadTeamLogo(hImg, m.home || '');
        const hName = document.createElement('div'); hName.className='team-name'; hName.setAttribute('data-team-name', m.home || ''); hName.textContent = withTeamCount(m.home || '');
        home.append(hImg, hName);
        const score = document.createElement('div'); score.className='score';
        const sH = (m.score_home || '').toString().trim(); const sA = (m.score_away || '').toString().trim();
        score.textContent = (sH && sA) ? `${sH} : ${sA}` : '— : —';
        const away = document.createElement('div'); away.className='team away';
        const aImg = document.createElement('img'); aImg.className='logo'; aImg.alt = m.away || ''; loadTeamLogo(aImg, m.away || '');
        const aName = document.createElement('div'); aName.className='team-name'; aName.setAttribute('data-team-name', m.away || ''); aName.textContent = withTeamCount(m.away || '');
        away.append(aImg, aName);
        center.append(home, score, away); card.appendChild(center);
        nodes.push(card);
      });
      batchAppend(listWrap, nodes, 12);
      prev.disabled = idx <= 0; next.disabled = idx >= tourList.length - 1;
    };
  prev.onclick = () => { if (idx > 0) { idx--; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
    next.onclick = () => { if (idx < tourList.length - 1) { idx++; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
    renderPage();
    pane.dataset.hasContent = '1';
  }

  window.League = { batchAppend, renderLeagueTable, renderStatsTable, renderSchedule, renderResults, setUpdatedLabelSafely };
})();
