// profile-core.js
// Orchestrator: последовательный запуск загрузок и сигнал готовности
(function(){
  if (window.ProfileCore) return;
  const tg = window.Telegram?.WebApp || null;
  let _achLoaded=false, _userLoaded=false, _tableLoaded=false, _statsPreloaded=false, _schedulePreloaded=false, _resultsPreloaded=false;

  function trySignalAllReady(){ if(_achLoaded && _userLoaded && _tableLoaded && _statsPreloaded && _schedulePreloaded && _resultsPreloaded){ window.dispatchEvent(new CustomEvent('app:all-ready')); } }

  async function init(){
    try { tg?.expand?.(); tg?.ready?.(); } catch(_) {}
    // Параллельная загрузка профиля + достижений
    const userP = window.ProfileUser.fetchUserData().then(()=>{ _userLoaded=true; window.dispatchEvent(new CustomEvent('app:data-ready')); }).catch(()=>{ _userLoaded=true; });
    const achP = window.ProfileAchievements.fetchAchievements().then(()=>{ _achLoaded=true; }).catch(()=>{ _achLoaded=true; });
    // Предзагрузка UFO (заглушки здесь — заменить при вынесении из старого файла):
    // Эти функции будут перенесены позже из legacy profile.js
    // Пока просто помечаем как выполненные, чтобы не блокировать all-ready
    _tableLoaded=true; _statsPreloaded=true; _schedulePreloaded=true; _resultsPreloaded=true;
    Promise.allSettled([userP, achP]).then(()=>trySignalAllReady());
  }

  document.addEventListener('DOMContentLoaded', init);
  window.ProfileCore = { init };
})();
