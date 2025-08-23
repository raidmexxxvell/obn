// Ads carousel & Top Match of Week extracted from profile.js
(function(){
  const tg = window.Telegram?.WebApp;
  function initHomeAdsCarousel(){
    const track = document.getElementById('ads-track');
    const dots = document.getElementById('ads-dots');
    const box = document.getElementById('ads-carousel');
    if (!track || !dots || !box) return;
    let slides = Array.isArray(window.__HOME_ADS__) ? window.__HOME_ADS__.slice() : null;
    if (!slides || slides.length === 0) {
      slides = [
        { img: '/static/img/ligareklama.webp', title: 'Здесь может быть ваша лига — нажми', action: 'BLB' },
        { img: '/static/img/reklama.webp', title: '', action: '' },
        { img: '/static/img/reklama.webp', title: '', action: '' }
      ];
    }
    track.innerHTML=''; dots.innerHTML='';
    slides.forEach((s, idx) => {
      const slide = document.createElement('div');
      slide.className = 'ads-slide';
      slide.innerHTML = `<img src="${s.img}" alt="" class="ads-img" loading="lazy"><div class="ads-title">${s.title||''}</div>`;
      if (s.action) {
        slide.style.cursor='pointer';
        slide.addEventListener('click', () => {
          try {
            if (s.action === 'BLB') {
              // Используем анимацию перехода лиг, если доступна
              if (window.selectBLBLeague) {
                window.selectBLBLeague(true);
              } else {
                window.__ACTIVE_LEAGUE__ = 'BLB';
                if (window.setActiveLeague) { try { window.setActiveLeague('BLB'); } catch(_) {} }
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                const navUfo = document.querySelector('.nav-item[data-tab="ufo"]');
                if (navUfo) navUfo.classList.add('active');
                ['tab-home','tab-ufo','tab-predictions','tab-leaderboard','tab-shop','tab-admin']
                  .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = (id==='tab-ufo'?'':'none'); });
              }
            }
          } catch(_) {}
        });
      }
      track.appendChild(slide);
      const dot = document.createElement('div'); dot.className = 'ads-dot'+(idx===0?' active':''); dots.appendChild(dot);
    });
    let index = 0; let timer=null;
    const apply = () => {
      const w = box.clientWidth;
      track.scrollTo({ left: index * w, behavior: 'smooth' });
      Array.from(dots.children).forEach((d,i)=>d.classList.toggle('active', i===index));
    };
    const arm = () => { if (slides.length <= 1) return; if (timer) clearInterval(timer); timer = setInterval(()=>{ index=(index+1)%slides.length; apply(); }, 5000); };
    arm();
    let startX=0, scx=0, dragging=false;
    track.addEventListener('touchstart', e=>{ if(!e.touches[0])return; startX=e.touches[0].clientX; scx=track.scrollLeft; dragging=true; if(timer) clearInterval(timer); }, { passive:true });
    track.addEventListener('touchmove', e=>{ if(!dragging||!e.touches[0])return; const dx=startX-e.touches[0].clientX; track.scrollLeft=scx+dx; }, { passive:true });
    track.addEventListener('touchend', ()=>{ if(!dragging)return; dragging=false; const w=box.clientWidth; const cur=Math.round(track.scrollLeft/Math.max(1,w)); index=Math.max(0, Math.min(slides.length-1, cur)); apply(); arm(); }, { passive:true });
    window.addEventListener('resize', apply);
    apply();
  }

  async function renderTopMatchOfWeek(){
    try {
      if ((window.__ACTIVE_LEAGUE__ || 'UFO') !== 'UFO') {
        const host = document.getElementById('home-pane');
        if (host) host.innerHTML='';
        return;
      }
      const res = await fetch(`/api/schedule?_=${Date.now()}`);
      const data = await res.json();
      const m = data?.match_of_week;
      const host = document.getElementById('home-pane');
      if (!host) return; host.innerHTML='';
      if (!m) { host.innerHTML='<div style="color: var(--gray);">Скоро анонс матча недели</div>'; return; }
      const card = document.createElement('div'); card.className='match-card home-feature';
      const head = document.createElement('div'); head.className='match-header'; head.textContent='Игра недели'; card.appendChild(head);
      const sub = document.createElement('div'); sub.className='match-subheader';
      const dtText = (()=>{ try { if(m.datetime){ const dt=new Date(m.datetime); return dt.toLocaleString(undefined,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});} if(m.date){ return m.time?`${m.date} ${m.time}`:String(m.date);} } catch(_){} return ''; })();
      if (dtText) { sub.textContent=dtText; card.appendChild(sub); }
      const center = document.createElement('div'); center.className='match-center';
      const loadLogo = (imgEl, teamName) => { const base='/static/img/team-logos/'; const name=(teamName||'').trim(); const candidates=[]; try { imgEl.loading='lazy'; imgEl.decoding='async'; } catch(_){} if(name){ const norm=name.toLowerCase().replace(/\s+/g,'').replace(/ё/g,'е'); candidates.push(base+encodeURIComponent(norm+'.png')); } candidates.push(base+'default.png'); let idx=0; const tryNext=()=>{ if(idx>=candidates.length)return; imgEl.onerror=()=>{ idx++; tryNext(); }; imgEl.src=candidates[idx]; }; tryNext(); };
      const L = (name)=>{ const t=document.createElement('div'); t.className='team'; const i=document.createElement('img'); i.className='logo'; loadLogo(i,name||''); const n=document.createElement('div'); n.className='team-name'; n.textContent=name||''; t.append(i,n); return t; };
      const scoreEl=document.createElement('div'); scoreEl.className='score'; scoreEl.textContent='VS';
      center.append(L(m.home), scoreEl, L(m.away)); card.appendChild(center);
      try { if (window.MatchUtils?.isLiveNow(m)) { scoreEl.textContent='0 : 0'; (async()=>{ try { const r=await fetch(`/api/match/score/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`); const d=await r.json(); if (typeof d?.score_home==='number' && typeof d?.score_away==='number') scoreEl.textContent=`${Number(d.score_home)} : ${Number(d.score_away)}`; } catch(_){} })(); } } catch(_) {}
      const wrap=document.createElement('div'); wrap.className='vote-inline';
      const title=document.createElement('div'); title.className='vote-title'; title.textContent='Голосование';
      const bar=document.createElement('div'); bar.className='vote-strip';
      const segH=document.createElement('div'); segH.className='seg seg-h';
      const segD=document.createElement('div'); segD.className='seg seg-d';
      const segA=document.createElement('div'); segA.className='seg seg-a';
      bar.append(segH,segD,segA);
      const legend=document.createElement('div'); legend.className='vote-legend'; legend.innerHTML='<span>П1</span><span>X</span><span>П2</span>';
      const btns=document.createElement('div'); btns.className='vote-inline-btns';
      const confirm=document.createElement('div'); confirm.className='vote-confirm'; confirm.style.fontSize='12px'; confirm.style.color='var(--success)';
      const voteKey=(()=>{ try { const raw=m.date?String(m.date):(m.datetime?String(m.datetime):''); const d=raw?raw.slice(0,10):''; return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${d}`; } catch(_) { return `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__`; } })();
      const mkBtn=(code,text)=>{ const b=document.createElement('button'); b.className='details-btn'; b.textContent=text; b.addEventListener('click', async (e)=>{ try{ e.stopPropagation(); }catch(_){} try { const fd=new FormData(); fd.append('initData', window.Telegram?.WebApp?.initData || ''); fd.append('home', m.home||''); fd.append('away', m.away||''); const dkey=(m.date?String(m.date):(m.datetime?String(m.datetime):'')).slice(0,10); fd.append('date', dkey); fd.append('choice', code); const r=await fetch('/api/vote/match',{ method:'POST', body:fd }); if(!r.ok) throw 0; btns.querySelectorAll('button').forEach(x=>x.disabled=true); confirm.textContent='Ваш голос учтён'; try { localStorage.setItem('voted:'+voteKey,'1'); } catch(_){} btns.style.display='none'; await loadAgg(true); } catch(_){} }); return b; };
      btns.append(mkBtn('home','За П1'), mkBtn('draw','За X'), mkBtn('away','За П2'));
      wrap.append(title, bar, legend, btns, confirm);
      try { segH.style.background = window.getTeamColor?window.getTeamColor(m.home||''):'#3b82f6'; segA.style.background = window.getTeamColor?window.getTeamColor(m.away||''):'#3b82f6'; segD.style.background='#8e8e93'; } catch(_){}
      const toursCache = (()=>{ try { return JSON.parse(localStorage.getItem('betting:tours') || 'null'); } catch(_) { return null; } })();
      const mkKey=(obj)=>{ try { const h=(obj?.home||'').toLowerCase().trim(); const a=(obj?.away||'').toLowerCase().trim(); const raw=obj?.date?String(obj.date):(obj?.datetime?String(obj.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; } catch(_) { return `${(obj?.home||'').toLowerCase()}__${(obj?.away||'').toLowerCase()}__`; } };
      const tourMatches=new Set(); try { const tours=toursCache?.data?.tours || toursCache?.tours || []; (tours).forEach(t=> (t.matches||[]).forEach(x=> tourMatches.add(mkKey(x)))); } catch(_) {}
      if (tourMatches.has(mkKey(m))) { card.appendChild(wrap); }
      try { card.style.cursor='pointer'; card.addEventListener('click', (e)=>{ try { if(e?.target?.closest('button')) return; } catch(_){} try { document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active')); const navUfo=document.querySelector('.nav-item[data-tab="ufo"]'); if(navUfo) navUfo.classList.add('active'); const elHome=document.getElementById('tab-home'); const elUfo=document.getElementById('tab-ufo'); const elUfoContent=document.getElementById('ufo-content'); const elPreds=document.getElementById('tab-predictions'); const elLead=document.getElementById('tab-leaderboard'); const elShop=document.getElementById('tab-shop'); const elAdmin=document.getElementById('tab-admin'); [elHome,elUfo,elPreds,elLead,elShop,elAdmin].forEach(x=>{ if(x) x.style.display='none'; }); if(elUfo) elUfo.style.display=''; if(elUfoContent) elUfoContent.style.display=''; } catch(_){} const params=new URLSearchParams({home:m.home||'', away:m.away||''}); const cacheKey=`md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`; const cached=(()=>{ try { return JSON.parse(localStorage.getItem(cacheKey)||'null'); } catch(_) { return null; } })(); const fetchWithETag=(etag)=> fetch(`/api/match-details?${params.toString()}`, { headers: etag?{'If-None-Match':etag}:{}}).then(async r=>{ if(r.status===304 && cached) return cached; const data=await r.json(); const version=data.version || r.headers.get('ETag') || null; const toStore={ data, version, ts: Date.now() }; try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_){} return toStore; }); const go=(store)=>{ try { window.openMatchScreen?.({ home:m.home, away:m.away, date:m.date, time:m.time }, store?.data || store); } catch(_){} }; const FRESH_TTL=10*60*1000; const isEmptyRosters=(()=>{ try { const d=cached?.data; const h=Array.isArray(d?.rosters?.home)?d.rosters.home:[]; const a=Array.isArray(d?.rosters?.away)?d.rosters.away:[]; return h.length===0 && a.length===0; } catch(_) { return false; } })(); if(cached && !isEmptyRosters && (Date.now()-(cached.ts||0) < FRESH_TTL)) { go(cached); } else if(cached && cached.version) { fetchWithETag(cached.version).then(go).catch(()=>{ go(cached); }); } else if(cached) { go(cached); } else { fetchWithETag(null).then(go).catch(()=>{}); } }); } catch(_){}
      const footer=document.createElement('div'); footer.className='match-footer'; const goPred=document.createElement('button'); goPred.className='details-btn'; goPred.textContent='Сделать прогноз'; goPred.addEventListener('click', (e)=>{ try { e.stopPropagation(); } catch(_){} try { document.querySelector('.nav-item[data-tab="predictions"]').click(); } catch(_){} }); footer.appendChild(goPred); card.appendChild(footer); host.appendChild(card);
      async function loadAgg(withInit){ try { const dkey=(m.date?String(m.date):(m.datetime?String(m.datetime):'')).slice(0,10); const params=new URLSearchParams({ home:m.home||'', away:m.away||'', date:dkey }); if(withInit) params.append('initData', (window.Telegram?.WebApp?.initData || '')); const agg=await fetch(`/api/vote/match-aggregates?${params.toString()}`).then(r=>r.json()); const h=Number(agg?.home||0), d=Number(agg?.draw||0), a=Number(agg?.away||0); const sum=Math.max(1,h+d+a); segH.style.width=Math.round(h*100/sum)+'%'; segD.style.width=Math.round(d*100/sum)+'%'; segA.style.width=Math.round(a*100/sum)+'%'; if(agg && agg.my_choice){ btns.querySelectorAll('button').forEach(x=>x.disabled=true); btns.style.display='none'; confirm.textContent='Ваш голос учтён'; try { localStorage.setItem('voted:'+voteKey,'1'); } catch(_){} } } catch(_) { segH.style.width='33%'; segD.style.width='34%'; segA.style.width='33%'; } }
      try { if(localStorage.getItem('voted:'+voteKey) === '1'){ btns.style.display='none'; confirm.textContent='Ваш голос учтён'; } } catch(_){}
      loadAgg(true);
    } catch(_){}
  }

  window.AdsFeatured = { initHomeAdsCarousel, renderTopMatchOfWeek };
  try { window.renderTopMatchOfWeek = renderTopMatchOfWeek; } catch(_) {}
  window.addEventListener('DOMContentLoaded', () => { try { initHomeAdsCarousel(); } catch(_) {}; try { renderTopMatchOfWeek(); } catch(_) {}; });
})();
