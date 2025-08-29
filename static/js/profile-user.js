// profile-user.js
// Пользовательские данные: загрузка профиля, любимый клуб, withTeamCount
(function(){
  if (window.ProfileUser) return;
  const tg = window.Telegram?.WebApp || null;
  const elements = {
    userName: document.getElementById('user-name'),
    userAvatarImg: document.querySelector('#user-avatar img'),
    credits: document.getElementById('credits'),
    level: document.getElementById('level'),
    xp: document.getElementById('xp'),
    currentLevel: document.getElementById('current-level'),
    currentXp: document.getElementById('current-xp'),
    xpNeeded: document.getElementById('xp-needed'),
    xpProgress: document.getElementById('xp-progress'),
    checkinDays: document.getElementById('checkin-days'),
    checkinBtn: document.getElementById('checkin-btn'),
    checkinStatus: document.getElementById('checkin-status'),
    currentStreak: document.getElementById('current-streak'),
  };
  const favoriteTeamSelect = document.getElementById('favorite-team');
  let _teamCountsCache = { byTeam: {}, teams: [], ts: 0 };
  async function fetchTeamsAndCounts(force=false){
    try {
      const now = Date.now();
      if(!force && _teamCountsCache.ts && (now - _teamCountsCache.ts) < 5*60*1000) return _teamCountsCache;
      const res = await fetch('/api/teams');
      if(!res.ok) return _teamCountsCache;
      const data = await res.json();
      _teamCountsCache = { byTeam: data.counts||{}, teams: data.teams||[], ts: Date.now() };
      return _teamCountsCache;
    } catch(_) { return _teamCountsCache; }
  }
  function withTeamCount(name){
    const n = String(name||'');
    try { const cnt = _teamCountsCache.byTeam && _teamCountsCache.byTeam[n]; return cnt ? `${n} (${cnt})` : n; } catch(_) { return n; }
  }
  try { window.withTeamCount = withTeamCount; } catch(_) {}
  function renderFavoriteSelect(current){
    if(!favoriteTeamSelect) return;
    favoriteTeamSelect.innerHTML='';
    const ph=document.createElement('option'); ph.value=''; ph.textContent='— выбрать —'; favoriteTeamSelect.appendChild(ph);
    // Нормализуем: если элемент объект, пробуем поля name/title/team
    const raw = Array.isArray(_teamCountsCache.teams)? _teamCountsCache.teams : [];
    const norm = raw.map(t => {
      if (t == null) return '';
      if (typeof t === 'string') return t.trim();
      if (typeof t === 'object'){
        return (t.name || t.title || t.team || t.team_name || '').toString().trim();
      }
      return String(t).trim();
    }).filter(Boolean);
    // Уникальные + сортировка как в исходном порядке (первая встреча)
    const seen = new Set();
    const ordered = [];
    norm.forEach(n=>{ if(!seen.has(n)){ seen.add(n); ordered.push(n); } });
    ordered.forEach(teamName=>{ const opt=document.createElement('option'); opt.value=teamName; opt.textContent=teamName; if(current && String(current)===teamName) opt.selected=true; favoriteTeamSelect.appendChild(opt); });
  }
  async function initFavoriteTeamUI(user){ await fetchTeamsAndCounts(); renderFavoriteSelect(user && (user.favorite_team||user.favoriteTeam)); }
  async function saveFavoriteTeam(value){
    try {
      if (value){ const ok = confirm('Сменить любимый клуб можно только один раз. Подтвердить выбор?'); if(!ok) return false; }
      const fd = new FormData(); fd.append('initData', (tg?.initData || '')); fd.append('team', value||'');
      const res = await fetch('/api/user/favorite-team',{ method:'POST', body: fd }); const data = await res.json().catch(()=>({}));
      if(!res.ok){ const msg = data?.message || (data?.error==='limit' ? 'Сменить любимый клуб можно только один раз' : 'Не удалось сохранить клуб'); try { window.showAlert?.(msg,'info'); } catch(_) { alert(msg); } return false; }
      await fetchTeamsAndCounts(true); renderFavoriteSelect(value); return true;
    } catch(_) { return false; }
  }
  if (favoriteTeamSelect){ favoriteTeamSelect.addEventListener('change', e => { saveFavoriteTeam(e.target.value||''); }); }

  let _lastUser = null;
  function renderUserProfile(user){
    if(!user) return; let avatarLoaded=false;
    const tryDispatch = () => { if(!avatarLoaded) return; if(elements.userName && elements.userName.textContent && elements.userName.textContent !== 'Загрузка...'){ window.dispatchEvent(new CustomEvent('app:profile-ready')); } };
    if (elements.userAvatarImg && tg?.initDataUnsafe?.user?.photo_url){
      elements.userAvatarImg.onload = () => { avatarLoaded=true; tryDispatch(); };
      elements.userAvatarImg.onerror = () => { avatarLoaded=true; tryDispatch(); };
      elements.userAvatarImg.src = tg.initDataUnsafe.user.photo_url;
    } else { avatarLoaded=true; }
    if (elements.userName) elements.userName.textContent = user.display_name || 'User';
    tryDispatch();
    if (elements.credits) elements.credits.textContent = (user.credits||0).toLocaleString();
    if (elements.level) elements.level.textContent = user.level || 1;
    const lvl = user.level || 1; if (elements.currentLevel) elements.currentLevel.textContent = lvl;
    const xpForNext = lvl * 100; const currentXp = (user.xp||0) % xpForNext;
    if (elements.xp) elements.xp.textContent = `${currentXp}/${xpForNext}`;
    if (elements.currentXp) elements.currentXp.textContent = currentXp;
    if (elements.xpNeeded) elements.xpNeeded.textContent = xpForNext;
    if (elements.xpProgress) elements.xpProgress.style.width = `${Math.min(Math.max(xpForNext ? (currentXp/xpForNext)*100 : 0,0),100)}%`;
    _lastUser = user;
    try { window.dispatchEvent(new CustomEvent('profile:user-loaded',{ detail: user })); } catch(_) {}
  }

  function fetchUserData(){
    if (!tg || !tg.initDataUnsafe?.user){
      const dev = { user_id:0, display_name:'Dev User', credits:1000, xp:0, level:1, consecutive_days:0, last_checkin_date:'' };
      renderUserProfile(dev); return Promise.resolve(dev);
    }
    const formData = new FormData(); formData.append('initData', tg.initData || '');
    return fetch('/api/user',{ method:'POST', body: formData })
      .then(res => { if(res.status===401){ window.showAlert?.('Ошибка авторизации','error'); throw new Error('Unauthorized'); } return res.json(); })
      .then(async data => { renderUserProfile(data); await initFavoriteTeamUI(data); try { ensureAdminUI(); } catch(_) {}; return data; })
      .catch(err => { console.error('fetchUserData', err); window.showAlert?.('Не удалось загрузить данные','error'); throw err; });
  }
  function getLastUser(){ return _lastUser; }
  // Отображение админ-пункта меню (если ID совпадает). Повторные вызовы безопасны.
  function ensureAdminUI(){
    try {
      const adminId = document.body.getAttribute('data-admin');
      const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
      if (!adminId || !currentId || String(adminId) !== currentId) return; // не админ
      const navItem = document.getElementById('nav-admin');
      if (navItem && navItem.style.display === 'none') navItem.style.display = '';
      // Кнопка обновления таблиц (если уже прогружено содержимое)
      const refreshBtn = document.getElementById('league-refresh-btn');
      if (refreshBtn && refreshBtn.style.display === 'none') refreshBtn.style.display='';
    } catch(_) {}
  }
  // Попытка периодического отображения (на случай поздней инициализации Telegram SDK)
  let _adminTries = 0; const _adminTimer = setInterval(()=>{ try { ensureAdminUI(); } catch(_) {} if(++_adminTries>=10) clearInterval(_adminTimer); }, 800);
  window.ProfileUser = { fetchUserData, renderUserProfile, initFavoriteTeamUI, withTeamCount, getLastUser };
  try { window.ensureAdminUI = ensureAdminUI; } catch(_) {}
})();

