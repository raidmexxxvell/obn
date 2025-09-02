// static/js/admin-enhanced.js
// Enhanced admin module with lineup management
(function(){
  
  // Global variables for lineup management
  let currentMatchId = null;
  let currentLineups = { home: { main: [], sub: [] }, away: { main: [], sub: [] } };

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
      ['main', 'sub'].forEach(type => {
        const container = document.getElementById(`${team}-${type}-lineup`);
        if (!container) return;
        
        container.innerHTML = '';
        
        currentLineups[team][type].forEach((player, index) => {
          const playerEl = document.createElement('div');
          playerEl.className = 'player-item';
          playerEl.innerHTML = `
            <div class="player-info">
              <span class="player-name">${player.name}</span>
              <span class="player-details">#${player.number || '-'} • ${player.position || 'N/A'}</span>
            </div>
            <button class="remove-player" onclick="window.AdminEnhanced.removePlayer('${team}', '${type}', ${index})">×</button>
          `;
          container.appendChild(playerEl);
        });
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

  function removePlayer(team, type, index) {
    currentLineups[team][type].splice(index, 1);
    renderLineups();
  }

  function saveLineups() {
    if (!currentMatchId) return;
    
    console.log('[Admin] Saving lineups:', currentLineups);
    
    const btn = document.getElementById('save-lineups-btn');
    btn.disabled = true;
    btn.textContent = 'Сохранение...';
    
    const fd = new FormData();
    fd.append('initData', window.Telegram?.WebApp?.initData || '');
    fd.append('lineups', JSON.stringify(currentLineups));
    
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
        alert('Составы сохранены!');
        closeMatchModal();
        loadMatches(); // Refresh matches list
      } else {
        alert('Ошибка сохранения: ' + (data.error || 'Неизвестная ошибка'));
      }
    })
    .catch(err => {
      console.error('[Admin] Error saving lineups:', err);
      alert('Ошибка сохранения составов');
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
      if (failed === 0) {
        alert('Все данные обновлены!');
      } else {
        alert(`Обновлено с ошибками: ${failed} из ${results.length} запросов не выполнены`);
      }
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
    const logEl=document.getElementById('season-rollover-log');
    if(logEl){ logEl.style.display='block'; logEl.textContent='Выполняю '+mode+'...'; }
    const fd=new FormData(); fd.append('initData', initData);
    fetch(url,{ method:'POST', body:fd }).then(r=>r.json().then(d=>({ok:r.ok, d}))).then(res=>{
      if(!res.ok || res.d.error){ throw new Error(res.d.error||'Ошибка'); }
      if(logEl){ logEl.textContent=JSON.stringify(res.d,null,2); }
      if(!res.d.dry_run){ alert('Новый сезон: '+res.d.new_season); }
    }).catch(e=>{ if(logEl){ logEl.textContent='Ошибка: '+e.message; } alert('Ошибка: '+e.message); });
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
      alert('Ошибка загрузки данных новости');
    });
  }

  function saveNews() {
    const modal = document.getElementById('news-modal');
    const newsId = modal.getAttribute('data-news-id');
    const title = document.getElementById('news-title').value.trim();
    const content = document.getElementById('news-content').value.trim();
    
    if (!title || !content) {
      alert('Заполните все поля');
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
        alert(newsId ? 'Новость обновлена!' : 'Новость создана!');
        closeNewsModal();
        loadNews(); // Refresh news list
      } else {
        alert('Ошибка сохранения: ' + (data.error || 'Неизвестная ошибка'));
      }
    })
    .catch(err => {
      console.error('[Admin] Error saving news:', err);
      alert('Ошибка сохранения новости');
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
        alert('Новость удалена!');
        loadNews(); // Refresh news list
      } else {
        alert('Ошибка удаления: ' + (data.error || 'Неизвестная ошибка'));
      }
    })
    .catch(err => {
      console.error('[Admin] Error deleting news:', err);
      alert('Ошибка удаления новости');
    });
  }

  // Global functions for HTML onclick handlers
  window.AdminEnhanced = {
    openMatchModal,
    closeMatchModal,
    addPlayerToLineup,
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
