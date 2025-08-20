// static/js/admin.js
// Admin module: admin subtabs, refresh, orders, streams. Exposes window.Admin
(function(){
  function ensureAdminInit() {
    const btnAll = document.getElementById('admin-refresh-all');
    const btnUsers = document.getElementById('admin-users-refresh');
    const btnSync = document.getElementById('admin-sync-refresh');
  const btnBump = document.getElementById('admin-bump-version');
    const lblUsers = document.getElementById('admin-users-stats');
    const lblSync = document.getElementById('admin-sync-summary');
    try {
      const tabs = document.querySelectorAll('#admin-subtabs .subtab-item');
      const panes = { service: document.getElementById('admin-pane-service'), stats: document.getElementById('admin-pane-stats'), orders: document.getElementById('admin-pane-orders'), streams: document.getElementById('admin-pane-streams') };
      tabs.forEach(btn => {
        btn.setAttribute('data-throttle', '600');
        btn.addEventListener('click', () => {
          const key = btn.getAttribute('data-atab');
          tabs.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
          if (panes[key]) panes[key].style.display = '';
          if (key === 'orders') renderAdminOrders();
          if (key === 'streams') initAdminStreams();
          if (key === 'stats') renderAdminStats();
        });
      });
    } catch(_) {}
    if (btnAll) btnAll.addEventListener('click', () => {
      const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
      btnAll.disabled = true; const orig = btnAll.textContent; btnAll.textContent = 'Обновляю...';
      Promise.allSettled([
        fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
        fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
        fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
  fetch('/api/results/refresh', { method: 'POST', body: fd }),
  // Также обновим туры для ставок, чтобы подтянулись прогнозы и «матч недели»
  fetch('/api/betting/tours/refresh', { method: 'POST', body: fd })
      ]).finally(() => { btnAll.disabled = false; btnAll.textContent = orig; });
    });
  if (btnUsers && lblUsers) btnUsers.addEventListener('click', renderAdminStats);
    if (btnSync && lblSync) btnSync.addEventListener('click', () => {
      btnSync.disabled = true; const o = btnSync.textContent; btnSync.textContent='...';
      fetch('/health/sync').then(r=>r.json()).then(m => {
        const last = m.last_sync || {}; const st = m.last_sync_status || {}; const dur = m.last_sync_duration_ms || {};
        const keys = ['league-table','stats-table','schedule','results','betting-tours','leaderboards'];
        const lines = keys.map(k => `${k}: ${st[k]||'—'}, ${dur[k]||0}мс, at ${last[k]||'—'}`);
        lblSync.textContent = lines.join(' | ');
      }).finally(()=>{ btnSync.disabled=false; btnSync.textContent=o; });
    });
    if (btnBump) btnBump.addEventListener('click', async () => {
      try {
        btnBump.disabled = true; const o = btnBump.textContent; btnBump.textContent = '...';
        const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
        const r = await fetch('/api/admin/bump-version', { method: 'POST', body: fd });
        const d = await r.json().catch(()=>({}));
        const v = d?.ver != null ? d.ver : '—';
        const msg = r.ok ? `Версия обновлена до v${v}. Клиентам будет предложено обновление.` : (d?.error || 'Ошибка');
        try { window.Telegram?.WebApp?.showAlert?.(msg); } catch(_) { alert(msg); }
      } finally {
        btnBump.disabled = false; btnBump.textContent = 'Применить';
      }
    });
  }
  async function renderAdminOrders() {
    const table = document.getElementById('admin-orders-table');
    const updated = document.getElementById('admin-orders-updated');
    if (!table) return; const tbody = table.querySelector('tbody'); tbody.innerHTML = '';
    try {
      const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
      const r = await fetch('/api/admin/orders', { method: 'POST', body: fd }); const data = await r.json();
      (data.orders||[]).forEach((o, idx) => {
        const tr = document.createElement('tr');
        let created = o.created_at || '';
        try { created = new Date(created).toLocaleDateString('ru-RU'); } catch(_) {}
        const userLabel = o.username ? ('@' + o.username) : (o.user_id ? ('ID ' + o.user_id) : '—');
        const tdIdx = document.createElement('td'); tdIdx.textContent = String(idx+1);
        const tdUser = document.createElement('td');
        const link = document.createElement('a');
        link.href = o.username ? (`https://t.me/${o.username}`) : (`https://t.me/+${o.user_id}`);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = userLabel;
        link.addEventListener('click', (e) => {
          // Внутри Telegram WebApp попробуем открыть нативно
          try {
            if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink) {
              e.preventDefault();
              const url = o.username ? (`https://t.me/${o.username}`) : (`https://t.me/+${o.user_id}`);
              window.Telegram.WebApp.openTelegramLink(url);
            }
          } catch(_) {}
        });
        tdUser.appendChild(link);
        const tdItems = document.createElement('td'); tdItems.textContent = o.items_preview || '';
        const tdQty = document.createElement('td'); tdQty.textContent = String(o.items_qty || 0);
        const tdSum = document.createElement('td'); tdSum.textContent = (o.total||0).toLocaleString();
        const tdCreated = document.createElement('td'); tdCreated.textContent = created;
        const tdStatus = document.createElement('td');
        const sel = document.createElement('select');
        const variants = [
          { v:'new', l:'новый' },
          { v:'accepted', l:'принят' },
          { v:'done', l:'завершен' },
          { v:'cancelled', l:'отменен' }
        ];
        variants.forEach(({v,l}) => { const opt=document.createElement('option'); opt.value=v; opt.textContent=l; sel.appendChild(opt); });
        sel.value = (o.status||'new');
        sel.addEventListener('change', async () => {
          try {
            sel.disabled = true;
            const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || '')); fd.append('status', sel.value);
            const rr = await fetch(`/api/admin/orders/${o.id}/status`, { method: 'POST', body: fd });
            if (!rr.ok) throw new Error('status');
          } catch(_) { /* revert on error */ sel.value = o.status||'new'; }
          finally { sel.disabled = false; }
        });
        tdStatus.appendChild(sel);
        const tdDel = document.createElement('td');
        const btnDel = document.createElement('button'); btnDel.className='details-btn'; btnDel.textContent='✖';
        btnDel.addEventListener('click', async () => {
          try {
            if (!confirm('Удалить заказ?')) return;
            btnDel.disabled = true;
            const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            const rr = await fetch(`/api/admin/orders/${o.id}/delete`, { method: 'POST', body: fd });
            if (!rr.ok) throw new Error('delete');
            tr.remove();
          } catch(_) { btnDel.disabled = false; }
        });
        tdDel.appendChild(btnDel);
        tr.append(tdIdx, tdUser, tdItems, tdQty, tdSum, tdCreated, tdStatus, tdDel);
        tbody.appendChild(tr);
      });
      if (updated && data.updated_at) { try { updated.textContent = `Обновлено: ${new Date(data.updated_at).toLocaleString()}`; } catch(_) {} }
    } catch(_) { /* ignore */ }
  }
  async function initAdminStreams() {
    const host = document.getElementById('admin-pane-streams'); if (!host) return;
    const list = document.getElementById('admin-streams-list'); const msg = document.getElementById('admin-streams-msg');
    const winInput = document.getElementById('admin-streams-window'); const refreshBtn = document.getElementById('admin-streams-refresh');
    if (!list || !msg || !winInput || !refreshBtn) return;
    list.innerHTML = '';
    try {
  const winMin = Math.max(60, Math.min(480, Number(winInput.value)||360));
  const params = new URLSearchParams({ window_min: String(winMin), include_started_min: '30' });
  const r = await fetch(`/api/streams/upcoming?${params}`);
  const data = await r.json();
      list.innerHTML = '';
      // Получим уже сохранённые подтверждения, чтобы предзаполнить поля
      let saved = {};
      try {
        const rr = await fetch('/api/streams/list');
        const dd = await rr.json();
        (dd.items||[]).forEach(it => {
          const key = `${(it.home||'').toLowerCase()}__${(it.away||'').toLowerCase()}__${(it.date||'')}`;
          saved[key] = { vkVideoId: it.vkVideoId||'', vkPostUrl: it.vkPostUrl||'' };
        });
      } catch(_) {}
      (data.matches||[]).forEach(m => {
        const card = document.createElement('div'); card.className='store-item';
        const name = document.createElement('div'); name.className='store-name'; name.textContent = `${m.home||''} — ${m.away||''}`;
        const when = document.createElement('div'); when.className='store-price'; when.textContent = m.datetime || m.date || '';
        const input = document.createElement('input'); input.type='text'; input.placeholder = 'Ссылка VK Live';
        const btn = document.createElement('button'); btn.className='details-btn confirm'; btn.textContent='Подтвердить';
        const btnReset = document.createElement('button'); btnReset.className='details-btn'; btnReset.textContent='Сбросить'; btnReset.style.marginLeft = '8px';
        const hint = document.createElement('div'); hint.className = 'save-hint';
        // Предзаполним, если уже была сохранённая ссылка
        try {
          const dateKey = (m.datetime||m.date||'').slice(0,10);
          const key = `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__${dateKey}`;
          const prev = saved[key];
          if (prev) {
            const val = prev.vkVideoId ? `https://vk.com/video${prev.vkVideoId}` : (prev.vkPostUrl||'');
            if (val) { input.value = val; hint.textContent = 'Ранее сохранено'; hint.classList.remove('error'); hint.classList.add('success'); }
          }
        } catch(_) {}
        btn.addEventListener('click', async () => {
          try {
            const val = (input.value || '').trim();
            if (!val) {
              hint.textContent = 'Введите ссылку';
              hint.classList.remove('success'); hint.classList.add('error');
              return;
            }
            // Если уже было сохранено и значение меняется — спросим подтверждение
            try {
              const dateKey = (m.datetime||m.date||'').slice(0,10);
              const key = `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__${dateKey}`;
              const prev = saved[key];
              const prevHuman = prev ? (prev.vkVideoId ? `https://vk.com/video${prev.vkVideoId}` : (prev.vkPostUrl||'')) : '';
              if (prevHuman && prevHuman !== val) {
                const ok = confirm('Ссылка уже сохранена. Перезаписать?');
                if (!ok) return;
              }
            } catch(_) {}
            btn.disabled = true; const o = btn.textContent; btn.textContent = '...';
            const fd = new FormData();
            fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            fd.append('home', m.home || ''); fd.append('away', m.away || '');
            fd.append('datetime', m.datetime || ''); fd.append('vk', val);
            const rr = await fetch('/api/streams/set', { method:'POST', body: fd });
            const resp = await rr.json().catch(()=>({}));
            if (!rr.ok) { throw new Error(resp?.error || 'save'); }
            btn.textContent = 'Сохранено';
            hint.textContent = resp?.message || 'Ссылка успешно сохранена';
            hint.classList.remove('error'); hint.classList.add('success');
            // Обновим локальный saved
            try {
              const dateKey = (m.datetime||m.date||'').slice(0,10);
              const key = `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__${dateKey}`;
              saved[key] = { vkVideoId: resp?.vkVideoId || '', vkPostUrl: resp?.vkPostUrl || '' };
            } catch(_) {}
          } catch(_) { btn.disabled=false; btn.textContent='Подтвердить'; }
        });
        const row = document.createElement('div'); row.className='stream-row'; row.append(input, btn, btnReset);
        card.append(name, when, row, hint); list.appendChild(card);

        btnReset.addEventListener('click', async () => {
          try {
            const ok = confirm('Сбросить ссылку трансляции для этого матча?');
            if (!ok) return;
            btnReset.disabled = true; const o = btnReset.textContent; btnReset.textContent = '...';
            const fd = new FormData();
            fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            fd.append('home', m.home || ''); fd.append('away', m.away || '');
            const dateKey = (m.datetime||m.date||'').slice(0,10);
            fd.append('date', dateKey);
            const rr = await fetch('/api/streams/reset', { method: 'POST', body: fd });
            const resp = await rr.json().catch(()=>({}));
            if (!rr.ok) throw new Error(resp?.error || 'reset');
            hint.textContent = 'Ссылка сброшена'; hint.classList.remove('error'); hint.classList.add('success');
            input.value = '';
          } catch(_){ /* ignore */ }
          finally { btnReset.disabled = false; btnReset.textContent = 'Сбросить'; }
        });
      });
      if (!data.matches || data.matches.length === 0) {
        msg.textContent = `В ближайшие ${winMin} мин. матчей нет`;
      } else {
        msg.textContent = 'Готово';
      }
      refreshBtn.onclick = initAdminStreams; winInput.onchange = initAdminStreams; winInput.onkeyup = (e)=>{ if(e.key==='Enter'){ initAdminStreams(); } };
    } catch (e) { console.error('admin streams load', e); msg.textContent = 'Ошибка загрузки'; }
  }
  async function renderAdminStats() {
    const table = document.getElementById('admin-stats-table');
    const updated = document.getElementById('admin-stats-updated');
    const btn = document.getElementById('admin-stats-refresh');
    const lblUsers = document.getElementById('admin-users-stats');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    try {
      if (btn) { btn.disabled = true; btn.textContent = '...'; }
      const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
      const r = await fetch('/api/admin/users-stats', { method: 'POST', body: fd });
      const d = await r.json();
      tbody.innerHTML = '';
      const rows = [
        ['Активные (1 день)', d.active_1d||0],
        ['Активные (7 дней)', d.active_7d||0],
        ['Активные (30 дней)', d.active_30d||0],
        ['Всего пользователей', d.total_users||0]
      ];
      rows.forEach(([k,v]) => {
        const tr = document.createElement('tr');
        const tdK = document.createElement('td'); tdK.textContent = k;
        const tdV = document.createElement('td'); tdV.textContent = String(v);
        tr.append(tdK, tdV); tbody.appendChild(tr);
      });
      if (updated) { try { updated.textContent = `Обновлено: ${new Date().toLocaleString()}`; } catch(_) {} }
  if (lblUsers) lblUsers.textContent = `Активные: ${d.active_1d||0}/${d.active_7d||0}/${d.active_30d||0} • Всего: ${d.total_users||0}`;
    } catch(_) {
      // ignore
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Обновить'; }
    }
  }
  window.Admin = { ensureAdminInit, renderAdminOrders, initAdminStreams, renderAdminStats };
})();
