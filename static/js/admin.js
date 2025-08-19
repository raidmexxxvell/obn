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
      const panes = { service: document.getElementById('admin-pane-service'), orders: document.getElementById('admin-pane-orders'), streams: document.getElementById('admin-pane-streams') };
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
        fetch('/api/results/refresh', { method: 'POST', body: fd })
      ]).finally(() => { btnAll.disabled = false; btnAll.textContent = orig; });
    });
    if (btnUsers && lblUsers) btnUsers.addEventListener('click', () => {
      const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
      btnUsers.disabled = true; const o = btnUsers.textContent; btnUsers.textContent = '...';
      fetch('/api/admin/users-stats', { method: 'POST', body: fd })
        .then(r => r.json()).then(d => {
          const s = `Всего: ${d.total_users||0} • Онлайн: ${d.online_5m||0} (5м) / ${d.online_15m||0} (15м) • Активные: ${d.active_1d||0} (1д) / ${d.active_7d||0} (7д) / ${d.active_30d||0} (30д) • Новые за 30д: ${d.new_30d||0}`;
          lblUsers.textContent = s;
        })
        .finally(()=>{ btnUsers.disabled=false; btnUsers.textContent=o; });
    });
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
        tr.innerHTML = `<td>${idx+1}</td><td>${userLabel}</td><td>${o.items_preview||''}</td><td>${o.items_qty||0}</td><td>${(o.total||0).toLocaleString()}</td><td>${created}</td><td>${o.status||''}</td>`;
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
  const winMin = Math.max(60, Math.min(240, Number(winInput.value)||60));
  const params = new URLSearchParams({ window_min: String(winMin), include_started_min: '30' });
  const r = await fetch(`/api/streams/upcoming?${params}`);
  const data = await r.json();
      list.innerHTML = '';
      (data.matches||[]).forEach(m => {
        const card = document.createElement('div'); card.className='store-item';
        const name = document.createElement('div'); name.className='store-name'; name.textContent = `${m.home||''} — ${m.away||''}`;
        const when = document.createElement('div'); when.className='store-price'; when.textContent = m.datetime || m.date || '';
        const input = document.createElement('input'); input.type='text'; input.placeholder = 'Ссылка VK Live';
        const btn = document.createElement('button'); btn.className='details-btn confirm'; btn.textContent='Подтвердить';
        const hint = document.createElement('div'); hint.className = 'save-hint';
        btn.addEventListener('click', async () => {
          try {
            const val = (input.value || '').trim();
            if (!val) {
              hint.textContent = 'Введите ссылку';
              hint.classList.remove('success'); hint.classList.add('error');
              return;
            }
            btn.disabled = true; const o = btn.textContent; btn.textContent = '...';
            const fd = new FormData();
            fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            fd.append('home', m.home || ''); fd.append('away', m.away || '');
            fd.append('datetime', m.datetime || ''); fd.append('vk', val);
            const rr = await fetch('/api/streams/set', { method:'POST', body: fd });
            if (!rr.ok) { throw new Error('save'); }
            btn.textContent = 'Сохранено';
            hint.textContent = 'Ссылка успешно сохранена';
            hint.classList.remove('error'); hint.classList.add('success');
          } catch(_) { btn.disabled=false; btn.textContent='Подтвердить'; }
        });
        const row = document.createElement('div'); row.className='stream-row'; row.append(input, btn);
        card.append(name, when, row, hint); list.appendChild(card);
      });
      if (!data.matches || data.matches.length === 0) {
        msg.textContent = `В ближайшие ${winMin} мин. матчей нет`;
      } else {
        msg.textContent = 'Готово';
      }
      refreshBtn.onclick = initAdminStreams; winInput.onchange = initAdminStreams; winInput.onkeyup = (e)=>{ if(e.key==='Enter'){ initAdminStreams(); } };
    } catch (e) { console.error('admin streams load', e); msg.textContent = 'Ошибка загрузки'; }
  }
  window.Admin = { ensureAdminInit, renderAdminOrders, initAdminStreams };
})();
