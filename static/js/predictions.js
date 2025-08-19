// static/js/predictions.js
(function(){
  document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp || null;
    const wrap = document.getElementById('tab-predictions');
    if (!wrap) return;

    const toursEl = document.getElementById('pred-tours');
    const myBetsEl = document.getElementById('my-bets');

    // Подвкладки раздела
    const pTabs = document.querySelectorAll('#pred-subtabs .subtab-item');
    const pMap = {
      place: document.getElementById('pred-pane-place'),
      mybets: document.getElementById('pred-pane-mybets')
    };
    pTabs.forEach(btn => {
      btn.setAttribute('data-throttle','600');
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-ptab');
        pTabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        Object.values(pMap).forEach(el => { if(el) el.style.display='none'; });
        if (pMap[key]) {
          pMap[key].style.display = '';
          if (key === 'place') loadTours();
          if (key === 'mybets') loadMyBets();
        }
      });
    });

  let _toursLoading = false;
  function loadTours() {
      if (!toursEl || _toursLoading) return;
      _toursLoading = true;
      const CACHE_KEY = 'betting:tours';
      const FRESH_TTL = 5 * 60 * 1000; // 5 минут
      const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
      const writeCache = (obj) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch(_) {} };

      const renderTours = (data) => {
        const ds = data?.tours ? data : (data?.data || {});
        const tours = ds.tours || [];
        if (!tours.length) {
          // если у нас уже есть контент — не затираем его пустым ответом
          if (toursEl.childElementCount > 0 || toursEl.dataset.hasContent === '1') { return; }
          toursEl.innerHTML = '<div class="schedule-empty">Матчи скоро появяться</div>';
          return;
        }
        const container = document.createElement('div');
        container.className = 'pred-tours-container';
        let visibleMatchesTotal = 0;
        tours.forEach(t => {
          const tourEl = document.createElement('div'); tourEl.className = 'tour-block';
          const title = document.createElement('div'); title.className = 'tour-title'; title.textContent = t.title || `Тур ${t.tour||''}`; tourEl.appendChild(title);
          const tourMatches = (t.matches||[]).filter(m => !m.lock);
          tourMatches.forEach(m => {
            const card = document.createElement('div'); card.className = 'match-card';
            try { card.dataset.home = m.home || ''; card.dataset.away = m.away || ''; } catch(_) {}
            const header = document.createElement('div'); header.className = 'match-header';
            const dtText = formatDateTime(m.date, m.time);
            const span = document.createElement('span'); span.textContent = dtText; header.appendChild(span);
            // LIVE badge
            if (isLiveNow(m)) {
              const live = document.createElement('span'); live.className = 'live-badge';
              const dot = document.createElement('span'); dot.className = 'live-dot';
              const lbl = document.createElement('span'); lbl.textContent = 'Матч идет';
              live.append(dot, lbl); header.appendChild(live);
            }
            card.appendChild(header);
            const center = document.createElement('div'); center.className = 'match-center';
            const home = mkTeam(m.home); const score = document.createElement('div'); score.className='score'; score.textContent = 'VS'; const away = mkTeam(m.away);
            center.append(home, score, away); card.appendChild(center);
            const line = document.createElement('div'); line.className = 'betting-line';
            const opts = mkOptions(t.tour, m, !!m.lock);
            line.appendChild(opts);
            card.appendChild(line);

            // Кнопка «Больше прогнозов» и скрытая панель с доп.рынками (тоталы)
            const moreWrap = document.createElement('div'); moreWrap.style.marginTop = '8px'; moreWrap.style.textAlign = 'center';
            const moreBtn = document.createElement('button'); moreBtn.className = 'details-btn'; moreBtn.textContent = 'Больше прогнозов'; moreBtn.setAttribute('data-throttle','800');
            const extra = document.createElement('div'); extra.className = 'extra-markets hidden'; extra.style.marginTop = '8px';
            moreBtn.addEventListener('click', () => { extra.classList.toggle('hidden'); });
            moreWrap.appendChild(moreBtn);

            // Тоталы: 3.5/4.5/5.5 Over/Under
            const totals = (m.markets && m.markets.totals) || [];
            if (totals.length) {
              const table = document.createElement('div'); table.className = 'totals-table';
              totals.forEach(row => {
                const rowEl = document.createElement('div'); rowEl.className = 'totals-row';
                const lbl = document.createElement('div'); lbl.className = 'totals-line'; lbl.textContent = `Тотал ${row.line.toFixed(1)}`;
                const btnOver = document.createElement('button'); btnOver.className='bet-btn'; btnOver.textContent = `Больше (${Number(row.odds.over).toFixed(2)})`;
                const btnUnder = document.createElement('button'); btnUnder.className='bet-btn'; btnUnder.textContent = `Меньше (${Number(row.odds.under).toFixed(2)})`;
                btnOver.disabled = !!m.lock; btnUnder.disabled = !!m.lock;
                btnOver.setAttribute('data-throttle','1200');
                btnUnder.setAttribute('data-throttle','1200');
                btnOver.addEventListener('click', ()=> {
                  if (btnOver.disabled) return;
                  btnOver.disabled = true;
                  Promise.resolve(openStakeModal(t.tour, m, 'over', 'totals', row.line)).finally(()=>{ btnOver.disabled = false; });
                });
                btnUnder.addEventListener('click', ()=> {
                  if (btnUnder.disabled) return;
                  btnUnder.disabled = true;
                  Promise.resolve(openStakeModal(t.tour, m, 'under', 'totals', row.line)).finally(()=>{ btnUnder.disabled = false; });
                });
                rowEl.append(lbl, btnOver, btnUnder);
                table.appendChild(rowEl);
              });
              extra.appendChild(table);
            }

            // Спецрынки: пенальти/красная (Да/Нет)
            const specials = (m.markets && m.markets.specials) || {};
            const mkYN = (title, odds, marketKey) => {
              if (!odds) return null;
              const rowEl = document.createElement('div'); rowEl.className = 'totals-row';
              const lbl = document.createElement('div'); lbl.className = 'totals-line'; lbl.textContent = title;
              const yesBtn = document.createElement('button'); yesBtn.className='bet-btn'; yesBtn.textContent = `Да (${Number(odds.yes).toFixed(2)})`;
              const noBtn = document.createElement('button'); noBtn.className='bet-btn'; noBtn.textContent = `Нет (${Number(odds.no).toFixed(2)})`;
              yesBtn.disabled = !!m.lock; noBtn.disabled = !!m.lock;
              yesBtn.setAttribute('data-throttle','1200');
              noBtn.setAttribute('data-throttle','1200');
              yesBtn.addEventListener('click', ()=> {
                if (yesBtn.disabled) return;
                yesBtn.disabled = true;
                Promise.resolve(openStakeModal(t.tour, m, 'yes', marketKey)).finally(()=>{ yesBtn.disabled = false; });
              });
              noBtn.addEventListener('click', ()=> {
                if (noBtn.disabled) return;
                noBtn.disabled = true;
                Promise.resolve(openStakeModal(t.tour, m, 'no', marketKey)).finally(()=>{ noBtn.disabled = false; });
              });
              rowEl.append(lbl, yesBtn, noBtn);
              return rowEl;
            };
            if (specials.penalty?.available) {
              const block = document.createElement('div'); block.className = 'totals-table';
              const row = mkYN('Пенальти', specials.penalty.odds, 'penalty');
              if (row) block.appendChild(row);
              extra.appendChild(block);
            }
            if (specials.redcard?.available) {
              const block = document.createElement('div'); block.className = 'totals-table';
              const row = mkYN('Красная карточка', specials.redcard.odds, 'redcard');
              if (row) block.appendChild(row);
              extra.appendChild(block);
            }

            card.appendChild(moreWrap);
            card.appendChild(extra);
            tourEl.appendChild(card);
            visibleMatchesTotal++;
          });
          if (tourMatches.length > 0) {
            container.appendChild(tourEl);
          }
        });
        toursEl.innerHTML = '';
        if (visibleMatchesTotal === 0) {
          toursEl.innerHTML = '<div class="schedule-empty">Матчи скоро появяться</div>';
        } else {
          toursEl.appendChild(container);
          toursEl.dataset.hasContent = '1';
        }
      };

      const cached = readCache();
      if (cached) {
        renderTours(cached);
      } else {
        toursEl.innerHTML = '<div class="schedule-loading">Загрузка матчей...</div>';
      }

      // Валидация/обновление по сети с ETag
      const fetchWithETag = (etag) => fetch('/api/betting/tours', { headers: etag ? { 'If-None-Match': etag } : {} })
        .then(async r => {
          if (r.status === 304 && cached) return cached;
          const data = await r.json();
          const version = data.version || r.headers.get('ETag') || null;
          const store = { data, version, ts: Date.now() };
          // не перезатираем кэш пустыми турами, если ранее были валидные
          const incoming = Array.isArray(data?.tours) ? data.tours : Array.isArray(data?.data?.tours) ? data.data.tours : [];
          const cachedTours = Array.isArray(cached?.data?.tours) ? cached.data.tours : [];
          const shouldWrite = incoming.length > 0 || !cached || cachedTours.length === 0;
          if (shouldWrite) writeCache(store);
          return store;
        });
  if (cached && cached.version) {
        fetchWithETag(cached.version).then(renderTours).catch(()=>{}).finally(()=>{ _toursLoading = false; });
      } else {
        fetchWithETag(null).then(renderTours).catch(err => {
          console.error('betting tours load error', err);
          if (!cached) toursEl.innerHTML = '<div class="schedule-error">Не удалось загрузить</div>';
        }).finally(()=>{ _toursLoading = false; });
      }
      if (cached && !(_toursLoading)) { /* уже отрисовали кэш; загрузка в фоне */ }
  }

  // Экспортируем для вызова извне при входе во вкладку
  try { window.loadBetTours = () => { try { loadTours(); } catch(_) {} }; } catch(_) {}

    function mkTeam(name) {
      const d = document.createElement('div'); d.className = 'team';
      const img = document.createElement('img'); img.className = 'logo'; img.alt = name || '';
      setTeamLogo(img, name||'');
      const nm = document.createElement('div'); nm.className = 'team-name';
      try {
        const withTeamCount = window.withTeamCount || (window.profileWithTeamCount /* fallback stub */);
        nm.textContent = withTeamCount ? withTeamCount(name||'') : (name||'');
      } catch(_) { nm.textContent = name || ''; }
      d.append(img, nm); return d;
    }

    function setTeamLogo(imgEl, teamName) {
      const base = '/static/img/team-logos/';
      const name = (teamName || '').trim();
      const candidates = [];
      try { imgEl.loading = 'lazy'; imgEl.decoding = 'async'; } catch(_) {}
      if (name) {
        const norm = name.toLowerCase().replace(/\s+/g,'').replace(/ё/g,'е');
        candidates.push(base + encodeURIComponent(norm + '.png'));
        // candidates.push(base + encodeURIComponent(name + '.png'));
      }
      candidates.push(base + 'default.png');
      let i = 0; const next = () => { if (i>=candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
      next();
    }

    function mkOptions(tour, m, locked) {
      const box = document.createElement('div'); box.className = 'options-box';
      const odds = m.odds || {};
  const mkBtn = (key, label) => {
        const b = document.createElement('button'); b.className='bet-btn';
        const k = odds[key] != null ? ` (${Number(odds[key]).toFixed(2)})` : '';
        b.textContent = label + k; b.disabled = !!locked;
        b.addEventListener('click', ()=> {
          if (b.disabled) return;
          b.disabled = true;
          Promise.resolve(openStakeModal(tour, m, key)).finally(()=>{ b.disabled = false; });
        });
        return b;
      };
      box.append(mkBtn('home','П1'), mkBtn('draw','Х'), mkBtn('away','П2'));
      return box;
    }

    function openStakeModal(tour, m, selection, market='1x2', line=null) {
      const stake = prompt(`Ставка на ${m.home} vs ${m.away}. Исход: ${selection.toUpperCase()}. Введите сумму:`,'100');
      if (!stake) return Promise.resolve();
      const amt = parseInt(String(stake).replace(/[^0-9]/g,''), 10) || 0;
      if (amt <= 0) return Promise.resolve();
      if (!tg || !tg.initDataUnsafe?.user) { try { alert('Нужен Telegram WebApp'); } catch(_) {} return Promise.resolve(); }
      const fd = new FormData();
      fd.append('initData', tg.initData || '');
      if (tour != null) fd.append('tour', String(tour));
      fd.append('home', m.home || '');
      fd.append('away', m.away || '');
      fd.append('selection', selection);
      if (market) fd.append('market', market);
      if (market === 'totals' && line != null) fd.append('line', String(line));
      fd.append('stake', String(amt));
      return fetch('/api/betting/place', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(resp => {
          if (resp?.error) { try { tg?.showAlert?.(resp.error); } catch(_) { alert(resp.error); } return; }
          try { tg?.showAlert?.(`Ставка принята! Баланс: ${resp.balance}`); } catch(_) {}
          // Обновим профильные кредиты на экране
          const creditsEl = document.getElementById('credits');
          if (creditsEl) creditsEl.textContent = (resp.balance||0).toLocaleString();
          // обновим список ставок если открыт
          const myPane = document.getElementById('pred-pane-mybets');
          if (myPane && myPane.style.display !== 'none') loadMyBets();
        })
        .catch(err => { console.error('place bet error', err); try { tg?.showAlert?.('Ошибка размещения ставки'); } catch(_) {} });
    }

    function loadMyBets() {
      if (!myBetsEl) return;
      if (!tg || !tg.initDataUnsafe?.user) { myBetsEl.textContent = 'Недоступно вне Telegram'; return; }
      const CACHE_KEY = 'betting:mybets';
      const FRESH_TTL = 2 * 60 * 1000; // 2 минуты
      const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
      const render = (data) => {
        const ds = data?.bets ? data : (data?.data || {});
        const bets = ds.bets || [];
        if (!bets.length) { myBetsEl.innerHTML = '<div class="schedule-empty">Ставок нет</div>'; return; }
        const list = document.createElement('div'); list.className = 'bets-list';
        bets.forEach(b => {
          const card = document.createElement('div'); card.className = 'bet-card';
          const top = document.createElement('div'); top.className = 'bet-top';
          const title = document.createElement('div'); title.className = 'bet-title'; title.textContent = `${b.home} vs ${b.away}`;
          const when = document.createElement('div'); when.className = 'bet-when'; when.textContent = b.datetime ? formatDateTime(b.datetime) : '';
          top.append(title, when);
          const mid = document.createElement('div'); mid.className = 'bet-mid'; mid.textContent = `Исход: ${b.selection.toUpperCase()} | Кф: ${b.odds || '-'} | Ставка: ${b.stake}`;
          const st = document.createElement('div'); st.className = `bet-status ${b.status}`; st.textContent = b.status;
          card.append(top, mid, st);
          list.appendChild(card);
        });
        myBetsEl.innerHTML = '';
        myBetsEl.appendChild(list);
      };
      const cached = readCache();
      if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) {
        render(cached);
      } else {
        myBetsEl.innerHTML = '<div class="schedule-loading">Загрузка...</div>';
      }
      const fd = new FormData(); fd.append('initData', tg.initData || '');
      fetch('/api/betting/my-bets', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch(_) {} render(data); })
        .catch(err => { console.error('my bets load error', err); if (!cached) myBetsEl.innerHTML = '<div class="schedule-error">Ошибка загрузки</div>'; });
    }

    function formatDateTime(dateIso, time) {
      try {
        if (!dateIso) return time || '';
        const d = new Date(dateIso);
        const ds = d.toLocaleDateString();
        const ts = time || (d.toTimeString().slice(0,5));
        return `${ds}${ts ? ' ' + ts : ''}`;
      } catch(_) { return time || ''; }
    }

      function isLiveNow(m) {
        try {
          const now = new Date();
          if (m.datetime) {
            const dt = new Date(m.datetime); const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
            return now >= dt && now < dtEnd;
          } else if (m.date && m.time) {
            const dt = new Date(m.date + 'T' + (m.time?.length===5? m.time+':00': m.time||''));
            const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
            return now >= dt && now < dtEnd;
          }
        } catch(_) {}
        return false;
      }

    // Автозагрузка при входе во вкладку
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item[data-tab="predictions"]');
      if (item) { loadTours(); }
    }, { once: true });
  });
})();
