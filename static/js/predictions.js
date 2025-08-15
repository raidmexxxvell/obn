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

    function loadTours() {
      if (!toursEl) return;
      toursEl.innerHTML = '<div class="schedule-loading">Загрузка матчей...</div>';
      fetch('/api/betting/tours').then(r => r.json()).then(data => {
        const tours = data.tours || [];
        if (!tours.length) { toursEl.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>'; return; }
        const container = document.createElement('div');
        container.className = 'pred-tours-container';
        tours.forEach(t => {
          const tourEl = document.createElement('div'); tourEl.className = 'tour-block';
          const title = document.createElement('div'); title.className = 'tour-title'; title.textContent = t.title || `Тур ${t.tour||''}`; tourEl.appendChild(title);
          (t.matches||[]).forEach(m => {
            const card = document.createElement('div'); card.className = 'match-card';
            const header = document.createElement('div'); header.className = 'match-header';
            header.textContent = formatDateTime(m.date, m.time); card.appendChild(header);
            const center = document.createElement('div'); center.className = 'match-center';
            const home = mkTeam(m.home); const score = document.createElement('div'); score.className='score'; score.textContent = 'VS'; const away = mkTeam(m.away);
            center.append(home, score, away); card.appendChild(center);
            const line = document.createElement('div'); line.className = 'betting-line';
            const opts = mkOptions(t.tour, m, !!m.lock);
            line.appendChild(opts);
            card.appendChild(line);
            tourEl.appendChild(card);
          });
          container.appendChild(tourEl);
        });
        toursEl.innerHTML = '';
        toursEl.appendChild(container);
      }).catch(err => {
        console.error('betting tours load error', err);
        toursEl.innerHTML = '<div class="schedule-error">Не удалось загрузить</div>';
      });
    }

    function mkTeam(name) {
      const d = document.createElement('div'); d.className = 'team';
      const img = document.createElement('img'); img.className = 'logo'; img.alt = name || '';
      setTeamLogo(img, name||'');
      const nm = document.createElement('div'); nm.className = 'team-name'; nm.textContent = name || '';
      d.append(img, nm); return d;
    }

    function setTeamLogo(imgEl, teamName) {
      const base = '/static/img/team-logos/';
      const name = (teamName || '').trim();
      const candidates = [];
      if (name) {
        candidates.push(base + encodeURIComponent(name + '.png'));
        const norm = name.toLowerCase().replace(/\s+/g,'').replace(/ё/g,'е');
        candidates.push(base + encodeURIComponent(norm + '.png'));
      }
      candidates.push(base + 'default.png');
      let i = 0; const next = () => { if (i>=candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
      next();
    }

    function mkOptions(tour, m, locked) {
      const box = document.createElement('div'); box.className = 'options-box';
      const mkBtn = (key, label) => { const b = document.createElement('button'); b.className='bet-btn'; b.textContent = label; b.disabled = !!locked; b.addEventListener('click', ()=> openStakeModal(tour, m, key)); return b; };
      box.append(mkBtn('home','П1'), mkBtn('draw','Х'), mkBtn('away','П2'));
      return box;
    }

    function openStakeModal(tour, m, selection) {
      const stake = prompt(`Ставка на ${m.home} vs ${m.away}. Исход: ${selection.toUpperCase()}. Введите сумму:`,'100');
      if (!stake) return;
      const amt = parseInt(String(stake).replace(/[^0-9]/g,''), 10) || 0;
      if (amt <= 0) return;
      if (!tg || !tg.initDataUnsafe?.user) { try { alert('Нужен Telegram WebApp'); } catch(_) {} return; }
      const fd = new FormData();
      fd.append('initData', tg.initData || '');
      if (tour != null) fd.append('tour', String(tour));
      fd.append('home', m.home || '');
      fd.append('away', m.away || '');
      fd.append('selection', selection);
      fd.append('stake', String(amt));
      fetch('/api/betting/place', { method: 'POST', body: fd })
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
      myBetsEl.innerHTML = '<div class="schedule-loading">Загрузка...</div>';
      const fd = new FormData(); fd.append('initData', tg.initData || '');
      fetch('/api/betting/my-bets', { method: 'POST', body: fd })
        .then(r => r.json())
        .then(data => {
          const bets = data.bets || [];
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
        })
        .catch(err => { console.error('my bets load error', err); myBetsEl.innerHTML = '<div class="schedule-error">Ошибка загрузки</div>'; });
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

    // Автозагрузка при входе во вкладку
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item[data-tab="predictions"]');
      if (item) { loadTours(); }
    }, { once: true });
  });
})();
