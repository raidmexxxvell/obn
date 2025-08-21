// profile-live.js
// LiveWatcher: отслеживание старта live матчей и уведомления
(function(){
  if (window.ProfileLive) return;
  const isLive = (m) => (window.MatchUtils ? window.MatchUtils.isLiveNow(m) : false);
  const getKey = (m) => `${m.home||''}__${m.away||''}__${m.datetime||m.date||''}`;
  const getPair = (m) => `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}`;
  let lastLiveKeys = new Set();
  let initialized = false;
  async function fetchLiveFlags(){
    try {
      const r = await fetch('/api/match/status/live?_=' + Date.now());
      const d = await r.json();
      const pairs = new Set();
      (d.items||[]).forEach(it => { pairs.add(`${(it.home||'').toLowerCase()}__${(it.away||'').toLowerCase()}`); });
      if (!window.__LIVE_STATUS) window.__LIVE_STATUS = { pairs: new Set(), ts: 0 };
      window.__LIVE_STATUS.pairs = pairs; window.__LIVE_STATUS.ts = Date.now();
      return pairs;
    } catch(_) {
      return (window.__LIVE_STATUS && window.__LIVE_STATUS.pairs) ? window.__LIVE_STATUS.pairs : new Set();
    }
  }
  function notify(text, onClick){
    if (window.NotificationSystem) window.NotificationSystem.show(text,'info',5000);
    else if (window.showAlert) window.showAlert(text,'info');
    else try { alert(text); } catch(_) {}
    if (onClick) try { onClick(); } catch(_) {}
  }
  async function scan(){
    try {
      const cached = JSON.parse(localStorage.getItem('schedule:tours') || 'null');
      const tours = cached?.data?.tours || [];
      const currentLive = new Set();
      const pairFlags = await fetchLiveFlags();
      const nowStarted = [];
      tours.forEach(t => (t.matches||[]).forEach(m => {
        const live = isLive(m) || pairFlags.has(getPair(m));
        const key = getKey(m);
        if (live) currentLive.add(key);
        if (live && !lastLiveKeys.has(key) && initialized) nowStarted.push(m);
      }));
      nowStarted.forEach(m => {
        const title = `${m.home||'Команда 1'} — ${m.away||'Команда 2'}: матч начался`;
        const onClick = () => {
          try {
            const params = new URLSearchParams({ home: m.home||'', away: m.away||'' });
            const cacheKey = `md:${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}`;
            const storeRaw = localStorage.getItem(cacheKey);
            const store = storeRaw ? JSON.parse(storeRaw) : null;
            const go = (st) => { try { window.openMatchScreen?.({ home: m.home, away: m.away, date: m.date, time: m.time }, st?.data || st); } catch(_) {} };
            if (store?.etag){
              fetch(`/api/match-details?${params.toString()}`, { headers: { 'If-None-Match': store.etag } })
                .then(r => r.status===304 ? store : r.json().then(d=>({ etag: r.headers.get('ETag'), data: d })))
                .then(st => go(st)).catch(()=>go(null));
            } else {
              fetch(`/api/match-details?${params.toString()}`)
                .then(r => r.json().then(d=>({ etag: r.headers.get('ETag'), data: d })))
                .then(st => { try { localStorage.setItem(cacheKey, JSON.stringify(st)); } catch(_) {} go(st); })
                .catch(()=>go(null));
            }
          } catch(_) {}
        };
        notify(title, onClick);
      });
      lastLiveKeys = currentLive;
      if (!initialized) initialized = true;
    } catch(_) {}
  }
  setInterval(scan, 30000);
  document.addEventListener('DOMContentLoaded', () => {
    try {
      const adminId = document.body.getAttribute('data-admin');
      const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
      if (adminId && currentId && String(adminId) === currentId){
        const btn = document.createElement('button');
        btn.textContent='Тест уведомления LIVE'; btn.className='details-btn';
        btn.style.position='fixed'; btn.style.bottom='90px'; btn.style.right='12px'; btn.style.zIndex='9999';
        btn.addEventListener('click', () => notify('Демо уведомление: Команда 1 — Команда 2'));
        document.body.appendChild(btn);
      }
    } catch(_) {}
  });
  window.ProfileLive = { scan };
})();
