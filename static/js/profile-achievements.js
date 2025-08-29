// profile-achievements.js
// Загрузка и рендер достижений
(function(){
  if (window.ProfileAchievements) return;
  const tg = window.Telegram?.WebApp || null;
  const badgesContainer = document.getElementById('badges');
  const achievementPlaceholder = document.getElementById('achievement-placeholder');
  let _loadedOnce = false;
  // prevent concurrent duplicate requests
  let _inFlightPromise = null;

  function renderAchievements(achievements){
    if (achievementPlaceholder) achievementPlaceholder.remove();
    if (!badgesContainer) return;
    badgesContainer.innerHTML='';
    if(!achievements || !achievements.length){
      const empty=document.createElement('div'); empty.style.cssText='padding:12px; color:var(--gray); font-size:12px;'; empty.textContent='Пока нет достижений'; badgesContainer.appendChild(empty); return; }
    const slugify = (s) => (s||'').toString().trim().toLowerCase().replace(/[\s_/]+/g,'-').replace(/[^a-z0-9\-]/g,'');
    const stateFromTier = (a) => {
      const t = (typeof a.tier === 'number') ? a.tier : null;
      if (a.unlocked === false || t === 0) return 'locked';
      if (t === 1) return 'bronze';
      if (t === 2) return 'silver';
      if (t === 3) return 'gold';
      if (a.icon === 'bronze') return 'bronze';
      if (a.icon === 'silver') return 'silver';
      if (a.icon === 'gold') return 'gold';
      return a.unlocked ? 'bronze' : 'locked';
    };
    const setAchievementIcon = (imgEl, a) => {
      const key = a.key || a.code || a.group || a.iconKey || slugify(a.name||'');
      const base = '/static/img/achievements/';
      const state = stateFromTier(a);
      const candidates = [];
      if (key) candidates.push(`${base}${slugify(key)}-${state}.png`);
      if (key && a.icon) candidates.push(`${base}${slugify(key)}-${slugify(a.icon)}.png`);
      candidates.push(`${base}${state}.png`);
      candidates.push(`${base}placeholder.png`);
      const svgFallbacks = candidates.map(p => p.replace(/\.png$/i, '.svg'));
      svgFallbacks.forEach(s => { if(!candidates.includes(s)) candidates.push(s); });
      let i=0; const next=()=>{ if(i>=candidates.length) return; imgEl.onerror=()=>{ i++; next(); }; imgEl.src=candidates[i]; }; next();
    };
    const descFor = (a) => {
      try {
        switch(a.group){
          case 'streak': return `Дней подряд`;
          case 'credits': return `Кредитов накоплено`;
          case 'level': return `Достигнут уровень`;
          case 'invited': return `Друзей приглашено`;
          case 'betcount': return `Ставок сделано`;
          case 'betwins': return `Ставок выиграно`;
          default: return a.description || a.desc || '';
        }
      } catch(_) { return a.description || ''; }
    };
    achievements.forEach(a => {
      const card = document.createElement('div'); card.className='achievement-card';
      if(!a.unlocked) card.classList.add('locked');
      const img=document.createElement('img'); img.alt=a.name||''; setAchievementIcon(img,a);
      const name=document.createElement('div'); name.className='badge-name'; name.textContent=a.name||'';
      const req=document.createElement('div'); req.className='badge-requirements'; 
      
      // Улучшенное отображение прогресса и требований
      if(a.value !== undefined && (a.target !== undefined || a.next_target !== undefined)) {
        const currentValue = a.value || 0;
        let currentTarget = a.target || 0;
        let nextTarget = a.next_target;
        
        console.debug(`Processing achievement: ${a.name} (${a.group}), value: ${currentValue}, original target: ${currentTarget}, next: ${nextTarget}`);
        
        // Специальная логика для разных типов достижений с правильными целями
        if (a.group === 'streak') {
          const streakTargets = [7, 30, 120]; // Правильные цели для streak
          
          // Находим текущую и следующую цель
          let currentTargetIndex = streakTargets.findIndex(target => currentValue < target);
          if (currentTargetIndex === -1) {
            // Достигли максимальной цели
            currentTarget = streakTargets[streakTargets.length - 1];
            nextTarget = null;
          } else {
            currentTarget = streakTargets[currentTargetIndex];
            nextTarget = streakTargets[currentTargetIndex + 1] || null;
          }
        } else if (a.group === 'betcount') {
          const betTargets = [10, 50, 200]; // Цели для количества ставок
          
          let currentTargetIndex = betTargets.findIndex(target => currentValue < target);
          if (currentTargetIndex === -1) {
            currentTarget = betTargets[betTargets.length - 1];
            nextTarget = null;
          } else {
            currentTarget = betTargets[currentTargetIndex];
            nextTarget = betTargets[currentTargetIndex + 1] || null;
          }
        } else if (a.group === 'credits') {
          const creditTargets = [1000, 5000, 20000]; // Цели для кредитов
          
          let currentTargetIndex = creditTargets.findIndex(target => currentValue < target);
          if (currentTargetIndex === -1) {
            currentTarget = creditTargets[creditTargets.length - 1];
            nextTarget = null;
          } else {
            currentTarget = creditTargets[currentTargetIndex];
            nextTarget = creditTargets[currentTargetIndex + 1] || null;
          }
        } else if (a.group === 'invited') {
          const inviteTargets = [1, 5, 20]; // Цели для приглашений
          
          let currentTargetIndex = inviteTargets.findIndex(target => currentValue < target);
          if (currentTargetIndex === -1) {
            currentTarget = inviteTargets[inviteTargets.length - 1];
            nextTarget = null;
          } else {
            currentTarget = inviteTargets[currentTargetIndex];
            nextTarget = inviteTargets[currentTargetIndex + 1] || null;
          }
        }
        
        console.debug(`After processing: target: ${currentTarget}, next: ${nextTarget}`);
        
        // Простая логика отображения прогресса
        let displayTarget = currentTarget;
        let progressValue = currentValue;
        let isCompleted = false;
        
        // Если достигли текущую цель и есть следующая
        if (currentValue >= currentTarget && nextTarget && nextTarget > currentTarget) {
          displayTarget = nextTarget;
          progressValue = currentValue;
          isCompleted = false;
        } else if (currentValue >= currentTarget && !nextTarget) {
          // Достигли финальную цель
          displayTarget = currentTarget;
          progressValue = currentTarget;
          isCompleted = true;
        } else {
          // Ещё не достигли текущую цель
          displayTarget = currentTarget;
          progressValue = currentValue;
          isCompleted = false;
        }
        
        // Текст с прогрессом - более понятный и простой
        const baseDesc = descFor(a);
        if (isCompleted) {
          req.textContent = `${baseDesc} ✅ Завершено (${currentValue})`;
        } else {
          req.textContent = `${baseDesc}: ${progressValue}/${displayTarget}`;
        }
        
        // Прогресс-бар - простая логика
        const progressContainer = document.createElement('div'); 
        progressContainer.className='achv-progress-container';
        const progressBar = document.createElement('div'); 
        progressBar.className='achv-progress-bar';
        
        let progressPercent = 0;
        if (isCompleted) {
          progressPercent = 100;
        } else {
          // Простой расчет процента
          progressPercent = Math.min(100, (progressValue / displayTarget) * 100);
        }
        
        progressBar.style.width = progressPercent + '%';
        progressContainer.appendChild(progressBar);
        card.append(img,name,req,progressContainer);
      } else {
        req.textContent = descFor(a);
        card.append(img,name,req);
      }
      
      badgesContainer.appendChild(card);
    });
  }
  
  function fetchAchievements(){
    if(_loadedOnce) return Promise.resolve([]);
    if(_inFlightPromise) return _inFlightPromise;
    const send=(init)=> fetch('/api/achievements',{ method:'POST', body: init })
      .then(r=>r.json())
      .then(data=>{ 
        console.debug('achievements raw data',data); 
        if (data.achievements) {
          data.achievements.forEach(a => {
            console.debug(`Achievement: ${a.name}, group: ${a.group}, value: ${a.value}, target: ${a.target}, next_target: ${a.next_target}`);
          });
        }
        _loadedOnce=true; 
        _inFlightPromise = null;
        renderAchievements(data.achievements||[]); 
        return data.achievements||[]; 
      }).catch(err=>{
        _inFlightPromise = null;
        throw err;
      });
    const fd=new FormData(); fd.append('initData', (tg && (tg.initData||tg.initDataUnsafe?.user ? tg.initData : tg?.initData)) || '');
    _inFlightPromise = send(fd).catch(err=>{ console.error('achievements load error',err); renderAchievements([]); return []; });
    return _inFlightPromise;
  }
  // Автозагрузка при готовности профиля и при клике на вкладку "Достижения"
  window.addEventListener('profile:user-loaded', ()=>{ try { const active = document.querySelector('.subtab-item.active[data-psub="badges"]'); if(active) fetchAchievements(); } catch(_) {} });
  document.addEventListener('click', e=>{ const tab = e.target.closest('.subtab-item[data-psub="badges"]'); if(tab) setTimeout(()=>fetchAchievements(), 30); });
  // Если вкладка активна сразу (по умолчанию)
  document.addEventListener('DOMContentLoaded', ()=>{ const active = document.querySelector('.subtab-item.active[data-psub="badges"]'); if(active) fetchAchievements(); });

  window.ProfileAchievements = { fetchAchievements, renderAchievements, forceReload: ()=>{ _loadedOnce=false; return fetchAchievements(); } };
})();
