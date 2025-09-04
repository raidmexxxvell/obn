// Шаг 5: Клиент селективных подписок
// Автоподключение и авто-подписка на league_table + динамическая подписка на составы активного матча
(function(){
  if(window.__SUBSCRIPTIONS_CLIENT_INITIALIZED__) return; window.__SUBSCRIPTIONS_CLIENT_INITIALIZED__=true;
  const DEBUG = localStorage.getItem('subs_debug')==='true';
  const sockLibReady = typeof io !== 'undefined';
  if(!sockLibReady){ if(DEBUG) console.warn('[subs] socket.io library missing'); return; }
  const tgUserId = (function(){ try { return window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : null; } catch(_){ return null;} })();
  const socket = io({ query: tgUserId ? { user_id: tgUserId } : {}, transports:['websocket','polling'] });

  const pendingMatch = { home:null, away:null, matchId:null };

  function log(...a){ if(DEBUG) console.log('[subs]', ...a); }

  socket.on('connect', ()=>{ log('connected');
    // Авто-подписка на league_table (broadcast тип)
    socket.emit('subscribe', { type: 'league_table' });
    // Если открыт какой-то матч уже к моменту коннекта – подписываемся
    try { if(pendingMatch.matchId){ socket.emit('subscribe', { type:'match_lineup', object_id: String(pendingMatch.matchId) }); } } catch(_){ }
  });
  socket.on('disconnect', ()=> log('disconnected'));

  socket.on('subscription_update', (payload)=>{
    try {
      if(!payload || !payload.type) return;
      switch(payload.type){
        case 'league_table':
          // Триггерим существующую функцию обновления таблицы (если есть)
          try { if(window.Realtime && typeof window.Realtime.refreshLeagueTable==='function'){ window.Realtime.refreshLeagueTable(); } } catch(_){ }
          log('league_table update received');
          break;
        case 'match_lineup':
          // Получение обновления состава матча -> фетчим по home/away
          try {
            const h = payload?.data?.home; const a = payload?.data?.away;
            if(h && a){
              const params = new URLSearchParams({ home: h, away: a, _: String(Date.now()) });
              fetch(`/api/match/lineups?${params.toString()}`, { headers:{'Cache-Control':'no-store'} })
                .then(r=> r.ok? r.json(): null)
                .then(json=>{ if(!json) return; if(window.Realtime && typeof window.Realtime.refreshMatchDetails==='function'){ window.Realtime.refreshMatchDetails({ rosters: json.rosters || {home:[],away:[]}, source:'db'}); } });
            }
          } catch(_){ }
          break;
        default:
          log('unhandled update', payload.type);
      }
    } catch(e){ log('subscription_update error', e); }
  });

  // Публичный API для динамической подписки на состав матча при открытии деталей
  window.SubscriptionClient = {
    subscribeMatchLineup(match){
      try {
        if(!match) return; // match = { id, home, away }
        pendingMatch.home = match.home; pendingMatch.away = match.away; pendingMatch.matchId = match.id;
        if(socket.connected){ socket.emit('subscribe', { type:'match_lineup', object_id: String(match.id) }); }
      } catch(_){ }
    },
    rawSocket: socket
  };
})();
