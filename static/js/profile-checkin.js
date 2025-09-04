// profile-checkin.js
// Ежедневный чек-ин: рендер календаря, получение награды, анимации
(function(){
  if (window.ProfileCheckin) return;
  const tg = window.Telegram?.WebApp || null;
  const elements = {
    checkinDays: document.getElementById('checkin-days'),
    checkinBtn: document.getElementById('checkin-btn'),
    checkinStatus: document.getElementById('checkin-status'),
    currentStreak: document.getElementById('current-streak'),
  };

  function getUser(){ return (window.ProfileUser && window.ProfileUser.getLastUser && window.ProfileUser.getLastUser()) || null; }

  function renderCheckinSection(user){
    if (!user || !elements.checkinDays) return;
    elements.checkinDays.innerHTML='';
    const today = new Date().toISOString().split('T')[0];
    const lastCheckin = (user.last_checkin_date||'').split('T')[0];
    const checkedToday = lastCheckin === today;
    // Определяем был ли пропуск (более 1 календарного дня)
    let gapBroken = false;
    if (lastCheckin && !checkedToday){
      try {
        const dLast = new Date(lastCheckin+ 'T00:00:00Z');
        const dToday = new Date(today + 'T00:00:00Z');
        const diffDays = Math.floor((dToday - dLast)/86400000);
        if (diffDays > 1) gapBroken = true; // streak сброшен
      } catch(_) {}
    }
    const mod = (user.consecutive_days||0) % 7;
    const completedCount = (checkedToday ? (mod === 0 ? 7 : mod) : mod);
    // Если серия сброшена gapBroken, активный день всегда 1
    const activeDay = gapBroken ? 1 : (checkedToday ? null : (mod + 1));
    if (elements.currentStreak) elements.currentStreak.textContent = user.consecutive_days || 0;
    for (let i=1;i<=7;i++){
      const d=document.createElement('div');
      d.className='checkin-day'; d.textContent=i;
      if (!gapBroken){
        if (i <= completedCount) d.classList.add('completed');
        else if (activeDay && i===activeDay) d.classList.add('active');
      } else {
        // При сбросе показываем только первый день как active-reset
        if (i===1) d.classList.add('active','reset-start');
      }
      elements.checkinDays.appendChild(d);
    }
    if (gapBroken && !checkedToday){
      if (elements.checkinBtn) elements.checkinBtn.disabled=false;
      if (elements.checkinStatus){
        elements.checkinStatus.textContent='Серия прервана — начните заново';
        elements.checkinStatus.style.color='var(--warning, #ffb347)';
      }
    } else if (checkedToday){
      if (elements.checkinBtn) elements.checkinBtn.disabled=true;
      if (elements.checkinStatus) elements.checkinStatus.textContent='✅ Награда получена сегодня';
    } else {
      if (elements.checkinBtn) elements.checkinBtn.disabled=false;
      if (elements.checkinStatus) elements.checkinStatus.textContent='';
    }
  }

  function uiError(msg){
    try { window.showAlert?.(msg,'error'); } catch(_) {}
    if (elements.checkinStatus){ elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color='var(--danger)'; setTimeout(()=>{ if(elements.checkinStatus){ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; } },3000); }
  }
  function uiSuccess(msg){
    try { window.showAlert?.(msg,'success'); } catch(_) {}
    if (elements.checkinStatus){ elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color='var(--success)'; setTimeout(()=>{ if(elements.checkinStatus){ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; } },2000); }
  }

  function animateStats(xpGain, creditsGain){
    try {
      const xpElement = document.querySelector('.stat-value[data-stat="xp"]') || document.getElementById('xp');
      const creditsElement = document.querySelector('.stat-value[data-stat="credits"]') || document.getElementById('credits');
      // Получаем текущие значения профиля (для корректного расчёта прогресса уровня)
      const user = (window.ProfileUser && window.ProfileUser.getLastUser && window.ProfileUser.getLastUser()) || null;
      if (window.CounterAnimation && user){
        // Текущий уровень и XP
        let level = user.level || 1;
        let totalXpBefore = user.xp || 0;
        const totalXpAfter = totalXpBefore + xpGain;
        // Функция для вычисления отображаемых данных
        function levelMeta(total){
          let lvl = 1; let remain = total; let need = 100; // формула: уровень N требует N*100 для перехода на N+1
          while(true){
            need = lvl * 100;
            if (remain < need) return { lvl, cur: remain, need };
            remain -= need; lvl++;
            if (lvl>500) return { lvl:500, cur:0, need:500*100 }; // предохранитель
          }
        }
        const beforeMeta = levelMeta(totalXpBefore);
        const afterMeta = levelMeta(totalXpAfter);
        if (xpElement){
          // Анимируем не просто число, а плавно переход, включая возможный апгрейд уровня
          const steps = 30; const duration = 1200; const start = performance.now();
          function frame(now){
            const p = Math.min(1, (now-start)/duration);
            const eased = 1 - Math.pow(1-p,3);
            const curTotal = totalXpBefore + (xpGain * eased);
            const m = levelMeta(curTotal);
            xpElement.textContent = `${Math.round(m.cur)}/${m.need}`;
            // Обновляем полоску прогресса если есть
            try { const bar = document.getElementById('xp-progress'); if(bar) bar.style.width = `${Math.min(100, (m.cur/m.need)*100)}%`; } catch(_) {}
            try { const lvlEl = document.getElementById('level'); const clEl=document.getElementById('current-level'); if (lvlEl) lvlEl.textContent = m.lvl; if(clEl) clEl.textContent = m.lvl; } catch(_) {}
            if (p<1) requestAnimationFrame(frame); else {
              xpElement.textContent = `${afterMeta.cur}/${afterMeta.need}`;
            }
          }
          requestAnimationFrame(frame);
        }
        if (creditsElement){
          const curCr = parseInt((creditsElement.textContent||'0').replace(/\D/g,''))||0;
            window.CounterAnimation.animate(creditsElement, curCr, curCr + creditsGain, 1200, v=>Math.round(v).toLocaleString());
        }
      } else if (window.CounterAnimation) {
        // fallback прежнее поведение
        if (xpElement){
          const parts = xpElement.textContent.split('/');
          const curXP = parseInt(parts[0]) || 0;
          window.CounterAnimation.animate(xpElement, curXP, curXP + xpGain, 1200, v=>`${Math.round(v)}/${parts[1]||100}`);
        }
        if (creditsElement){
          const curCr = parseInt((creditsElement.textContent||'0').replace(/\D/g,''))||0;
          window.CounterAnimation.animate(creditsElement, curCr, curCr + creditsGain, 1200, v=>Math.round(v).toLocaleString());
        }
      }
      if (window.UIAnimations){ if (xpElement) window.UIAnimations.pulse(xpElement); if (creditsElement) window.UIAnimations.pulse(creditsElement); }
    } catch(e){ console.warn('animateStats fail', e); }
  }

  function showRewardAnimation(xp, credits){
    if (!elements.checkinStatus) return;
    if (window.RewardAnimation){
      window.RewardAnimation.show(document.body, xp, credits).then(()=>{
        if (elements.checkinStatus){ elements.checkinStatus.textContent='Награда получена!'; elements.checkinStatus.style.color='var(--success)'; setTimeout(()=>{ if(elements.checkinStatus){ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; } },3000); }
        animateStats(xp, credits);
      });
    } else {
      elements.checkinStatus.innerHTML = `<div class="reward-animation">+${xp} XP | +${credits} кредитов</div>`;
      setTimeout(()=>{ if(elements.checkinStatus) elements.checkinStatus.textContent='Награда получена!'; },2000);
    }
  }

  function handleCheckin(){
    if (!elements.checkinBtn) return;
    elements.checkinBtn.disabled = true;
    if (elements.checkinStatus) elements.checkinStatus.textContent='Обработка...';
    if (!tg || !tg.initDataUnsafe?.user){ uiError('Невозможно выполнить чекин без Telegram WebApp'); if(elements.checkinBtn) elements.checkinBtn.disabled=false; return; }
    const fd = new FormData(); fd.append('initData', tg.initData || '');
    fetch('/api/checkin',{ method:'POST', body: fd })
      .then(res=>{ if(res.status===401){ uiError('Ошибка авторизации'); throw new Error('unauth'); } return res.json(); })
      .then(data=>{ if(!data) return; if(data.status==='already_checked'){ if(elements.checkinStatus) elements.checkinStatus.textContent='✅ Награда получена сегодня'; return; } showRewardAnimation(data.xp, data.credits); return window.ProfileUser.fetchUserData(); })
      .then(u=>{ if(u) renderCheckinSection(u); })
      .catch(err=>{ console.error('checkin err', err); uiError('Ошибка получения награды'); if(elements.checkinBtn) elements.checkinBtn.disabled=false; });
  }

  function attach(){ if(elements.checkinBtn){ elements.checkinBtn.addEventListener('click', handleCheckin); elements.checkinBtn.setAttribute('data-throttle','2000'); } }

  // Событие из ProfileUser
  window.addEventListener('profile:user-loaded', e=>{ try { renderCheckinSection(e.detail); } catch(_) {} });
  // Если данные уже загружены к моменту старта
  document.addEventListener('DOMContentLoaded', ()=>{ const u=getUser(); if(u) renderCheckinSection(u); attach(); });

  window.ProfileCheckin = { renderCheckinSection, handleCheckin };
})();
