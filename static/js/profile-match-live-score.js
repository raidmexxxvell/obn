// Live status badge + score polling & admin inline score controls (without finish)
(function(){
  function setup(match, refs){
    const scoreEl = refs.scoreEl; const dtEl = refs.dtEl; const mdPane=refs.mdPane; if(!scoreEl||!dtEl||!mdPane) return {};
    let scorePoll=null; let adminScoreCtrlsAdded=false;
    const applyScore=(sh,sa)=>{ try { if(sh==null || sa==null) return; scoreEl.textContent=`${Number(sh)} : ${Number(sa)}`; } catch(_){} };
    const fetchScore=async()=>{ try { const r=await fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`); const d=await r.json(); if(typeof d?.score_home==='number' && typeof d?.score_away==='number') applyScore(d.score_home,d.score_away); } catch(_){} };
    const ensureAdminCtrls=()=>{ try { if(adminScoreCtrlsAdded) return; const adminId=document.body.getAttribute('data-admin'); const currentId=window.Telegram?.WebApp?.initDataUnsafe?.user?.id?String(window.Telegram.WebApp.initDataUnsafe.user.id):''; const isAdmin=!!(adminId && currentId && String(adminId)===currentId); if(!isAdmin) return; if(mdPane.querySelector('.admin-score-ctrls')){ adminScoreCtrlsAdded=true; return; }
        const mkBtn=(t)=>{ const b=document.createElement('button'); b.className='details-btn'; b.textContent=t; b.style.padding='2px 8px'; b.style.minWidth='unset'; return b; };
        const row=document.createElement('div'); row.className='admin-score-ctrls'; row.style.marginTop='6px'; row.style.display='flex'; row.style.gap='10px'; row.style.alignItems='center'; row.style.justifyContent='center';
        const left=document.createElement('div'); left.style.display='flex'; left.style.gap='6px';
        const right=document.createElement('div'); right.style.display='flex'; right.style.gap='6px';
        const hMinus=mkBtn('−'); const hPlus=mkBtn('+'); const aMinus=mkBtn('−'); const aPlus=mkBtn('+');
        left.append(hMinus,hPlus); right.append(aMinus,aPlus);
        const center=scoreEl.parentElement || dtEl.parentElement || mdPane.querySelector('.match-modal-header .center');
        const spacer=document.createElement('div'); spacer.style.width='8px';
        row.append(left, spacer, right);
        try { center.appendChild(row); } catch(_){}
        const tg=window.Telegram?.WebApp||null;
        const parseScore=()=>{ try { const t=scoreEl.textContent||''; const m=t.match(/(\d+)\s*:\s*(\d+)/); if(m) return [parseInt(m[1],10)||0, parseInt(m[2],10)||0]; } catch(_){} return [0,0]; };
        const postScore=async(sh,sa)=>{ try { const fd=new FormData(); fd.append('initData', tg?.initData||''); fd.append('home',match.home||''); fd.append('away',match.away||''); fd.append('score_home', String(Math.max(0,sh))); fd.append('score_away', String(Math.max(0,sa))); const r=await fetch('/api/match/score/set',{ method:'POST', body:fd }); const d=await r.json().catch(()=>({})); if(!r.ok || d?.error) throw new Error(d?.error||'Ошибка сохранения'); applyScore(d.score_home,d.score_away); } catch(e){ window.showAlert?.(e?.message||'Не удалось сохранить счёт','error'); } };
        hMinus.addEventListener('click',()=>{ const [h,a]=parseScore(); postScore(Math.max(0,h-1),a); });
        hPlus.addEventListener('click',()=>{ const [h,a]=parseScore(); postScore(h+1,a); });
        aMinus.addEventListener('click',()=>{ const [h,a]=parseScore(); postScore(h,Math.max(0,a-1)); });
        aPlus.addEventListener('click',()=>{ const [h,a]=parseScore(); postScore(h,a+1); });
        adminScoreCtrlsAdded=true;
      } catch(_){} };
    // Live status fetch
    fetch(`/api/match/status/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
      .then(r=>r.json()).then(async s=>{ if(s?.status==='live'){ const live=document.createElement('span'); live.className='live-badge'; const dot=document.createElement('span'); dot.className='live-dot'; const lbl=document.createElement('span'); lbl.textContent='Матч идет'; live.append(dot,lbl); dtEl.appendChild(live); if(scoreEl.textContent.trim()==='— : —') scoreEl.textContent='0 : 0';
          try { const adminId=document.body.getAttribute('data-admin'); const currentId=window.Telegram?.WebApp?.initDataUnsafe?.user?.id?String(window.Telegram.WebApp.initDataUnsafe.user.id):''; const isAdmin=!!(adminId && currentId && String(adminId)===currentId); if(isAdmin){ const r0=await fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`); const d0=await r0.json().catch(()=>({})); if(d0?.score_home==null && d0?.score_away==null){ const tg=window.Telegram?.WebApp||null; const fd0=new FormData(); fd0.append('initData', tg?.initData||''); fd0.append('home', match.home||''); fd0.append('away', match.away||''); await fetch('/api/match/status/set-live',{ method:'POST', body:fd0 }).catch(()=>{}); } } } catch(_){}
          fetchScore(); scorePoll=setInterval(fetchScore,15000); ensureAdminCtrls(); }
        }).catch(()=>{});
    return { cleanup(){ try { if(scorePoll) clearInterval(scorePoll); } catch(_){} try { mdPane.querySelectorAll('.admin-score-ctrls').forEach(n=>n.remove()); } catch(_){} } };
  }
  window.MatchLiveScore = { setup };
})();
