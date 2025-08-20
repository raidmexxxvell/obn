// static/js/profile.js
// --- Global fetch rate limiter: <= 20 req/sec, limited concurrency ---
(() => {
    try {
        const originalFetch = window.fetch.bind(window);
        const cfg = Object.assign({ tokensPerSec: 20, bucketCapacity: 20, maxConcurrent: 6 }, window.__FETCH_LIMITS__ || {});
        let tokens = cfg.bucketCapacity;
        let inFlight = 0;
        const q = [];
        const schedule = () => {
            while (q.length && tokens > 0 && inFlight < cfg.maxConcurrent) {
                tokens -= 1;
                const job = q.shift();
                inFlight += 1;
                const p = originalFetch(...job.args);
                p.finally(() => { inFlight = Math.max(0, inFlight - 1); schedule(); });
                job.resolve(p);
            }
        };
        const refillMs = Math.max(5, Math.floor(1000 / Math.max(1, cfg.tokensPerSec)));
        setInterval(() => { tokens = Math.min(cfg.bucketCapacity, tokens + 1); schedule(); }, refillMs);
        window.fetch = function(...args) {
            return new Promise((resolve) => { q.push({ args, resolve }); schedule(); });
        };
        window.__FETCH_QUEUE__ = { cfg, get length() { return q.length; }, get inFlight() { return inFlight; } };
    } catch (_) { /* no-op */ }
})();

