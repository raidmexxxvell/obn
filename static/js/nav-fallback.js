// nav-fallback.js
// Запасная инициализация нижнего меню, если основной profile.js не выставил __NAV_INITIALIZED__
(function(){
  function initFallback(){
    if (window.__NAV_INITIALIZED__ || window.__NAV_FALLBACK_RAN__) return;
    const items = document.querySelectorAll('.nav-item');
    if(!items.length) return; // ничего не делать пока не появятся
    window.__NAV_FALLBACK_RAN__ = true;
    // Показать админ-пункт, если пользователь админ (fallback сценарий — может не вызваться основная логика)
    try {
      const adminId = document.body.getAttribute('data-admin');
      const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
      if (adminId && currentId && String(adminId) === currentId){
        const navAdmin = document.getElementById('nav-admin'); if(navAdmin) navAdmin.style.display='';
        const refreshBtn = document.getElementById('league-refresh-btn'); if(refreshBtn) refreshBtn.style.display='';
      }
    } catch(_) {}
    items.forEach(it => {
      if(it.__fbBound) return; it.__fbBound = true;
      it.addEventListener('click', () => {
        try {
          document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
          it.classList.add('active');
          const tab = it.getAttribute('data-tab');
          ['home','ufo','predictions','leaderboard','shop','admin','profile'].forEach(id=>{
            const el = document.getElementById('tab-'+id); if(el) el.style.display = (tab===id?'':'none');
          });
          window.scrollTo({ top: 0, behavior: 'instant' });
        } catch(e){ console.warn('Nav fallback click error', e); }
      }, { passive:true });
    });
  }
  // Попытки запуска по времени (на случай, если DOM не готов или основной скрипт завис)
  const attempts = [500, 1200, 2500, 4000];
  attempts.forEach(ms => setTimeout(initFallback, ms));
  document.addEventListener('DOMContentLoaded', initFallback);
})();
