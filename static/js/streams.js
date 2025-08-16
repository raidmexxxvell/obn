// static/js/streams.js
// Конфигурация трансляций VK для матчей. Минимизируем нагрузку: ленивое подключение iframe.
// Как заполнять: добавьте запись c ключами (home, away, date?) и vkVideoId или vkPostUrl.
// Пример ключа: `${home.toLowerCase()}__${away.toLowerCase()}__${dateYYYYMMDD}`
// Если дата не критична, можно оставить пустой третий сегмент: `${home}__${away}__`.

(function(){
  // Хранилище соответствий: ключ → объект трансляции
  const registry = {
    // 'дождь__звезда__2025-08-16': { vkVideoId: '123456789_987654321', autoplay: 0 },
    // 'дождь__звезда__': { vkPostUrl: 'https://vk.com/video-123456_654321', autoplay: 0 },
  };
  function makeKey(match){
    const h = (match?.home||'').toLowerCase().trim();
    const a = (match?.away||'').toLowerCase().trim();
    let d = '';
    try{
      const raw = match?.date ? String(match.date) : (match?.datetime ? String(match.datetime) : '');
      d = raw ? raw.slice(0,10) : '';
    }catch(_){ d=''; }
    return `${h}__${a}__${d}`;
  }
  function findStream(match){
    const keyExact = makeKey(match);
    const keyDateAgnostic = `${(match?.home||'').toLowerCase().trim()}__${(match?.away||'').toLowerCase().trim()}__`;
    return registry[keyExact] || registry[keyDateAgnostic] || null;
  }
  window.__STREAMS__ = { findStream, registry };
})();
