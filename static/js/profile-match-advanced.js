// Advanced match details screen (admin controls, events, rosters, stats, finish button, comments)
// Extracted from legacy profile.js
(function(){
  function openMatchScreen(match, details){
    try { window.__CURRENT_MATCH_KEY__ = `${(match?.home||'').toLowerCase().trim()}__${(match?.away||'').toLowerCase().trim()}__${((match?.datetime||match?.date||'').toString().slice(0,10))}`; } catch(_) {}
    const schedulePane = document.getElementById('ufo-schedule');
    const mdPane = document.getElementById('ufo-match-details');
    if (!schedulePane || !mdPane) return;
    try {
      const tablePane = document.getElementById('ufo-table');
      const statsPaneLeague = document.getElementById('ufo-stats');
      const resultsPane = document.getElementById('ufo-results');
      [tablePane, statsPaneLeague, schedulePane, resultsPane].forEach(p => { if (p) p.style.display='none'; });
    } catch(_) {}
    try { mdPane.querySelectorAll('.admin-score-ctrls').forEach(n=>n.remove()); } catch(_) {}
    schedulePane.style.display='none'; mdPane.style.display='';
    try { document.getElementById('ufo-subtabs').style.display='none'; } catch(_) {}
    const hLogo=document.getElementById('md-home-logo'); const aLogo=document.getElementById('md-away-logo');
    const hName=document.getElementById('md-home-name'); const aName=document.getElementById('md-away-name');
    const score=document.getElementById('md-score'); const dt=document.getElementById('md-datetime');
    const homePane=document.getElementById('md-pane-home'); const awayPane=document.getElementById('md-pane-away');
    const setLogo=(imgEl,name)=>{ const base='/static/img/team-logos/'; const candidates=[]; if(name){ const norm=name.toLowerCase().replace(/\s+/g,'').replace(/ё/g,'е'); candidates.push(base+encodeURIComponent(norm+'.png')+`?v=${Date.now()}`);} candidates.push(base+'default.png'+`?v=${Date.now()}`); let i=0; const next=()=>{ if(i>=candidates.length)return; imgEl.onerror=()=>{ i++; next(); }; imgEl.src=candidates[i]; }; next(); };
    hName.setAttribute('data-team-name', match.home || ''); aName.setAttribute('data-team-name', match.away || '');
    hName.textContent = (window.withTeamCount?window.withTeamCount(match.home||''):(match.home||''));
    aName.textContent = (window.withTeamCount?window.withTeamCount(match.away||''):(match.away||''));
    setLogo(hLogo, match.home||''); setLogo(aLogo, match.away||''); score.textContent='— : —';
    try { if (match.date || match.time){ const d=match.date? new Date(match.date):null; const ds=d?d.toLocaleDateString():''; dt.textContent = `${ds}${match.time? ' '+match.time:''}`; } else dt.textContent=''; } catch(_) { dt.textContent = match.time||''; }
    const subtabs = mdPane.querySelector('.modal-subtabs');
    try { const mkKey=(o)=>{ const h=(o?.home||'').toLowerCase().trim(); const a=(o?.away||'').toLowerCase().trim(); const raw=o?.date?String(o.date):(o?.datetime?String(o.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; }; mdPane.setAttribute('data-match-key', mkKey(match)); const oldTab=subtabs?.querySelector('[data-mdtab="stream"]'); if(oldTab) oldTab.remove(); const oldPane=document.getElementById('md-pane-stream'); if(oldPane) oldPane.remove(); } catch(_) {}
    mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach(el=>el.classList.remove('active'));
    try { const tabHome=subtabs?.querySelector('[data-mdtab="home"]'); const tabAway=subtabs?.querySelector('[data-mdtab="away"]'); if(tabHome) tabHome.textContent=(match.home||'Команда 1'); if(tabAway) tabAway.textContent=(match.away||'Команда 2'); } catch(_) {}
    let specialsPane=document.getElementById('md-pane-specials'); if(!specialsPane){ specialsPane=document.createElement('div'); specialsPane.id='md-pane-specials'; specialsPane.className='md-pane'; specialsPane.style.display='none'; mdPane.querySelector('.modal-body')?.appendChild(specialsPane); }
    try { const toursCache=JSON.parse(localStorage.getItem('betting:tours')||'null'); const tours=toursCache?.data?.tours || toursCache?.tours || []; const mkKey=(o)=>{ const h=(o?.home||'').toLowerCase().trim(); const a=(o?.away||'').toLowerCase().trim(); const raw=o?.date?String(o.date):(o?.datetime?String(o.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; }; const present=new Set(); tours.forEach(t=>(t.matches||[]).forEach(x=>present.add(mkKey(x)))); const thisKey=mkKey(match); const adminId=document.body.getAttribute('data-admin'); const currentId=window.Telegram?.WebApp?.initDataUnsafe?.user?.id?String(window.Telegram.WebApp.initDataUnsafe.user.id):''; const isAdmin=!!(adminId && currentId && String(adminId)===currentId); const existed=subtabs?.querySelector('[data-mdtab="specials"]'); if (present.has(thisKey) && isAdmin){ if(!existed){ const sp=document.createElement('div'); sp.className='subtab-item'; sp.setAttribute('data-mdtab','specials'); sp.textContent='Спецсобытия'; subtabs.appendChild(sp); } } else if (existed){ existed.remove(); } } catch(_) {}
  // Интеграция трансляции через legacy Streams (если MatchStream модуль отсутствует)
  let streamPane=null;
  try {
    // Сначала новый модуль, создаёт пустую панель (без вкладки)
    if (window.MatchStream && typeof window.MatchStream.setup==='function') {
      streamPane = window.MatchStream.setup(mdPane, subtabs, match);
    }
  } catch(_) {}
  try {
    // Затем всегда пытаемся создать вкладку/скелет через Streams (он добавляет subtab)
    if (window.Streams && typeof window.Streams.setupMatchStream==='function') {
      const hasTab = subtabs?.querySelector('[data-mdtab="stream"]');
      if (!hasTab) {
        streamPane = window.Streams.setupMatchStream(mdPane, subtabs, match) || streamPane;
      }
    }
  } catch(_) {}
  let statsPane=document.getElementById('md-pane-stats'); if(!statsPane){ statsPane=document.createElement('div'); statsPane.id='md-pane-stats'; statsPane.className='md-pane'; statsPane.style.display='none'; mdPane.querySelector('.modal-body')?.appendChild(statsPane); }
  if(!subtabs.querySelector('[data-mdtab="stats"]')){ const st=document.createElement('div'); st.className='subtab-item'; st.setAttribute('data-mdtab','stats'); st.textContent='Статистика'; subtabs.appendChild(st); }
    mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
  homePane.style.display=''; awayPane.style.display='none'; specialsPane.style.display='none'; if(streamPane) streamPane.style.display='none'; statsPane.style.display='none';
  // Delegate roster & events rendering
  try { if(window.MatchRostersEvents?.render) { window.MatchRostersEvents.render(match, details, mdPane, { homePane, awayPane }); } } catch(_) {}
  // live score + admin inline ctrls delegated
  let liveScoreCtx = null;
  try { if(window.MatchLiveScore?.setup){ liveScoreCtx = window.MatchLiveScore.setup(match,{ scoreEl:score, dtEl:dt, mdPane }); } } catch(_){ }
  // preload stats & specials (modular)
  try { if(window.MatchStats?.render) window.MatchStats.render(statsPane, match); } catch(e){ console.error('preload stats err', e); }
  try { if(window.MatchSpecials?.render) window.MatchSpecials.render(specialsPane, match); } catch(e){ console.error('preload specials err', e); }
    mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach(btn=>{ btn.onclick=()=>{ mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); const key=btn.getAttribute('data-mdtab'); if(key!=='stream'){ try { document.body.classList.remove('allow-landscape'); } catch(_){} }
      if(key==='home'){ homePane.style.display=''; awayPane.style.display='none'; specialsPane.style.display='none'; statsPane.style.display='none'; }
      else if(key==='away'){ homePane.style.display='none'; awayPane.style.display=''; specialsPane.style.display='none'; statsPane.style.display='none'; }
      else if(key==='specials'){ homePane.style.display='none'; awayPane.style.display='none'; specialsPane.style.display=''; try { if(window.MatchSpecials?.render) window.MatchSpecials.render(specialsPane, match); } catch(e){ console.error('specials render err', e); } statsPane.style.display='none'; }
      else if(key==='stream'){
        homePane.style.display='none'; awayPane.style.display='none'; specialsPane.style.display='none'; statsPane.style.display='none';
        // Если есть новый модуль MatchStream
  // Обновляем (на случай ленивой загрузки) и MatchStream, и Streams
  if(window.MatchStream?.setup){ try { streamPane = window.MatchStream.setup(mdPane, subtabs, match) || streamPane; } catch(_){} }
  if(window.Streams?.setupMatchStream){ try { const hadTab = !!subtabs.querySelector('[data-mdtab="stream"]'); streamPane = window.Streams.setupMatchStream(mdPane, subtabs, match) || streamPane; if(!hadTab) {/* tab now created */} } catch(_){} }
        if(streamPane){
          try {
            if(window.MatchStream && typeof window.MatchStream.activate==='function'){
              window.MatchStream.activate(streamPane, match);
            } else if(window.Streams && typeof window.Streams.onStreamTabActivated==='function') {
              window.Streams.onStreamTabActivated(streamPane, match);
            }
          } catch(_){}
        } else {
          // Нет панели (ещё не подтянулась ссылка) — откат на вкладку home
          btn.classList.remove('active');
          const homeTab=mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]');
          if(homeTab){ homeTab.classList.add('active'); homePane.style.display=''; awayPane.style.display='none'; specialsPane.style.display='none'; statsPane.style.display='none'; }
        }
      }
      else if(key==='stats'){ homePane.style.display='none'; awayPane.style.display='none'; specialsPane.style.display='none'; statsPane.style.display=''; try { if(window.MatchStats?.render) window.MatchStats.render(statsPane, match); } catch(e){ console.error('stats render err', e); } }
    }; });
  // Removed legacy subtabs stream delegation (handled above with MatchStream)
    try { const adminId=document.body.getAttribute('data-admin'); const currentId=window.Telegram?.WebApp?.initDataUnsafe?.user?.id?String(window.Telegram.WebApp.initDataUnsafe.user.id):''; const isAdmin=!!(adminId && currentId && String(adminId)===currentId); const topbar=mdPane.querySelector('.match-details-topbar'); if(isAdmin && topbar){ const prev=topbar.querySelector('#md-finish-btn'); if(prev) prev.remove(); if(mdPane.__finishBtnTimer){ try { clearInterval(mdPane.__finishBtnTimer); } catch(_){} mdPane.__finishBtnTimer=null; } const btn=document.createElement('button'); btn.id='md-finish-btn'; btn.className='details-btn'; btn.textContent='Завершить матч'; btn.style.marginLeft='auto'; const finStore=(window.__FINISHED_MATCHES=window.__FINISHED_MATCHES||{}); const mkKey2=(m)=>{ try { const dateStr=(m?.datetime||m?.date||'').toString().slice(0,10); return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${dateStr}`; } catch(_) { return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__`; } }; const mKey=mkKey2(match); const isLiveNow=(mm)=>(window.MatchUtils?window.MatchUtils.isLiveNow(mm):false); const applyVisibility=()=>{ btn.style.display=(!finStore[mKey] && isLiveNow(match))? '':'none'; }; applyVisibility(); mdPane.__finishBtnTimer=setInterval(applyVisibility,30000); const confirmFinish=()=>new Promise(resolve=>{ let ov=document.querySelector('.modal-overlay'); if(!ov){ ov=document.createElement('div'); ov.className='modal-overlay'; ov.style.position='fixed'; ov.style.inset='0'; ov.style.background='rgba(0,0,0,0.6)'; ov.style.zIndex='9999'; ov.style.display='flex'; ov.style.alignItems='center'; ov.style.justifyContent='center'; const box=document.createElement('div'); box.className='modal-box'; box.style.background='rgba(20,24,34,0.98)'; box.style.border='1px solid rgba(255,255,255,0.12)'; box.style.borderRadius='14px'; box.style.width='min(92vw,420px)'; box.style.padding='14px'; box.innerHTML='<div style="font-weight:700; font-size:16px; margin-bottom:8px;">Завершить матч?</div><div style="opacity:.9; font-size:13px; line-height:1.35; margin-bottom:12px;">Счёт будет записан, ставки рассчитаны. Продолжить?</div><div style="display:flex; gap:8px; justify-content:flex-end;"><button class="app-btn neutral" id="mf-cancel">Отмена</button><button class="app-btn danger" id="mf-ok">Завершить</button></div>'; ov.appendChild(box); document.body.appendChild(ov); box.querySelector('#mf-cancel').onclick=()=>{ ov.remove(); resolve(false); }; box.querySelector('#mf-ok').onclick=()=>{ ov.remove(); resolve(true); }; } else { resolve(false); } }); const fullRefresh=async()=>{ try { const tg=window.Telegram?.WebApp||null; const fd=new FormData(); fd.append('initData', tg?.initData||''); await Promise.allSettled([ fetch('/api/league-table/refresh',{ method:'POST', body:fd }), fetch('/api/stats-table/refresh',{ method:'POST', body:fd }), fetch('/api/schedule/refresh',{ method:'POST', body:fd }), fetch('/api/results/refresh',{ method:'POST', body:fd }) ]); try { window.loadLeagueTable?.(); } catch(_){} try { window.loadResults?.(); } catch(_){} try { window.loadSchedule?.(); } catch(_){} } catch(_){} }; btn.addEventListener('click', async()=>{ const ok=await confirmFinish(); if(!ok) return; const tg=window.Telegram?.WebApp||null; btn.disabled=true; const old=btn.textContent; btn.textContent='Завершаю...'; try { const fd=new FormData(); fd.append('initData', tg?.initData||''); fd.append('home', match.home||''); fd.append('away', match.away||''); const r=await fetch('/api/match/settle',{ method:'POST', body:fd }); const d=await r.json().catch(()=>({})); if(!r.ok || d?.error) throw new Error(d?.error||'Ошибка завершения'); try { window.showAlert?.('Матч завершён','success'); } catch(_){} try { const dateStr=(match?.datetime||match?.date||'').toString().slice(0,10); const key=`stream:${(match.home||'').toLowerCase().trim()}__${(match.away||'').toLowerCase().trim()}__${dateStr}`; localStorage.removeItem(key); const sp=document.getElementById('md-pane-stream'); if(sp){ sp.style.display='none'; sp.innerHTML='<div class="stream-wrap"><div class="stream-skeleton">Трансляция недоступна</div></div>'; } } catch(_){} try { finStore[mKey]=true; } catch(_){} await fullRefresh(); try { btn.style.display='none'; const statusEl=mdPane.querySelector('.match-details-topbar .status-text'); if(statusEl) statusEl.textContent='Матч завершен'; } catch(_){} } catch(e){ console.error('finish match error', e); try { window.showAlert?.(e?.message||'Ошибка','error'); } catch(_){} } finally { btn.disabled=false; btn.textContent=old; } }); topbar.appendChild(btn); } } catch(_){}
  // finish button delegated
  let adminCtx=null; try { if(window.MatchAdmin?.setup){ adminCtx=window.MatchAdmin.setup(match,{ mdPane }); } } catch(_){}
  const back=document.getElementById('match-back'); if(back) back.onclick=()=>{ homePane.innerHTML=''; awayPane.innerHTML=''; try { if(adminCtx) adminCtx.cleanup(); } catch(_){} try { if(liveScoreCtx) liveScoreCtx.cleanup(); } catch(_){} try { if(window.Streams?.resetOnLeave) window.Streams.resetOnLeave(mdPane); } catch(_){} try { const spLeak=document.getElementById('md-pane-stream'); if(spLeak) spLeak.classList.remove('fs-mode'); } catch(_){} try { document.body.classList.remove('allow-landscape'); } catch(_){} mdPane.style.display='none'; schedulePane.style.display=''; window.scrollTo({ top:0, behavior:'smooth' }); try { document.getElementById('ufo-subtabs').style.display=''; } catch(_){} };
  }
  window.MatchAdvanced = { openMatchScreen };
  try { window.openMatchScreen = openMatchScreen; } catch(_) {}
})();
