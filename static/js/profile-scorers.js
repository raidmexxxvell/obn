// Scorers table loader
(function(){
  function renderScorers(){
    const hostPane = document.getElementById('ufo-stats');
    if(!hostPane) return;
    const table = document.getElementById('stats-table');
    if(!table) return;
    const tbody = table.querySelector('tbody');
    if(!tbody) return;
    tbody.innerHTML = '<tr><td style="padding:8px; font-size:12px; opacity:.7;">Загрузка...</td></tr>';
    fetch('/api/scorers').then(r=>r.json()).then(data => {
      const items = data?.items || [];
      if(!items.length){
        tbody.innerHTML = '<tr><td style="padding:8px; font-size:12px; opacity:.7;">Нет данных</td></tr>';
        return;
      }
      // Header
      tbody.innerHTML = '';
      const header = document.createElement('tr');
      header.innerHTML = '<th style="text-align:left; padding:6px;">#</th><th style="text-align:left; padding:6px;">Игрок</th><th style="padding:6px;">И</th><th style="padding:6px;">Г</th><th style="padding:6px;">П</th><th style="padding:6px;">Г+П</th>';
      tbody.appendChild(header);
      items.slice(0,100).forEach(it => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="padding:4px 6px; font-size:12px;">${it.rank||''}</td>
          <td style="padding:4px 6px; text-align:left; font-size:12px; white-space:nowrap;">${escapeHtml(it.player||'')}</td>
          <td style="padding:4px 6px; font-size:12px;">${it.games}</td>
          <td style="padding:4px 6px; font-size:12px;">${it.goals}</td>
            <td style="padding:4px 6px; font-size:12px;">${it.assists}</td>
            <td style="padding:4px 6px; font-size:12px; font-weight:600;">${it.total_points}</td>`;
        tbody.appendChild(tr);
      });
      try {
        const upd = document.getElementById('stats-table-updated');
        if(upd){ const dt = data.updated_at? new Date(data.updated_at*1000):null; upd.textContent = 'Обновлено: '+(dt? dt.toLocaleString('ru-RU'):'—'); }
      } catch(_) {}
    }).catch(err => {
      console.error('scorers load error', err);
      tbody.innerHTML = '<tr><td style="padding:8px; font-size:12px; opacity:.7;">Ошибка загрузки</td></tr>';
    });
  }
  function escapeHtml(s){ return (s||'').replace(/[&<>"] /g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]||c); }
  // Автоматическая загрузка при переключении на подкладку stats
  document.addEventListener('click', (e)=>{
    try {
      const tab = e.target.closest('.subtab-item[data-subtab="stats"]');
      if(tab){ setTimeout(renderScorers, 50); }
    } catch(_) {}
  });
  // Фолбэк автозапуска (если уже открыта вкладка stats через программный клик)
  setTimeout(()=>{ const active = document.querySelector('#ufo-subtabs .subtab-item.active[data-subtab="stats"]'); if(active) renderScorers(); }, 500);
  window.renderScorersTable = renderScorers;
})();
