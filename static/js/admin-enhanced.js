// static/js/admin-enhanced.js
// Enhanced admin module with lineup management
(function(){
  // Toast system
  function ensureToastContainer(){
    if(document.getElementById('toast-container')) return;
    const c=document.createElement('div');
    c.id='toast-container';
    c.style.position='fixed';
    c.style.top='12px';
    c.style.right='12px';
    c.style.zIndex='9999';
    c.style.display='flex';
    c.style.flexDirection='column';
    c.style.gap='8px';
    c.style.pointerEvents='none';
    document.addEventListener('DOMContentLoaded',()=>{ document.body.appendChild(c); });
  }
  function showToast(msg,type='info',timeout=3000){
    try { ensureToastContainer(); const c=document.getElementById('toast-container'); if(!c) return; const box=document.createElement('div'); box.textContent=msg; box.style.pointerEvents='auto'; box.style.padding='10px 14px'; box.style.borderRadius='8px'; box.style.fontSize='13px'; box.style.maxWidth='340px'; box.style.lineHeight='1.35'; box.style.fontFamily='inherit'; box.style.color='#fff'; box.style.background= type==='error'? 'linear-gradient(135deg,#d9534f,#b52a25)': (type==='success'? 'linear-gradient(135deg,#28a745,#1e7e34)': 'linear-gradient(135deg,#444,#222)'); box.style.boxShadow='0 4px 12px rgba(0,0,0,0.35)'; box.style.opacity='0'; box.style.transform='translateY(-6px)'; box.style.transition='opacity .25s ease, transform .25s ease'; const close=document.createElement('span'); close.textContent='×'; close.style.marginLeft='8px'; close.style.cursor='pointer'; close.style.fontWeight='600'; close.onclick=()=>{ box.style.opacity='0'; box.style.transform='translateY(-6px)'; setTimeout(()=>box.remove(),220); }; const wrap=document.createElement('div'); wrap.style.display='flex'; wrap.style.alignItems='flex-start'; wrap.style.justifyContent='space-between'; wrap.style.gap='6px'; const textSpan=document.createElement('span'); textSpan.style.flex='1'; textSpan.textContent=msg; wrap.append(textSpan,close); box.innerHTML=''; box.appendChild(wrap); c.appendChild(box); requestAnimationFrame(()=>{ box.style.opacity='1'; box.style.transform='translateY(0)'; }); if(timeout>0){ setTimeout(()=>close.click(), timeout); } } catch(e){ console.warn('toast fail',e); }
  }
  window.showToast = showToast;
  ensureToastContainer();
  
  // Global variables for lineup management
  let currentMatchId = null;
  let currentLineups = { home: { main: [] }, away: { main: [] } };

  // Initialize admin dashboard
  function initAdminDashboard() {
    console.log('[Admin] Initializing enhanced admin dashboard');
    
    // Set up tab switching
    setupTabSwitching();
    
    // Set up event listeners
    setupEventListeners();
    
    // Load initial data
    loadMatches();
  }

  function setupTabSwitching() {
    const tabs = document.querySelectorAll('#admin-subtabs .subtab-item');
    const panes = {
      'matches': document.getElementById('admin-pane-matches'),
      'players': document.getElementById('admin-pane-players'),
      'news': document.getElementById('admin-pane-news'),
      'service': document.getElementById('admin-pane-service'),
      'stats': document.getElementById('admin-pane-stats')
    };
    
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetPane = tab.getAttribute('data-atab');
        
        // Update active tab
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        // Show/hide panes
        Object.keys(panes).forEach(key => {
          if (panes[key]) {
            panes[key].style.display = key === targetPane ? 'block' : 'none';
          }
        });
        
        // Load data for active pane
        if (targetPane === 'matches') {
          loadMatches();
        } else if (targetPane === 'players') {
          loadPlayers();
        } else if (targetPane === 'news') {
          loadNews();
        } else if (targetPane === 'stats') {
          loadStats();
        }
      });
    });
  }

  function setupEventListeners() {
    // Matches refresh button
    const refreshBtn = document.getElementById('admin-matches-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadMatches);
    }

    // Save lineups button
    const saveBtn = document.getElementById('save-lineups-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', saveLineups);
    }

    // Add player button
    const addPlayerBtn = document.getElementById('add-new-player-btn');
    if (addPlayerBtn) {
      addPlayerBtn.addEventListener('click', () => openPlayerModal());
    }

    // Add news button
    const addNewsBtn = document.getElementById('add-new-news-btn');
    if (addNewsBtn) {
      addNewsBtn.addEventListener('click', () => openNewsModal());
    }

    // Service buttons
    const refreshAllBtn = document.getElementById('admin-refresh-all');
    if (refreshAllBtn) {
      refreshAllBtn.addEventListener('click', refreshAllData);
    }

    const statsRefreshBtn = document.getElementById('admin-stats-refresh');
    if (statsRefreshBtn) {
      statsRefreshBtn.addEventListener('click', loadStats);
    }

  // Season rollover buttons
  const btnDry = document.getElementById('admin-season-dry');
  const btnSoft = document.getElementById('admin-season-soft');
  const btnRoll = document.getElementById('admin-season-roll');
  if (btnDry) btnDry.onclick = ()=> seasonRollover('dry');
  if (btnSoft) btnSoft.onclick = ()=> seasonRollover('soft');
    if (btnRoll) btnRoll.onclick = ()=> {
      const first = confirm('Полный сброс сезона? Это удалит legacy статистику матчей. Продолжить?');
      if(!first) return;
      const phrase = prompt('Введите СБРОС для подтверждения:');
      if(phrase !== 'СБРОС') { alert('Отменено'); return; }
      seasonRollover('full');
    };
  }

  // Match management functions
  function loadMatches() {
    console.log('[Admin] Loading matches...');
    const container = document.getElementById('matches-list');
    if (!container) return;
    
    container.innerHTML = '<div class="status-text">Загрузка матчей...</div>';
    
    const fd = new FormData();
    fd.append('initData', window.Telegram?.WebApp?.initData || '');
    
    fetch('/api/admin/matches/upcoming', {
      method: 'POST',
      body: fd
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] Matches loaded:', data);
      container.innerHTML = '';
      
      if (!data.matches || data.matches.length === 0) {
        container.innerHTML = '<div class="status-text">Нет предстоящих матчей</div>';
        return;
      }
      
      data.matches.forEach(match => {
        const matchEl = createMatchElement(match);
        container.appendChild(matchEl);
      });
    })
    .catch(err => {
      console.error('[Admin] Error loading matches:', err);
      container.innerHTML = '<div class="status-text">Ошибка загрузки матчей</div>';
    });
  }

  function createMatchElement(match) {
    const matchEl = document.createElement('div');
    matchEl.className = 'match-item';
    
    const lineupStatus = getLineupStatus(match.lineups);
    const matchDate = new Date(match.match_date).toLocaleString('ru-RU');
    
    matchEl.innerHTML = `
      <div class="match-info">
        <div class="match-main">
          <div class="match-teams">${match.home_team} vs ${match.away_team}</div>
          <div class="match-date">${matchDate}</div>
        </div>
        <div class="lineup-status ${lineupStatus.class}">${lineupStatus.text}</div>
      </div>
      <div class="match-actions">
        <button class="edit-lineup-btn" onclick="window.AdminEnhanced.openMatchModal('${match.id}', '${match.home_team}', '${match.away_team}')">
          Составы
        </button>
      </div>
    `;
    
    return matchEl;
  }

  function getLineupStatus(lineups) {
    if (!lineups) return { class: 'lineup-empty', text: 'Нет составов' };
    
    const homeMain = lineups.home?.main?.length || 0;
    const awayMain = lineups.away?.main?.length || 0;
    
    if (homeMain >= 11 && awayMain >= 11) {
      return { class: 'lineup-complete', text: 'Составы готовы' };
    } else if (homeMain > 0 || awayMain > 0) {
      return { class: 'lineup-partial', text: `Частично (${homeMain}/${awayMain})` };
    } else {
      return { class: 'lineup-empty', text: 'Нет составов' };
    }
  }

  // Modal functions
  function openMatchModal(matchId, homeTeam, awayTeam) {
    console.log('[Admin] Opening match modal:', matchId, homeTeam, awayTeam);
    currentMatchId = matchId;
    
    document.getElementById('match-details-title').textContent = `${homeTeam} vs ${awayTeam} - Составы`;
    document.getElementById('home-team-name').textContent = homeTeam;
    document.getElementById('away-team-name').textContent = awayTeam;
    
    // Load existing lineups
    loadLineups(matchId);
    
    document.getElementById('match-details-modal').style.display = 'flex';
  }

  function closeMatchModal() {
    document.getElementById('match-details-modal').style.display = 'none';
    currentMatchId = null;
  }
  // Legacy global alias for existing inline onclick="closeMatchModal()" in template
  window.closeMatchModal = closeMatchModal;

  function loadLineups(matchId) {
    console.log('[Admin] Loading lineups for match:', matchId);
    
    const fd = new FormData();
    fd.append('initData', window.Telegram?.WebApp?.initData || '');
    
    fetch(`/api/admin/match/${matchId}/lineups`, {
      method: 'POST',
      body: fd
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] Lineups loaded:', data);
      currentLineups = data.lineups || { home: { main: [], sub: [] }, away: { main: [], sub: [] } };
      renderLineups();
    })
    .catch(err => {
      console.error('[Admin] Error loading lineups:', err);
      currentLineups = { home: { main: [], sub: [] }, away: { main: [], sub: [] } };
      renderLineups();
    });
  }

  function renderLineups() {
    console.log('[Admin] Rendering lineups:', currentLineups);
    
    ['home', 'away'].forEach(team => {
      // Рендерим только основной состав (main)
      const container = document.getElementById(`${team}-main-lineup`);
      if (!container) return;
      
      container.innerHTML = '';
      
      const counts = currentLineups[team].main.reduce((a,p)=>{const k=p.name.toLowerCase();a[k]=(a[k]||0)+1;return a;},{});
      currentLineups[team].main.forEach((player, index) => {
        const dup = counts[player.name.toLowerCase()] > 1;
        const playerEl = document.createElement('div');
        playerEl.className = 'player-item';
        playerEl.innerHTML = `
          <div class="player-info">
            <span class="player-name ${dup ? 'dup-player' : ''}" data-player-index="${index}">${player.name}</span>
          </div>
          <button class="remove-player" title="Удалить" onclick="window.AdminEnhanced.removePlayer('${team}', 'main', ${index})">×</button>
        `;
        container.appendChild(playerEl);
      });
    });
  }

  function addPlayerToLineup(team, type) {
    const playerName = prompt('Введите имя игрока:');
    if (!playerName) return;
    
    const playerNumber = prompt('Введите номер игрока (или оставьте пустым):');
    const playerPosition = prompt('Введите позицию (GK/DEF/MID/FWD):');
    
    const player = {
      name: playerName.trim(),
      number: playerNumber ? parseInt(playerNumber) : null,
      position: playerPosition ? playerPosition.toUpperCase() : null
    };
    
    currentLineups[team][type].push(player);
    renderLineups();
  }

  function updateTeamLineup(team) {
    const inputId = `${team}-main-lineup-input`;
    const textarea = document.getElementById(inputId);
    if (!textarea) return;
    
    const lines = textarea.value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    if (lines.length === 0) {
      showToast('Введите список игроков','error');
      return;
    }
    
    // Проверка дублей
    const counts = lines.reduce((acc,l)=>{const k=l.toLowerCase();acc[k]=(acc[k]||0)+1;return acc;},{});
    const dups = Object.entries(counts).filter(([_,c])=>c>1).map(([k])=>k);
    if (dups.length){
      textarea.classList.add('has-dup');
      showToast('Дубликаты: '+dups.join(', '),'error',6000);
      return;
    } else {
      textarea.classList.remove('has-dup');
    }
    // Сохраняем
    currentLineups[team].main = lines.map(name => ({ name, number: null, position: null }));
    // Очищаем textarea после применения
    textarea.value = '';
    
    // Обновляем отображение
    renderLineups();
    
    console.log(`[Admin] Updated ${team} lineup:`, currentLineups[team].main);
  }

  function removePlayer(team, type, index) {
    currentLineups[team][type].splice(index, 1);
    renderLineups();
  }

  function saveLineups() {
    if (!currentMatchId) return;
    
    // Готовим данные только с основными составами
    const lineupsToSave = {
  home: { main: currentLineups.home.main.map(p => ({ name: p.name })), sub: [] },
  away: { main: currentLineups.away.main.map(p => ({ name: p.name })), sub: [] }
    };
    
    console.log('[Admin] Saving lineups:', lineupsToSave);
    
    const btn = document.getElementById('save-lineups-btn');
    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    
    const fd = new FormData();
    fd.append('initData', window.Telegram?.WebApp?.initData || '');
    fd.append('lineups', JSON.stringify(lineupsToSave));
    
    fetch(`/api/admin/match/${currentMatchId}/lineups/save`, {
      method: 'POST',
      body: fd
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] Lineups saved:', data);
      if (data.success) {
        showToast('Составы сохранены','success');
        closeMatchModal();
        loadMatches(); // Refresh matches list
      } else {
        showToast('Ошибка сохранения: ' + (data.error || 'Неизвестная'),'error',6000);
      }
    })
    .catch(err => {
      console.error('[Admin] Error saving lineups:', err);
      showToast('Ошибка сохранения составов','error',6000);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Сохранить составы';
    });
  }

  // Player management functions
  function loadPlayers() {
    console.log('[Admin] Loading players...');
    const tbody = document.getElementById('players-table');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="6">Загрузка игроков...</td></tr>';
    
    // For now, show placeholder
    tbody.innerHTML = '<tr><td colspan="6">Функция загрузки игроков в разработке</td></tr>';
  }

  function openPlayerModal(playerId = null) {
    document.getElementById('player-modal-title').textContent = playerId ? 'Редактировать игрока' : 'Добавить игрока';
    document.getElementById('player-modal').style.display = 'flex';
    
    if (playerId) {
      loadPlayerData(playerId);
    } else {
      document.getElementById('player-form').reset();
    }
  }

  function closePlayerModal() {
    document.getElementById('player-modal').style.display = 'none';
  }

  function loadPlayerData(playerId) {
    console.log('[Admin] Loading player data for:', playerId);
    // Implementation for loading specific player data
  }

  // Service functions
  function refreshAllData() {
    console.log('[Admin] Refreshing all data...');
    
    const btn = document.getElementById('admin-refresh-all');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Обновляю...';
    
    const fd = new FormData();
    fd.append('initData', window.Telegram?.WebApp?.initData || '');
    
    Promise.allSettled([
      fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
      fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
      fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
      fetch('/api/results/refresh', { method: 'POST', body: fd }),
      fetch('/api/betting/tours/refresh', { method: 'POST', body: fd })
    ])
    .then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
  if (failed === 0) showToast('Все данные обновлены','success'); else showToast(`Ошибки: ${failed} / ${results.length}`,'error',6000);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = originalText;
    });
  }

  function loadStats() {
    console.log('[Admin] Loading stats...');
    const container = document.getElementById('admin-stats-display');
    if (!container) return;
    
    container.innerHTML = '<div class="status-text">Загрузка статистики...</div>';
    
    // For now, show placeholder
    container.innerHTML = '<div class="status-text">Статистика в разработке</div>';
  }

  function seasonRollover(mode){
    const initData = window.Telegram?.WebApp?.initData || '';
    let url='/api/admin/season/rollover';
    if(mode==='dry') url+='?dry=1'; else if(mode==='soft') url+='?soft=1';
    else if(mode==='full') {
      // Проверяем чекбокс deep
      const deepCb = document.getElementById('season-rollover-deep');
      if(deepCb && deepCb.checked){
        url += (url.includes('?')?'&':'?')+'deep=1';
      }
    }
    const logEl=document.getElementById('season-rollover-log');
    if(logEl){ logEl.style.display='block'; logEl.textContent='Выполняю '+mode+'...'; }
    const fd=new FormData(); fd.append('initData', initData);
    fetch(url,{ method:'POST', body:fd }).then(r=>r.json().then(d=>({ok:r.ok, d}))).then(res=>{
      if(!res.ok || res.d.error){ throw new Error(res.d.error||'Ошибка'); }
      if(logEl){ logEl.textContent=JSON.stringify(res.d,null,2); }
      if(!res.d.dry_run){ showToast('Новый сезон: '+res.d.new_season,'success'); }
    }).catch(e=>{ if(logEl){ logEl.textContent='Ошибка: '+e.message; } showToast('Ошибка: '+e.message,'error',6000); });
  }

  // News management functions
  function loadNews() {
    console.log('[Admin] Loading news...');
    const container = document.getElementById('news-list');
    if (!container) return;
    
    container.innerHTML = '<div class="status-text">Загрузка новостей...</div>';
    
    const initData = window.Telegram?.WebApp?.initData || '';
    
    fetch(`/api/admin/news?initData=${encodeURIComponent(initData)}`, {
      method: 'GET'
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] News loaded:', data);
      container.innerHTML = '';
      
      if (!data.news || data.news.length === 0) {
        container.innerHTML = '<div class="status-text">Нет новостей</div>';
        return;
      }
      
      data.news.forEach(news => {
        const newsEl = createNewsElement(news);
        container.appendChild(newsEl);
      });
    })
    .catch(err => {
      console.error('[Admin] Error loading news:', err);
      container.innerHTML = '<div class="status-text">Ошибка загрузки новостей</div>';
    });
  }

  function createNewsElement(news) {
    const newsEl = document.createElement('div');
    newsEl.className = 'news-item';
    
    const createdDate = new Date(news.created_at).toLocaleString('ru-RU');
    const truncatedContent = news.content.length > 100 ? 
      news.content.substring(0, 100) + '...' : news.content;
    
    newsEl.innerHTML = `
      <div class="news-info">
        <div class="news-title">${news.title}</div>
        <div class="news-content">${truncatedContent}</div>
        <div class="news-date">Создано: ${createdDate}</div>
      </div>
      <div class="news-actions">
        <button class="edit-news-btn" onclick="window.AdminEnhanced.openNewsModal(${news.id})">
          Редактировать
        </button>
        <button class="delete-news-btn" onclick="window.AdminEnhanced.deleteNews(${news.id})">
          Удалить
        </button>
      </div>
    `;
    
    return newsEl;
  }

  function openNewsModal(newsId = null) {
    console.log('[Admin] Opening news modal:', newsId);
    
    document.getElementById('news-modal-title').textContent = newsId ? 'Редактировать новость' : 'Создать новость';
    document.getElementById('news-modal').style.display = 'flex';
    
    if (newsId) {
      loadNewsData(newsId);
    } else {
      document.getElementById('news-form').reset();
    }
    
    // Store current news ID for saving
    document.getElementById('news-modal').setAttribute('data-news-id', newsId || '');
  }

  function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
  }

  function loadNewsData(newsId) {
    console.log('[Admin] Loading news data for:', newsId);
    
    const initData = window.Telegram?.WebApp?.initData || '';
    
    fetch(`/api/admin/news?initData=${encodeURIComponent(initData)}`, {
      method: 'GET'
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      const news = data.news.find(n => n.id === newsId);
      if (news) {
        document.getElementById('news-title').value = news.title;
        document.getElementById('news-content').value = news.content;
      }
    })
    .catch(err => {
  console.error('[Admin] Error loading news data:', err);
  showToast('Ошибка загрузки данных новости','error',6000);
    });
  }

  function saveNews() {
    const modal = document.getElementById('news-modal');
    const newsId = modal.getAttribute('data-news-id');
    const title = document.getElementById('news-title').value.trim();
    const content = document.getElementById('news-content').value.trim();
    
    if (!title || !content) {
      showToast('Заполните все поля','error');
      return;
    }
    
    console.log('[Admin] Saving news:', { newsId, title, content });
    
    const btn = document.getElementById('save-news-btn');
    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    
    const data = {
      initData: window.Telegram?.WebApp?.initData || '',
      title: title,
      content: content
    };
    
    const url = newsId ? `/api/admin/news/${newsId}` : '/api/admin/news';
    const method = newsId ? 'PUT' : 'POST';
    
    fetch(url, {
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] News saved:', data);
      if (data.status === 'success') {
        showToast(newsId ? 'Новость обновлена!' : 'Новость создана!','success');
        closeNewsModal();
        loadNews(); // Refresh news list
      } else {
        showToast('Ошибка сохранения: ' + (data.error || 'Неизвестная'),'error',6000);
      }
    })
    .catch(err => {
      console.error('[Admin] Error saving news:', err);
      showToast('Ошибка сохранения новости','error',6000);
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = 'Сохранить';
    });
  }

  function deleteNews(newsId) {
    if (!confirm('Вы уверены, что хотите удалить эту новость?')) {
      return;
    }
    
    console.log('[Admin] Deleting news:', newsId);
    
    const initData = window.Telegram?.WebApp?.initData || '';
    
    fetch(`/api/admin/news/${newsId}?initData=${encodeURIComponent(initData)}`, {
      method: 'DELETE'
    })
    .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(data => {
      console.log('[Admin] News deleted:', data);
      if (data.status === 'success') {
        showToast('Новость удалена!','success');
        loadNews(); // Refresh news list
      } else {
        showToast('Ошибка удаления: ' + (data.error || 'Неизвестная'),'error',6000);
      }
    })
    .catch(err => {
      console.error('[Admin] Error deleting news:', err);
      showToast('Ошибка удаления новости','error',6000);
    });
  }

  // Global functions for HTML onclick handlers
  window.AdminEnhanced = {
    openMatchModal,
    closeMatchModal,
    addPlayerToLineup,
    updateTeamLineup,
    removePlayer,
    openPlayerModal,
    closePlayerModal,
    openNewsModal,
    closeNewsModal,
    saveNews,
    deleteNews,
    loadNews
  };

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAdminDashboard);
  } else {
    initAdminDashboard();
  }

})();
