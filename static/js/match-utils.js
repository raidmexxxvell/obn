// static/js/match-utils.js
// Универсальные утилиты для матчей: время, live-статус, форматирование, ключи, уведомления
(function(){
  if (window.MatchUtils) return;

  function parseDateTime(match){
    try {
      if (!match) return null;
      if (match.datetime) {
        const d = new Date(match.datetime);
        return isNaN(d.getTime()) ? null : d;
      }
      if (match.date) {
        const time = (match.time || '').trim();
        const t = time.length === 5 ? time + ':00' : time; // HH:MM -> HH:MM:SS
        const iso = match.date + (t ? 'T' + t : 'T00:00:00');
        const d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
      }
    } catch(_) {}
    return null;
  }

  function matchKey(m){
    try {
      const h = (m?.home||'').toLowerCase().trim();
      const a = (m?.away||'').toLowerCase().trim();
      const d = (m?.date || m?.datetime || '').toString().slice(0,10);
      return `${h}__${a}__${d}`;
    } catch(_) { return `${m?.home||''}__${m?.away||''}`; }
  }

  function isLiveNow(m, opts={}){
    const { windowMinutes = 120, nowTs = Date.now() } = opts;
    try {
      // Проверяем finStore (завершенные матчи)
      const finStore = window.__FINISHED_MATCHES || {};
      const key = matchKey(m);
      if (finStore[key]) return false;
      
      // Проверяем результаты в кэше
      try {
        const resultsCache = JSON.parse(localStorage.getItem('results') || 'null');
        if (resultsCache?.data?.results) {
          const found = resultsCache.data.results.find(r => 
            r.home === m.home && r.away === m.away);
          if (found && (found.score_home !== undefined && found.score_away !== undefined)) {
            return false; // матч завершен
          }
        }
      } catch(_) {}
      
      const start = parseDateTime(m);
      if (!start) return false;
      const endTs = start.getTime() + windowMinutes*60*1000;
      return nowTs >= start.getTime() && nowTs < endTs;
    } catch(_) { return false; }
  }

  function isStartingSoon(m, minutes = 5, opts={}){
    try {
      const nowTs = opts.nowTs || Date.now();
      const start = parseDateTime(m);
      if (!start) return false;
      const diffMin = (start.getTime() - nowTs) / 60000;
      return diffMin > 0 && diffMin <= minutes;
    } catch(_) { return false; }
  }

  function formatDateTime(dateIso, time){
    try {
      if (!dateIso) return time || '';
      const d = new Date(dateIso);
      if (!isNaN(d.getTime()) && dateIso.includes('T') && !time) {
        const ds = d.toLocaleDateString();
        const ts = d.toTimeString().slice(0,5);
        return `${ds} ${ts}`;
      }
      if (!isNaN(d.getTime())) {
        const ds = d.toLocaleDateString();
        const ts = time || (d.toTimeString().slice(0,5));
        return `${ds}${ts? ' ' + ts : ''}`;
      }
    } catch(_) {}
    return time || '';
  }

  const MatchNotifications = {
    shownKeys: new Set(),
    showMatchStart(match){
      const key = matchKey(match);
      if (this.shownKeys.has(key)) return;
      this.shownKeys.add(key);
      if (window.NotificationSystem) {
        const msg = `${match.home} vs ${match.away} — старт матча!`;
        window.NotificationSystem.show(msg, 'info', 5000);
      } else if (window.showAlert) {
        window.showAlert(`${match.home} vs ${match.away} начался`);
      }
      try {
        if (!document.getElementById('match-start-banner')) {
          const div = document.createElement('div');
          div.id = 'match-start-banner';
          div.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);background:#1976d2;color:#fff;padding:10px 16px;border-radius:10px;z-index:10000;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer;';
            div.textContent = `${match.home} vs ${match.away} — матч начался`;
            div.addEventListener('click', ()=>{ try { window.showMatchDetails?.(match); } catch(_) {} div.remove(); });
            document.body.appendChild(div);
            setTimeout(()=>{ try { div.remove(); } catch(_) {} }, 7000);
        }
      } catch(_) {}
    },
    scan(matches){
      try {
        const nowTs = Date.now();
        (matches||[]).forEach(m => { if (isLiveNow(m, { nowTs }) ) this.showMatchStart(m); });
      } catch(_) {}
    }
  };

  window.MatchUtils = { parseDateTime, matchKey, isLiveNow, isStartingSoon, formatDateTime, MatchNotifications };
  try { window.isLiveNow = isLiveNow; } catch(_) {}
  try { window.formatMatchDateTime = formatDateTime; } catch(_) {}
})();
