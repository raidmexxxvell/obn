// Referral feature extracted from legacy profile.js
// Provides window.Referral with methods: prefetch, load, getCache
// Keeps backwards compatibility by exposing loadReferralInfo/prefetchReferral globals.
(function(){
  const tg = window.Telegram?.WebApp;
  let _referralCache = null;

  function updateCounters(){
    try {
      if (!_referralCache) return;
      const val = (_referralCache.invited_count ?? 0).toString();
      const c1 = document.getElementById('ref-count');
      const c2 = document.getElementById('ref-count-2');
      if (c1) c1.textContent = val;
      if (c2) c2.textContent = val;
    } catch(_) {}
  }

  function prefetchReferral(){
    if (!tg || !tg.initDataUnsafe?.user) return;
    if (_referralCache) { updateCounters(); return; }
    const fd = new FormData();
    fd.append('initData', tg.initData || '');
    fetch('/api/referral', { method: 'POST', body: fd })
      .then(r=>r.json())
      .then(data => { _referralCache = data; updateCounters(); })
      .catch(()=>{});
  }

  function loadReferralInfo(){
    if (!tg || !tg.initDataUnsafe?.user) return Promise.resolve();
    // Instant render from cache if present
    updateCounters();
    const fd = new FormData();
    fd.append('initData', tg.initData || '');
    return fetch('/api/referral', { method: 'POST', body: fd })
      .then(r=>r.json())
      .then(data => { _referralCache = data; updateCounters(); return data; })
      .catch(err => { console.error('referral load error', err); });
  }

  function setupShareButton(){
    const btn = document.getElementById('share-ref');
    if (!btn) return;
    btn.setAttribute('data-throttle', '1200');
    btn.addEventListener('click', async () => {
      try {
        if (!_referralCache) await loadReferralInfo();
        const link = _referralCache?.referral_link || '';
        if (!link) return;
        const text = encodeURIComponent(`Присоединяйся к лиге: ${link}`);
        if (window.Telegram?.WebApp?.openTelegramLink) {
          window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
        } else if (navigator.share) {
          try { await navigator.share({ title: 'Приглашение', text: 'Присоединяйся к лиге', url: link }); } catch(_) {}
        } else {
          window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
        }
      } catch(e) { console.warn('share failed', e); }
    });
  }

  // Public API
  window.Referral = {
    prefetch: prefetchReferral,
    load: loadReferralInfo,
    getCache: () => _referralCache
  };
  // Backwards compatibility
  try { window.loadReferralInfo = loadReferralInfo; } catch(_) {}
  try { window.prefetchReferral = prefetchReferral; } catch(_) {}

  // Hooks
  window.addEventListener('app:data-ready', prefetchReferral);
  document.addEventListener('DOMContentLoaded', setupShareButton);
})();