document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp || null;
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    // Запрет масштабирования/зумов внутри приложения
    try {
        // Ctrl + колесо мыши
        window.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); } }, { passive: false });
        // Жесты (iOS/Android)
        window.addEventListener('gesturestart', (e) => e.preventDefault());
        window.addEventListener('gesturechange', (e) => e.preventDefault());
        window.addEventListener('gestureend', (e) => e.preventDefault());
        // Двойной тап/клик
        let lastTouch = 0;
        window.addEventListener('touchend', (e) => {
            const now = Date.now();
            if (now - lastTouch < 300) { e.preventDefault(); }
            lastTouch = now;
        }, { passive: false });
        window.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    } catch(_) {}

    // безопасные вызовы Telegram API
    try { tg?.expand?.(); } catch (e) { console.warn('tg.expand failed', e); }
    try { tg?.ready?.(); } catch (e) { console.warn('tg.ready failed', e); }

    // Попытка зафиксировать портретную ориентацию (где поддерживается)
    try {
        if (screen?.orientation?.lock) {
            screen.orientation.lock('portrait').catch(()=>{});
        }
    } catch(_) {}

    const elements = {
        userName: document.getElementById('user-name'),
        userAvatarImg: document.querySelector('#user-avatar img'),
        credits: document.getElementById('credits'),
        level: document.getElementById('level'),
        xp: document.getElementById('xp'),
        currentLevel: document.getElementById('current-level'),
        currentXp: document.getElementById('current-xp'),
        xpNeeded: document.getElementById('xp-needed'),
        xpProgress: document.getElementById('xp-progress'),
        checkinDays: document.getElementById('checkin-days'),
        checkinBtn: document.getElementById('checkin-btn'),
        checkinStatus: document.getElementById('checkin-status'),
        currentStreak: document.getElementById('current-streak'),
        badgesContainer: document.getElementById('badges'),
        achievementPlaceholder: document.getElementById('achievement-placeholder'),
        editName: document.getElementById('edit-name')
    };

    // Любимый клуб + счётчики фанатов команд
    const favoriteTeamSelect = document.getElementById('favorite-team');
    let _teamCountsCache = { byTeam: {}, teams: [], ts: 0 };
    async function fetchTeamsAndCounts(force = false) {
        try {
            const now = Date.now();
            if (!force && _teamCountsCache.ts && (now - _teamCountsCache.ts) < 5 * 60 * 1000) return _teamCountsCache;
            const res = await fetch('/api/teams');
            if (!res.ok) return _teamCountsCache;
            const data = await res.json();
            _teamCountsCache = { byTeam: data.counts || {}, teams: data.teams || [], ts: Date.now() };
            return _teamCountsCache;
        } catch(_) { return _teamCountsCache; }
    }
    function withTeamCount(name) {
        const n = (name || '').toString();
        try {
            const cnt = _teamCountsCache.byTeam && _teamCountsCache.byTeam[n];
            return cnt ? `${n} (${cnt})` : n;
        } catch(_) { return n; }
    }
    // Сделаем доступной глобально для других модулей (predictions.js)
    try { window.withTeamCount = withTeamCount; } catch(_) {}
    function renderFavoriteSelect(currentFavorite) {
        if (!favoriteTeamSelect) return;
        favoriteTeamSelect.innerHTML = '';
        const ph = document.createElement('option'); ph.value = ''; ph.textContent = '— выбрать —';
        favoriteTeamSelect.appendChild(ph);
        (_teamCountsCache.teams || []).forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            // В профиле — без числа фанатов
            opt.textContent = t;
            if (currentFavorite && currentFavorite === t) opt.selected = true;
            favoriteTeamSelect.appendChild(opt);
        });
    }
    async function initFavoriteTeamUI(user) {
        await fetchTeamsAndCounts();
        renderFavoriteSelect(user && (user.favorite_team || user.favoriteTeam));
    }
    async function saveFavoriteTeam(value) {
        try {
            if (value) {
                const ok = confirm('Сменить любимый клуб можно только один раз. Подтвердить выбор?');
                if (!ok) return false;
            }
            const fd = new FormData();
            fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            fd.append('team', value || '');
            const res = await fetch('/api/user/favorite-team', { method: 'POST', body: fd });
            const data = await res.json().catch(()=>({}));
            if (!res.ok) {
                const msg = data?.message || (data?.error === 'limit' ? 'Сменить любимый клуб можно только один раз' : 'Не удалось сохранить клуб');
                try { window.Telegram?.WebApp?.showAlert?.(msg); } catch(_) { try { alert(msg); } catch(_) {} }
                return false;
            }
            await fetchTeamsAndCounts(true);
            renderFavoriteSelect(value);
            return true;
        } catch(_) { return false; }
    }
    if (favoriteTeamSelect) {
        favoriteTeamSelect.addEventListener('change', (e) => { const v = e.target.value || ''; saveFavoriteTeam(v); });
    }

    // Цвета команд: нормализуем имя и подставляем цвет
    function getTeamColor(name) {
        try {
            const norm = (name || '')
                .toString()
                .trim()
                .toLowerCase()
                .replace(/ё/g, 'е')
                .replace(/[^a-z0-9а-я]+/gi, '');
            const map = {
                'полет': '#fdfdfc',
                'дождь': '#292929',
                'киборги': '#f4f3fb',
                'фкобнинск': '#eb0000',
                'ювелиры': '#333333',
                'звезда': '#a01818',
                'фкsetka4real': '#000000',
                'серпантин': '#141098',
                'креатив': '#98108c',
            };
            return map[norm] || '#3b82f6';
        } catch(_) { return '#3b82f6'; }
    }
    // Экспортируем глобально, чтобы могли использовать другие модули
    try { window.getTeamColor = getTeamColor; } catch(_) {}

    function initApp() {
        // если tg есть, но в нём нет user — сообщаем об ошибке
        if (tg && !tg.initDataUnsafe?.user) {
            console.warn('Telegram WebApp present but initDataUnsafe.user missing');
            // не прерываем — будем работать с заглушкой
        }

        // загружаем данные (в dev режиме вернём заглушку)
        setTimeout(() => {
        Promise.allSettled([ fetchUserData(), fetchAchievements() ])
                .then(() => {
                    // триггерим готовность пользовательских данных независимо от исхода
                    window.dispatchEvent(new CustomEvent('app:data-ready'));
            // параллельно загружаем таблицу (фон), чтобы закрыть splash без навигации
                    loadLeagueTable();
        // Рефералка: единичный запрос, без дублирования
        try { loadReferralInfo(); } catch(_) {}
                })
                .catch(err => console.error('Init error', err));
        }, 400); // минимальное время показа

    // Автопинг сервера каждые 3-5 минут, с учётом видимости вкладки (в фоне браузер может душить таймеры)
    let _pingTimer = null;
    const pingOnce = () => fetch(`/health?_=${Date.now()}`, { cache: 'no-store' }).catch(() => {});
    const armPing = () => { if (_pingTimer) clearInterval(_pingTimer); _pingTimer = setInterval(pingOnce, 3 * 60 * 1000); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { pingOnce(); armPing(); } });
    armPing(); pingOnce();

        // Если текущий пользователь — владелец, показываем вкладку Админ
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
            const navAdmin = document.getElementById('nav-admin');
            if (adminId && currentId && adminId === currentId && navAdmin) {
                navAdmin.style.display = '';
            }
        } catch(_) {}
    }

    // Загрузка достижений
    function fetchAchievements() {
        // если нет Telegram — пропускаем (сервер требует initData)
        if (!tg || !tg.initDataUnsafe?.user) {
            renderAchievements([]);
            return Promise.resolve([]);
        }
        const fd = new FormData();
        fd.append('initData', tg.initData || '');
        return fetch('/api/achievements', { method: 'POST', body: fd })
            .then(r => r.json())
            .then(data => { renderAchievements(data.achievements || []); return data.achievements || []; })
            .catch(err => { console.error('achievements load error', err); renderAchievements([]); return []; });
    }

    function fetchUserData() {
        if (!tg || !tg.initDataUnsafe?.user) {
            // dev-заглушка
            const dev = {
                user_id: 0,
                display_name: 'Dev User',
                credits: 1000,
                xp: 0,
                level: 1,
                consecutive_days: 0,
                last_checkin_date: ''
            };
            renderUserProfile(dev);
            renderCheckinSection(dev);
            return Promise.resolve(dev);
        }

    const formData = new FormData();
    formData.append('initData', tg.initData || '');

        return fetch('/api/user', { method: 'POST', body: formData })
            .then(res => {
                if (res.status === 401) {
                    // Не закрываем приложение при ошибке авторизации — показываем сообщение и работаем в ограниченном режиме
                    showError('Ошибка авторизации');
                    throw new Error('Unauthorized');
                }
                return res.json();
            })
            .then(async data => { renderUserProfile(data); renderCheckinSection(data); await initFavoriteTeamUI(data); return data; })
            .catch(err => { console.error('fetchUserData', err); showError('Не удалось загрузить данные'); throw err; });
    }

    function renderUserProfile(user) {
        if (!user) return;
        let avatarLoaded = false;
        const tryDispatchReady = () => {
            if (!avatarLoaded) return;
            if (elements.userName && elements.userName.textContent && elements.userName.textContent !== 'Загрузка...') {
                window.dispatchEvent(new CustomEvent('app:profile-ready'));
            }
        };
        if (elements.userAvatarImg && tg?.initDataUnsafe?.user?.photo_url) {
            elements.userAvatarImg.onload = () => { avatarLoaded = true; tryDispatchReady(); };
            elements.userAvatarImg.onerror = () => { avatarLoaded = true; tryDispatchReady(); };
            elements.userAvatarImg.src = tg.initDataUnsafe.user.photo_url;
        } else {
            avatarLoaded = true;
        }
        if (elements.userName) elements.userName.textContent = user.display_name || 'User';
        // После установки имени пробуем диспатчить готовность
        tryDispatchReady();
        if (elements.credits) elements.credits.textContent = (user.credits || 0).toLocaleString();
        if (elements.level) elements.level.textContent = user.level || 1;

        const lvl = user.level || 1;
        if (elements.currentLevel) elements.currentLevel.textContent = lvl;
        const xpForNextLevel = lvl * 100;
        const currentXp = (user.xp || 0) % xpForNextLevel;
        if (elements.xp) elements.xp.textContent = `${currentXp}/${xpForNextLevel}`;
        if (elements.currentXp) elements.currentXp.textContent = currentXp;
        if (elements.xpNeeded) elements.xpNeeded.textContent = xpForNextLevel;
        if (elements.xpProgress) elements.xpProgress.style.width = `${Math.min(Math.max((xpForNextLevel ? (currentXp / xpForNextLevel) * 100 : 0),0),100)}%`;
    }

    function renderCheckinSection(user) {
        if (!elements.checkinDays) return;
        elements.checkinDays.innerHTML = '';
        const today = new Date().toISOString().split('T')[0];
        const lastCheckin = (user.last_checkin_date || '').split('T')[0];
        const checkedToday = lastCheckin === today;
        const mod = (user.consecutive_days || 0) % 7;
        const completedCount = checkedToday ? (mod === 0 ? 7 : mod) : mod;
        const activeDay = checkedToday ? null : (mod + 1);

        if (elements.currentStreak) elements.currentStreak.textContent = user.consecutive_days || 0;

        for (let i = 1; i <= 7; i++) {
            const dayEl = document.createElement('div');
            dayEl.className = 'checkin-day';
            dayEl.textContent = i;
            if (i <= completedCount) dayEl.classList.add('completed');
            else if (activeDay && i === activeDay) dayEl.classList.add('active');
            elements.checkinDays.appendChild(dayEl);
        }

        if (checkedToday) {
            if (elements.checkinBtn) elements.checkinBtn.disabled = true;
            if (elements.checkinStatus) elements.checkinStatus.textContent = '✅ Награда получена сегодня';
        } else {
            if (elements.checkinBtn) elements.checkinBtn.disabled = false;
            if (elements.checkinStatus) elements.checkinStatus.textContent = '';
        }
    }

    function renderAchievements(achievements) {
        if (elements.achievementPlaceholder) elements.achievementPlaceholder.remove();
        if (!elements.badgesContainer) return;
        elements.badgesContainer.innerHTML = '';
        if (!achievements || achievements.length === 0) return;

        // Вычисление уникальной иконки для достижения с 4 уровнями: locked/bronze/silver/gold
        const slugify = (s) => (s || '').toString().trim()
            .toLowerCase()
            .replace(/[\s_/]+/g, '-')
            .replace(/[^a-z0-9\-]/g, '');
        const stateFromTier = (a) => {
            const t = (typeof a.tier === 'number') ? a.tier : null;
            if (a.unlocked === false || t === 0) return 'locked';
            if (t === 1) return 'bronze';
            if (t === 2) return 'silver';
            if (t === 3) return 'gold';
            // фолбэк по старому полю icon
            if (a.icon === 'bronze') return 'bronze';
            if (a.icon === 'silver') return 'silver';
            if (a.icon === 'gold') return 'gold';
            return a.unlocked ? 'bronze' : 'locked';
        };
        const setAchievementIcon = (imgEl, a) => {
            const key = a.key || a.code || a.group || a.iconKey || slugify(a.name || '');
            const base = '/static/img/achievements/';
            const state = stateFromTier(a);
            const candidates = [];
            // PNG первичны
            if (key) candidates.push(`${base}${slugify(key)}-${state}.png`);
            if (key && a.icon) candidates.push(`${base}${slugify(key)}-${slugify(a.icon)}.png`);
            candidates.push(`${base}${state}.png`);
            candidates.push(`${base}placeholder.png`);
            // SVG как запасной вариант для каждого PNG-кандидата
            const svgFallbacks = candidates.map(p => p.replace(/\.png$/i, '.svg'));
            svgFallbacks.forEach(s => { if (!candidates.includes(s)) candidates.push(s); });
            let i = 0;
            const next = () => { if (i >= candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
            next();
        };

        const descFor = (a) => {
            try {
                const tgt = a.target;
                switch (a.group) {
                    case 'streak':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : [7,30,120];
                            const base = `Ежедневные чекины подряд.`;
                            return `${base} Цели: ${all.join(' / ')}.`;
                        }
                    case 'credits':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Накопите кредиты.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'level':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Достигайте уровни. Получайте опыт за активность.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'invited':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Приглашайте друзей по реферальной ссылке.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'betcount':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Сделайте ставки.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'betwins':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Выигрывайте ставки.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'bigodds':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Выигрывайте ставки с высоким коэффициентом.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'markets':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Ставьте на разные рынки (1X2, тоталы, спецсобытия и т.д.).`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    case 'weeks':
                        {
                            const all = Array.isArray(a.all_targets) ? a.all_targets : null;
                            const base = `Делайте ставки в разные недели.`;
                            return all && all.length>1 ? `${base} Цели: ${all.join(' / ')}.` : base;
                        }
                    default:
                        return '';
                }
            } catch(_) { return ''; }
        };

        // Сортировка по близости к выполнению (меньший остаток до цели первее)
        const safe = Array.isArray(achievements) ? achievements.slice() : [];
        safe.sort((a,b) => {
            const pa = Math.max(0, (a.target||1) - (a.value||0));
            const pb = Math.max(0, (b.target||1) - (b.value||0));
            return pa - pb;
        });

        // Пагинация по 4, с кнопкой «Показать ещё»
        const pageSize = 4;
        let shown = 0;
        const renderBatch = () => {
            const batch = safe.slice(shown, shown + pageSize);
            batch.forEach(a => {
            const card = document.createElement('div');
            card.className = `achievement-card ${a.unlocked ? '' : 'locked'}`;
            const icon = document.createElement('img');
            setAchievementIcon(icon, a);
            icon.alt = a.name || 'badge';
            const name = document.createElement('div'); name.className='badge-name'; name.textContent = a.name;
            // Описание (скрыто по умолчанию) + кнопка «Описание»
            const req = document.createElement('div'); req.className='badge-requirements hidden';
            // Короткая сводка прогресса: показываем оставшееся до следующей цели, если текущая достигнута
            const progressLine = (() => {
                const vRaw = a.value ?? 0; const tRaw = a.target ?? 0;
                const v = Number(vRaw) || 0; const t = Number(tRaw) || 0;
                const tier = Number.isFinite(a.tier) ? Number(a.tier) : (a.unlocked ? 1 : 0);
                const nt = (typeof a.next_target !== 'undefined' && a.next_target !== null) ? Number(a.next_target) : null;
                const hasNext = nt !== null && Number.isFinite(nt) && nt > t;
                const maxed = (!hasNext && v >= t) || (tier >= 3);
                if (maxed) {
                    return 'Все цели достигнуты';
                }
                if (hasNext && v >= t) {
                    const remain = Math.max(0, nt - v);
                    return `До следующей цели ${nt}: осталось ${remain}`;
                }
                if (a.group === 'bigodds') {
                    return `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${Number(v||0).toFixed(2)} / ${Number(t||0).toFixed(1)}`;
                }
                return `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${v} / ${t}`;
            })();
            const fullDesc = descFor(a);
            req.textContent = fullDesc ? `${progressLine}. ${fullDesc}` : progressLine;
            const toggle = document.createElement('div');
            toggle.className = 'achv-desc-toggle';
            toggle.textContent = 'Описание';
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                req.classList.toggle('hidden');
            });
            const progressWrap = document.createElement('div');
            progressWrap.className = 'achv-progress-container';
            const progressBar = document.createElement('div');
            progressBar.className = 'achv-progress';
            // Показываем прогресс к следующему тиру (если доступен) на основании next_target с бэкенда.
            const val = Number(a.value || 0);
            const curTarget = Number(a.target || 1);
            const tier = Number.isFinite(a.tier) ? Number(a.tier) : (a.unlocked ? 1 : 0);
            const nextTarget = (typeof a.next_target !== 'undefined' && a.next_target !== null) ? Number(a.next_target) : curTarget;
            // Если тир < 3 и nextTarget > curTarget, считаем прогресс против следующей цели; иначе — против текущей
            const denom = (tier && tier < 3 && Number(nextTarget) > Number(curTarget)) ? Number(nextTarget) : Number(curTarget);
            const pct = Math.max(0, Math.min(100, Math.floor((Math.min(val, denom) / (denom || 1)) * 100)));
            progressBar.style.width = `${pct}%`;
            progressWrap.appendChild(progressBar);

            card.append(icon, name, toggle, req, progressWrap);
            elements.badgesContainer.appendChild(card);
            });
            shown += batch.length;
        };

        renderBatch();
        // Кнопка «Показать ещё», пока есть элементы (без дублей, по центру)
        const parent = elements.badgesContainer.parentElement;
        try { parent.querySelectorAll('.achv-more-btn').forEach(b => b.remove()); } catch(_) {}
        if (safe.length > shown) {
            const moreBtn = document.createElement('button');
            moreBtn.className = 'details-btn achv-more-btn';
            moreBtn.textContent = 'Показать ещё';
            moreBtn.style.display = 'block';
            moreBtn.style.margin = '12px auto';
            moreBtn.addEventListener('click', () => {
                renderBatch();
                if (shown >= safe.length) moreBtn.remove();
            });
            parent.appendChild(moreBtn);
        }
    // отметим, что достижения готовы
    _achLoaded = true;
    trySignalAllReady();
    }

    function handleCheckin() {
        if (!elements.checkinBtn) return;
        elements.checkinBtn.disabled = true;
        if (elements.checkinStatus) elements.checkinStatus.textContent = 'Обработка...';
        if (!tg || !tg.initDataUnsafe?.user) { showError('Невозможно выполнить чекин без Telegram WebApp'); elements.checkinBtn.disabled=false; return; }

    const formData = new FormData();
    formData.append('initData', tg.initData || '');

        fetch('/api/checkin', { method:'POST', body: formData })
            .then(res => {
                if (res.status === 401) {
                    // Не закрываем приложение, просто уведомляем пользователя
                    showError('Ошибка авторизации');
                    throw new Error('Unauthorized');
                }
                return res.json();
            })
            .then(data => {
                if (!data) return;
                if (data.status === 'already_checked') { if (elements.checkinStatus) elements.checkinStatus.textContent='✅ Награда получена сегодня'; return; }
                showRewardAnimation(data.xp, data.credits);
                fetchUserData(); fetchAchievements();
            })
            .catch(err => { console.error('checkin err', err); if (elements.checkinStatus) elements.checkinStatus.textContent='Ошибка получения награды'; if (elements.checkinBtn) elements.checkinBtn.disabled=false; });
    }

    function handleNameChange() {
        if (!elements.userName) return;
        // Открываем модалку
        const modal = document.getElementById('name-modal');
        const input = document.getElementById('name-input');
        const btnSave = document.getElementById('name-save');
        const btnCancel = document.getElementById('name-cancel');
        const errBox = document.getElementById('name-modal-error');
        if (!modal || !input || !btnSave || !btnCancel) return;
        input.value = elements.userName.textContent || '';
        errBox.textContent = '';
        modal.classList.add('show');
        modal.style.display = 'block';
        setTimeout(()=>{ try { input.focus(); input.select(); } catch(_){} }, 0);

        const close = () => { modal.classList.remove('show'); modal.style.display = 'none'; btnSave.disabled = false; };
        const cleanup = () => {
            modal.querySelector('.modal-backdrop')?.removeEventListener('click', onBackdrop);
            btnCancel.removeEventListener('click', onCancel);
            btnSave.removeEventListener('click', onSave);
            input.removeEventListener('keydown', onKey);
        };
        const onBackdrop = (e) => { if (e.target?.dataset?.close) { close(); cleanup(); } };
        const onCancel = () => { close(); cleanup(); };
        const onKey = (e) => { if (e.key === 'Enter') { onSave(); } if (e.key === 'Escape') { onCancel(); } };
        const onSave = async () => {
            const newName = (input.value || '').trim();
            errBox.textContent = '';
            if (!newName) { errBox.textContent = 'Введите имя.'; return; }
            if (newName === elements.userName.textContent) { errBox.textContent = 'Имя не изменилось.'; return; }
            if (!tg || !tg.initDataUnsafe?.user) { errBox.textContent = 'Нет авторизации Telegram.'; return; }
            btnSave.disabled = true;
            try {
                const formData = new FormData();
                formData.append('initData', tg.initData || '');
                formData.append('new_name', newName);
                const res = await fetch('/api/update-name', { method:'POST', body: formData });
                const d = await res.json().catch(()=>({}));
                if (!res.ok) { const msg = d?.message || 'Не удалось изменить имя'; throw new Error(msg); }
                elements.userName.textContent = d.display_name || newName;
                close(); cleanup();
            } catch (err) {
                console.error('update name err', err);
                const m = err?.message || 'Не удалось изменить имя';
                errBox.textContent = m;
                btnSave.disabled = false;
            }
        };

        modal.querySelector('.modal-backdrop')?.addEventListener('click', onBackdrop);
        btnCancel.addEventListener('click', onCancel);
        btnSave.addEventListener('click', onSave);
        input.addEventListener('keydown', onKey);
    }

    function showError(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--danger)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },3000);} else console.warn(msg); }
    function showSuccessMessage(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--success)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },2000);} else console.log(msg); }
    function showRewardAnimation(xp, credits) { if (!elements.checkinStatus) return; elements.checkinStatus.innerHTML = `<div class="reward-animation">+${xp} XP | +${credits} кредитов</div>`; setTimeout(()=>{ elements.checkinStatus.textContent='Награда получена!'; },2000); }

    function setupEventListeners() {
        if (elements.checkinBtn) elements.checkinBtn.addEventListener('click', handleCheckin);
        if (elements.editName) { elements.editName.style.cursor='pointer'; elements.editName.addEventListener('click', handleNameChange); }
        // помечаем элементы для троттлинга кликов
        if (elements.checkinBtn) elements.checkinBtn.setAttribute('data-throttle', '2000');
        if (elements.editName) elements.editName.setAttribute('data-throttle', '1500');
    // переключение вкладок нижнего меню
        const navItems = document.querySelectorAll('.nav-item');
    let _lastUfoTap = 0;
    const bottomNav = document.getElementById('bottom-nav');
    const leagueBtn = document.getElementById('nav-league-switch');
    const leagueIcon = document.getElementById('nav-league-icon');
    const leagueText = document.getElementById('nav-league-text');
        navItems.forEach(item => {
            const tab = item.getAttribute('data-tab');
            // На НЛО отключаем троттлинг, иначе двойной тап не сработает
            if (tab === 'ufo') item.setAttribute('data-throttle', '0'); else item.setAttribute('data-throttle', '600');
            item.addEventListener('click', () => {
                const tab = item.getAttribute('data-tab');
                // Если открыт экран деталей матча — закрываем его при любом переходе по нижнему меню
                try {
                    const mdPane = document.getElementById('ufo-match-details');
                    const sched = document.getElementById('ufo-schedule');
                    if (mdPane && mdPane.style.display !== 'none') {
                        mdPane.style.display = 'none';
                        if (sched) sched.style.display = '';
                        const st = document.getElementById('ufo-subtabs'); if (st) st.style.display = '';
                    }
                } catch(_) {}
                // Обработка двойного тапа для НЛО
        if (tab === 'ufo') {
                    const now = Date.now();
                    if (now - _lastUfoTap < 350) {
            // двойной тап: открыть боковое меню лиг
            try { openLeagueDrawer(); } catch(_) {}
                        _lastUfoTap = 0;
                        return;
                    }
                    _lastUfoTap = now;
                }

                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
    const home = document.getElementById('tab-home');
    const prof = document.getElementById('tab-profile');
        const ufo = document.getElementById('tab-ufo');
        const preds = document.getElementById('tab-predictions');
        const lead = document.getElementById('tab-leaderboard');
    const shop = document.getElementById('tab-shop');
    const admin = document.getElementById('tab-admin');
    [home, prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
    if (tab === 'home' && home) home.style.display = '';
    if (tab === 'profile' && prof) prof.style.display = '';
    if (tab === 'ufo' && ufo) {
        ufo.style.display = '';
        // Показ контента по активной лиге (без автопоказа оверлея)
        try {
            const act = getActiveLeague();
            if (act === 'BLB') selectBLBLeague(false); else selectUFOLeague(true, false);
            // При входе в НЛО — всегда показываем «Таблица» и скрываем детали матча
            const sub = document.querySelector('#ufo-subtabs .subtab-item[data-subtab="table"]');
            if (sub) sub.click();
        } catch(_) {}
    }
    if (tab === 'predictions' && preds) {
        preds.style.display = '';
        // Если выбрана БЛБ, показываем пусто; иначе — стандартная логика
        if (window.__ACTIVE_LEAGUE__ === 'BLB') {
            const host = document.getElementById('pred-tours');
            if (host) host.textContent = 'Скоро...';
            const myb = document.getElementById('my-bets'); if (myb) myb.textContent = 'Скоро...';
        } else {
            try { window.loadBetTours?.(); } catch(_) {}
        }
    }
    if (tab === 'leaderboard' && lead) { lead.style.display = ''; ensureLeaderboardInit(); }
    if (tab === 'shop' && shop) { shop.style.display = ''; try { window.Shop?.initShopUI?.(); } catch(_) {} }
    if (tab === 'admin' && admin) { admin.style.display = ''; try { window.Admin?.ensureAdminInit?.(); } catch(_) {} }
                // прокрутка к верху при смене вкладки
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            // Поддержка dblclick (десктоп) для оверлея
            if (tab === 'ufo') {
                item.addEventListener('dblclick', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    try { openLeagueDrawer(); } catch(_) {}
                });
                // Явная обработка touchend для надёжного двойного тапа
                let _ufoLastTouch = 0;
                item.addEventListener('touchend', (e) => {
                    const now = Date.now();
                    if (now - _ufoLastTouch < 350) {
                        e.preventDefault(); e.stopPropagation();
                        try { openLeagueDrawer(); } catch(_) {}
                        _ufoLastTouch = 0;
                    } else {
                        _ufoLastTouch = now;
                    }
                }, { passive: false });
            }
        });

        // Наполняем левую панель (иконка/название второй лиги) и кликом переключаем
        function updateNavLeaguePanel() {
            // Всегда показываем подпись «Лига», иконку оставляем текущей альтернативы
            const act = getActiveLeague();
            const other = act === 'BLB' ? 'UFO' : 'BLB';
            leagueIcon.textContent = other === 'UFO' ? '🛸' : '❔';
            leagueText.textContent = 'Лига';
        }
        leagueBtn?.addEventListener('click', () => {
            // Открываем полку выбора лиг по нажатию на мини-кнопку
            try { openLeagueDrawer(); } catch(_) {}
        });
        // Стартовая вкладка: Главная
        try {
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            const homeItem = document.querySelector('.nav-item[data-tab="home"]');
            if (homeItem) homeItem.classList.add('active');
            const home = document.getElementById('tab-home');
            const prof = document.getElementById('tab-profile');
            const ufo = document.getElementById('tab-ufo');
            const preds = document.getElementById('tab-predictions');
            const lead = document.getElementById('tab-leaderboard');
            const shop = document.getElementById('tab-shop');
            const admin = document.getElementById('tab-admin');
            [home, prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
            if (home) home.style.display = '';
        } catch(_) {}

    // Инициализация рекламной карусели на Главной
    try { initHomeAdsCarousel(); } catch(_) {}
    try { renderTopMatchOfWeek(); } catch(_) {}

        // подвкладки НЛО
    const subtabItems = document.querySelectorAll('#ufo-subtabs .subtab-item');
        const subtabMap = {
            table: document.getElementById('ufo-table'),
            stats: document.getElementById('ufo-stats'),
            schedule: document.getElementById('ufo-schedule'),
            results: document.getElementById('ufo-results'),
        };
        subtabItems.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                // При переключении подвкладок — убеждаемся, что экран деталей скрыт
                try {
                    const mdPane = document.getElementById('ufo-match-details');
                    const sched = document.getElementById('ufo-schedule');
                    if (mdPane && mdPane.style.display !== 'none') { mdPane.style.display = 'none'; if (sched) sched.style.display=''; const st = document.getElementById('ufo-subtabs'); if (st) st.style.display=''; }
                } catch(_) {}
                const key = btn.getAttribute('data-subtab');
                subtabItems.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(subtabMap).forEach(el => { if (el) el.style.display = 'none'; });
                if (subtabMap[key]) {
                    subtabMap[key].style.display = '';
                    if (key === 'table') {
                        loadLeagueTable();
                    } else if (key === 'stats') {
                        loadStatsTable();
                    } else if (key === 'schedule') {
                        loadSchedule();
                    } else if (key === 'results') {
                        loadResults();
                    }
                }
            });
        });

        // Кнопка «Обновить» на вкладке Таблица (для админа): обновляет ВСЕ панели НЛО
        try {
            const refreshBtn = document.getElementById('league-refresh-btn');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', async () => {
                    const original = refreshBtn.textContent;
                    refreshBtn.disabled = true; refreshBtn.textContent = 'Обновляю...';
                    const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
                    const reqs = [
                        fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
                        fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
                        fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
                        fetch('/api/results/refresh', { method: 'POST', body: fd })
                    ];
                    try { await Promise.allSettled(reqs); } catch(_) {}
                    // Мгновенно обновим дату локальным временем
                    try {
                        const updatedText = document.getElementById('league-updated-text');
                        if (updatedText) {
                            const now = new Date();
                            // Сохраним ISO в data-атрибут и не дадим перезаписать более старым временем
                            const iso = now.toISOString();
                            updatedText.setAttribute('data-updated-iso', iso);
                            updatedText.textContent = `Обновлено: ${now.toLocaleString()}`;
                        }
                    } catch(_) {}
                    // И параллельно актуализируем по серверу принудительным GET без кэша
                    try {
                        const u = `/api/league-table?_=${Date.now()}`;
                        const r = await fetch(u, { headers: { 'Cache-Control': 'no-store' } });
                        const data = await r.json();
                        const updatedText = document.getElementById('league-updated-text');
                        if (updatedText && data?.updated_at) {
                            setUpdatedLabelSafely(updatedText, data.updated_at);
                        }
                    } catch(_) {}
                    // Перерисуем все панели
                    try { await Promise.allSettled([ Promise.resolve(loadLeagueTable()), Promise.resolve(loadStatsTable()) ]); } catch(_) {}
                    try { localStorage.removeItem('schedule:tours'); localStorage.removeItem('results:list'); } catch(_) {}
                    try { loadSchedule(); } catch(_) {}
                    try { loadResults(); } catch(_) {}
                    refreshBtn.disabled = false; refreshBtn.textContent = original;
                });
            }
        } catch(_) {}

    // подвкладки Профиля (Достижения/Реферал)
        const pTabs = document.querySelectorAll('#profile-subtabs .subtab-item');
        const pMap = {
            badges: document.getElementById('profile-pane-badges'),
            ref: document.getElementById('profile-pane-ref'),
        };
        pTabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-psub');
                pTabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(pMap).forEach(el => { if (el) el.style.display = 'none'; });
                if (pMap[key]) {
                    pMap[key].style.display = '';
                    if (key === 'ref') loadReferralInfo();
                }
            });
        });

    // Админ-вкладки и потоки вынесены в window.Admin.ensureAdminInit()
        const shareBtn = document.getElementById('share-ref');
        if (shareBtn) {
            shareBtn.setAttribute('data-throttle', '1200');
            shareBtn.addEventListener('click', async () => {
                try {
                    // гарантируем, что реф. данные подгружены
                    if (!_referralCache) await loadReferralInfo();
                    const link = _referralCache?.referral_link || '';
                    if (!link) return;
                    const text = encodeURIComponent(`Присоединяйся к лиге: ${link}`);
                    // Telegram рекомендует использовать openTelegramLink для deeplink в чат выбора
                    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.openTelegramLink) {
                        window.Telegram.WebApp.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
                    } else if (navigator.share) {
                        try { await navigator.share({ title: 'Приглашение', text: 'Присоединяйся к лиге', url: link }); } catch(_) {}
                    } else {
                        window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
                    }
                } catch (e) { console.warn('share failed', e); }
            });
        }
    }

    // Админ-логика вынесена в static/js/admin.js (window.Admin)

    // ---------- Главная: рекламная карусель ----------
    function initHomeAdsCarousel() {
        const track = document.getElementById('ads-track');
        const dots = document.getElementById('ads-dots');
        const box = document.getElementById('ads-carousel');
        if (!track || !dots || !box) return;
        // Слайды можно задать глобально в index.html через window.__HOME_ADS__
        // Пример:
        // window.__HOME_ADS__ = [ { img:'/static/img/foto.png', title:'Здесь может быть ваша лига — нажми', action:'BLB' } ]
        let slides = Array.isArray(window.__HOME_ADS__) ? window.__HOME_ADS__.slice() : null;
        if (!slides || slides.length === 0) {
            slides = [
                { img: '/static/img/ligareklama.webp', title: 'Здесь может быть ваша лига — нажми', action: 'BLB' },
                { img: '/static/img/reklama.webp', title: '', action: '' },
                { img: '/static/img/reklama.webp', title: '', action: '' }
            ];
        }
        // Рендер слайдов
        track.innerHTML = '';
        dots.innerHTML = '';
        slides.forEach((s, idx) => {
            const slide = document.createElement('div');
            slide.className = 'ads-slide';
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = s.title || '';
            img.src = s.img;
            const overlay = document.createElement('div'); overlay.className = 'ads-overlay'; overlay.textContent = s.title || '';
            slide.append(img, overlay);
            slide.addEventListener('click', () => {
                try {
                    if (s.href) { window.open(s.href, '_blank'); return; }
                    const act = (s.action || '').toUpperCase();
                    if (act === 'BLB') {
                        selectBLBLeague(true);
                    } else if (act === 'UFO') {
                        // Плавный переход и подсказка после завершения
                        let hinted = false;
                        const onEnd = () => { if (hinted) return; hinted = true; try { showLeagueHint(); } catch(_) {} };
                        window.addEventListener('league:transition-end', onEnd, { once: true });
                        setTimeout(onEnd, 3300);
                        selectUFOLeague(false, true);
                        // Переключим вкладку на НЛО
                        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                        const navUfo = document.querySelector('.nav-item[data-tab="ufo"]');
                        if (navUfo) navUfo.classList.add('active');
                        const elHome = document.getElementById('tab-home');
                        const elUfo = document.getElementById('tab-ufo');
                        const elPreds = document.getElementById('tab-predictions');
                        const elLead = document.getElementById('tab-leaderboard');
                        const elShop = document.getElementById('tab-shop');
                        const elAdmin = document.getElementById('tab-admin');
                        [elHome, elUfo, elPreds, elLead, elShop, elAdmin].forEach(el => { if (el) el.style.display = 'none'; });
                        if (elUfo) elUfo.style.display = '';
                    }
                } catch(_) {}
            });
            track.appendChild(slide);
            const dot = document.createElement('div'); dot.className = 'ads-dot' + (idx===0?' active':'');
            dots.appendChild(dot);
        });
        // Авто-листание каждые 3 сек (если слайдов больше одного)
        let index = 0;
        const apply = () => {
            // Прокручиваем через scrollLeft (адаптивно)
            const w = box.clientWidth;
            track.scrollTo({ left: index * w, behavior: 'smooth' });
            // Обновляем точки
            const dlist = Array.from(dots.children);
            dlist.forEach((d,i) => d.classList.toggle('active', i===index));
        };
        let timer = null;
    const arm = () => { if (slides.length <= 1) return; if (timer) clearInterval(timer); timer = setInterval(() => { index = (index + 1) % slides.length; apply(); }, 5000); };
        arm();
        // Свайп-поддержка
        let startX = 0; let scx = 0; let dragging = false;
        track.addEventListener('touchstart', (e) => { if (!e.touches || !e.touches[0]) return; startX = e.touches[0].clientX; scx = track.scrollLeft; dragging = true; if (timer) clearInterval(timer); }, { passive: true });
        track.addEventListener('touchmove', (e) => { if (!dragging || !e.touches || !e.touches[0]) return; const dx = startX - e.touches[0].clientX; track.scrollLeft = scx + dx; }, { passive: true });
        track.addEventListener('touchend', (e) => {
            if (!dragging) return; dragging = false;
            const w = box.clientWidth; const cur = Math.round(track.scrollLeft / Math.max(1,w));
            index = Math.max(0, Math.min(slides.length - 1, cur));
            apply(); arm();
        }, { passive: true });
        // На ресайз подправим позицию
        window.addEventListener('resize', () => { apply(); });
        // Инициал
        apply();
    }

    // Блок «Топ матч недели» под рекламой на Главной
    async function renderTopMatchOfWeek() {
        try {
            // Показываем на Главной только для активной лиги (по ТЗ)
            if ((window.__ACTIVE_LEAGUE__ || 'UFO') !== 'UFO') {
                const host = document.getElementById('home-pane');
                if (host) host.innerHTML = '';
                return;
            }
            const res = await fetch(`/api/schedule?_=${Date.now()}`);
            const data = await res.json();
            const m = data?.match_of_week;
            const host = document.getElementById('home-pane');
            if (!host) return;
            host.innerHTML = '';
            if (!m) { host.innerHTML = '<div style="color: var(--gray);">Скоро анонс матча недели</div>'; return; }
            // Карточка
            const card = document.createElement('div'); card.className = 'match-card home-feature';
            const head = document.createElement('div'); head.className = 'match-header';
            // Заголовок: жирный и крупнее
            head.textContent = 'Игра недели';
            card.appendChild(head);
            // Подзаголовок: дата/время тонким шрифтом под заголовком
            const sub = document.createElement('div'); sub.className = 'match-subheader';
            const dtText = (() => {
                try {
                    if (m.datetime) {
                        const dt = new Date(m.datetime);
                        return dt.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                    }
                    if (m.date) {
                        if (m.time) return `${m.date} ${m.time}`;
                        return String(m.date);
                    }
                } catch(_) {}
                return '';
            })();
            if (dtText) { sub.textContent = dtText; card.appendChild(sub); }
            const center = document.createElement('div'); center.className = 'match-center';
            // Локальный загрузчик логотипов (не зависит от других модулей)
            const loadLogo = (imgEl, teamName) => {
                const base = '/static/img/team-logos/';
                const name = (teamName || '').trim();
                const candidates = [];
                try { imgEl.loading = 'lazy'; imgEl.decoding = 'async'; } catch(_) {}
                if (name) {
                    const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
                    candidates.push(base + encodeURIComponent(norm + '.png'));
                }
                candidates.push(base + 'default.png');
                let idx = 0;
                const tryNext = () => { if (idx >= candidates.length) return; imgEl.onerror = () => { idx++; tryNext(); }; imgEl.src = candidates[idx]; };
                tryNext();
            };
            const L = (name) => { const t = document.createElement('div'); t.className = 'team'; const i = document.createElement('img'); i.className='logo'; loadLogo(i, name||''); const n = document.createElement('div'); n.className='team-name'; n.textContent = name||''; t.append(i, n); return t; };
            const scoreEl = document.createElement('div'); scoreEl.className='score'; scoreEl.textContent='VS';
            center.append(L(m.home), scoreEl, L(m.away));
            card.appendChild(center);
            // Если матч идёт — показываем счёт и обновляем
            try {
                const isLive = (() => {
                    try {
                        const now = new Date();
                        if (m.datetime) { const dt = new Date(m.datetime); const end = new Date(dt.getTime()+2*60*60*1000); return now>=dt && now<end; }
                        if (m.date && m.time) { const dt = new Date(m.date + 'T' + (m.time.length===5? m.time+':00': m.time)); const end = new Date(dt.getTime()+2*60*60*1000); return now>=dt && now<end; }
                    } catch(_) {}
                    return false;
                })();
                if (isLive) {
                    scoreEl.textContent = '0 : 0';
                    const fetchScore = async () => {
                        try {
                            const r = await fetch(`/api/match/score/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`);
                            const d = await r.json();
                            if (typeof d?.score_home === 'number' && typeof d?.score_away === 'number') { scoreEl.textContent = `${Number(d.score_home)} : ${Number(d.score_away)}`; }
                        } catch(_) {}
                    };
                    fetchScore();
                }
            } catch(_) {}
            // Горизонтальная полоса голосования «П1 • X • П2» (показываем только если на матч есть ставки)
            const wrap = document.createElement('div'); wrap.className = 'vote-inline';
            const title = document.createElement('div'); title.className = 'vote-title'; title.textContent = 'Голосование';
            const bar = document.createElement('div'); bar.className = 'vote-strip';
            const segH = document.createElement('div'); segH.className = 'seg seg-h';
            const segD = document.createElement('div'); segD.className = 'seg seg-d';
            const segA = document.createElement('div'); segA.className = 'seg seg-a';
            bar.append(segH, segD, segA);
            const legend = document.createElement('div'); legend.className = 'vote-legend';
            const btns = document.createElement('div'); btns.className = 'vote-inline-btns';
            const confirm = document.createElement('div'); confirm.className = 'vote-confirm'; confirm.style.fontSize='12px'; confirm.style.color='var(--success)';
            const voteKey = (() => { try { const raw=m.date?String(m.date):(m.datetime?String(m.datetime):''); const d=raw?raw.slice(0,10):''; return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${d}`; } catch(_) { return `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__`; } })();
            const mkBtn = (code, text) => {
                const b = document.createElement('button');
                b.className = 'details-btn';
                b.textContent = text;
        b.addEventListener('click', async (e) => {
                    try { e.stopPropagation(); } catch(_) {}
                    try {
                        const fd = new FormData();
            fd.append('initData', window.Telegram?.WebApp?.initData || '');
            fd.append('home', m.home || '');
            fd.append('away', m.away || '');
            const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
            fd.append('date', dkey);
                        fd.append('choice', code);
                        const r = await fetch('/api/vote/match', { method: 'POST', body: fd });
                        if (!r.ok) throw 0;
                        btns.querySelectorAll('button').forEach(x => x.disabled = true);
                        confirm.textContent = 'Ваш голос учтён';
                        try { localStorage.setItem('voted:'+voteKey, '1'); } catch(_) {}
                        btns.style.display = 'none';
                        await loadAgg(true);
                    } catch (_) {}
                });
                return b;
            };
            btns.append(mkBtn('home','За П1'), mkBtn('draw','За X'), mkBtn('away','За П2'));
            legend.innerHTML = '<span>П1</span><span>X</span><span>П2</span>';
            wrap.append(title, bar, legend, btns, confirm);
            // Покрасим полосы под цвета команд + серый для ничьей (через background, чтобы перекрыть CSS-градиенты)
            try {
                segH.style.background = getTeamColor(m.home || '');
                segA.style.background = getTeamColor(m.away || '');
                segD.style.background = '#8e8e93';
            } catch(_) {}
            // Показываем блок только если матч в ставочных турах
            const toursCache = (() => { try { return JSON.parse(localStorage.getItem('betting:tours') || 'null'); } catch(_) { return null; } })();
            const mkKey = (obj) => { try { const h=(obj?.home||'').toLowerCase().trim(); const a=(obj?.away||'').toLowerCase().trim(); const raw=obj?.date?String(obj.date):(obj?.datetime?String(obj.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; } catch(_) { return `${(obj?.home||'').toLowerCase()}__${(obj?.away||'').toLowerCase()}__`; } };
            const tourMatches = new Set(); try { const tours=toursCache?.data?.tours || toursCache?.tours || []; tours.forEach(t => (t.matches||[]).forEach(x => tourMatches.add(mkKey(x)))); } catch(_) {}
            if (tourMatches.has(mkKey(m))) { card.appendChild(wrap); }
                        // Клика по карточке всегда открывает детали матча
                        try {
                                card.style.cursor = 'pointer';
                                card.addEventListener('click', (e) => {
                                        // Не реагируем на клики по кнопкам внутри карточки
                                        try { if (e?.target?.closest('button')) return; } catch(_) {}
                                    // Переключаемся на вкладку НЛО, чтобы экран деталей был видим
                                    try {
                                        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                                        const navUfo = document.querySelector('.nav-item[data-tab="ufo"]');
                                        if (navUfo) navUfo.classList.add('active');
                                        const elHome = document.getElementById('tab-home');
                                        const elUfo = document.getElementById('tab-ufo');
                                        const elUfoContent = document.getElementById('ufo-content');
                                        const elPreds = document.getElementById('tab-predictions');
                                        const elLead = document.getElementById('tab-leaderboard');
                                        const elShop = document.getElementById('tab-shop');
                                        const elAdmin = document.getElementById('tab-admin');
                                        [elHome, elUfo, elPreds, elLead, elShop, elAdmin].forEach(el => { if (el) el.style.display = 'none'; });
                                        if (elUfo) elUfo.style.display = '';
                                        if (elUfoContent) elUfoContent.style.display = '';
                                    } catch(_) {}
                                        const params = new URLSearchParams({ home: m.home || '', away: m.away || '' });
                                        const cacheKey = `md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`;
                                        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
                                        const fetchWithETag = (etag) => fetch(`/api/match-details?${params.toString()}`, { headers: etag ? { 'If-None-Match': etag } : {} })
                                            .then(async r => { if (r.status === 304 && cached) return cached; const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; const toStore = { data, version, ts: Date.now() }; try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_) {} return toStore; });
                                        const go = (store) => { try { window.openMatchScreen?.({ home: m.home, away: m.away, date: m.date, time: m.time }, store?.data || store); } catch(_) {} };
                                        const FRESH_TTL = 10 * 60 * 1000;
                                        const isEmptyRosters = (()=>{ try { const d=cached?.data; const h=Array.isArray(d?.rosters?.home)?d.rosters.home:[]; const a=Array.isArray(d?.rosters?.away)?d.rosters.away:[]; return h.length===0 && a.length===0; } catch(_) { return false; }})();
                                        if (cached && !isEmptyRosters && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
                                        else if (cached && cached.version) { fetchWithETag(cached.version).then(go).catch(() => { go(cached); }); }
                                        else if (cached) { go(cached); }
                                        else { fetchWithETag(null).then(go).catch(()=>{}); }
                                });
                        } catch(_) {}
            // кнопка перехода в Прогнозы
            const footer = document.createElement('div'); footer.className='match-footer';
            const goPred = document.createElement('button'); goPred.className='details-btn'; goPred.textContent='Сделать прогноз';
            goPred.addEventListener('click', (e)=>{
                try { e.stopPropagation(); } catch(_) {}
                try { document.querySelector('.nav-item[data-tab="predictions"]').click(); } catch(_) {}
            });
            footer.appendChild(goPred); card.appendChild(footer);
            host.appendChild(card);

            async function loadAgg(withInit){
                try {
            const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
            const params = new URLSearchParams({ home: m.home||'', away: m.away||'', date: dkey });
            if (withInit) params.append('initData', (window.Telegram?.WebApp?.initData || ''));
                    const agg = await fetch(`/api/vote/match-aggregates?${params.toString()}`).then(r=>r.json());
                    const h = Number(agg?.home||0), d = Number(agg?.draw||0), a = Number(agg?.away||0);
                    const sum = Math.max(1, h+d+a);
                    const ph = Math.round(h*100/sum), pd = Math.round(d*100/sum), pa = Math.round(a*100/sum);
                    segH.style.width = ph+'%'; segD.style.width = pd+'%'; segA.style.width = pa+'%';
            if (agg && agg.my_choice) { btns.querySelectorAll('button').forEach(x=>x.disabled=true); btns.style.display='none'; confirm.textContent='Ваш голос учтён'; try { localStorage.setItem('voted:'+voteKey,'1'); } catch(_) {} }
                } catch(_){ segH.style.width='33%'; segD.style.width='34%'; segA.style.width='33%'; }
            }
        try { if (localStorage.getItem('voted:'+voteKey) === '1') { btns.style.display='none'; confirm.textContent='Ваш голос учтён'; } } catch(_) {}
        loadAgg(true);
        } catch(_) {}
    }
    // Сделаем доступной глобально для вызова из других модулей (например, после назначения матча недели)
    try { window.renderTopMatchOfWeek = renderTopMatchOfWeek; } catch(_) {}

    // Магазин вынесен в static/js/shop.js (window.Shop)

    let _leagueLoading = false;
    function loadLeagueTable() {
        if (_leagueLoading) return;
        const table = document.getElementById('league-table');
        const updatedWrap = document.getElementById('league-table-updated');
        const updatedText = document.getElementById('league-updated-text');
        if (!table) return;
        _leagueLoading = true;
        fetch('/api/league-table')
            .then(r => r.json())
            .then(data => {
                try { window.League?.renderLeagueTable?.(table, updatedText, data); } catch(_) {
                    // fallback: nothing, errors are non-fatal
                }
                // показать кнопку обновления для админа (обработчик навешивается один раз выше)
                const refreshBtn = document.getElementById('league-refresh-btn');
                const adminId = document.body.getAttribute('data-admin');
                const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
                if (updatedWrap && refreshBtn && adminId && currentId && String(adminId) === currentId) {
                    refreshBtn.style.display = '';
                }
                _tableLoaded = true;
                trySignalAllReady();
            })
            .catch(err => { console.error('league table load error', err); })
            .finally(() => { _tableLoaded = true; trySignalAllReady(); _leagueLoading = false; });
    }

    // Безопасное обновление метки "Обновлено":
    // - хранит текущий ISO в data-updated-iso
    // - обновляет текст только если новый ts >= текущего
    function setUpdatedLabelSafely(labelEl, newIso) { try { window.League?.setUpdatedLabelSafely?.(labelEl, newIso); } catch(_) {} }

    let _statsLoading = false;
    function loadStatsTable() {
        if (_statsLoading) return;
        const table = document.getElementById('stats-table');
        const updated = document.getElementById('stats-table-updated');
        if (!table) return;
        _statsLoading = true;
        fetch('/api/stats-table')
            .then(r => r.json())
            .then(data => { try { window.League?.renderStatsTable?.(table, updated, data); } catch(_) {} })
            .catch(err => { console.error('stats table load error', err); })
            .finally(() => { _statsLoading = false; });
    }

    // --------- ЛИДЕРБОРД ---------
    let _leaderInited = false;
    function ensureLeaderboardInit() {
        if (_leaderInited) return;
        _leaderInited = true;
        // подвкладки
        const tabs = document.querySelectorAll('#leader-subtabs .subtab-item');
        const panes = {
            predictors: document.getElementById('leader-pane-predictors'),
            rich: document.getElementById('leader-pane-rich'),
            server: document.getElementById('leader-pane-server'),
            prizes: document.getElementById('leader-pane-prizes'),
        };
    // бейдж периода: для прогнозистов показываем неделю, для богатства — месяц. Здесь общий monthly бейдж.
        try {
            const badge = document.getElementById('leader-week-badge');
            if (badge) {
        const now = new Date();
        // Переводим now в МСК (UTC+3) без учёта DST
        const mskNow = new Date(now.getTime() + 3*60*60*1000);
        // Начало месяца в МСК 03:00
        const monthStartMsk = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), 1, 3, 0, 0));
        // Конец месяца: начало следующего месяца минус 1 день
        const nextMonthStartMsk = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth()+1, 1, 3, 0, 0));
        const periodStartUtc = new Date(monthStartMsk.getTime() - 3*60*60*1000);
        const periodEndUtc = new Date(nextMonthStartMsk.getTime() - 3*60*60*1000 - 1);
        const fmt = (d) => `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}`;
        badge.textContent = `Месяц: ${fmt(periodStartUtc)} — ${fmt(periodEndUtc)}`;
            }
        } catch(_) {}
        tabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-ltab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
                if (key === 'predictors') loadLBPredictors();
                else if (key === 'rich') loadLBRich();
                else if (key === 'server') loadLBServer();
                else if (key === 'prizes') loadLBPrizes();
            });
        });
        // первичная загрузка
        loadLBPredictors();
    }

    function etagFetch(url, cacheKey) {
        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
        const ifNone = cached?.version ? { 'If-None-Match': cached.version } : {};
        return fetch(url, { headers: ifNone })
            .then(async r => {
                if (r.status === 304 && cached) return cached; // валидный кэш
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
                try { localStorage.setItem(cacheKey, JSON.stringify(store)); } catch(_) {}
                return store;
            })
            .catch(err => { if (cached) return cached; throw err; });
    }

    function loadLBPredictors() {
        const table = document.querySelector('#lb-predictors tbody');
        const updated = document.getElementById('lb-predictors-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/top-predictors', 'lb:predictors')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${it.bets_total}</td><td>${it.bets_won}</td><td>${it.winrate}%</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb predictors err', err));
    }

    function loadLBRich() {
        const table = document.querySelector('#lb-rich tbody');
        const updated = document.getElementById('lb-rich-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/top-rich', 'lb:rich')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${Number(it.gain||0).toLocaleString()}</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb rich err', err));
    }

    function loadLBServer() {
        const table = document.querySelector('#lb-server tbody');
        const updated = document.getElementById('lb-server-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/server-leaders', 'lb:server')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${it.level}</td><td>${it.xp}</td><td>${it.streak}</td><td>${it.score}</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb server err', err));
    }

    function loadLBPrizes() {
        const host = document.getElementById('lb-prizes');
        const updated = document.getElementById('lb-prizes-updated');
        if (!host) return;
        etagFetch('/api/leaderboard/prizes', 'lb:prizes')
            .then(store => {
                const data = store?.data?.data || {};
                host.innerHTML = '';
                const blocks = [
                    { key: 'predictors', title: 'Топ прогнозистов' },
                    { key: 'rich', title: 'Лидеры месяца' },
                    { key: 'server', title: 'Лидеры сервера' },
                ];
                // загрузим аватарки победителей одним запросом
                const allIds = new Set();
                blocks.forEach(b => { (data[b.key]||[]).forEach(it => { if (it?.user_id) allIds.add(it.user_id); }); });
                const idsParam = Array.from(allIds).join(',');
                const render = (avatars) => {
                    blocks.forEach(b => {
                    const section = document.createElement('div'); section.className = 'prize-block';
                    const h = document.createElement('h3'); h.textContent = b.title; section.appendChild(h);
                    const podium = document.createElement('div'); podium.className = 'podium';
                    const items = data[b.key] || [];
                    // порядок пьедестала: 2-е, 1-е, 3-е для симметрии
                    const order = [1, 0, 2];
                    order.forEach(i => {
                        const it = items[i];
                        const pl = document.createElement('div'); pl.className = 'podium-place';
                        if (i === 0) pl.classList.add('gold');
                        if (i === 1) pl.classList.add('silver');
                        if (i === 2) pl.classList.add('bronze');
                        const avatar = document.createElement('div'); avatar.className = 'podium-avatar';
                        const img = document.createElement('img'); img.alt = it?.display_name || '';
                        // Аватар с бэкенда, если есть; иначе заглушка
                        const key = it?.user_id ? String(it.user_id) : null;
                        const photo = (key && avatars && avatars[key]) ? avatars[key] : '/static/img/achievements/placeholder.png';
                        img.src = photo;
                        avatar.appendChild(img);
                        const name = document.createElement('div'); name.className = 'podium-name'; name.textContent = it ? it.display_name : '—';
                        pl.append(avatar, name);
                        podium.appendChild(pl);
                    });
                    section.appendChild(podium);
                    host.appendChild(section);
                    });
                };
                if (idsParam) {
                    fetch(`/api/user/avatars?ids=${encodeURIComponent(idsParam)}`).then(r=>r.json()).then(d => { render(d.avatars||{}); }).catch(()=>{ render({}); });
                } else {
                    render({});
                }
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb prizes err', err));
    }

    function escapeHtml(s) {
        return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
    }

    // --------- РАСПИСАНИЕ ---------
    let _scheduleLoading = false;
    function loadSchedule() {
        if (_scheduleLoading) return;
        const pane = document.getElementById('ufo-schedule');
        if (!pane) return;
        _scheduleLoading = true;
    const CACHE_KEY = 'schedule:tours';
    const FRESH_TTL = 10 * 60 * 1000; // 10 минут
    const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
    const cached = readCache();
    if (!cached) pane.innerHTML = '<div class="schedule-loading">Загрузка расписания...</div>';

        // Хелпер: загрузка логотипа команды с фолбэками по названию
        const loadTeamLogo = (imgEl, teamName) => {
            const base = '/static/img/team-logos/';
            const name = (teamName || '').trim();
            const candidates = [];
            if (name) {
        // 1) нормализованное: нижний регистр, без пробелов/ё->е
        const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
        const ver = `?v=${Date.now()}`;
        candidates.push(base + encodeURIComponent(norm + '.png') + ver);
        // 2) при желании можно попытаться точным именем (закомментировано для избежания 404-спама)
        // candidates.push(base + encodeURIComponent(name + '.png'));
            }
            // 3) дефолт (с версией)
            candidates.push(base + 'default.png' + `?v=${Date.now()}`);

            let idx = 0;
            const tryNext = () => {
                if (idx >= candidates.length) return;
                imgEl.onerror = () => { idx++; tryNext(); };
                imgEl.src = candidates[idx];
            };
            tryNext();
        };
    const renderSchedule = (data) => {
            try { window.League?.renderSchedule?.(pane, data?.data || data); } catch(_) {
                // fall back: preserve existing empty state
                const ds = data?.tours ? data : (data?.data || {});
                const tours = ds.tours || [];
                if (!tours.length && !(pane.childElementCount > 0 || pane.dataset.hasContent === '1')) {
                    pane.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>';
                }
            }
        };

        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) {
            renderSchedule(cached);
        }
        const fetchWithETag = (etag) => fetch('/api/schedule', { headers: etag ? { 'If-None-Match': etag } : {} })
            .then(async r => {
                if (r.status === 304 && cached) return cached;
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
                // Не затираем кэш пустыми турами, если кэш уже есть и свежий
                const incomingTours = Array.isArray(data?.tours) ? data.tours : Array.isArray(data?.data?.tours) ? data.data.tours : [];
                const cachedTours = Array.isArray(cached?.data?.tours) ? cached.data.tours : [];
                const shouldWrite = incomingTours.length > 0 || !cached || cachedTours.length === 0;
                if (shouldWrite) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch(_) {} }
                return store;
            });
        const startNetwork = () => {
            const p = (cached && cached.version) ? fetchWithETag(cached.version) : fetchWithETag(null);
            p.then(renderSchedule)
             .catch(err => { console.error('schedule load error', err); if (!cached && pane.childElementCount === 0) pane.innerHTML = '<div class="schedule-error">Не удалось загрузить расписание</div>'; })
             .finally(() => { _scheduleLoading = false; });
        };
        startNetwork();
    }

    // --------- РЕЗУЛЬТАТЫ ---------
    let _resultsLoading = false;
    function loadResults() {
        if (_resultsLoading) return;
        const pane = document.getElementById('ufo-results');
        if (!pane) return;
    _resultsLoading = true;
    const CACHE_KEY = 'results:list';
    const FRESH_TTL = 10 * 60 * 1000; // 10 минут
    const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
    const cached = readCache();
    if (!cached) pane.innerHTML = '<div class="schedule-loading">Загрузка результатов...</div>';

    const loadTeamLogo = (imgEl, teamName) => {
            const base = '/static/img/team-logos/';
            const name = (teamName || '').trim();
            const candidates = [];
            if (name) {
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
        candidates.push(base + encodeURIComponent(norm + '.png') + `?v=${Date.now()}`);
            }
        candidates.push(base + 'default.png' + `?v=${Date.now()}`);
            let idx = 0;
            const tryNext = () => { if (idx >= candidates.length) return; imgEl.onerror = () => { idx++; tryNext(); }; imgEl.src = candidates[idx]; };
            tryNext();
        };

        // ETag-кэш для /api/results
    const writeCache = (obj) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch(_) {} };

    const fetchWithETag = (etag) => fetch('/api/results', { headers: etag ? { 'If-None-Match': etag } : {} })
            .then(async r => {
                if (r.status === 304 && cached) return cached; // валидный кэш
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
        // Не перезаписываем кэш пустыми результатами, если уже были
        const incoming = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data?.results) ? data.data.results : [];
        const cachedList = Array.isArray(cached?.data?.results) ? cached.data.results : [];
        const shouldWrite = incoming.length > 0 || !cached || cachedList.length === 0;
        if (shouldWrite) writeCache(store);
                return store;
            });

    const renderResults = (data) => {
            try { window.League?.renderResults?.(pane, data?.data || data); } catch(_) {
                const all = data?.results || data?.data?.results || [];
                if (!all.length && !(pane.childElementCount > 0 || pane.dataset.hasContent === '1')) {
                    pane.innerHTML = '<div class="schedule-empty">Нет прошедших матчей</div>';
                }
            }
        };

        const go = (store) => { renderResults(store?.data || store); _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady(); };

    if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
    else if (cached) { go(cached); }
    // сеть — в любом случае валидируем/обновляем кэш
    if (cached && cached.version) fetchWithETag(cached.version).then(go).catch(()=>{});
    else fetchWithETag(null).then(go).catch(err => { console.error('results load error', err); if (!cached) pane.innerHTML = '<div class="schedule-error">Не удалось загрузить результаты</div>'; _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady(); });
    }

    ; // separator for parser safety
    // Предзагрузка статистики и расписания во время заставки
    let _resultsPreloaded = false;
    let _schedulePreloaded = false;
    let _statsPreloaded = false;
    function preloadUfoData() {
        // Статистика
        fetch('/api/stats-table', { headers: { 'Cache-Control': 'no-cache' } })
            .then(r => r.json()).then(() => { _statsPreloaded = true; trySignalAllReady(); })
            .catch(() => { _statsPreloaded = true; trySignalAllReady(); });
        // Расписание — сохраним в кэш с версией
        fetch('/api/schedule', { headers: { 'Cache-Control': 'no-cache' } })
            .then(async r => { const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; try { localStorage.setItem('schedule:tours', JSON.stringify({ data, version, ts: Date.now() })); } catch(_) {} })
            .finally(() => { _schedulePreloaded = true; trySignalAllReady(); });
        // Результаты — сохраним в кэш с версией
        fetch('/api/results', { headers: { 'Cache-Control': 'no-cache' } })
            .then(async r => { const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; try { localStorage.setItem('results:list', JSON.stringify({ data, version, ts: Date.now() })); } catch(_) {} })
            .finally(() => { _resultsPreloaded = true; trySignalAllReady(); });

        // Прогнозы/Ставки: предзагрузка ближайшего тура и моих ставок (если в Telegram)
        try {
            const tg = window.Telegram?.WebApp || null;
            const FRESH_TTL = 5 * 60 * 1000; // 5 минут
            // Туры для ставок (публично, GET)
            fetch('/api/betting/tours', { headers: { 'Cache-Control': 'no-cache' } })
                .then(async r => {
                    const data = await r.json();
                    const version = data.version || r.headers.get('ETag') || null;
                    const store = { data, version, ts: Date.now() };
                    try { localStorage.setItem('betting:tours', JSON.stringify(store)); } catch(_) {}
                })
                .catch(()=>{});
            // Мои ставки (только в Telegram)
            if (tg?.initDataUnsafe?.user) {
                const fd = new FormData(); fd.append('initData', tg.initData || '');
                fetch('/api/betting/my-bets', { method: 'POST', body: fd })
                    .then(r => r.json())
                    .then(data => { try { localStorage.setItem('betting:mybets', JSON.stringify({ data, ts: Date.now() })); } catch(_) {} })
                    .catch(()=>{});
            }
        } catch(_) {}
    }

    // ---------- ЛИГИ: НЛО / БЛБ (оверлей над нижним меню) ----------
    function getActiveLeague() {
        try {
            const mem = sessionStorage.getItem('activeLeague');
            if (mem === 'BLB' || mem === 'UFO') return mem;
        } catch(_) {}
        return window.__ACTIVE_LEAGUE__ || 'UFO';
    }
    function setActiveLeague(code) {
        window.__ACTIVE_LEAGUE__ = code;
        try { sessionStorage.setItem('activeLeague', code || 'UFO'); } catch(_) {}
        try { updateNavLeagueIcon(); } catch(_) {}
    }
    function renderLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        if (!overlay) return;
        const act = getActiveLeague();
        const other = act === 'BLB' ? 'UFO' : 'BLB';
        const ico = other === 'UFO' ? '🛸' : '❔';
        const title = other === 'UFO' ? 'НЛО' : 'БЛБ';
        // Рендерим одну иконку как продолжение нижнего меню
        overlay.innerHTML = `
            <div class="league-icons" style="display:flex; align-items:center; justify-content:center; background: rgba(10,18,40,0.96); padding:6px 0; border-radius: 10px 10px 0 0; box-shadow: 0 6px 18px rgba(0,0,0,0.4);">
                <div class="nav-icon" data-league="${other}" title="${title}" style="font-size:22px; cursor:pointer; line-height:1;">${ico}</div>
            </div>
        `;
        // Подгонка позиции/размера под иконку меню
        try {
            const anchor = document.querySelector('.nav-item[data-tab="ufo"]');
            const nav = document.querySelector('nav.nav');
            if (anchor && nav) {
                const r = anchor.getBoundingClientRect();
                const rn = nav.getBoundingClientRect();
                // Ширина как у иконки меню
                const w = Math.max(40, Math.floor(r.width));
                overlay.style.width = `${w}px`;
                // Привязать левый край плашки к левому краю нижнего меню
                const leftEdge = Math.floor(rn.left);
                overlay.style.left = `${leftEdge}px`;
                overlay.style.transform = 'none';
                // Чуть поднять над меню
                const gap = 6;
                const navH = Math.floor(rn.height);
                overlay.style.bottom = `${navH + gap}px`;
            }
        } catch(_) {}
    }
    function showLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!overlay || !ufoTabs || !ufoContent || !blbBlock) return;
    // если уже открыт — не дублируем
    if (overlay.style.display === 'block') return;
        // Обновим содержимое оверлея и покажем
        renderLeagueOverlay();
        overlay.style.display = 'block';
        if (!overlay.__inited) {
            overlay.__inited = true;
        overlay.addEventListener('click', (e) => {
                const ico = e.target.closest('.nav-icon[data-league]');
                if (ico) {
                    const key = ico.getAttribute('data-league');
            // Выбор из оверлея: включаем анимацию перехода
            if (key === 'UFO') selectUFOLeague(false, true);
            if (key === 'BLB') selectBLBLeague(true);
                    overlay.style.display = 'none';
                    return;
                }
            });
            // Клик вне оверлея — закрыть
            document.addEventListener('click', (e) => {
                const isUfoNav = !!e.target.closest('.nav-item[data-tab="ufo"]');
                if (!overlay || overlay.style.display === 'none') return;
                if (e.target.closest('#league-overlay') || isUfoNav) return;
                overlay.style.display = 'none';
            });
            // При ресайзе/смене ориентации — скрыть
            window.addEventListener('resize', () => { if (overlay) overlay.style.display = 'none'; });
            window.addEventListener('orientationchange', () => { if (overlay) overlay.style.display = 'none'; });
        }
        // На всякий случай пересчитать позицию после показа (рендер может занять тик)
        setTimeout(renderLeagueOverlay, 0);
    }

    function selectUFOLeague(_silent, animate=false) {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!ufoTabs || !ufoContent || !blbBlock) return;
    setActiveLeague('UFO');
        if (overlay) overlay.style.display = 'none';
        blbBlock.style.display = 'none';
        ufoTabs.style.display = '';
        ufoContent.style.display = '';
        if (!_silent) {
            // Ждём, пока оверлей полностью закроет экран, и ещё 1 сек — затем подгружаем
            const onCovered = () => {
                setTimeout(() => {
                    try { loadLeagueTable(); } catch(_) {}
                    try { loadStatsTable(); } catch(_) {}
                    try { loadSchedule(); } catch(_) {}
                    try { loadResults(); } catch(_) {}
                    try { renderTopMatchOfWeek(); } catch(_) {}
                }, 1000);
                window.removeEventListener('league:transition-covered', onCovered);
            };
            window.addEventListener('league:transition-covered', onCovered);
            // На случай, если анимации нет — фолбэк сразу
            if (!animate) { window.removeEventListener('league:transition-covered', onCovered); onCovered(); }
        }
    if (animate) {
        // Показать подсказку после завершения анимации (один раз для пользователя)
        const onEnd = () => { try { showLeagueHint(); } catch(_) {} };
        window.addEventListener('league:transition-end', onEnd, { once: true });
        playLeagueTransition('UFO');
    }
    }

    function selectBLBLeague(animate=false) {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!ufoTabs || !ufoContent || !blbBlock) return;
        setActiveLeague('BLB');
        if (overlay) overlay.style.display = 'none';
        ufoTabs.style.display = 'none';
        ufoContent.style.display = 'none';
        blbBlock.style.display = '';
        // Небольшая задержка показа контента БЛБ после покрытия оверлеем
        const showBLB = () => { initBLBSubtabs(); window.removeEventListener('league:transition-covered', showBLB); };
        window.addEventListener('league:transition-covered', showBLB);
        if (!animate) { window.removeEventListener('league:transition-covered', showBLB); showBLB(); }
    // Обновим «Матч недели» на Главной в соответствии с активной лигой
    try { renderTopMatchOfWeek(); } catch(_) {}
    if (animate) {
        // Показать подсказку после завершения анимации (один раз для пользователя)
        const onEnd = () => { try { showLeagueHint(); } catch(_) {} };
        window.addEventListener('league:transition-end', onEnd, { once: true });
        playLeagueTransition('BLB');
    }
    }

    function playLeagueTransition(to) {
        try {
            const layer = document.getElementById('league-transition');
            if (!layer) return;
            const content = document.createElement('div');
            content.className = 'lt-content';
            const img = document.createElement('img');
            img.className = 'lt-logo';
            const title = document.createElement('div');
            title.className = 'lt-title';
            // Очистим классы стадий
            layer.classList.remove('lt-fill-bottom','lt-fill-top','lt-unfill-top','lt-unfill-bottom');
            if (to === 'BLB') {
                img.src = '/static/img/placeholderlogo.png';
                title.textContent = 'Здесь может быть ваша лига';
                layer.style.display = 'flex';
                // Используем золотисто-черную палитру BLБ: мягкий градиент к золотистому
                layer.style.background = 'linear-gradient(135deg, #0b0b0b 0%, #1a160c 40%, #8d6e2f 100%)';
                // Фаза 1: заливка снизу вверх (1s)
                layer.classList.add('lt-fill-bottom');
                // Сразу после старта заливки считаем экран покрытым
                try { window.dispatchEvent(new CustomEvent('league:transition-covered', { detail: { to } })); } catch(_) {}
        setTimeout(() => {
                    // Смена темы/топ-бара во время полной заливки (пользователь не видит)
                    document.body.classList.add('theme-blb');
                    const t = document.querySelector('.top-bar .league-title');
                    if (t) t.textContent = 'Название лиги';
                    const logo = document.querySelector('.top-bar .league-logo');
                    if (logo) logo.src = '/static/img/placeholderlogo.png';
                    // Пауза 1s
                    layer.classList.remove('lt-fill-bottom');
                    setTimeout(() => {
                        // Фаза 2: уборка вверх (1s)
                        layer.classList.add('lt-unfill-top');
            setTimeout(() => { layer.style.display = 'none'; layer.classList.remove('lt-unfill-top'); try { window.dispatchEvent(new CustomEvent('league:transition-end', { detail: { to } })); } catch(_) {} }, 1000);
                    }, 1000);
                }, 1000);
            } else {
                img.src = '/static/img/logo.png';
                title.textContent = 'ОБНИНСКСКАЯ ЛИГА';
                layer.style.display = 'flex';
                // Используем палитру стартовой заставки (splash): var(--dark)->var(--darker)
                // Берём переменные с :root (а не body), чтобы не подмешивалась тема BLB
                const cs = getComputedStyle(document.documentElement);
                const dark = (cs.getPropertyValue('--dark') || '#0f172a').trim();
                const darker = (cs.getPropertyValue('--darker') || '#020617').trim();
                layer.style.background = `linear-gradient(135deg, ${dark}, ${darker})`;
                // Фаза 1: заливка сверху вниз (1s)
                layer.classList.add('lt-fill-top');
                // Сразу после старта заливки считаем экран покрытым
                try { window.dispatchEvent(new CustomEvent('league:transition-covered', { detail: { to } })); } catch(_) {}
                setTimeout(() => {
                    // Смена темы/топ-бара во время полной заливки
                    document.body.classList.remove('theme-blb');
                    const t = document.querySelector('.top-bar .league-title');
                    if (t) t.textContent = 'Лига Обнинска';
                    const logo = document.querySelector('.top-bar .league-logo');
                    if (logo) logo.src = '/static/img/logo.png';
                    // Пауза 1s
                    layer.classList.remove('lt-fill-top');
                    setTimeout(() => {
                        // Фаза 2: уборка вниз (1s)
                        layer.classList.add('lt-unfill-bottom');
                        setTimeout(() => { layer.style.display = 'none'; layer.classList.remove('lt-unfill-bottom'); try { window.dispatchEvent(new CustomEvent('league:transition-end', { detail: { to } })); } catch(_) {} }, 1000);
                    }, 1000);
                }, 1000);
            }
            content.appendChild(img);
            content.appendChild(title);
            layer.innerHTML = '';
            layer.appendChild(content);
        } catch(_) {}
    }

    // Красиво открывающаяся «полка» списка лиг из нижнего меню
    function ensureLeagueShelf() {
        let shelf = document.getElementById('league-shelf');
        if (shelf) return shelf;
        shelf = document.createElement('div');
        shelf.id = 'league-shelf';
        shelf.className = 'league-shelf';
        shelf.style.position = 'fixed';
        shelf.style.left = '50%';
        shelf.style.transform = 'translateX(-50%)';
        shelf.style.bottom = '0';
        shelf.style.zIndex = '1099';
        const inner = document.createElement('div');
        inner.className = 'league-options';
        // Две плитки лиг
        const mkTile = (code, icon, name) => {
            const tile = document.createElement('div'); tile.className = 'league-tile'; tile.setAttribute('data-league', code);
            const ic = document.createElement('div'); ic.className = 'league-icon'; ic.textContent = icon;
            const nm = document.createElement('div'); nm.className = 'league-name'; nm.textContent = name;
            tile.append(ic, nm);
            tile.addEventListener('click', () => {
                try {
                    if (code === 'UFO') selectUFOLeague(false, true); else selectBLBLeague(true);
                } catch(_) {}
                closeLeagueShelf();
            });
            return tile;
        };
        inner.append(
            mkTile('UFO', '🛸', 'НЛО'),
            mkTile('BLB', '❔', 'БЛБ')
        );
        shelf.appendChild(inner);
        document.body.appendChild(shelf);
        // Закрытие по клику вне полки
        setTimeout(() => {
            const onDoc = (e) => { if (!shelf.contains(e.target) && !e.target.closest('nav.nav')) { closeLeagueShelf(); } };
            document.addEventListener('click', onDoc, { capture: true });
            shelf.__onDoc = onDoc;
        }, 0);
        return shelf;
    }
    // Старое всплывающее меню лиг больше не используется

    // Боковой drawer лиг
    function openLeagueDrawer() {
        const drawer = document.getElementById('league-drawer');
        const nav = document.getElementById('bottom-nav');
        if (!drawer) return;
        // скрыть нижнее меню быстро
    if (nav) { nav.style.transition = 'transform .12s ease, opacity .12s ease'; nav.style.transform = 'translateX(-50%) translateY(100%)'; nav.style.opacity = '0'; }
        drawer.style.display = 'block';
        requestAnimationFrame(() => { drawer.style.transform = 'translateX(0)'; drawer.setAttribute('aria-hidden', 'false'); });
        const onClick = (e) => {
            const btn = e.target.closest('.drawer-item');
            if (!btn) return;
            const key = btn.getAttribute('data-league');
            // анимация перехода
            if (key === 'UFO') selectUFOLeague(false, true); else if (key === 'BLB') selectBLBLeague(true);
            // сразу закрываем drawer, чтобы не мешал анимации перехода
            closeLeagueDrawer();
        };
        drawer.addEventListener('click', onClick, { once: true });
        // клик вне — закрытие
        const onDoc = (e) => { if (!drawer.contains(e.target)) closeLeagueDrawer(); };
        setTimeout(() => document.addEventListener('click', onDoc, { capture: true, once: true }), 0);
    }
    function closeLeagueDrawer() {
        const drawer = document.getElementById('league-drawer');
        const nav = document.getElementById('bottom-nav');
        if (!drawer) return;
        drawer.style.transform = 'translateX(100%)';
        setTimeout(() => { drawer.style.display = 'none'; drawer.setAttribute('aria-hidden', 'true'); }, 280);
        if (nav) {
            nav.style.transform = 'translateX(-50%) translateY(0)';
            nav.style.opacity = '1';
            // немного отложим сброс transition, чтобы анимация вернулась корректно
            setTimeout(() => { if (nav) nav.style.transition = ''; }, 60);
        }
    }

    function initBLBSubtabs() {
        const tabs = document.querySelectorAll('#blb-subtabs .subtab-item');
        const panes = {
            table: document.getElementById('blb-table'),
            stats: document.getElementById('blb-stats'),
            schedule: document.getElementById('blb-schedule'),
            results: document.getElementById('blb-results')
        };
        tabs.forEach(btn => {
            if (btn.__inited) return; btn.__inited = true;
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-blbtab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
            });
        });
    }

    // Подсказка: стрелка к вкладке «Лига» с текстом (один раз). Стрелка и текст двигаются синхронно.
    function showLeagueHint() {
        try {
            // Только один раз для пользователя
            try { if (localStorage.getItem('hint:league-shown') === '1') return; } catch(_) {}
            if (document.getElementById('league-hint-tip')) return;
            const target = document.querySelector('.nav-item[data-tab="ufo"]');
            const nav = document.querySelector('nav.nav');
            if (!target || !nav) return;
            const r = target.getBoundingClientRect();
            const rn = nav.getBoundingClientRect();
            const tip = document.createElement('div');
            tip.id = 'league-hint-tip';
            tip.style.position = 'fixed';
            tip.style.zIndex = '1200';
            tip.style.pointerEvents = 'none';
            // Стрелка (анимированная)
            const arrow = document.createElement('div');
            arrow.style.width = '0';
            arrow.style.height = '0';
            arrow.style.borderLeft = '7px solid transparent';
            arrow.style.borderRight = '7px solid transparent';
            arrow.style.borderTop = '12px solid #fff';
            arrow.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,.6))';
            arrow.style.position = 'absolute';
            arrow.style.left = '50%';
            arrow.style.transform = 'translateX(-50%)';
            arrow.style.bottom = '14px';
            arrow.style.animation = 'hint-bounce 1s ease-in-out infinite';
            // Текст (появится позже)
            const label = document.createElement('div');
            label.textContent = 'Двойное нажатие — выбор лиги';
            label.style.position = 'absolute';
            label.style.left = '50%';
            // Совместим анимацию с стрелкой: вертикально синхронный bounce
            label.style.transform = 'translateX(-50%)';
            label.style.bottom = '30px';
            label.style.fontSize = '11px';
            label.style.fontWeight = '800';
            label.style.color = '#fff';
            label.style.whiteSpace = 'nowrap';
            label.style.textShadow = '0 1px 2px rgba(0,0,0,.6)';
            // Появление и синхронная анимация
            label.style.opacity = '0';
            label.style.transition = 'opacity .25s ease';
            label.style.animation = 'hint-bounce 1s ease-in-out infinite';
            tip.appendChild(arrow);
            tip.appendChild(label);
            document.body.appendChild(tip);
            // Позиционирование по центру иконки лиги
            let centerX = r.left + r.width / 2;
            tip.style.left = `${Math.round(centerX)}px`;
            // Центрируем контейнер и затем ограничиваем с учётом реальной ширины
            tip.style.transform = 'translateX(-50%)';
            const margin = 16;
            // После рендера измерим и поправим позицию
            requestAnimationFrame(() => {
                try {
                    const bw = tip.getBoundingClientRect().width || 0;
                    const half = bw / 2;
                    const clampedCenter = Math.max(margin + half, Math.min(window.innerWidth - margin - half, centerX));
                    tip.style.left = `${Math.round(clampedCenter)}px`;
                } catch(_) {}
            });
            tip.style.bottom = `${Math.round((window.innerHeight - rn.top) + 6)}px`;
            // Показать текст сразу после завершения перехода (функция вызывается по событию 
            // league:transition-end с once, но оставим лёгкую задержку для плавности)
            setTimeout(() => { label.style.opacity = '1'; }, 200);
            // Убрать подсказку по клику по нижнему меню или через таймаут, и больше не показывать
            const cleanup = () => {
                try { localStorage.setItem('hint:league-shown', '1'); } catch(_) {}
                try { tip.remove(); } catch(_) {}
                document.removeEventListener('click', onDocClick, true);
            };
            const onDocClick = (e) => { if (e.target.closest('nav.nav')) cleanup(); };
            document.addEventListener('click', onDocClick, true);
            setTimeout(cleanup, 6000);
            // Встроенная keyframes-анимация
            if (!document.getElementById('hint-bounce-style')) {
                const st = document.createElement('style');
                st.id = 'hint-bounce-style';
                // Дублируем translateX, чтобы синхронность сохранялась для обоих элементов
                st.textContent = `@keyframes hint-bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-6px)}}`;
                document.head.appendChild(st);
            }
        } catch(_) {}
    }

    // ---------- MATCH DETAILS SCREEN (in-app, not modal) ----------
    function openMatchScreen(match, details) {
    const schedulePane = document.getElementById('ufo-schedule');
        const mdPane = document.getElementById('ufo-match-details');
        if (!schedulePane || !mdPane) return;
    // Скрыть все основные панели лиги, чтобы не было «Таблица/Статистика» сверху
    try {
        const tablePane = document.getElementById('ufo-table');
        const statsPaneLeague = document.getElementById('ufo-stats');
        const resultsPane = document.getElementById('ufo-results');
        [tablePane, statsPaneLeague, schedulePane, resultsPane].forEach(p => { if (p) p.style.display = 'none'; });
    } catch(_) {}
    // Очистим возможные дубликаты админских контролов
    try { mdPane.querySelectorAll('.admin-score-ctrls').forEach(n => n.remove()); } catch(_) {}
    // показать экран деталей
    schedulePane.style.display = 'none';
    mdPane.style.display = '';
    // Скрыть верхние подвкладки лиги в деталях, чтобы не мешали (таблица/статистика/расписание/результаты)
    try { document.getElementById('ufo-subtabs').style.display = 'none'; } catch(_) {}

        const hLogo = document.getElementById('md-home-logo');
        const aLogo = document.getElementById('md-away-logo');
        const hName = document.getElementById('md-home-name');
        const aName = document.getElementById('md-away-name');
        const score = document.getElementById('md-score');
        const dt = document.getElementById('md-datetime');
        const homePane = document.getElementById('md-pane-home');
        const awayPane = document.getElementById('md-pane-away');

        // логотипы
    const setLogo = (imgEl, name) => {
            const base = '/static/img/team-logos/';
            const candidates = [];
            if (name) {
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
        candidates.push(base + encodeURIComponent(norm + '.png') + `?v=${Date.now()}`);
                // candidates.push(base + encodeURIComponent(name + '.png'));
            }
        candidates.push(base + 'default.png' + `?v=${Date.now()}`);
            let i = 0;
            const next = () => { if (i >= candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
            next();
        };

    // Показываем названия с числом фанатов; атрибуты храним «сырые»
    hName.setAttribute('data-team-name', match.home || '');
    aName.setAttribute('data-team-name', match.away || '');
    hName.textContent = withTeamCount(match.home || '');
    aName.textContent = withTeamCount(match.away || '');
        setLogo(hLogo, match.home || '');
        setLogo(aLogo, match.away || '');
    score.textContent = '— : —';
        try {
            if (match.date || match.time) {
                const d = match.date ? new Date(match.date) : null;
                const ds = d ? d.toLocaleDateString() : '';
                dt.textContent = `${ds}${match.time ? ' ' + match.time : ''}`;
            } else { dt.textContent = ''; }
        } catch(_) { dt.textContent = match.time || ''; }

    // вкладки (добавим «Спецсобытия» для админа и «Трансляция», если есть в конфиге)
        const subtabs = mdPane.querySelector('.modal-subtabs');
        mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((el) => el.classList.remove('active'));
        // Переименуем вкладки на имена команд
        try {
            const tabHome = subtabs?.querySelector('[data-mdtab="home"]');
            const tabAway = subtabs?.querySelector('[data-mdtab="away"]');
            if (tabHome) tabHome.textContent = (match.home || 'Команда 1');
            if (tabAway) tabAway.textContent = (match.away || 'Команда 2');
        } catch(_) {}
        // создаём/находим панель спецсобытий
        let specialsPane = document.getElementById('md-pane-specials');
        if (!specialsPane) {
            specialsPane = document.createElement('div');
            specialsPane.id = 'md-pane-specials';
            specialsPane.className = 'md-pane';
            specialsPane.style.display = 'none';
            mdPane.querySelector('.modal-body')?.appendChild(specialsPane);
        }
        // Вкладка «Спецсобытия» только для матчей, присутствующих в турах ставок
        try {
            const toursCache = JSON.parse(localStorage.getItem('betting:tours') || 'null');
            const tours = toursCache?.data?.tours || toursCache?.tours || [];
            const mkKey = (obj) => {
                const h = (obj?.home || '').toLowerCase().trim();
                const a = (obj?.away || '').toLowerCase().trim();
                const raw = obj?.date ? String(obj.date) : (obj?.datetime ? String(obj.datetime) : '');
                const d = raw ? raw.slice(0, 10) : '';
                return `${h}__${a}__${d}`;
            };
            const present = new Set();
            tours.forEach(t => (t.matches||[]).forEach(x => present.add(mkKey(x))));
            const thisKey = mkKey(match);
            let specialsAllowed = present.has(thisKey);
            // Разрешаем редактирование только админу
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            // Показать вкладку только если матч в ставках И пользователь админ
            const existed = subtabs?.querySelector('[data-mdtab="specials"]');
            if (specialsAllowed && isAdmin) {
                if (!existed) {
                    const sp = document.createElement('div');
                    sp.className = 'subtab-item'; sp.setAttribute('data-mdtab','specials'); sp.textContent = 'Спецсобытия';
                    subtabs.appendChild(sp);
                }
            } else if (existed) {
                existed.remove();
            }
        } catch(_) {}
        // Трансляция: логику ведёт Streams.js — вкладка появляется только при наличии ссылки (без привязки ко времени)
        let streamPane = null;
        try {
            if (window.Streams && typeof window.Streams.setupMatchStream === 'function') {
                streamPane = window.Streams.setupMatchStream(mdPane, subtabs, match);
            }
        } catch(_) {}

    // События будут отображаться внутри вкладок составов
        // Вкладка «Статистика»
        let statsPane = document.getElementById('md-pane-stats');
        if (!statsPane) {
            statsPane = document.createElement('div');
            statsPane.id = 'md-pane-stats';
            statsPane.className = 'md-pane';
            statsPane.style.display = 'none';
            mdPane.querySelector('.modal-body')?.appendChild(statsPane);
        }
        // Добавим пункт в подменю, если его нет
        if (!subtabs.querySelector('[data-mdtab="stats"]')) {
            const st = document.createElement('div'); st.className = 'subtab-item'; st.setAttribute('data-mdtab','stats'); st.textContent = 'Статистика';
            subtabs.appendChild(st);
        }

        // по умолчанию активируем «Команда 1»
        mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
        homePane.style.display = '';
        awayPane.style.display = 'none';
    specialsPane.style.display = 'none';
    if (streamPane) streamPane.style.display = 'none';
    statsPane.style.display = 'none';
    if (typeof eventsPane !== 'undefined') eventsPane.style.display = 'none';

        // заполнение составов — табличный вид с событиями
    const renderRosterTable = (pane, players, side, existingEvents) => {
            pane.innerHTML = '';
            const table = document.createElement('table');
            table.className = 'roster-table';
            table.style.width = '100%';
            table.style.borderCollapse = 'collapse';
            const mkTh = (content) => { const th = document.createElement('th'); th.style.border='1px solid rgba(255,255,255,0.15)'; th.style.padding='6px'; th.style.textAlign='left'; th.append(content); return th; };
            const mkTd = () => { const td = document.createElement('td'); td.style.border='1px solid rgba(255,255,255,0.15)'; td.style.padding='6px'; td.style.textAlign='center'; return td; };
            const thead = document.createElement('thead');
            const trh = document.createElement('tr');
            const nameTh = document.createElement('th'); nameTh.textContent = 'Фамилия Имя'; nameTh.style.border='1px solid rgba(255,255,255,0.15)'; nameTh.style.padding='6px'; nameTh.style.textAlign='left';
            const getAssetVer = () => { try { return Number(localStorage.getItem('appVersion:lastSeen')||'0')||0; } catch(_) { return 0; } };
            const vUrl = (u) => { try { const v=getAssetVer(); return v? (u + (u.includes('?')?'&':'?') + 'v='+v): u; } catch(_) { return u; } };
            const iconImg = (srcHint) => { const img = document.createElement('img'); img.style.width='18px'; img.style.height='18px'; img.style.objectFit='contain'; img.alt='';
                const candidates = [vUrl(srcHint), vUrl('/static/img/icons/placeholder.png'), vUrl('/static/img/placeholderlogo.png')].filter(Boolean);
                let i=0; const next=()=>{ if(i>=candidates.length) return; img.onerror=()=>{ i++; next(); }; img.src=candidates[i]; }; next();
                return img; };
            const thYellow = mkTh(iconImg('/static/img/icons/yellow.png'));
            const thRed = mkTh(iconImg('/static/img/icons/red.png'));
            const thAssist = mkTh(iconImg('/static/img/icons/assist.png'));
            const thGoal = mkTh(iconImg('/static/img/icons/goal.png'));
            trh.append(nameTh, thYellow, thRed, thAssist, thGoal); thead.appendChild(trh);
            const tbody = document.createElement('tbody');
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            const tg = window.Telegram?.WebApp || null;
            // быстрый индекс событий: player(lower) -> Set(types)
            const evIdx = (() => {
                const idx = new Map();
                try {
                    const list = existingEvents && existingEvents[side] ? existingEvents[side] : [];
                    list.forEach(e => {
                        const key = (e.player||'').trim().toLowerCase();
                        if (!idx.has(key)) idx.set(key, new Set());
                        idx.get(key).add(e.type);
                    });
                } catch(_) {}
                return idx;
            })();
            const highlightRow = (tr, key) => {
                try {
                    const hasAny = !!(evIdx.get(key) && evIdx.get(key).size > 0);
                    tr.style.transition = 'background-color 120ms ease';
                    tr.style.backgroundColor = hasAny ? 'rgba(255,255,255,0.06)' : '';
                } catch(_) {}
            };
            const createCell = (player, type, trRef) => {
                const td = mkTd();
                const key = (player||'').trim().toLowerCase();
                const has = evIdx.get(key) && evIdx.get(key).has(type);
        if (!isAdmin) {
                    if (has) {
            const img = document.createElement('img'); img.style.width='18px'; img.style.height='18px'; img.style.objectFit='contain';
            const srcHint = (type==='yellow')?'/static/img/icons/yellow.png':(type==='red')?'/static/img/icons/red.png':(type==='assist')?'/static/img/icons/assist.png':'/static/img/icons/goal.png';
            const candidates=[vUrl(srcHint), vUrl('/static/img/icons/placeholder.png'), vUrl('/static/img/placeholderlogo.png')];
            let i=0; const next=()=>{ if(i>=candidates.length) return; img.onerror=()=>{ i++; next(); }; img.src=candidates[i]; }; next();
                        td.appendChild(img);
                    } else {
                        // пусто для пользователя, если события нет
                        td.textContent='';
                    }
                    return td;
                }
                // Админ: селект «—/ДА» + иконка справа, если уже есть
                const box = document.createElement('div'); box.style.display='flex'; box.style.gap='6px'; box.style.alignItems='center'; box.style.justifyContent='center';
                const sel = document.createElement('select');
                const optNo = document.createElement('option'); optNo.value=''; optNo.textContent='—';
                const optYes = document.createElement('option'); optYes.value='yes'; optYes.textContent='ДА';
                sel.append(optNo, optYes);
                if (has) sel.value='yes';
                const icon = document.createElement('img'); icon.style.width='18px'; icon.style.height='18px'; icon.style.objectFit='contain'; icon.style.opacity = has ? '1' : '0.2';
                const srcHint = (type==='yellow')?'/static/img/icons/yellow.png':(type==='red')?'/static/img/icons/red.png':(type==='assist')?'/static/img/icons/assist.png':'/static/img/icons/goal.png';
                const candidates=[vUrl(srcHint), vUrl('/static/img/icons/placeholder.png'), vUrl('/static/img/placeholderlogo.png')];
                let i=0; const next=()=>{ if(i>=candidates.length) return; icon.onerror=()=>{ i++; next(); }; icon.src=candidates[i]; }; next();
                sel.addEventListener('change', () => {
                    if (sel.value === 'yes' && !has) {
                        // отправляем событие
                        try {
                            const fd = new FormData();
                            fd.append('initData', tg?.initData || '');
                            fd.append('home', match.home || '');
                            fd.append('away', match.away || '');
                            fd.append('team', side);
                            fd.append('player', player || '');
                            fd.append('type', type);
                            fetch('/api/match/events/add', { method: 'POST', body: fd })
                                .then(r=>r.json())
                                .then(d => {
                                    if (d?.error) { try { tg?.showAlert?.(d.error); } catch(_) {} return; }
                                    icon.style.opacity = '1';
                                    // пометим наличие локально, чтобы следующий клик мог удалить
                                    if (!evIdx.has(key)) evIdx.set(key, new Set()); evIdx.get(key).add(type);
                                    highlightRow(trRef, key);
                                })
                                .catch(err => { console.error('events/add', err); try { tg?.showAlert?.('Ошибка сохранения'); } catch(_) {} })
                        } catch(_) {}
                    } else if (sel.value === '' && (has || (evIdx.get(key) && evIdx.get(key).has(type)))) {
                        // удаляем событие
                        try {
                            const fd = new FormData();
                            fd.append('initData', tg?.initData || '');
                            fd.append('home', match.home || '');
                            fd.append('away', match.away || '');
                            fd.append('team', side);
                            fd.append('player', player || '');
                            fd.append('type', type);
                            fetch('/api/match/events/remove', { method: 'POST', body: fd })
                                .then(r=>r.json())
                                .then(d => {
                                    if (d?.error) { try { tg?.showAlert?.(d.error); } catch(_) {} sel.value='yes'; return; }
                                    icon.style.opacity = '0.2';
                                    if (evIdx.get(key)) evIdx.get(key).delete(type);
                                    highlightRow(trRef, key);
                                })
                                .catch(err => { console.error('events/remove', err); try { tg?.showAlert?.('Ошибка удаления'); } catch(_) {} sel.value='yes'; })
                        } catch(_) {}
                    }
                });
                box.append(sel, icon); td.appendChild(box); return td;
            };
            // заголовок
            table.appendChild(thead);
            // строки
            if (!players || players.length === 0) {
                const tr = document.createElement('tr');
                const td = document.createElement('td'); td.colSpan = 5; td.style.padding='10px'; td.style.textAlign='center'; td.style.border='1px solid rgba(255,255,255,0.15)'; td.textContent = 'Нет данных';
                tr.appendChild(td); tbody.appendChild(tr);
            } else {
                players.forEach(pName => {
                    const tr = document.createElement('tr');
                    const tdName = document.createElement('td'); tdName.style.border='1px solid rgba(255,255,255,0.15)'; tdName.style.padding='6px'; tdName.style.textAlign='left'; tdName.textContent = pName;
                    const tdY = createCell(pName, 'yellow', tr);
                    const tdR = createCell(pName, 'red', tr);
                    const tdA = createCell(pName, 'assist', tr);
                    const tdG = createCell(pName, 'goal', tr);
                    tr.append(tdName, tdY, tdR, tdA, tdG);
                    // начальная подсветка
                    const key = (pName||'').trim().toLowerCase();
                    highlightRow(tr, key);
                    tbody.appendChild(tr);
                });
            }
            table.appendChild(tbody);
            pane.appendChild(table);
            // Кнопка «Обновить составы» — только под таблицей домашней команды
            if (side === 'home') {
                const btnWrap = document.createElement('div');
                btnWrap.style.display = 'flex';
                btnWrap.style.justifyContent = 'center';
                btnWrap.style.marginTop = '8px';
                const btn = document.createElement('button');
                btn.className = 'details-btn';
                btn.textContent = 'Обновить составы';
                btn.style.fontSize = '12px';
                btn.style.padding = '6px 10px';
                btn.style.borderRadius = '8px';
                // Лимит: не чаще 1 раза в 10 минут на пользователя/матч
                const mkKey = () => {
                    try {
                        const dRaw = (match?.datetime || match?.date || '').toString();
                        const d = dRaw ? dRaw.slice(0,10) : '';
                        return `roster:refresh:${(match.home||'').toLowerCase().trim()}__${(match.away||'').toLowerCase().trim()}__${d}`;
                    } catch(_) { return 'roster:refresh'; }
                };
                const key = mkKey();
                const COOLDOWN = 10 * 60 * 1000; // 10 мин
                const updateState = () => {
                    try {
                        const last = Number(localStorage.getItem(key) || '0') || 0;
                        const left = Math.max(0, (last + COOLDOWN) - Date.now());
                        if (left > 0) {
                            btn.disabled = true;
                            const mins = Math.ceil(left / 60000);
                            btn.textContent = `Доступно через ${mins} мин`;
                        } else {
                            btn.disabled = false;
                            btn.textContent = 'Обновить составы';
                        }
                    } catch(_) {}
                };
                updateState();
                btn.addEventListener('click', async () => {
                    // Повторная проверка лимита прямо перед запросом
                    try {
                        const last = Number(localStorage.getItem(key) || '0') || 0;
                        if (Date.now() - last < COOLDOWN) { updateState(); return; }
                    } catch(_) {}
                    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Обновляю...';
                    try {
                        // Перезагрузим детали матча и перерисуем составы
                        const params = new URLSearchParams({ home: match.home || '', away: match.away || '' });
                        const r = await fetch(`/api/match-details?${params.toString()}`, { headers: { 'Cache-Control': 'no-store' } });
                        const fresh = await r.json();
                        const homeList = Array.isArray(fresh?.rosters?.home) ? fresh.rosters.home : [];
                        const awayList = Array.isArray(fresh?.rosters?.away) ? fresh.rosters.away : [];
                        const ev = fresh?.events || { home: [], away: [] };
                        // Перерисуем обе таблицы
                        renderRosterTable(homePane, homeList, 'home', ev);
                        renderRosterTable(awayPane, awayList, 'away', ev);
                        try { localStorage.setItem(key, String(Date.now())); } catch(_) {}
                    } catch (e) {
                        // В случае ошибки просто вернём исходный статус
                    }
                    btn.textContent = orig;
                    updateState();
                });
                btnWrap.appendChild(btn);
                pane.appendChild(btnWrap);
            }
        };
        try {
            const homeList = Array.isArray(details?.rosters?.home) ? details.rosters.home : [];
            const awayList = Array.isArray(details?.rosters?.away) ? details.rosters.away : [];
            const ev = details?.events || { home: [], away: [] };
            renderRosterTable(homePane, homeList, 'home', ev);
            renderRosterTable(awayPane, awayList, 'away', ev);
    } catch(_) {
            renderRosterTable(homePane, [], 'home', {home:[],away:[]});
            renderRosterTable(awayPane, [], 'away', {home:[],away:[]});
        }

        // Если доступно API статуса — отметим LIVE индикатором в заголовке деталей
        // LIVE-индикатор и обновление счёта в онлайне
        let scorePoll = null;
        const applyScore = (sh, sa) => {
            try {
                if (sh == null || sa == null) return; // не меняем если нет данных
                score.textContent = `${Number(sh)} : ${Number(sa)}`;
            } catch(_) {}
        };
        const fetchScore = async () => {
            try {
                const r = await fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`);
                const d = await r.json();
                if (typeof d?.score_home === 'number' && typeof d?.score_away === 'number') applyScore(d.score_home, d.score_away);
            } catch(_) {}
        };
        try {
            fetch(`/api/match/status/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
                .then(r=>r.json()).then(async (s) => {
                    if (s?.status === 'live') {
                        const live = document.createElement('span'); live.className = 'live-badge';
                        const dot = document.createElement('span'); dot.className = 'live-dot';
                        const lbl = document.createElement('span'); lbl.textContent = 'Матч идет';
                        live.append(dot, lbl);
                        dt.appendChild(live);
                        // Во время лайва показываем стартовый 0 : 0, если ещё нет счёта
                        if (score.textContent.trim() === '— : —') score.textContent = '0 : 0';
                        // Если админ и счёт ещё не инициализирован в БД — поставим 0:0 и в Sheets
                        try {
                            const adminId = document.body.getAttribute('data-admin');
                            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
                            if (isAdmin) {
                                const r0 = await fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`);
                                const d0 = await r0.json().catch(()=>({}));
                                const noScore = (d0?.score_home == null) && (d0?.score_away == null);
                                if (noScore) {
                                    const tg = window.Telegram?.WebApp || null;
                                    const fd0 = new FormData();
                                    fd0.append('initData', tg?.initData || '');
                                    fd0.append('home', match.home || '');
                                    fd0.append('away', match.away || '');
                                    await fetch('/api/match/status/set-live', { method: 'POST', body: fd0 }).catch(()=>{});
                                }
                            }
                        } catch(_) {}
                        // Запускаем поллинг счёта
                        fetchScore();
                        scorePoll = setInterval(fetchScore, 15000);
                        // Админ-контролы +/- около счёта (без подписей «Команда 1/2»)
                        try {
                            const adminId = document.body.getAttribute('data-admin');
                            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
                            if (isAdmin) {
                                const center = score.parentElement || dt.parentElement;
                                if (!mdPane.querySelector('.admin-score-ctrls')) {
                                    const mkBtn = (txt) => { const b = document.createElement('button'); b.className = 'details-btn'; b.textContent = txt; b.style.padding = '2px 8px'; b.style.minWidth = 'unset'; return b; };
                                    const row = document.createElement('div');
                                    row.className = 'admin-score-ctrls';
                                    row.style.marginTop = '6px';
                                    row.style.display = 'flex';
                                    row.style.gap = '10px';
                                    row.style.alignItems = 'center';
                                    row.style.justifyContent = 'center';
                                    const left = document.createElement('div'); left.style.display='flex'; left.style.gap='6px';
                                    const right = document.createElement('div'); right.style.display='flex'; right.style.gap='6px';
                                    const hMinus = mkBtn('−'); const hPlus = mkBtn('+');
                                    const aMinus = mkBtn('−'); const aPlus = mkBtn('+');
                                    left.append(hMinus, hPlus); right.append(aMinus, aPlus);
                                    try { if (dt && dt.parentElement === center) center.insertBefore(row, dt); else center.appendChild(row); } catch(_) {}
                                    const spacer = document.createElement('div'); spacer.style.width='8px';
                                    row.append(left, spacer, right);
                                    const tg = window.Telegram?.WebApp || null;
                                    const parseScore = () => {
                                        try { const t = score.textContent||''; const m = t.match(/(\d+)\s*:\s*(\d+)/); if (m) return [parseInt(m[1],10)||0, parseInt(m[2],10)||0]; } catch(_) {}
                                        return [0,0];
                                    };
                                    const postScore = async (sh, sa) => {
                                        try {
                                            const fd = new FormData();
                                            fd.append('initData', tg?.initData || '');
                                            fd.append('home', match.home || '');
                                            fd.append('away', match.away || '');
                                            fd.append('score_home', String(Math.max(0, sh)));
                                            fd.append('score_away', String(Math.max(0, sa)));
                                            const r = await fetch('/api/match/score/set', { method: 'POST', body: fd });
                                            const d = await r.json().catch(()=>({}));
                                            if (!r.ok || d?.error) throw new Error(d?.error || 'Ошибка сохранения');
                                            applyScore(d.score_home, d.score_away);
                                        } catch(e) {
                                            try { tg?.showAlert?.(e?.message || 'Не удалось сохранить счёт'); } catch(_) {}
                                        }
                                    };
                                    hMinus.addEventListener('click', () => { const [h,a] = parseScore(); postScore(Math.max(0, h-1), a); });
                                    hPlus.addEventListener('click', () => { const [h,a] = parseScore(); postScore(h+1, a); });
                                    aMinus.addEventListener('click', () => { const [h,a] = parseScore(); postScore(h, Math.max(0, a-1)); });
                                    aPlus.addEventListener('click', () => { const [h,a] = parseScore(); postScore(h, a+1); });
                                }
                            }
                        } catch(_) {}
                    }
                }).catch(()=>{});
        } catch(_) {}

    // переключение вкладок
    mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((btn) => {
            btn.onclick = () => {
                mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((x)=>x.classList.remove('active'));
                btn.classList.add('active');
                const key = btn.getAttribute('data-mdtab');
    if (key === 'home') { homePane.style.display = ''; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; if (streamPane) streamPane.style.display = 'none'; statsPane.style.display = 'none'; }
    else if (key === 'away') { homePane.style.display = 'none'; awayPane.style.display = ''; specialsPane.style.display = 'none'; if (streamPane) streamPane.style.display = 'none'; statsPane.style.display = 'none'; }
                else if (key === 'specials') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = '';
                    // отрисуем спецпанель внутри specialsPane
                    renderSpecialsPane(specialsPane, match);
                    if (streamPane) streamPane.style.display = 'none'; statsPane.style.display = 'none';
                } else if (key === 'stream') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; statsPane.style.display = 'none';
                    // Гарантируем наличие панели и запускаем ленивую инициализацию через Streams.js
                    streamPane = document.getElementById('md-pane-stream');
                    if (!streamPane && window.Streams && typeof window.Streams.setupMatchStream === 'function') {
                        streamPane = window.Streams.setupMatchStream(mdPane, subtabs, match);
                    }
                    if (streamPane) {
                        streamPane.style.display = '';
                        try { if (window.Streams && typeof window.Streams.onStreamTabActivated === 'function') window.Streams.onStreamTabActivated(streamPane, match); } catch(_) {}
                    } else {
                        // Нет ссылки/панели — возвращаемся на вкладку команды
                        btn.classList.remove('active');
                        const homeTab = mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]');
                        if (homeTab) { homeTab.classList.add('active'); homePane.style.display=''; awayPane.style.display='none'; specialsPane.style.display='none'; statsPane.style.display='none'; }
                    }
                } else if (key === 'stats') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; if (streamPane) streamPane.style.display = 'none'; statsPane.style.display = '';
                    renderMatchStats(statsPane, match);
                    }
            };
        });
        // Делегирование для динамически добавляемой вкладки «Трансляция»
        try {
            if (subtabs && !subtabs.__streamDelegated) {
                subtabs.__streamDelegated = true;
                subtabs.addEventListener('click', (e) => {
                    const btn = e.target.closest('.subtab-item[data-mdtab="stream"]');
                    if (!btn) return;
                    e.preventDefault();
                    // Имитация логики обработки клика по вкладке «stream»
                    mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((x)=>x.classList.remove('active'));
                    btn.classList.add('active');
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; statsPane.style.display = 'none';
                    let sp = document.getElementById('md-pane-stream');
                    if (!sp && window.Streams && typeof window.Streams.setupMatchStream === 'function') {
                        sp = window.Streams.setupMatchStream(mdPane, subtabs, match);
                    }
                    if (sp) {
                        sp.style.display = '';
                        try { if (window.Streams && typeof window.Streams.onStreamTabActivated === 'function') window.Streams.onStreamTabActivated(sp, match); } catch(_) {}
                    } else {
                        // Нет ссылки — возвращаемся на «home»
                        const homeTab = mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]');
                        if (homeTab) { homeTab.classList.add('active'); homePane.style.display=''; }
                    }
                });
            }
        } catch(_) {}

        // Добавим в топбар кнопку «Завершить матч» для админа
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            const topbar = mdPane.querySelector('.match-details-topbar');
            if (isAdmin && topbar) {
                // Всегда пересоздаем кнопку под конкретный матч, чтобы обработчик и видимость были корректными
                const prev = topbar.querySelector('#md-finish-btn'); if (prev) prev.remove();
                if (mdPane.__finishBtnTimer) { try { clearInterval(mdPane.__finishBtnTimer); } catch(_) {} mdPane.__finishBtnTimer = null; }
                const btn = document.createElement('button');
                btn.id = 'md-finish-btn'; btn.className = 'details-btn'; btn.textContent = 'Завершить матч';
                btn.style.marginLeft = 'auto';
                // Сессионное хранилище завершенных матчей: только для текущего запуска приложения
                const finStore = (window.__FINISHED_MATCHES = window.__FINISHED_MATCHES || {});
                const mkKey = (m) => {
                    try {
                        const dateStr = (m?.datetime || m?.date || '').toString().slice(0,10);
                        return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${dateStr}`;
                    } catch(_) { return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__`; }
                };
                const mKey = mkKey(match);
                // Хелпер: определяем «матч идет онлайн» по времени (старт → +2 часа)
                const isLiveNow = (mm) => {
                    try {
                        const now = Date.now();
                        let start = null;
                        if (mm?.datetime) { start = new Date(mm.datetime).getTime(); }
                        else if (mm?.date && mm?.time) {
                            const t = mm.time.length===5 ? mm.time+':00' : mm.time;
                            start = new Date(`${mm.date}T${t}`).getTime();
                        }
                        if (!start || isNaN(start)) return false;
                        const end = start + 2*60*60*1000; // 2 часа окно прямого эфира
                        return now >= start && now < end;
                    } catch(_) { return false; }
                };
                // Установим видимость кнопки: только для этого матча, только когда он «live» и не завершен локально
                const applyVisibility = () => { btn.style.display = (!finStore[mKey] && isLiveNow(match)) ? '' : 'none'; };
                applyVisibility();
                // Переоценивать каждые 30 секунд, чтобы кнопка появлялась/скрывалась по времени
                mdPane.__finishBtnTimer = setInterval(applyVisibility, 30000);
                const confirmFinish = () => new Promise((resolve) => {
                    let ov = document.querySelector('.modal-overlay');
                    if (!ov) {
                        ov = document.createElement('div'); ov.className='modal-overlay';
                        ov.style.position='fixed'; ov.style.inset='0'; ov.style.background='rgba(0,0,0,0.6)'; ov.style.zIndex='9999';
                        ov.style.display='flex'; ov.style.alignItems='center'; ov.style.justifyContent='center';
                        const box = document.createElement('div'); box.className='modal-box';
                        box.style.background='rgba(20,24,34,0.98)'; box.style.border='1px solid rgba(255,255,255,0.12)'; box.style.borderRadius='14px'; box.style.width='min(92vw,420px)'; box.style.padding='14px';
                        box.innerHTML = '<div style="font-weight:700; font-size:16px; margin-bottom:8px;">Завершить матч?</div>'+
                            '<div style="opacity:.9; font-size:13px; line-height:1.35; margin-bottom:12px;">Счёт будет записан, ставки рассчитаны. Продолжить?</div>'+
                            '<div style="display:flex; gap:8px; justify-content:flex-end;"><button class="app-btn neutral" id="mf-cancel">Отмена</button><button class="app-btn danger" id="mf-ok">Завершить</button></div>';
                        ov.appendChild(box); document.body.appendChild(ov);
                        box.querySelector('#mf-cancel').onclick = () => { ov.remove(); resolve(false); };
                        box.querySelector('#mf-ok').onclick = () => { ov.remove(); resolve(true); };
                    } else { resolve(false); }
                });
                const fullRefresh = async () => {
                    try {
                        const tg = window.Telegram?.WebApp || null;
                        const fd = new FormData(); fd.append('initData', tg?.initData || '');
                        await Promise.allSettled([
                            fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
                            fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
                            fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
                            fetch('/api/results/refresh', { method: 'POST', body: fd }),
                        ]);
                        try { loadLeagueTable(); } catch(_) {}
                        try { loadResults(); } catch(_) {}
                        try { loadSchedule(); } catch(_) {}
                    } catch(_) {}
                };
                btn.addEventListener('click', async () => {
                    const ok = await confirmFinish(); if (!ok) return;
                    const tg = window.Telegram?.WebApp || null;
                    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Завершаю...';
                    try {
                        const fd = new FormData(); fd.append('initData', tg?.initData || ''); fd.append('home', match.home||''); fd.append('away', match.away||'');
                        const r = await fetch('/api/match/settle', { method: 'POST', body: fd }); const d = await r.json().catch(()=>({}));
                        if (!r.ok || d?.error) throw new Error(d?.error || 'Ошибка завершения');
                        try { tg?.showAlert?.('Матч завершён'); } catch(_) {}
                        // Очистим кэш трансляции, чтобы вкладка скрылась после завершения
                        try {
                            const dateStr = (match?.datetime || match?.date || '').toString().slice(0,10);
                            const key = `stream:${(match.home||'').toLowerCase().trim()}__${(match.away||'').toLowerCase().trim()}__${dateStr}`;
                            localStorage.removeItem(key);
                            // Вкладку не убираем, просто сбрасываем содержимое
                            if (streamPane) { streamPane.style.display = 'none'; streamPane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция недоступна</div></div>'; }
                        } catch(_) {}
                        // Зафиксируем локально, что именно этот матч завершен в текущей сессии
                        try { finStore[mKey] = true; } catch(_) {}
                        await fullRefresh();
                        // Скрыть кнопку и пометить статус
                        try {
                            btn.style.display = 'none';
                            const statusEl = mdPane.querySelector('.match-details-topbar .status-text');
                            if (statusEl) statusEl.textContent = 'Матч завершен';
                        } catch(_) {}
                    } catch(e) {
                        console.error('finish match error', e); try { tg?.showAlert?.(e?.message || 'Ошибка'); } catch(_) {}
                    } finally { btn.disabled=false; btn.textContent = old; }
                });
                topbar.appendChild(btn);
            }
        } catch(_) {}

        // кнопка Назад
        const back = document.getElementById('match-back');
        if (back) back.onclick = () => {
            // очистка
            homePane.innerHTML = '';
            awayPane.innerHTML = '';
            try { if (mdPane.__finishBtnTimer) { clearInterval(mdPane.__finishBtnTimer); mdPane.__finishBtnTimer = null; } } catch(_) {}
            try { if (scorePoll) { clearInterval(scorePoll); scorePoll = null; } } catch(_) {}
            // останов поллинга комментариев, если был
            try { if (typeof streamPane.__stopCommentsPoll === 'function') streamPane.__stopCommentsPoll(); } catch(_) {}
            // Поставить видео на паузу (VK iframe не управляем напрямую, делаем reset src)
            try {
                const ifr = streamPane.querySelector('iframe');
                if (ifr) { const src = ifr.src; ifr.src = src; }
            } catch(_) {}
            // вернуть расписание
            mdPane.style.display = 'none';
            schedulePane.style.display = '';
            // прокрутка к верху для UX
            window.scrollTo({ top: 0, behavior: 'smooth' });
            // Вернуть подвкладки лиги
            try { document.getElementById('ufo-subtabs').style.display = ''; } catch(_) {}
        };

        // --- Вспом: Комментарии под трансляцией ---
    function initStreamComments(hostPane, m) {
            // Корневой контейнер
            const box = document.createElement('div'); box.className = 'comments-box';
            box.innerHTML = `
                <div class="comments-title">Комментарии</div>
                <div class="comments-list" id="cm-list"></div>
                <div class="comments-form">
                    <input type="text" class="comments-input" id="cm-input" placeholder="Написать комментарий..." maxlength="280" />
                    <button class="details-btn" id="cm-send">Отправить</button>
                </div>
                <div class="comments-hint">Сообщения хранятся 10 минут. Не чаще 1 комментария в 5 минут.</div>
            `;
            hostPane.appendChild(box);
            const listEl = box.querySelector('#cm-list');
            const inputEl = box.querySelector('#cm-input');
            const sendBtn = box.querySelector('#cm-send');
            const tg = window.Telegram?.WebApp || null;
            // Если не Telegram — запретим отправку
            if (!tg || !tg.initDataUnsafe?.user) {
                inputEl.disabled = true; sendBtn.disabled = true;
                inputEl.placeholder = 'Комментарии доступны в Telegram-приложении';
            }
            const dateStr = (m?.datetime || m?.date || '').toString().slice(0,10);
            let polling = null;
        const fetchComments = async () => {
                try {
            const url = `/api/match/comments/list?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}&date=${encodeURIComponent(dateStr)}`;
            const hdrs = {};
            if (box.__cmEtag) hdrs['If-None-Match'] = box.__cmEtag;
            if (box.__cmLastMod) hdrs['If-Modified-Since'] = box.__cmLastMod;
            const r = await fetch(url, { headers: hdrs });
            if (r.status === 304) return; // без изменений
                    const d = await r.json();
            const et = r.headers.get('ETag'); if (et) box.__cmEtag = et;
            const lm = r.headers.get('Last-Modified'); if (lm) box.__cmLastMod = lm;
                    const items = Array.isArray(d?.items) ? d.items : [];
                    renderComments(items);
                } catch(e) { /* noop */ }
            };
            const renderComments = (items) => {
                if (!listEl) return;
                if (!items.length) { listEl.innerHTML = '<div class="cm-empty">Пока нет комментариев</div>'; return; }
                listEl.innerHTML = '';
                items.forEach(it => {
                    const row = document.createElement('div'); row.className = 'comment-item';
                    const meta = document.createElement('div'); meta.className = 'comment-meta';
                    const ts = (()=>{ try { const d = new Date(it.created_at); return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); } catch(_) { return ''; } })();
                    meta.textContent = `${escapeHtml(it.name || 'Игрок')} • ${ts}`;
                    const body = document.createElement('div'); body.className = 'comment-text'; body.textContent = it.content || '';
                    row.append(meta, body); listEl.appendChild(row);
                });
                // автопрокрутка вниз
                try { listEl.scrollTop = listEl.scrollHeight; } catch(_) {}
            };
            const postComment = async () => {
                const text = (inputEl.value || '').trim();
                if (!text) return;
                sendBtn.disabled = true;
                try {
                    const fd = new FormData();
                    fd.append('initData', tg?.initData || '');
                    fd.append('home', m.home || '');
                    fd.append('away', m.away || '');
                    fd.append('date', dateStr || '');
                    fd.append('content', text);
                    const r = await fetch('/api/match/comments/add', { method: 'POST', body: fd });
                    const d = await r.json().catch(()=>({}));
                    if (!r.ok) {
                        const msg = d?.error || 'Не удалось отправить';
                        try { tg?.showAlert?.(msg); } catch(_) { alert(msg); }
                        // при лимите — заблокируем на 5 минут
                        if (r.status === 429) {
                            inputEl.disabled = true; sendBtn.disabled = true;
                            setTimeout(() => { inputEl.disabled = false; sendBtn.disabled = false; }, 5*60*1000);
                        }
                        return;
                    }
                    inputEl.value = '';
                    // Мгновенно подтянем ленту
                    fetchComments();
                } catch(e) {
                    try { tg?.showAlert?.('Ошибка сети'); } catch(_) {}
                } finally {
                    if (!inputEl.disabled) sendBtn.disabled = false;
                }
            };
            sendBtn.addEventListener('click', postComment);
            inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') postComment(); });
            // Поллинг
            const start = () => { if (polling) return; fetchComments(); polling = setInterval(fetchComments, 12000); };
            const stop = () => { if (polling) { clearInterval(polling); polling = null; } };
            hostPane.__startCommentsPoll = start;
            hostPane.__stopCommentsPoll = stop;
            start();
    }
    try { window.initStreamComments = initStreamComments; } catch(_) {}
    }
    try { window.openMatchScreen = openMatchScreen; } catch(_) {}

    // Отрисовка статистики матча (одна строка на метрику)
    function renderMatchStats(host, m) {
        host.innerHTML = '<div class="stats-wrap">Загрузка…</div>';
        const url = `/api/match/stats/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`;
        fetch(url).then(r=>r.json()).then(d => {
            const metrics = [
                { key: 'shots_total', label: 'Всего ударов' },
                { key: 'shots_on', label: 'Удары в створ' },
                { key: 'corners', label: 'Угловые' },
                { key: 'yellows', label: 'Жёлтые карточки' },
                { key: 'reds', label: 'Удаления' },
            ];
            const wrap = document.createElement('div'); wrap.className = 'stats-grid';
            const bar = (l, r) => {
                const total = (Number(l)||0) + (Number(r)||0);
                const lp = total>0 ? Math.round((l/total)*100) : 50;
                const rp = 100 - lp;
                const row = document.createElement('div'); row.className = 'stat-row';
                const leftSide = document.createElement('div'); leftSide.className='stat-side stat-left';
                const leftVal = document.createElement('div'); leftVal.className='stat-val'; leftVal.textContent = String(l||0);
                leftSide.appendChild(leftVal);
                const mid = document.createElement('div'); mid.className='stat-bar';
                const leftFill = document.createElement('div'); leftFill.className='stat-fill-left'; leftFill.style.width = lp+'%';
                const rightFill = document.createElement('div'); rightFill.className='stat-fill-right'; rightFill.style.width = rp+'%';
                // Цвета заливок — цвета команд
                try {
                    leftFill.style.backgroundColor = getTeamColor(m.home || '');
                    rightFill.style.backgroundColor = getTeamColor(m.away || '');
                } catch(_) {}
                mid.append(leftFill, rightFill);
                const rightSide = document.createElement('div'); rightSide.className='stat-side stat-right';
                const rightVal = document.createElement('div'); rightVal.className='stat-val'; rightVal.textContent = String(r||0);
                rightSide.appendChild(rightVal);
                row.append(leftSide, mid, rightSide);
                return row;
            };
            wrap.innerHTML = '';
            metrics.forEach(mt => {
                const rowWrap = document.createElement('div'); rowWrap.className='metric';
                const title = document.createElement('div'); title.className='metric-title'; title.textContent = mt.label;
                const vals = d && Array.isArray(d[mt.key]) ? d[mt.key] : [0,0];
                const row = bar(vals[0], vals[1]);
        // Админ +/- рядом с цифрами (внутри крайних колонок)
                try {
                    const adminId = document.body.getAttribute('data-admin');
                    const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                    const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
                    if (isAdmin) {
            const mk = (txt) => { const b=document.createElement('button'); b.className='details-btn'; b.textContent=txt; b.style.padding='0 6px'; b.style.minWidth='unset'; return b; };
            const lh = mk('−'); const lplus = mk('+'); const rh = mk('−'); const rplus = mk('+');
            const leftBox = document.createElement('div'); leftBox.className = 'admin-inc';
            const rightBox = document.createElement('div'); rightBox.className = 'admin-inc';
            const leftVal = row.querySelector('.stat-left .stat-val') || row.querySelector('.stat-val');
            const rightVal = row.querySelector('.stat-right .stat-val') || row.querySelectorAll('.stat-val')[1];
                        const fieldMap = { shots_total:'shots_total', shots_on:'shots_on', corners:'corners', yellows:'yellows', reds:'reds' };
                        const base = fieldMap[mt.key];
                        const post = (lhv, rhv) => {
                            const tg = window.Telegram?.WebApp || null;
                            const fd = new FormData(); fd.append('initData', tg?.initData || ''); fd.append('home', m.home||''); fd.append('away', m.away||'');
                            fd.append(base+'_home', String(lhv)); fd.append(base+'_away', String(rhv));
                            fetch('/api/match/stats/set', { method: 'POST', body: fd }).catch(()=>{});
                        };
                        lh.addEventListener('click', () => { const l= Math.max(0, (parseInt(leftVal.textContent,10)||0)-1); const r=(parseInt(rightVal.textContent,10)||0); leftVal.textContent=String(l); post(l,r); renderMatchStats(host,m); });
                        lplus.addEventListener('click', () => { const l=(parseInt(leftVal.textContent,10)||0)+1; const r=(parseInt(rightVal.textContent,10)||0); leftVal.textContent=String(l); post(l,r); renderMatchStats(host,m); });
                        rh.addEventListener('click', () => { const r= Math.max(0, (parseInt(rightVal.textContent,10)||0)-1); const l=(parseInt(leftVal.textContent,10)||0); rightVal.textContent=String(r); post(l,r); renderMatchStats(host,m); });
                        rplus.addEventListener('click', () => { const r=(parseInt(rightVal.textContent,10)||0)+1; const l=(parseInt(leftVal.textContent,10)||0); rightVal.textContent=String(r); post(l,r); renderMatchStats(host,m); });
            leftBox.append(lh, lplus); rightBox.append(rh, rplus);
            // Вставляем кнопки в крайние боксы
            const leftSide = row.querySelector('.stat-left');
            const rightSide = row.querySelector('.stat-right');
            if (leftSide) leftSide.insertBefore(leftBox, leftSide.firstChild);
            if (rightSide) rightSide.appendChild(rightBox);
                    }
                } catch(_) {}
                rowWrap.append(title, row);
                wrap.appendChild(rowWrap);
            });
            host.innerHTML = ''; host.appendChild(wrap);
        }).catch(()=>{ host.innerHTML = '<div class="stats-wrap">Нет данных</div>'; });
    }

    // Рендер спецсобытий (внутри деталей матча)
    function renderSpecialsPane(host, m) {
        const tg = window.Telegram?.WebApp || null;
        host.innerHTML = '';
        const shell = document.createElement('div');
        shell.className = 'admin-panel';
        shell.style.marginTop = '8px'; shell.style.padding = '8px'; shell.style.border = '1px solid rgba(255,255,255,0.1)'; shell.style.borderRadius = '10px';
    const title = document.createElement('div'); title.style.marginBottom = '6px'; title.textContent = 'Спецсобытия матча';
    // Авто-статус (только отображение)
    const statusRow = document.createElement('div'); statusRow.style.display='flex'; statusRow.style.gap='8px'; statusRow.style.alignItems='center'; statusRow.style.marginBottom='6px';
    const sLab = document.createElement('div'); sLab.textContent = 'Статус:';
    const sBadge = document.createElement('span'); sBadge.className = 'status-badge';
    const updStatus = async () => {
        try {
            const r = await fetch(`/api/match/status/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`);
            const d = await r.json();
            let txt = 'Запланирован';
            if (d?.status === 'live') txt = 'Матч идет'; else if (d?.status === 'finished') txt = 'Матч завершен'; else if (d?.soon) txt = 'Скоро начнется';
            sBadge.textContent = txt;
        } catch(_) { sBadge.textContent = '—'; }
    };
    statusRow.append(sLab, sBadge);
        const row1 = document.createElement('div'); row1.style.display='flex'; row1.style.gap='8px'; row1.style.alignItems='center';
        const lab1 = document.createElement('div'); lab1.textContent = 'Пенальти:';
        const sel1 = document.createElement('select'); sel1.innerHTML = '<option value="">—</option><option value="1">Да</option><option value="0">Нет</option>';
        row1.append(lab1, sel1);
        const row2 = document.createElement('div'); row2.style.display='flex'; row2.style.gap='8px'; row2.style.alignItems='center'; row2.style.marginTop='6px';
        const lab2 = document.createElement('div'); lab2.textContent = 'Красная:';
        const sel2 = document.createElement('select'); sel2.innerHTML = '<option value="">—</option><option value="1">Да</option><option value="0">Нет</option>';
        row2.append(lab2, sel2);
    const actions = document.createElement('div'); actions.style.marginTop='8px'; actions.style.display='flex'; actions.style.gap='8px'; actions.style.flexWrap='wrap';
    const savePenalty = document.createElement('button'); savePenalty.className = 'app-btn neutral'; savePenalty.textContent = 'Сохранить и рассчитать пенальти';
    const saveRed = document.createElement('button'); saveRed.className = 'app-btn neutral'; saveRed.textContent = 'Сохранить и рассчитать красную';
    const settleMatchBtn = document.createElement('button'); settleMatchBtn.className = 'app-btn danger'; settleMatchBtn.textContent = 'Рассчитать матч';
    actions.append(savePenalty, saveRed, settleMatchBtn);
    shell.append(title, statusRow, row1, row2, actions);
        host.appendChild(shell);

    // Инициализируем авто-статус и периодически обновляем во время открытия модалки
    updStatus();
    const stId = setInterval(updStatus, 30000);
    try { host.__onclose = () => clearInterval(stId); } catch(_) {}

        // Загрузим текущее состояние
        fetch(`/api/specials/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`)
            .then(r=>r.json())
            .then(d => {
                if (d.penalty_yes === 1) sel1.value = '1'; else if (d.penalty_yes === 0) sel1.value = '0'; else sel1.value='';
                if (d.redcard_yes === 1) sel2.value = '1'; else if (d.redcard_yes === 0) sel2.value = '0'; else sel2.value='';
            }).catch(()=>{});

    // Удалено ручное управление статусом: статусы вычисляются автоматически на сервере

        // Хелпер: сохранить флаг и рассчитать конкретный рынок
        const saveAndSettle = async (market) => {
            const fd = new FormData();
            fd.append('initData', tg?.initData || '');
            fd.append('home', m.home || '');
            fd.append('away', m.away || '');
            if (market === 'penalty') {
                if (sel1.value === '') { try { tg?.showAlert?.('Укажите значение для Пенальти'); } catch(_) {} return; }
                fd.append('penalty_yes', sel1.value);
            } else if (market === 'redcard') {
                if (sel2.value === '') { try { tg?.showAlert?.('Укажите значение для Красной карточки'); } catch(_) {} return; }
                fd.append('redcard_yes', sel2.value);
            }
            const btn = market === 'penalty' ? savePenalty : saveRed;
            const old = btn.textContent; btn.disabled = true; btn.textContent = 'Сохранение...';
            try {
                const r = await fetch('/api/specials/set', { method: 'POST', body: fd });
                const d = await r.json().catch(()=>({}));
                if (!r.ok || d?.error) { throw new Error(d?.error || 'Ошибка сохранения'); }
                // затем точечный расчёт
                const fd2 = new FormData();
                fd2.append('initData', tg?.initData || '');
                fd2.append('home', m.home || '');
                fd2.append('away', m.away || '');
                fd2.append('market', market);
                const r2 = await fetch('/api/specials/settle', { method: 'POST', body: fd2 });
                const d2 = await r2.json().catch(()=>({}));
                if (!r2.ok || d2?.error) { throw new Error(d2?.error || 'Ошибка расчёта'); }
                try { tg?.showAlert?.(`Готово: изменено ${d2.changed||0}, выиграло ${d2.won||0}, проиграло ${d2.lost||0}`); } catch(_) {}
            } catch (e) {
                console.error('specials save/settle error', e);
                try { tg?.showAlert?.(e?.message || 'Ошибка операции'); } catch(_) {}
            } finally {
                btn.disabled = false; btn.textContent = old;
            }
        };
        savePenalty.addEventListener('click', () => saveAndSettle('penalty'));
        saveRed.addEventListener('click', () => saveAndSettle('redcard'));

        // Подтверждение перед полным расчётом матча
        const confirmSettle = () => new Promise((resolve) => {
            let ov = document.querySelector('.modal-overlay');
            if (!ov) {
                ov = document.createElement('div');
                ov.className = 'modal-overlay';
                ov.style.position = 'fixed'; ov.style.inset = '0'; ov.style.background = 'rgba(0,0,0,0.6)'; ov.style.zIndex = '9999';
                ov.style.display = 'flex'; ov.style.alignItems = 'center'; ov.style.justifyContent = 'center';
                const box = document.createElement('div'); box.className = 'modal-box';
                box.style.background = 'rgba(20,24,34,0.98)'; box.style.border = '1px solid rgba(255,255,255,0.12)'; box.style.borderRadius = '14px';
                box.style.width = 'min(92vw, 420px)'; box.style.padding = '14px'; box.style.boxShadow = '0 10px 30px rgba(0,0,0,0.4)';
                box.innerHTML = `
                    <div style="font-weight:700; font-size:16px; margin-bottom:8px;">Завершить и рассчитать матч?</div>
                    <div style="opacity:.9; font-size:13px; line-height:1.35; margin-bottom:12px;">
                        Действие необратимо. Будут рассчитаны все ставки по матчу, а незаполненные спецсобытия зафиксируются как «Нет».
                    </div>
                    <div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
                        <button class="app-btn neutral" id="ms-cancel">Отмена</button>
                        <button class="app-btn danger" id="ms-ok">Да, рассчитать</button>
                    </div>
                `;
                ov.appendChild(box); document.body.appendChild(ov);
                box.querySelector('#ms-cancel').onclick = () => { ov.remove(); resolve(false); };
                box.querySelector('#ms-ok').onclick = () => { ov.remove(); resolve(true); };
            } else {
                resolve(false);
            }
        });

        // Полный расчёт матча с подтверждением
        settleMatchBtn.addEventListener('click', async () => {
            const ok = await confirmSettle();
            if (!ok) return;
            const tg = window.Telegram?.WebApp || null;
            const btn = settleMatchBtn; const old = btn.textContent; btn.disabled = true; btn.textContent = 'Расчет...';
            try {
                const fd = new FormData();
                fd.append('initData', tg?.initData || '');
                fd.append('home', m.home || '');
                fd.append('away', m.away || '');
                const r = await fetch('/api/match/settle', { method: 'POST', body: fd });
                const d = await r.json().catch(()=>({}));
                if (!r.ok || d?.error) throw new Error(d?.error || 'Ошибка расчёта матча');
                try { tg?.showAlert?.(`Готово: изменено ${d.changed||0}, выиграло ${d.won||0}, проиграло ${d.lost||0}`); } catch(_) {}
                // Очистим кэш трансляции для матча, чтобы вкладка больше не показывалась
                try {
                    const dateStr = (m?.datetime || m?.date || '').toString().slice(0,10);
                    const key = `stream:${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${dateStr}`;
                    localStorage.removeItem(key);
                    // Уберём вкладку «Трансляция», если пользователь в деталях матча
                    const root = document.getElementById('ufo-match-details');
                    const tab = root?.querySelector('.modal-subtabs [data-mdtab="stream"]');
                    const pane = document.getElementById('md-pane-stream');
                    if (tab) tab.remove();
                    if (pane) { pane.style.display = 'none'; pane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция недоступна</div></div>'; }
                    // Отметим завершение только для этого матча в рамках текущей сессии
                    const finStore = (window.__FINISHED_MATCHES = window.__FINISHED_MATCHES || {});
                    const mkKey = (mm) => { try { const dstr=(mm?.datetime||mm?.date||'').toString().slice(0,10); return `${(mm.home||'').toLowerCase().trim()}__${(mm.away||'').toLowerCase().trim()}__${dstr}`; } catch(_) { return `${(mm.home||'').toLowerCase().trim()}__${(mm.away||'').toLowerCase().trim()}__`; } };
                    finStore[mkKey(m)] = true;
                } catch(_) {}
            } catch(e) {
                console.error('match settle error', e);
                try { tg?.showAlert?.(e?.message || 'Ошибка расчёта'); } catch(_) {}
            } finally {
                btn.disabled = false; btn.textContent = old;
            }
        });
    }

    // Рендер событий игроков (для обеих команд) + админ-форма добавления
    function renderEventsPane(host, match, cachedEvents) {
        const tg = window.Telegram?.WebApp || null;
        host.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'events-wrap';

        const mkSide = (title) => {
            const col = document.createElement('div');
            col.className = 'events-col';
            const h = document.createElement('div'); h.className = 'events-title'; h.textContent = title;
            const list = document.createElement('div'); list.className = 'events-list';
            col.append(h, list);
            return { col, list };
        };
        const homeBlock = mkSide('Команда 1');
        const awayBlock = mkSide('Команда 2');
        const grid = document.createElement('div'); grid.className = 'events-grid'; grid.style.display='grid'; grid.style.gridTemplateColumns='1fr 1fr'; grid.style.gap='12px';
        grid.append(homeBlock.col, awayBlock.col);
        wrap.appendChild(grid);

        // Админский блок редактирования счёта (live), не влияет на ставки до завершения матча
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            if (isAdmin) {
                const scoreBox = document.createElement('div');
                scoreBox.className = 'admin-panel';
                scoreBox.style.marginTop='12px'; scoreBox.style.padding='8px'; scoreBox.style.border='1px solid rgba(255,255,255,0.1)'; scoreBox.style.borderRadius='10px';
                scoreBox.innerHTML = `
                    <div style="margin-bottom:6px; font-weight:600;">Счёт матча (только отображение)</div>
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <label>Команда 1: <input type="number" id="sc-h" min="0" style="width:80px;" /></label>
                        <label>Команда 2: <input type="number" id="sc-a" min="0" style="width:80px;" /></label>
                        <button class="app-btn" id="sc-save">Сохранить счёт</button>
                        <div class="hint">Ставки будут рассчитаны только после нажатия «Рассчитать матч».</div>
                    </div>
                `;
                wrap.appendChild(scoreBox);
                const inpH = scoreBox.querySelector('#sc-h');
                const inpA = scoreBox.querySelector('#sc-a');
                const btn = scoreBox.querySelector('#sc-save');
                // загрузим текущий счёт
                fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
                    .then(r=>r.json()).then(d => {
                        if (typeof d.score_home === 'number') inpH.value = d.score_home;
                        if (typeof d.score_away === 'number') inpA.value = d.score_away;
                    }).catch(()=>{});
                btn.addEventListener('click', async () => {
                    const tg = window.Telegram?.WebApp || null;
                    const fd = new FormData();
                    fd.append('initData', tg?.initData || '');
                    fd.append('home', match.home || '');
                    fd.append('away', match.away || '');
                    if (inpH.value !== '') fd.append('score_home', inpH.value);
                    if (inpA.value !== '') fd.append('score_away', inpA.value);
                    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Сохранение...';
                    try {
                        const r = await fetch('/api/match/score/set', { method: 'POST', body: fd });
                        const d = await r.json().catch(()=>({}));
                        if (!r.ok || d?.error) throw new Error(d?.error || 'Ошибка сохранения счёта');
                        try { tg?.showAlert?.('Счёт сохранён'); } catch(_) {}
                    } catch(e) {
                        console.error('score set error', e);
                        try { tg?.showAlert?.(e?.message || 'Ошибка'); } catch(_) {}
                    } finally { btn.disabled=false; btn.textContent = old; }
                });
            }
        } catch(_) {}

        const renderList = (listEl, items) => {
            listEl.innerHTML = '';
            if (!items || !items.length) {
                const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Нет событий';
                listEl.appendChild(empty); return;
            }
            items.forEach(e => {
                const row = document.createElement('div'); row.className = 'event-item';
                const left = document.createElement('div'); left.className = 'event-left';
                const right = document.createElement('div'); right.className = 'event-right';
                left.textContent = (e.minute!=null? `${e.minute}'` : '');
                const typeLabel = { goal:'Гол', assist:'Пас', yellow:'Желтая', red:'Красная' }[e.type] || e.type;
                right.textContent = `${typeLabel}: ${e.player}${e.note? ' — ' + e.note : ''}`;
                row.style.display='flex'; row.style.gap='8px'; row.style.alignItems='center';
                row.append(left, right); listEl.appendChild(row);
            });
        };

        const applyData = (data) => {
            try {
                renderList(homeBlock.list, data?.home || []);
                renderList(awayBlock.list, data?.away || []);
            } catch(_) {
                renderList(homeBlock.list, []); renderList(awayBlock.list, []);
            }
        };

        // начальный рендер
        if (cachedEvents) applyData(cachedEvents);

        // актуализируем с сервера
        const refresh = () => {
            const url = `/api/match/events/list?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`;
            fetch(url).then(r=>r.json()).then(d => applyData(d?.items)).catch(()=>{});
        };
        refresh();

        // Админ-форма
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            if (isAdmin) {
                const form = document.createElement('div'); form.className = 'admin-panel';
                form.style.marginTop='12px'; form.style.padding='8px'; form.style.border='1px solid rgba(255,255,255,0.1)'; form.style.borderRadius='10px';
                form.innerHTML = `
                    <div style="margin-bottom:6px; font-weight:600;">Добавить событие</div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                        <label>Сторона:
                            <select id="ev-team"><option value="home">Команда 1</option><option value="away">Команда 2</option></select>
                        </label>
                        <label>Минута:
                            <input type="number" id="ev-minute" min="0" max="200" placeholder="мин" style="width:80px;" />
                        </label>
                        <label>Игрок:
                            <input type="text" id="ev-player" placeholder="ФИО" />
                        </label>
                        <label>Тип:
                            <select id="ev-type">
                                <option value="goal">Гол</option>
                                <option value="assist">Пас</option>
                                <option value="yellow">Желтая</option>
                                <option value="red">Красная</option>
                            </select>
                        </label>
                        <label>Заметка:
                            <input type="text" id="ev-note" placeholder="необязательно" />
                        </label>
                        <button class="details-btn" id="ev-save">Добавить</button>
                    </div>
                `;
                wrap.appendChild(form);
                const btn = form.querySelector('#ev-save');
                btn.addEventListener('click', () => {
                    const minuteRaw = form.querySelector('#ev-minute').value;
                    const payload = new FormData();
                    payload.append('initData', tg?.initData || '');
                    payload.append('home', match.home || '');
                    payload.append('away', match.away || '');
                    payload.append('team', form.querySelector('#ev-team').value);
                    const minute = minuteRaw!=='' ? String(parseInt(minuteRaw,10)) : '';
                    if (minute!=='') payload.append('minute', minute);
                    payload.append('player', form.querySelector('#ev-player').value.trim());
                    payload.append('type', form.querySelector('#ev-type').value);
                    const noteVal = form.querySelector('#ev-note').value.trim(); if (noteVal) payload.append('note', noteVal);
                    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Сохранение...';
                    fetch('/api/match/events/add', { method: 'POST', body: payload })
                        .then(r=>r.json())
                        .then(d => {
                            if (d?.error) { try { tg?.showAlert?.(d.error); } catch(_) {} return; }
                            // очистим поля и обновим список
                            form.querySelector('#ev-minute').value='';
                            form.querySelector('#ev-player').value='';
                            form.querySelector('#ev-type').value='goal';
                            form.querySelector('#ev-note').value='';
                            refresh();
                        })
                        .catch(err => { console.error('events/add error', err); try { tg?.showAlert?.('Ошибка сохранения'); } catch(_) {} })
                        .finally(()=>{ btn.disabled=false; btn.textContent = old; });
                });
            }
        } catch(_) {}

        host.appendChild(wrap);
    }

    // Удалён каталог достижений

    // Кэш для реферала
    let _referralCache = null;
    function prefetchReferral() {
        if (!tg || !tg.initDataUnsafe?.user) return;
        if (_referralCache) return; // уже есть
        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        fetch('/api/referral', { method: 'POST', body: formData })
            .then(r => r.json())
            .then(data => { _referralCache = data; })
            .catch(() => {});
    }

    function loadReferralInfo() {
        const countEl = document.getElementById('ref-count');
        const countEl2 = document.getElementById('ref-count-2');
        if (!tg || !tg.initDataUnsafe?.user) return Promise.resolve();
        // Мгновенный рендер из кэша, если есть
        if (_referralCache) {
            if (countEl) countEl.textContent = (_referralCache.invited_count ?? 0).toString();
            if (countEl2) countEl2.textContent = (_referralCache.invited_count ?? 0).toString();
        }
        // Актуализируем в фоне
        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        return fetch('/api/referral', { method: 'POST', body: formData })
            .then(r => r.json())
            .then(data => {
                _referralCache = data;
                if (countEl) countEl.textContent = (data.invited_count ?? 0).toString();
                if (countEl2) countEl2.textContent = (data.invited_count ?? 0).toString();
                return data;
            })
            .catch(err => { console.error('referral load error', err); });
    }

    let _achLoaded = false;
    let _tableLoaded = false;
    function trySignalAllReady() {
        // считаем готовность, когда базовые данные профиля есть, таблица лиги подтянулась,
        // и стартовые данные UFO (stats/schedule/results) прогреты (не обязательно успешны)
        if (_achLoaded && _tableLoaded && _statsPreloaded && _schedulePreloaded && _resultsPreloaded) {
            window.dispatchEvent(new CustomEvent('app:all-ready'));
        }
    }

    // При старте запоминаем активную лигу из сессии (по умолчанию НЛО) и обновляем иконку меню
    try { setActiveLeague(getActiveLeague()); updateNavLeagueIcon(); } catch(_) {}

    function updateNavLeagueIcon() {
        try {
            const item = document.querySelector('.nav-item[data-tab="ufo"]');
            if (!item) return;
            const iconEl = item.querySelector('.nav-icon');
            const labelEl = item.querySelector('.nav-label');
            const act = getActiveLeague();
            if (act === 'BLB') {
                if (iconEl) iconEl.textContent = '❔';
                if (labelEl) labelEl.textContent = 'Лига';
            } else {
                if (iconEl) iconEl.textContent = '🛸';
                if (labelEl) labelEl.textContent = 'НЛО';
            }
        } catch(_) {}
    }

    // старт
    initApp();
    // Стартовая предзагрузка UFO-данных во время заставки
    preloadUfoData();
    setupEventListeners();
    try { window.Shop?.updateCartBadge?.(); } catch(_) {}

    // ---------- LIVE notifications ----------
    const LiveWatcher = (() => {
        let lastLiveKeys = new Set();
        let initialized = false; // чтобы не уведомлять о матчах, уже идущих при первом заходе
        const getKey = (m) => `${m.home||''}__${m.away||''}__${m.datetime||m.date||''}`;
        const getPair = (m) => `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}`;
        const isLive = (m) => {
            try {
                const now = new Date();
                if (m.datetime) {
                    const dt = new Date(m.datetime);
                    const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
                    return now >= dt && now < dtEnd;
                } else if (m.date && m.time) {
                    const dt = new Date(m.date + 'T' + (m.time.length===5? m.time+':00': m.time));
                    const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
                    return now >= dt && now < dtEnd;
                }
            } catch(_) {}
            return false;
        };
        const fetchLiveFlags = async () => {
            try {
                const r = await fetch('/api/match/status/live?_=' + Date.now());
                const d = await r.json();
                const pairs = new Set();
                (d.items||[]).forEach(it => { pairs.add(`${(it.home||'').toLowerCase()}__${(it.away||'').toLowerCase()}`); });
                if (!window.__LIVE_STATUS) window.__LIVE_STATUS = { pairs: new Set(), ts: 0 };
                window.__LIVE_STATUS.pairs = pairs;
                window.__LIVE_STATUS.ts = Date.now();
                return pairs;
            } catch(_) {
                return (window.__LIVE_STATUS && window.__LIVE_STATUS.pairs) ? window.__LIVE_STATUS.pairs : new Set();
            }
        };
        const showToast = (text, onClick) => {
            let cont = document.querySelector('.toast-container');
            if (!cont) { cont = document.createElement('div'); cont.className = 'toast-container'; document.body.appendChild(cont); }
            const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
            el.style.cursor = onClick ? 'pointer' : '';
            if (onClick) el.addEventListener('click', () => { try { onClick(); } catch(_) {} try { el.remove(); } catch(_) {} });
            cont.appendChild(el);
            setTimeout(()=>{ try { el.remove(); if (cont.childElementCount===0) cont.remove(); } catch(_) {} }, 5000);
        };
        const scan = async () => {
            // берём из кэша /api/schedule
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
                    // Новый старт во время открытого приложения
                    if (live && !lastLiveKeys.has(key) && initialized) {
                        nowStarted.push(m);
                    }
                }));
                // уведомления только для матчей, стартовавших после инициализации
                nowStarted.forEach(m => {
                    const title = `${m.home || 'Команда 1'} — ${m.away || 'Команда 2'}: матч начался`;
                    const onClick = () => {
                        // Открыть детали матча
                        const params = new URLSearchParams({ home: m.home||'', away: m.away||'' });
                        const cacheKey = `md:${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}`;
                        try {
                            const storeRaw = localStorage.getItem(cacheKey);
                            const store = storeRaw ? JSON.parse(storeRaw) : null;
                            const go = (st) => { try { window.openMatchScreen?.({ home: m.home, away: m.away, date: m.date, time: m.time }, st?.data || st); } catch(_) {} };
                            if (store?.etag) {
                                fetch(`/api/match-details?${params.toString()}`, { headers: { 'If-None-Match': store.etag } })
                                  .then(r => r.status===304? store : r.json().then(d=>({ etag: r.headers.get('ETag'), data: d })))
                                  .then(st => go(st))
                                  .catch(()=> go(null));
                            } else {
                                fetch(`/api/match-details?${params.toString()}`)
                                  .then(r => r.json().then(d=>({ etag: r.headers.get('ETag'), data: d })))
                                  .then(st => { try { localStorage.setItem(cacheKey, JSON.stringify(st)); } catch(_) {} go(st); })
                                  .catch(()=> go(null));
                            }
                        } catch(_) {}
                    };
                    showToast(title, onClick);
                });
                lastLiveKeys = currentLive;
                if (!initialized) initialized = true;
            } catch(_) {}
        };
    setInterval(scan, 30000); // каждые 30 секунд мягкий опрос клиентского кэша
        document.addEventListener('DOMContentLoaded', () => {
            try {
                const adminId = document.body.getAttribute('data-admin');
                const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                if (adminId && currentId && String(adminId) === currentId) {
                    const btn = document.createElement('button');
                    btn.textContent = 'Тест уведомления LIVE';
                    btn.className = 'details-btn';
                    btn.style.position = 'fixed'; btn.style.bottom = '90px'; btn.style.right = '12px'; btn.style.zIndex = '9999';
                    btn.addEventListener('click', () => showToast('Демо уведомление: Команда 1 — Команда 2', null));
                    document.body.appendChild(btn);
                }
            } catch(_) {}
        });
        return { scan };
    })();
});
