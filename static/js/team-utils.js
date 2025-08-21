// static/js/team-utils.js
// Унифицированные утилиты команд: нормализация имени, цвет, логотипы, фабрика DOM
(function(){
  if (window.TeamUtils) return; // idempotent
  const LOGO_BASE = '/static/img/team-logos/';
  function normalizeTeamName(raw){
    try {
      return (raw||'').toString().trim().toLowerCase()
        .replace(/ё/g,'е')
        .replace(/фк/g,'')
        .replace(/fc|fk/g,'')
        .replace(/\s+/g,'')
        .replace(/[^a-z0-9а-я]+/gi,'');
    } catch(_) { return ''; }
  }
  function getTeamColor(name){
    const norm = normalizeTeamName(name);
    const map = {
      'полет': '#fdfdfc',
      'дождь': '#292929',
      'киборги': '#f4f3fb',
      'фкобнинск': '#eb0000',
      'ювелиры': '#333333',
      'звезда': '#a01818',
      'фкsetka4real': '#000000',
      'серпантин': '#141098',
      'креатив': '#98108c'
    };
    return map[norm] || '#3b82f6';
  }
  function setTeamLogo(imgEl, teamName){
    const name = (teamName||'').trim();
    const candidates = [];
    try { imgEl.loading='lazy'; imgEl.decoding='async'; } catch(_) {}
    if (name){
      const norm = normalizeTeamName(name);
      if (norm) candidates.push(LOGO_BASE + encodeURIComponent(norm + '.png'));
    }
    candidates.push(LOGO_BASE + 'default.png');
    let i=0; const next=()=>{ if(i>=candidates.length) return; imgEl.onerror=()=>{ i++; next(); }; imgEl.src=candidates[i]; }; next();
  }
  function createTeamWithLogo(teamName, options={}){
    const { showLogo=true, logoSize='20px', className='team-with-logo', textClassName='team-name', logoClassName='team-logo'} = options;
    const container = document.createElement('span');
    container.className = className;
    container.style.display='inline-flex';
    container.style.alignItems='center';
    container.style.gap='6px';
    if (showLogo){
      const img = document.createElement('img');
      img.className = logoClassName;
      img.alt = teamName||'';
      img.style.width=logoSize; img.style.height=logoSize; img.style.objectFit='contain'; img.style.borderRadius='2px';
      setTeamLogo(img, teamName);
      container.appendChild(img);
    }
    const nameEl = document.createElement('span'); nameEl.className=textClassName; nameEl.textContent=teamName||''; container.appendChild(nameEl);
    return container;
  }
  window.TeamUtils = { normalizeTeamName, getTeamColor, setTeamLogo, createTeamWithLogo };
  // Глобальные шорткаты (сохранить обратную совместимость)
  try { window.getTeamColor = getTeamColor; } catch(_) {}
  try { window.setTeamLogo = setTeamLogo; } catch(_) {}
  try { window.createTeamWithLogo = createTeamWithLogo; } catch(_) {}
})();