// --- Profile shade handling: allow user to pick/upload a background image for profile top area ---
(function(){
  try {
    const modal = document.getElementById('shade-modal');
    const btn = document.getElementById('profile-shade-btn');
    const upload = document.getElementById('shade-upload');
    const shadeList = document.getElementById('shade-list');
    const btnSet = document.getElementById('shade-set');
    const btnCancel = document.getElementById('shade-cancel');
  const topArea = document.getElementById('profile-top-area');
  const shadeBg = document.getElementById('shade-bg');
    const STORAGE_KEY = 'profile:shade';

    function applyShade(url){
      try {
        if (shadeBg) {
          if (!url) { shadeBg.style.backgroundImage=''; return; }
          shadeBg.style.backgroundImage = `url(${url})`;
        } else if (topArea) {
          if (!url) { topArea.style.backgroundImage=''; return; }
          topArea.style.backgroundImage = `url(${url})`;
        }
      } catch(_){}
    }

  // load saved shade or default preset
  try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) applyShade(saved); else { try { applyShade(PRESETS[0]); } catch(_){} } } catch(_){}

    if (!btn || !modal) return;
    // preset shades (png). Add your files to /static/img/profile-shades/ and they will appear here.
    const PRESETS = [
      '/static/img/profile-shades/shade1.png',
      '/static/img/profile-shades/shade2.png',
      '/static/img/profile-shades/shade3.webp'
    ];

    function populateShadeList(){
      try {
        shadeList.innerHTML='';
        // saved first
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved){ const img = document.createElement('img'); img.src=saved; img.className='saved-shade selected'; img.addEventListener('click', ()=>{ document.querySelectorAll('#shade-list img').forEach(i=>i.classList.remove('selected')); img.classList.add('selected'); }); shadeList.appendChild(img); }
        // presets
        PRESETS.forEach(p => {
          const img = document.createElement('img'); img.src=p; img.alt='preset'; img.addEventListener('error', ()=>{ img.style.display='none'; });
          img.addEventListener('click', ()=>{ document.querySelectorAll('#shade-list img').forEach(i=>i.classList.remove('selected')); img.classList.add('selected'); });
          shadeList.appendChild(img);
        });
        // if nothing selected, select first preset
        if (!document.querySelector('#shade-list img.selected')) {
          const first = shadeList.querySelector('img'); if (first) first.classList.add('selected');
        }
      } catch(_){}
    }

    btn.addEventListener('click', ()=>{ populateShadeList(); modal.style.display = 'block'; modal.classList.add('show'); });

    // upload handler
  // file upload disabled: only presets allowed

    btnCancel?.addEventListener('click', ()=>{ modal.classList.remove('show'); modal.style.display='none'; });
    btnSet?.addEventListener('click', ()=>{
      try {
        const sel = document.querySelector('#shade-list img.selected') || document.querySelector('#shade-list img');
        if (!sel) { alert('Выберите фон.'); return; }
        const url = sel.src;
        try { localStorage.setItem(STORAGE_KEY, url); } catch(_){}
        applyShade(url);
        modal.classList.remove('show'); modal.style.display='none';
      } catch(err){ console.error(err); }
    });

    // close on backdrop
    modal?.querySelector('.modal-backdrop')?.addEventListener('click', (e)=>{ if (e.target?.dataset?.close) { modal.classList.remove('show'); modal.style.display='none'; } });
  } catch(_){}
})();
