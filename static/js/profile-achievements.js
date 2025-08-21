// profile-achievements.js
// Загрузка и рендер достижений
(function(){
  if (window.ProfileAchievements) return;
  const tg = window.Telegram?.WebApp || null;
  const badgesContainer = document.getElementById('badges');
  const achievementPlaceholder = document.getElementById('achievement-placeholder');

  function renderAchievements(achievements){
    if (achievementPlaceholder) achievementPlaceholder.remove();
    if (!badgesContainer) return;
    badgesContainer.innerHTML='';
    if(!achievements || !achievements.length) return;
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
      card.classList.add(a.unlocked? '':'locked');
      const img=document.createElement('img'); img.alt=a.name||''; setAchievementIcon(img,a);
      const name=document.createElement('div'); name.className='badge-name'; name.textContent=a.name||'';
      const req=document.createElement('div'); req.className='badge-requirements'; req.textContent=descFor(a);
      card.append(img,name,req); badgesContainer.appendChild(card);
    });
  }

  function fetchAchievements(){
    if(!tg || !tg.initDataUnsafe?.user){ renderAchievements([]); return Promise.resolve([]); }
    const fd = new FormData(); fd.append('initData', tg.initData || '');
    return fetch('/api/achievements',{ method:'POST', body: fd })
      .then(r=>r.json())
      .then(data => { renderAchievements(data.achievements||[]); return data.achievements||[]; })
      .catch(err => { console.error('achievements load error', err); renderAchievements([]); return []; });
  }

  window.ProfileAchievements = { fetchAchievements, renderAchievements };
})();
