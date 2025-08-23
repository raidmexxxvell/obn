// profile-achievements.js
// Загрузка и рендер достижений
(function(){
  if (window.ProfileAchievements) return;
  const tg = window.Telegram?.WebApp || null;
  const badgesContainer = document.getElementById('badges');
  const achievementPlaceholder = document.getElementById('achievement-placeholder');
  let _loadedOnce = false;

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
        const tgt=a.target; const all=Array.isArray(a.all_targets)?a.all_targets:null;
        switch(a.group){
          case 'streak': return `Ежедневные чекины подряд. Цели: ${(all||[7,30,120]).join(' / ')}.`;
          case 'credits': return `Накопите кредиты.${all? ' Цели: '+all.join(' / ')+'.':''}`;
          case 'level': return `Достигайте уровни.${all? ' Цели: '+all.join(' / ')+'.':''}`;
          case 'invited': return `Приглашайте друзей.${all? ' Цели: '+all.join(' / ')+'.':''}`;
          case 'betcount': return `Сделайте ставки.${all? ' Цели: '+all.join(' / ')+'.':''}`;
          case 'betwins': return `Выигрывайте ставки.${all? ' Цели: '+all.join(' / ')+'.':''}`;
          default: return a.description || a.desc || '';
        }
      } catch(_) { return a.description || ''; }
    };
    achievements.forEach(a => {
      const card = document.createElement('div'); card.className='achievement-card';
      if(!a.unlocked) card.classList.add('locked');
      const img=document.createElement('img'); img.alt=a.name||''; setAchievementIcon(img,a);
      const name=document.createElement('div'); name.className='badge-name'; name.textContent=a.name||'';
      const req=document.createElement('div'); req.className='badge-requirements'; req.textContent=descFor(a);
      
      // Добавляем прогресс-бар
      if(a.value !== undefined && a.target !== undefined) {
        const progressContainer = document.createElement('div'); progressContainer.className='achv-progress-container';
        const progressBar = document.createElement('div'); progressBar.className='achv-progress-bar';
        const progress = Math.min(100, Math.max(0, (a.value / a.target) * 100));
        progressBar.style.width = progress + '%';
        progressContainer.appendChild(progressBar);
        card.append(img,name,req,progressContainer);
      } else {
        card.append(img,name,req);
      }
      
      badgesContainer.appendChild(card);
    });
  }
  function fetchAchievements(){
    if(_loadedOnce) return Promise.resolve([]);
    const send=(init)=> fetch('/api/achievements',{ method:'POST', body: init }).then(r=>r.json()).then(data=>{ console.debug('achievements data',data); _loadedOnce=true; renderAchievements(data.achievements||[]); return data.achievements||[]; });
    if(!tg || !tg.initDataUnsafe?.user){ const fd=new FormData(); fd.append('initData', tg?.initData||''); return send(fd).catch(err=>{ console.error('achievements load error (no tg user)',err); renderAchievements([]); return []; }); }
    const fd=new FormData(); fd.append('initData', tg.initData||''); return send(fd).catch(err=>{ console.error('achievements load error',err); renderAchievements([]); return []; });
  }
  // Автозагрузка при готовности профиля и при клике на вкладку "Достижения"
  window.addEventListener('profile:user-loaded', ()=>{ try { const active = document.querySelector('.subtab-item.active[data-psub="badges"]'); if(active) fetchAchievements(); } catch(_) {} });
  document.addEventListener('click', e=>{ const tab = e.target.closest('.subtab-item[data-psub="badges"]'); if(tab) setTimeout(()=>fetchAchievements(), 30); });
  // Если вкладка активна сразу (по умолчанию)
  document.addEventListener('DOMContentLoaded', ()=>{ const active = document.querySelector('.subtab-item.active[data-psub="badges"]'); if(active) fetchAchievements(); });

  window.ProfileAchievements = { fetchAchievements, renderAchievements, forceReload: ()=>{ _loadedOnce=false; return fetchAchievements(); } };
})();
