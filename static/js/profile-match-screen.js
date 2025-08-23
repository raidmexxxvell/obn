// profile-match-screen.js
// ВЫРЕЗКА: openMatchScreen и упрощённая логика экрана деталей матча
(function(){
  if (window.openMatchScreen) return;
  function withTeamCount(n){ try { return window.withTeamCount? window.withTeamCount(n): n; } catch(_) { return n; } }
  function openMatchScreen(match, details){
    try { window.__CURRENT_MATCH_KEY__ = `${(match?.home||'').toLowerCase().trim()}__${(match?.away||'').toLowerCase().trim()}__${((match?.datetime||match?.date||'').toString().slice(0,10))}`; } catch(_) {}
    const schedulePane = document.getElementById('ufo-schedule');
    const mdPane = document.getElementById('ufo-match-details');
    if (!schedulePane || !mdPane) return;
    try { ['ufo-table','ufo-stats','ufo-results','ufo-schedule'].forEach(id=>{ const p=document.getElementById(id); if(p) p.style.display='none'; }); } catch(_) {}
    try { mdPane.querySelectorAll('.admin-score-ctrls').forEach(n=>n.remove()); } catch(_) {}
    schedulePane.style.display='none'; mdPane.style.display='';
    try { document.getElementById('ufo-subtabs').style.display='none'; } catch(_) {}
    const hLogo = document.getElementById('md-home-logo');
    const aLogo = document.getElementById('md-away-logo');
    const hName = document.getElementById('md-home-name');
    const aName = document.getElementById('md-away-name');
    const score = document.getElementById('md-score');
    const dt = document.getElementById('md-datetime');
    const homePane = document.getElementById('md-pane-home');
    const awayPane = document.getElementById('md-pane-away');
    const setLogo = (imgEl,name)=>{ const base='/static/img/team-logos/'; const candidates=[]; if(name){ const norm=name.toLowerCase().replace(/\s+/g,'').replace(/ё/g,'е'); candidates.push(base+encodeURIComponent(norm+'.png')+`?v=${Date.now()}`);} candidates.push(base+'default.png'+`?v=${Date.now()}`); let i=0; const next=()=>{ if(i>=candidates.length) return; imgEl.onerror=()=>{ i++; next(); }; imgEl.src=candidates[i]; }; next(); };
    hName.setAttribute('data-team-name', match.home||''); aName.setAttribute('data-team-name', match.away||'');
    hName.textContent = withTeamCount(match.home||''); aName.textContent = withTeamCount(match.away||'');
    setLogo(hLogo, match.home||''); setLogo(aLogo, match.away||'');
    if (score) score.textContent='— : —';
    try { if (dt){ if (match.date||match.time){ const d=match.date? new Date(match.date): null; const ds = d? d.toLocaleDateString():''; dt.textContent = `${ds}${match.time? ' '+match.time:''}`;} else dt.textContent=''; }} catch(_) {}
    const subtabs = mdPane.querySelector('.modal-subtabs');
    try { const mkKey=(obj)=>{ const h=(obj?.home||'').toLowerCase().trim(); const a=(obj?.away||'').toLowerCase().trim(); const raw=obj?.date? String(obj.date):(obj?.datetime? String(obj.datetime):''); const d=raw? raw.slice(0,10):''; return `${h}__${a}__${d}`; }; const currentKey = mkKey(match); mdPane.setAttribute('data-match-key', currentKey); const oldTab=subtabs?.querySelector('[data-mdtab="stream"]'); if(oldTab) oldTab.remove(); const oldPane=document.getElementById('md-pane-stream'); if(oldPane) oldPane.remove(); } catch(_) {}
    try { const tabHome=subtabs?.querySelector('[data-mdtab="home"]'); const tabAway=subtabs?.querySelector('[data-mdtab="away"]'); if(tabHome) tabHome.textContent=match.home||'Команда 1'; if(tabAway) tabAway.textContent=match.away||'Команда 2'; } catch(_) {}
    let specialsPane=document.getElementById('md-pane-specials'); if(!specialsPane){ specialsPane=document.createElement('div'); specialsPane.id='md-pane-specials'; specialsPane.className='md-pane'; specialsPane.style.display='none'; mdPane.querySelector('.modal-body')?.appendChild(specialsPane);}    
    let streamPane=null;
    try {
      if(window.MatchStream && typeof window.MatchStream.setup==='function') {
        streamPane = window.MatchStream.setup(mdPane, subtabs, match);
      }
    } catch(_) {}
    try {
      if(window.Streams && typeof window.Streams.setupMatchStream==='function') {
        const hasTab = subtabs?.querySelector('[data-mdtab="stream"]');
        if(!hasTab) streamPane = window.Streams.setupMatchStream(mdPane, subtabs, match) || streamPane;
      }
    } catch(_) {}
    let statsPane=document.getElementById('md-pane-stats'); if(!statsPane){ statsPane=document.createElement('div'); statsPane.id='md-pane-stats'; statsPane.className='md-pane'; statsPane.style.display='none'; mdPane.querySelector('.modal-body')?.appendChild(statsPane);} if(!subtabs.querySelector('[data-mdtab="stats"]')) { const st=document.createElement('div'); st.className='subtab-item'; st.setAttribute('data-mdtab','stats'); st.textContent='Статистика'; subtabs.appendChild(st);}    
    mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
    homePane.style.display=''; awayPane.style.display='none'; specialsPane.style.display='none'; if(streamPane) streamPane.style.display='none'; statsPane.style.display='none';
    function simpleRoster(pane,list){ pane.innerHTML=''; const ul=document.createElement('ul'); ul.style.listStyle='none'; ul.style.padding='0'; if(!list||!list.length){ const li=document.createElement('li'); li.textContent='Нет данных'; li.style.opacity='.6'; ul.appendChild(li);} else list.forEach(n=>{ const li=document.createElement('li'); li.textContent=n; ul.appendChild(li); }); pane.appendChild(ul); }
    try { const homeList = Array.isArray(details?.rosters?.home)? details.rosters.home: []; const awayList = Array.isArray(details?.rosters?.away)? details.rosters.away: []; simpleRoster(homePane, homeList); simpleRoster(awayPane, awayList); } catch(_) { simpleRoster(homePane,[]); simpleRoster(awayPane,[]); }
    let scorePoll=null; const applyScore=(sh,sa)=>{ try { if (sh==null||sa==null) return; score.textContent=`${Number(sh)} : ${Number(sa)}`; } catch(_) {} };
    async function fetchScore(){ try { const r=await fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`); const d=await r.json(); if(typeof d?.score_home==='number' && typeof d?.score_away==='number') applyScore(d.score_home,d.score_away); } catch(_) {} }
    try { fetch(`/api/match/status/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`).then(r=>r.json()).then(s=>{ if(s?.status==='live'){ const live=document.createElement('span'); live.className='live-badge'; const dot=document.createElement('span'); dot.className='live-dot'; const lbl=document.createElement('span'); lbl.textContent='Матч идет'; live.append(dot,lbl); dt.appendChild(live); if(score.textContent.trim()==='— : —') score.textContent='0 : 0'; fetchScore(); scorePoll=setInterval(fetchScore,15000); } }).catch(()=>{}); } catch(_) {}
    const back = document.getElementById('match-back'); if(back) back.onclick=()=>{ try { if(scorePoll) clearInterval(scorePoll); } catch(_) {}; mdPane.style.display='none'; schedulePane.style.display=''; try { document.getElementById('ufo-subtabs').style.display=''; } catch(_) {}; window.scrollTo({ top:0, behavior:'smooth'}); };
  }
  try { window.openMatchScreen = openMatchScreen; } catch(_) {}
})();
