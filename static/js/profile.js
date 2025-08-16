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
            const fd = new FormData();
            fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            fd.append('team', value || '');
            const res = await fetch('/api/user/favorite-team', { method: 'POST', body: fd });
            if (!res.ok) return false;
            await fetchTeamsAndCounts(true);
            renderFavoriteSelect(value);
            return true;
        } catch(_) { return false; }
    }
    if (favoriteTeamSelect) {
        favoriteTeamSelect.addEventListener('change', (e) => { const v = e.target.value || ''; saveFavoriteTeam(v); });
    }

    // Управление заставкой вынесено в static/js/splash.js

    // --- Антиспам защиты ---
    // Делегированный троттлинг кликов. Если data-throttle нет, задаём дефолт для популярных элементов.
    const _clickThrottle = new WeakMap();
    const _defaultThrottleFor = (el) => {
        if (!el) return 0;
        if (el.matches('.bet-btn')) return 1200;
        if (el.matches('.details-btn')) return 800;
        if (el.matches('.subtab-item')) return 600;
        if (el.matches('.nav-item')) return 600;
        if (el.tagName === 'BUTTON') return 500;
        return 0;
    };
    document.addEventListener('click', (e) => {
        let el = e.target.closest('[data-throttle], .bet-btn, .details-btn, .subtab-item, .nav-item, button');
        if (!el) return;
        if (!el.hasAttribute('data-throttle')) {
            const def = _defaultThrottleFor(el);
            if (def > 0) el.setAttribute('data-throttle', String(def));
        }
        const ms = parseInt(el.getAttribute('data-throttle') || '0', 10) || 0;
        if (ms <= 0) return;
        const now = Date.now();
        const last = _clickThrottle.get(el) || 0;
        if (now - last < ms) {
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        _clickThrottle.set(el, now);
    }, true);

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
            // тёплый прогрев рефералки (не блокирует ничего) + первичное отображение
            try { prefetchReferral(); } catch(_) {}
            try { loadReferralInfo(); } catch(_) {}
                })
                .catch(err => console.error('Init error', err));
        }, 400); // минимальное время показа

        // Автопинг сервера каждые 5 минут, чтобы не засыпал
        setInterval(() => {
            fetch(`/health?_=${Date.now()}`, { cache: 'no-store' }).catch(() => {});
        }, 5 * 60 * 1000);

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
                if (res.status === 401) { showError('Ошибка авторизации'); tg?.close?.(); throw new Error('Unauthorized'); }
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
                        return `Ежедневные чекины подряд. Цель: ${tgt} дней.`;
                    case 'credits':
                        return `Накопите кредиты до порога: ${(tgt||0).toLocaleString()} кр.`;
                    case 'level':
                        return `Достигните уровень: ${tgt}. Получайте опыт за активность.`;
                    case 'invited':
                        return `Пригласите друзей по реферальной ссылке: ${tgt} человек.`;
                    case 'betcount':
                        return `Сделайте ${tgt} ставок.`;
                    case 'betwins':
                        return `Выиграйте ${tgt} ставок.`;
                    case 'bigodds':
                        return `Выиграйте ставку с коэффициентом не ниже ${Number(tgt).toFixed(1)}.`;
                    case 'markets':
                        return `Ставьте на разные рынки (1X2, тоталы, спецсобытия и т.д.). Цель: ${tgt} типа рынков.`;
                    case 'weeks':
                        return `Делайте ставки в разные недели. Цель: ${tgt} недель.`;
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
            // Короткая сводка прогресса
            const progressLine = (() => {
                const v = a.value ?? 0; const t = a.target ?? 0;
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
            const pct = Math.max(0, Math.min(100, Math.floor((Math.min(a.value||0, a.target||1) / (a.target||1)) * 100)));
            progressBar.style.width = `${pct}%`;
            progressWrap.appendChild(progressBar);

            card.append(icon, name, toggle, req, progressWrap);
            elements.badgesContainer.appendChild(card);
            });
            shown += batch.length;
        };

        renderBatch();
        // Кнопка «Показать ещё», пока есть элементы
        const moreBtn = document.createElement('button');
        moreBtn.className = 'details-btn';
        moreBtn.textContent = 'Показать ещё';
        moreBtn.style.marginTop = '8px';
        moreBtn.addEventListener('click', () => {
            renderBatch();
            if (shown >= safe.length) moreBtn.remove();
        });
        if (safe.length > shown) {
            elements.badgesContainer.parentElement.appendChild(moreBtn);
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
                if (res.status === 401) { showError('Ошибка авторизации'); tg?.close?.(); throw new Error('Unauthorized'); }
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
        const newName = prompt('Введите новое имя:', elements.userName.textContent);
        if (!newName || !newName.trim() || newName === elements.userName.textContent) return;
        const original = elements.userName.textContent;
        elements.userName.textContent = 'Сохранение...';
        if (!tg || !tg.initDataUnsafe?.user) { elements.userName.textContent = original; return; }

    const formData = new FormData();
    formData.append('initData', tg.initData || '');
    formData.append('new_name', newName.trim());

        fetch('/api/update-name', { method:'POST', body: formData })
        .then(res => { if (res.status === 401) throw new Error('Unauthorized'); return res.json(); })
        .then(data => { if (elements.userName) elements.userName.textContent = data.display_name; })
        .catch(err => {
            console.error('update name err', err);
            if (elements.userName) elements.userName.textContent = original;
            try { tg?.showAlert?.('Не удалось изменить имя'); } catch (_) { try { alert('Не удалось изменить имя'); } catch(_){} }
        });
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
        navItems.forEach(item => {
            const tab = item.getAttribute('data-tab');
            // На НЛО отключаем троттлинг, иначе двойной тап не сработает
            if (tab === 'ufo') item.setAttribute('data-throttle', '0'); else item.setAttribute('data-throttle', '600');
            item.addEventListener('click', () => {
                const tab = item.getAttribute('data-tab');
                // Обработка двойного тапа для НЛО
                if (tab === 'ufo') {
                    const now = Date.now();
                    if (now - _lastUfoTap < 350) {
                        // двойной тап: показываем компактный оверлей-расширение
                        showLeagueOverlay();
                        _lastUfoTap = 0;
                        return;
                    }
                    _lastUfoTap = now;
                }

                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
    const prof = document.getElementById('tab-profile');
        const ufo = document.getElementById('tab-ufo');
        const preds = document.getElementById('tab-predictions');
        const lead = document.getElementById('tab-leaderboard');
    const shop = document.getElementById('tab-shop');
    const admin = document.getElementById('tab-admin');
    [prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
    if (tab === 'profile' && prof) prof.style.display = '';
    if (tab === 'ufo' && ufo) {
        ufo.style.display = '';
        // Показ контента по активной лиге (без автопоказа оверлея)
        try {
            const act = getActiveLeague();
            if (act === 'BLB') selectBLBLeague(); else selectUFOLeague(true);
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
    if (tab === 'shop' && shop) { shop.style.display = ''; }
    if (tab === 'admin' && admin) { admin.style.display = ''; ensureAdminInit(); }
                // прокрутка к верху при смене вкладки
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            // Поддержка dblclick (десктоп) для оверлея
            if (tab === 'ufo') {
                item.addEventListener('dblclick', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    showLeagueOverlay();
                });
                // Явная обработка touchend для надёжного двойного тапа
                let _ufoLastTouch = 0;
                item.addEventListener('touchend', (e) => {
                    const now = Date.now();
                    if (now - _ufoLastTouch < 350) {
                        e.preventDefault(); e.stopPropagation();
                        showLeagueOverlay();
                        _ufoLastTouch = 0;
                    } else {
                        _ufoLastTouch = now;
                    }
                }, { passive: false });
            }
        });
        // Стартовая вкладка: Профиль
        try {
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            const profItem = document.querySelector('.nav-item[data-tab="profile"]');
            if (profItem) profItem.classList.add('active');
            const prof = document.getElementById('tab-profile');
            const ufo = document.getElementById('tab-ufo');
            const preds = document.getElementById('tab-predictions');
            const lead = document.getElementById('tab-leaderboard');
            const shop = document.getElementById('tab-shop');
            const admin = document.getElementById('tab-admin');
            [prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
            if (prof) prof.style.display = '';
        } catch(_) {}

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

        const copyBtn = document.getElementById('copy-ref');
        if (copyBtn) {
            copyBtn.setAttribute('data-throttle', '1200');
            copyBtn.addEventListener('click', async () => {
                const el = document.getElementById('referral-link');
                const txt = el?.textContent?.trim();
                if (!txt) return;
                try { await navigator.clipboard.writeText(txt); tg?.showAlert?.('Ссылка скопирована'); } catch(_) {}
            });
        }
    }

    // ---------- ADMIN TAB ----------
    let _adminInited = false;
    function ensureAdminInit() {
        if (_adminInited) return; _adminInited = true;
        const btnAll = document.getElementById('admin-refresh-all');
        const btnUsers = document.getElementById('admin-users-refresh');
        const btnSync = document.getElementById('admin-sync-refresh');
        const lblUsers = document.getElementById('admin-users-stats');
        const lblSync = document.getElementById('admin-sync-summary');
        // Обновить все
        if (btnAll) btnAll.addEventListener('click', () => {
            const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            btnAll.disabled = true; const orig = btnAll.textContent; btnAll.textContent = 'Обновляю...';
            Promise.allSettled([
                fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
                fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
                fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
                fetch('/api/results/refresh', { method: 'POST', body: fd })
            ]).finally(() => { btnAll.disabled = false; btnAll.textContent = orig; });
        });
        // Онлайн/уникальные
        if (btnUsers && lblUsers) btnUsers.addEventListener('click', () => {
            const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
            btnUsers.disabled = true; const o = btnUsers.textContent; btnUsers.textContent = '...';
            fetch('/api/admin/users-stats', { method: 'POST', body: fd })
                .then(r => r.json()).then(d => {
                    const s = `Всего: ${d.total_users||0} • Онлайн: ${d.online_5m||0} (5м) / ${d.online_15m||0} (15м)`;
                    lblUsers.textContent = s;
                })
                .finally(()=>{ btnUsers.disabled=false; btnUsers.textContent=o; });
        });
        // Метрики синка
        if (btnSync && lblSync) btnSync.addEventListener('click', () => {
            btnSync.disabled = true; const o = btnSync.textContent; btnSync.textContent='...';
            fetch('/health/sync').then(r=>r.json()).then(m => {
                const last = m.last_sync || {}; const st = m.last_sync_status || {}; const dur = m.last_sync_duration_ms || {};
                const keys = ['league-table','stats-table','schedule','results','betting-tours','leaderboards'];
                const lines = keys.map(k => `${k}: ${st[k]||'—'}, ${dur[k]||0}мс, at ${last[k]||'—'}`);
                lblSync.textContent = lines.join(' | ');
            }).finally(()=>{ btnSync.disabled=false; btnSync.textContent=o; });
        });
    }

    // Подвкладки Магазина — инициализация сразу (без вложенного DOMContentLoaded)
    function initShopUI() {
        const tabs = document.querySelectorAll('#shop-subtabs .subtab-item');
        const panes = { store: document.getElementById('shop-pane-store'), cart: document.getElementById('shop-pane-cart') };
        tabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-stab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
                if (key === 'cart') renderCart();
            });
        });
        initShop();
    }

    // ---------- МАГАЗИН ----------
    function readCart() {
        try { return JSON.parse(localStorage.getItem('shop:cart') || '[]'); } catch(_) { return []; }
    }
    function writeCart(items) {
        try { localStorage.setItem('shop:cart', JSON.stringify(items)); } catch(_) {}
    }
    function addToCart(item) {
        const cart = readCart();
        const idx = cart.findIndex(x => x.id === item.id);
        if (idx >= 0) { cart[idx].qty = (cart[idx].qty || 1) + 1; }
        else { cart.push({ ...item, qty: 1 }); }
        writeCart(cart);
        try { window.Telegram?.WebApp?.showAlert?.('Товар добавлен в корзину'); } catch(_) {}
        renderCart();
    }
    function removeFromCart(id) {
        let cart = readCart();
        cart = cart.filter(x => x.id !== id);
        writeCart(cart);
        renderCart();
    }
    function renderCart() {
        const pane = document.getElementById('shop-pane-cart');
        if (!pane) return;
        const cart = readCart();
        const wrap = document.createElement('div');
        wrap.className = 'cart-list';
        if (!cart.length) {
            pane.innerHTML = '<div style="padding:12px; color: var(--gray);">Корзина пуста.</div>';
            return;
        }
        let total = 0;
        cart.forEach(it => {
            total += (it.price || 0) * (it.qty || 1);
            const row = document.createElement('div');
            row.className = 'cart-row';
            const left = document.createElement('div'); left.className = 'cart-left'; left.textContent = `${it.name} × ${it.qty || 1}`;
            const right = document.createElement('div'); right.className = 'cart-right'; right.textContent = `${(it.price* (it.qty||1)).toLocaleString()} кр.`;
            const del = document.createElement('button'); del.className = 'details-btn'; del.textContent = 'Убрать'; del.style.marginLeft = '8px'; del.setAttribute('data-throttle','600');
            del.addEventListener('click', () => removeFromCart(it.id));
            const line = document.createElement('div'); line.className = 'cart-line';
            line.append(left, right, del);
            wrap.appendChild(line);
        });
        const totalEl = document.createElement('div'); totalEl.className = 'cart-total'; totalEl.textContent = `Итого: ${total.toLocaleString()} кредитов`;
        pane.innerHTML = '';
        pane.appendChild(wrap);
        pane.appendChild(totalEl);
    }
    function initShop() {
        // Подвяжем кнопки «В корзину» и метаданные товаров
        const cards = document.querySelectorAll('#shop-pane-store .store-item');
        const catalogue = [];
        cards.forEach((card, i) => {
            const id = card.getAttribute('data-id') || `item_${i+1}`;
            const name = card.getAttribute('data-name') || (card.querySelector('.store-name')?.textContent || `Товар ${i+1}`);
            const priceAttr = card.getAttribute('data-price') || '0';
            const price = parseInt(String(priceAttr).replace(/[^0-9]/g,''), 10) || 0;
            catalogue.push({ id, name, price });
            const btn = card.querySelector('button');
            if (btn) {
                btn.disabled = false;
                btn.setAttribute('data-throttle','600');
                btn.addEventListener('click', () => addToCart({ id, name, price }));
            }
        });
    }

    let _leagueLoading = false;
    function loadLeagueTable() {
        if (_leagueLoading) return;
    const table = document.getElementById('league-table');
    const updatedWrap = document.getElementById('league-table-updated');
    const updatedText = document.getElementById('league-updated-text');
        if (!table) return;
        _leagueLoading = true;
        fetch('/api/league-table').then(r => r.json()).then(data => {
            const tbody = table.querySelector('tbody');
            tbody.innerHTML = '';
            const rows = data.values || [];
        for (let i = 0; i < 10; i++) {
                const r = rows[i] || [];
                const tr = document.createElement('tr');
                for (let j = 0; j < 8; j++) {
                    const td = document.createElement('td');
            td.textContent = (r[j] ?? '').toString();
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            // подсветка топ-3 только для строк 2..4, т.к. первая строка — заголовки
            const trs = tbody.querySelectorAll('tr');
            trs.forEach((rowEl, idx) => {
                // idx: 0..9 — если 0 это заголовок, подсвечиваем 1..3
                if (idx === 1) rowEl.classList.add('rank-1');
                if (idx === 2) rowEl.classList.add('rank-2');
                if (idx === 3) rowEl.classList.add('rank-3');
            });
            if (updatedText && data.updated_at) {
                setUpdatedLabelSafely(updatedText, data.updated_at);
            }
            // показать кнопку обновления для админа (обработчик навешивается один раз выше)
            const refreshBtn = document.getElementById('league-refresh-btn');
            const adminId = document.body.getAttribute('data-admin');
            const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
            if (updatedWrap && refreshBtn && adminId && currentId && String(adminId) === currentId) {
                refreshBtn.style.display = '';
            }
            // после первой успешной загрузки таблицы, если достижения уже готовы — можно сигналить all-ready
            _tableLoaded = true;
            trySignalAllReady();
        }).catch(err => {
            console.error('league table load error', err);
        }).finally(() => {
            // не блокируем сплэш: считаем таблицу загруженной даже при ошибке
            _tableLoaded = true;
            trySignalAllReady();
            _leagueLoading = false;
        });
    }

    // Безопасное обновление метки "Обновлено":
    // - хранит текущий ISO в data-updated-iso
    // - обновляет текст только если новый ts >= текущего
    function setUpdatedLabelSafely(labelEl, newIso) {
        try {
            const prevIso = labelEl.getAttribute('data-updated-iso');
            const prevTs = prevIso ? Date.parse(prevIso) : 0;
            const nextTs = Date.parse(newIso);
            if (!Number.isFinite(nextTs)) return;
            if (nextTs >= prevTs) {
                labelEl.setAttribute('data-updated-iso', newIso);
                const d = new Date(newIso);
                labelEl.textContent = `Обновлено: ${d.toLocaleString()}`;
            }
        } catch(_) {}
    }

    let _statsLoading = false;
    function loadStatsTable() {
        if (_statsLoading) return;
        const table = document.getElementById('stats-table');
        const updated = document.getElementById('stats-table-updated');
        if (!table) return;
        _statsLoading = true;
        fetch('/api/stats-table').then(r => r.json()).then(data => {
            const tbody = table.querySelector('tbody');
            tbody.innerHTML = '';
            const rows = data.values || [];
            for (let i = 0; i < 11; i++) {
                const r = rows[i] || [];
                const tr = document.createElement('tr');
                for (let j = 0; j < 7; j++) {
                    const td = document.createElement('td');
                    td.textContent = (r[j] ?? '').toString();
                    tr.appendChild(td);
                }
                tbody.appendChild(tr);
            }
            // подсветка топ-3 для строк 2..4 (0 — заголовки)
            const trs = tbody.querySelectorAll('tr');
            trs.forEach((rowEl, idx) => {
                if (idx === 1) rowEl.classList.add('rank-1');
                if (idx === 2) rowEl.classList.add('rank-2');
                if (idx === 3) rowEl.classList.add('rank-3');
            });
            if (updated && data.updated_at) {
                const d = new Date(data.updated_at);
                updated.textContent = `Обновлено: ${d.toLocaleString()}`;
            }
    }).catch(err => {
            console.error('stats table load error', err);
    }).finally(() => { _statsLoading = false; });
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
        // бейдж недели: вычислим старт периода (понедельник 03:00 МСК) и конец
        try {
            const badge = document.getElementById('leader-week-badge');
            if (badge) {
                const now = new Date();
                // переводим now в МСК (UTC+3) без учёта DST (как на сервере)
                const mskNow = new Date(now.getTime() + 3*60*60*1000);
                const wd = mskNow.getUTCDay(); // 0-вс,1-пн,.. 6-сб для UTC-времени, но на mskNow смещение уже учтено
                // найдём понедельник этой недели в МСК
                const diffDays = (wd === 0 ? 6 : (wd - 1)); // сколько дней от пн
                const monday = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 3, 0, 0));
                monday.setUTCDate(monday.getUTCDate() - diffDays);
                // если текущее mskNow ещё до понедельника 03:00 — берём предыдущую неделю
                const mondayCut = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate(), 3, 0, 0));
                if (mskNow < mondayCut) {
                    monday.setUTCDate(monday.getUTCDate() - 7);
                }
                const periodStartUtc = new Date(monday.getTime() - 3*60*60*1000); // вернёмся в UTC для читаемости
                const periodEndUtc = new Date(periodStartUtc.getTime() + 7*24*60*60*1000);
                const fmt = (d) => `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}`;
                // ISO номер недели считаем по МСК-дате начала периода
                const mskStart = new Date(periodStartUtc.getTime() + 3*60*60*1000);
                const getISOWeek = (date) => {
                    // преобразуем к четвергу той же недели для вычисления номера
                    const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
                    const day = tmp.getUTCDay() || 7; // 1..7
                    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
                    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
                    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
                    return weekNo;
                };
                const weekNo = getISOWeek(mskStart);
                badge.textContent = `Неделя №${weekNo}: ${fmt(periodStartUtc)} — ${fmt(new Date(periodEndUtc.getTime()-1))}`;
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
                    { key: 'rich', title: 'Топ богачей' },
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
        candidates.push(base + encodeURIComponent(norm + '.png'));
        // 2) при желании можно попытаться точным именем (закомментировано для избежания 404-спама)
        // candidates.push(base + encodeURIComponent(name + '.png'));
            }
            // 3) дефолт
            candidates.push(base + 'default.png');

            let idx = 0;
            const tryNext = () => {
                if (idx >= candidates.length) return;
                imgEl.onerror = () => { idx++; tryNext(); };
                imgEl.src = candidates[idx];
            };
            tryNext();
        };
    const renderSchedule = (data) => {
            const ds = data?.tours ? data : (data?.data || {});
            const tours = ds.tours || [];
            if (!tours.length) {
                // Если уже есть контент, не затираем его пустым ответом
                if (pane.childElementCount > 0 || pane.dataset.hasContent === '1') {
                    return;
                }
                pane.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>';
                return;
            }
            pane.innerHTML = '';
            tours.forEach(t => {
                const tourEl = document.createElement('div');
                tourEl.className = 'tour-block';
                const title = document.createElement('div');
                title.className = 'tour-title';
                title.textContent = t.title || `Тур ${t.tour || ''}`;
                tourEl.appendChild(title);

                (t.matches || []).forEach(m => {
                    const card = document.createElement('div');
                    card.className = 'match-card';
                    const header = document.createElement('div');
                    header.className = 'match-header';
                    const dateStr = (() => {
                        try {
                            if (m.date) {
                                const d = new Date(m.date);
                                const dd = d.toLocaleDateString();
                                return dd;
                            }
                        } catch(_) {}
                        return '';
                    })();
                    const timeStr = m.time || '';
                    // LIVE вычисление: если есть точное datetime, используем его; иначе, если дата сегодня и время пусто, считаем не LIVE
                    const now = new Date();
                    let isLive = false;
                    try {
                        if (m.datetime) {
                            const dt = new Date(m.datetime);
                            // считаем live, если dt <= now < dt+2ч
                            const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
                            isLive = now >= dt && now < dtEnd;
                        } else if (m.date && m.time) {
                            const dt = new Date(m.date + 'T' + (m.time.length===5? m.time+':00': m.time));
                            const dtEnd = new Date(dt.getTime() + 2*60*60*1000);
                            isLive = now >= dt && now < dtEnd;
                        }
                    } catch(_) {}
                    const headerText = document.createElement('span');
                    headerText.textContent = `${dateStr}${timeStr ? ' ' + timeStr : ''}`;
                    header.appendChild(headerText);
                    if (isLive) {
                        const live = document.createElement('span'); live.className = 'live-badge';
                        const dot = document.createElement('span'); dot.className = 'live-dot';
                        const lbl = document.createElement('span'); lbl.textContent = 'LIVE';
                        live.append(dot, lbl);
                        header.appendChild(live);
                    }
                    card.appendChild(header);

                    const center = document.createElement('div');
                    center.className = 'match-center';
                    const home = document.createElement('div'); home.className = 'team home';
                    const hImg = document.createElement('img'); hImg.className = 'logo'; hImg.alt = m.home || '';
                    loadTeamLogo(hImg, m.home || '');
                    const hName = document.createElement('div'); hName.className = 'team-name'; hName.setAttribute('data-team-name', m.home || ''); hName.textContent = withTeamCount(m.home || '');
                    home.append(hImg, hName);
                    const score = document.createElement('div'); score.className = 'score'; score.textContent = 'VS';
                    const away = document.createElement('div'); away.className = 'team away';
                    const aImg = document.createElement('img'); aImg.className = 'logo'; aImg.alt = m.away || '';
                    loadTeamLogo(aImg, m.away || '');
                    const aName = document.createElement('div'); aName.className = 'team-name'; aName.setAttribute('data-team-name', m.away || ''); aName.textContent = withTeamCount(m.away || '');
                    away.append(aImg, aName);
                    center.append(home, score, away);
                    card.appendChild(center);

                    const footer = document.createElement('div');
                    footer.className = 'match-footer';
                    // Кнопка «Детали» (как было)
                    const btnDetails = document.createElement('button');
                    btnDetails.className = 'details-btn';
                    btnDetails.textContent = 'Детали';
                    btnDetails.setAttribute('data-throttle', '800');
                    btnDetails.addEventListener('click', () => {
                        const original = btnDetails.textContent;
                        btnDetails.disabled = true; btnDetails.textContent = 'Загрузка контента...';
                        const params = new URLSearchParams({ home: m.home || '', away: m.away || '' });
                        const cacheKey = `md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`;
                        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
                        const fetchWithETag = (etag) => fetch(`/api/match-details?${params.toString()}`, { headers: etag ? { 'If-None-Match': etag } : {} })
                            .then(async r => {
                                if (r.status === 304 && cached) return cached;
                                const data = await r.json();
                                const version = data.version || r.headers.get('ETag') || null;
                                const toStore = { data, version, ts: Date.now() };
                                try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_) {}
                                return toStore;
                            });
                        const go = (store) => {
                            openMatchScreen({ home: m.home, away: m.away, date: m.date, time: m.time }, store?.data || store);
                            btnDetails.disabled = false; btnDetails.textContent = original;
                        };
                        const FRESH_TTL = 10 * 60 * 1000;
                        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
                        else if (cached && cached.version) { fetchWithETag(cached.version).then(go).catch(() => { go(cached); }); }
                        else if (cached) { go(cached); }
                        else {
                            fetchWithETag(null).then(go).catch(err => {
                                console.error('match details load error', err);
                                try { window.Telegram?.WebApp?.showAlert?.('Не удалось загрузить данные матча'); } catch(_) {}
                                btnDetails.disabled = false; btnDetails.textContent = original;
                            });
                        }
                    });
                    footer.appendChild(btnDetails);
                    // Кнопка «Сделать прогноз» показывается, только если ЭТОТ матч (с этой датой) есть в турах для ставок
                    const btn = document.createElement('button');
                    btn.className = 'details-btn';
                    btn.setAttribute('data-throttle', '800');
                    const toursCache = (() => { try { return JSON.parse(localStorage.getItem('betting:tours') || 'null'); } catch(_) { return null; } })();
                    // Ключ матча: home__away__YYYY-MM-DD (чтобы отличать одноимённые пары в разных турах)
                    const mkKey = (obj) => {
                        try {
                            const h = (obj?.home || '').toLowerCase().trim();
                            const a = (obj?.away || '').toLowerCase().trim();
                            const raw = obj?.date ? String(obj.date) : (obj?.datetime ? String(obj.datetime) : '');
                            const d = raw ? raw.slice(0, 10) : '';
                            return `${h}__${a}__${d}`;
                        } catch(_) { return `${(obj?.home||'').toLowerCase()}__${(obj?.away||'').toLowerCase()}__`; }
                    };
                    const tourMatches = new Set();
                    try {
                        const tours = toursCache?.data?.tours || toursCache?.tours || [];
                        tours.forEach(t => (t.matches||[]).forEach(x => {
                            tourMatches.add(mkKey(x));
                        }));
                    } catch(_) {}
                    const thisKey = mkKey(m);
                    const matchHasPrediction = tourMatches.has(thisKey);
                    if (matchHasPrediction) {
                        btn.textContent = 'Сделать прогноз';
                        btn.addEventListener('click', async () => {
                            // Переключаемся на вкладку Прогнозы
                            try {
                                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                                const navPred = document.querySelector('.nav-item[data-tab="predictions"]');
                                if (navPred) navPred.classList.add('active');
                                const prof = document.getElementById('tab-profile');
                                const ufo = document.getElementById('tab-ufo');
                                const preds = document.getElementById('tab-predictions');
                                const lead = document.getElementById('tab-leaderboard');
                                const shop = document.getElementById('tab-shop');
                                const admin = document.getElementById('tab-admin');
                                [prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
                                if (preds) preds.style.display = '';
                            } catch(_) {}
                            // Убедимся, что туры загружены
                            try { window.loadBetTours?.(); } catch(_) {}
                            // Подождём до 1.5с появления карточек
                            const waitForCard = () => new Promise((resolve) => {
                                const started = Date.now();
                                const tick = () => {
                                    const host = document.getElementById('pred-tours');
                                    if (host && host.querySelector('.match-card')) { resolve(); return; }
                                    if (Date.now() - started > 1500) { resolve(); return; }
                                    requestAnimationFrame(tick);
                                };
                                tick();
                            });
                            await waitForCard();
                            // Прокрутка к нужной карточке и подсветка
                            try {
                                const host = document.getElementById('pred-tours');
                                if (!host) return;
                                const cards = host.querySelectorAll('.match-card');
                                const targetH = (m.home||'').toLowerCase();
                                const targetA = (m.away||'').toLowerCase();
                                for (const c of cards) {
                                    const h = (c.getAttribute('data-home') || '').toLowerCase();
                                    const a = (c.getAttribute('data-away') || '').toLowerCase();
                                    if (h === targetH && a === targetA) {
                                        c.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                        c.classList.add('highlight');
                                        setTimeout(()=> c.classList.remove('highlight'), 1600);
                                        break;
                                    }
                                }
                            } catch(_) {}
                        });
                        footer.appendChild(btn);
                    }
                    card.appendChild(footer);

                    tourEl.appendChild(card);
                });

                pane.appendChild(tourEl);
            });
            // пометим, что контент есть
            pane.dataset.hasContent = '1';
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
                candidates.push(base + encodeURIComponent(name + '.png'));
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
                candidates.push(base + encodeURIComponent(norm + '.png'));
            }
            candidates.push(base + 'default.png');
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
            const all = data?.results || [];
            if (!all.length) {
                if (pane.childElementCount > 0 || pane.dataset.hasContent === '1') {
                    return;
                }
                pane.innerHTML = '<div class="schedule-empty">Нет прошедших матчей</div>';
                return;
            }
            pane.innerHTML = '';
            // Группируем по туру
            const byTour = new Map();
            all.forEach(m => { const t = m.tour || 0; if (!byTour.has(t)) byTour.set(t, []); byTour.get(t).push(m); });
            // Список туров по убыванию номера/даты
            const tourList = Array.from(byTour.keys()).sort((a,b)=>b-a);
            const container = document.createElement('div');
            container.className = 'results-container';
            // Pager
            const pager = document.createElement('div'); pager.className = 'results-pager';
            const prev = document.createElement('button'); prev.className = 'pager-btn'; prev.textContent = '←';
            const title = document.createElement('div'); title.className = 'pager-title';
            const next = document.createElement('button'); next.className = 'pager-btn'; next.textContent = '→';
            pager.append(prev, title, next);
            const listWrap = document.createElement('div'); listWrap.className = 'results-list';
            container.append(pager, listWrap);
            pane.appendChild(container);

            let idx = 0;
            const renderPage = () => {
                const tour = tourList[idx];
                title.textContent = `${tour} Тур`;
                listWrap.innerHTML = '';
                const matches = (byTour.get(tour) || []).slice();
                // сортируем внутри тура по времени (новые сверху)
                matches.sort((m1,m2)=>{
                    const d1 = m1.datetime || m1.date || ''; const d2 = m2.datetime || m2.date || '';
                    return (d2 > d1) ? 1 : (d2 < d1 ? -1 : 0);
                });
                matches.forEach(m => {
                    const card = document.createElement('div');
                    card.className = 'match-card result';
                    const header = document.createElement('div'); header.className = 'match-header';
                    const dateStr = (() => { try { if (m.date) { const d = new Date(m.date); return d.toLocaleDateString(); } } catch(_) {} return ''; })();
                    header.textContent = `${dateStr}${m.time ? ' ' + m.time : ''}`;
                    card.appendChild(header);

                    const center = document.createElement('div'); center.className = 'match-center';
                    const home = document.createElement('div'); home.className = 'team home';
                    const hImg = document.createElement('img'); hImg.className = 'logo'; hImg.alt = m.home || '';
                    loadTeamLogo(hImg, m.home || '');
                    const hName = document.createElement('div'); hName.className = 'team-name'; hName.setAttribute('data-team-name', m.home || ''); hName.textContent = withTeamCount(m.home || '');
                    home.append(hImg, hName);
                    const score = document.createElement('div'); score.className = 'score';
                    const sH = (m.score_home || '').toString().trim(); const sA = (m.score_away || '').toString().trim();
                    score.textContent = (sH && sA) ? `${sH} : ${sA}` : '— : —';
                    const away = document.createElement('div'); away.className = 'team away';
                    const aImg = document.createElement('img'); aImg.className = 'logo'; aImg.alt = m.away || '';
                    loadTeamLogo(aImg, m.away || '');
                    const aName = document.createElement('div'); aName.className = 'team-name'; aName.setAttribute('data-team-name', m.away || ''); aName.textContent = withTeamCount(m.away || '');
                    away.append(aImg, aName);

                    // Подсветка победителя: постоянное золотое кольцо + усиление при hover
                    const toInt = (x) => { const n = parseInt(String(x).replace(/[^0-9-]/g,''), 10); return isNaN(n) ? null : n; };
                    const nH = toInt(sH), nA = toInt(sA);
                    if (nH != null && nA != null && nH !== nA) {
                        if (nH > nA) hImg.classList.add('winner-ring'); else aImg.classList.add('winner-ring');
                    }

                    center.append(home, score, away);
                    card.appendChild(center);
                    listWrap.appendChild(card);
                });
                prev.disabled = idx <= 0; next.disabled = idx >= tourList.length - 1;
            };
            prev.onclick = () => { if (idx > 0) { idx--; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
            next.onclick = () => { if (idx < tourList.length - 1) { idx++; renderPage(); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
            renderPage();
            pane.dataset.hasContent = '1';
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
    }
    function renderLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        if (!overlay) return;
        const act = getActiveLeague();
        const other = act === 'BLB' ? 'UFO' : 'BLB';
        const ico = other === 'UFO' ? '🛸' : '🅱️';
        const title = other === 'UFO' ? 'НЛО' : 'БЛБ';
        // Рендерим одну иконку как продолжение нижнего меню
        overlay.innerHTML = `
            <div class="league-icons" style="display:flex; justify-content:center; gap:12px; background: rgba(10,18,40,0.96); padding:8px 10px; border-radius:12px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);">
                <div class="nav-icon" data-league="${other}" title="${title}" style="font-size:22px; cursor:pointer; line-height:1;">${ico}</div>
            </div>
        `;
    }
    function showLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!overlay || !ufoTabs || !ufoContent || !blbBlock) return;
        // Обновим содержимое оверлея и покажем
        renderLeagueOverlay();
        overlay.style.display = 'block';
        if (!overlay.__inited) {
            overlay.__inited = true;
            overlay.addEventListener('click', (e) => {
                const ico = e.target.closest('.nav-icon[data-league]');
                if (ico) {
                    const key = ico.getAttribute('data-league');
                    if (key === 'UFO') selectUFOLeague();
                    if (key === 'BLB') selectBLBLeague();
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
        }
    }

    function selectUFOLeague(_silent) {
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
            loadLeagueTable();
            loadStatsTable();
            loadSchedule();
            loadResults();
        }
    }

    function selectBLBLeague() {
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
        initBLBSubtabs();
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

    // ---------- MATCH DETAILS SCREEN (in-app, not modal) ----------
    function openMatchScreen(match, details) {
    const schedulePane = document.getElementById('ufo-schedule');
        const mdPane = document.getElementById('ufo-match-details');
        if (!schedulePane || !mdPane) return;
        // показать экран деталей
        schedulePane.style.display = 'none';
        mdPane.style.display = '';

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
                candidates.push(base + encodeURIComponent(norm + '.png'));
                // candidates.push(base + encodeURIComponent(name + '.png'));
            }
            candidates.push(base + 'default.png');
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

        // вкладки (добавим «Спецсобытия» для админа)
        const subtabs = mdPane.querySelector('.modal-subtabs');
        mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((el) => el.classList.remove('active'));
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
        // по умолчанию активируем «Команда 1»
        mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
        homePane.style.display = '';
        awayPane.style.display = 'none';
        specialsPane.style.display = 'none';

        // заполнение составов
        const renderRoster = (pane, players) => {
            pane.innerHTML = '';
            const ul = document.createElement('ul');
            ul.className = 'roster-list';
            if (!players || players.length === 0) {
                const li = document.createElement('li');
                li.className = 'empty';
                li.textContent = 'Нет данных';
                ul.appendChild(li);
            } else {
                players.forEach(p => { const li = document.createElement('li'); li.textContent = p; ul.appendChild(li); });
            }
            pane.appendChild(ul);
        };
        try {
            const homeList = Array.isArray(details?.rosters?.home) ? details.rosters.home : [];
            const awayList = Array.isArray(details?.rosters?.away) ? details.rosters.away : [];
            if (homeList.length || awayList.length) {
                renderRoster(homePane, homeList);
                renderRoster(awayPane, awayList);
            } else {
                renderRoster(homePane, []);
                renderRoster(awayPane, []);
            }
        } catch(_) {
            renderRoster(homePane, []);
            renderRoster(awayPane, []);
        }

        // Если доступно API статуса — отметим LIVE индикатором в заголовке деталей
        try {
            fetch(`/api/match/status/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
                .then(r=>r.json()).then(s => {
                    if (s?.status === 'live') {
                        const live = document.createElement('span'); live.className = 'live-badge';
                        const dot = document.createElement('span'); dot.className = 'live-dot';
                        const lbl = document.createElement('span'); lbl.textContent = 'LIVE';
                        live.append(dot, lbl);
                        dt.appendChild(live);
                    }
                }).catch(()=>{});
        } catch(_) {}

        // переключение вкладок
        mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((btn) => {
            btn.onclick = () => {
                mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((x)=>x.classList.remove('active'));
                btn.classList.add('active');
                const key = btn.getAttribute('data-mdtab');
                if (key === 'home') { homePane.style.display = ''; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; }
                else if (key === 'away') { homePane.style.display = 'none'; awayPane.style.display = ''; specialsPane.style.display = 'none'; }
                else if (key === 'specials') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = '';
                    // отрисуем спецпанель внутри specialsPane
                    renderSpecialsPane(specialsPane, match);
                }
            };
        });

        // кнопка Назад
        const back = document.getElementById('match-back');
        if (back) back.onclick = () => {
            // очистка
            homePane.innerHTML = '';
            awayPane.innerHTML = '';
            // вернуть расписание
            mdPane.style.display = 'none';
            schedulePane.style.display = '';
            // прокрутка к верху для UX
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };
    }

    // Рендер спецсобытий (внутри деталей матча)
    function renderSpecialsPane(host, m) {
        const tg = window.Telegram?.WebApp || null;
        host.innerHTML = '';
        const shell = document.createElement('div');
        shell.className = 'admin-panel';
        shell.style.marginTop = '8px'; shell.style.padding = '8px'; shell.style.border = '1px solid rgba(255,255,255,0.1)'; shell.style.borderRadius = '10px';
    const title = document.createElement('div'); title.style.marginBottom = '6px'; title.textContent = 'Спецсобытия матча';
    // Блок статуса матча: scheduled|live|finished
    const statusRow = document.createElement('div'); statusRow.style.display='flex'; statusRow.style.gap='8px'; statusRow.style.alignItems='center'; statusRow.style.marginBottom='6px';
    const sLab = document.createElement('div'); sLab.textContent = 'Статус:';
    const sSel = document.createElement('select'); sSel.innerHTML = '<option value="scheduled">Запланирован</option><option value="live">Матч идет</option><option value="finished">Матч завершен</option>';
    const sBtn = document.createElement('button'); sBtn.className = 'details-btn'; sBtn.textContent = 'Применить статус';
    statusRow.append(sLab, sSel, sBtn);
        const row1 = document.createElement('div'); row1.style.display='flex'; row1.style.gap='8px'; row1.style.alignItems='center';
        const lab1 = document.createElement('div'); lab1.textContent = 'Пенальти:';
        const sel1 = document.createElement('select'); sel1.innerHTML = '<option value="">—</option><option value="1">Да</option><option value="0">Нет</option>';
        row1.append(lab1, sel1);
        const row2 = document.createElement('div'); row2.style.display='flex'; row2.style.gap='8px'; row2.style.alignItems='center'; row2.style.marginTop='6px';
        const lab2 = document.createElement('div'); lab2.textContent = 'Красная:';
        const sel2 = document.createElement('select'); sel2.innerHTML = '<option value="">—</option><option value="1">Да</option><option value="0">Нет</option>';
        row2.append(lab2, sel2);
        const actions = document.createElement('div'); actions.style.marginTop='8px';
        const save = document.createElement('button'); save.className = 'details-btn'; save.textContent = 'Сохранить и рассчитать';
        actions.append(save);
        shell.append(title, statusRow, row1, row2, actions);
        host.appendChild(shell);

        // Инициализируем селектор статуса текущим значением
        try {
            fetch(`/api/match/status/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`)
                .then(r=>r.json()).then(s => { if (s?.status) sSel.value = s.status; }).catch(()=>{});
        } catch(_) {}

        // Загрузим текущее состояние
        fetch(`/api/specials/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`)
            .then(r=>r.json())
            .then(d => {
                if (d.penalty_yes === 1) sel1.value = '1'; else if (d.penalty_yes === 0) sel1.value = '0'; else sel1.value='';
                if (d.redcard_yes === 1) sel2.value = '1'; else if (d.redcard_yes === 0) sel2.value = '0'; else sel2.value='';
            }).catch(()=>{});

        // Сохранение статуса
        sBtn.addEventListener('click', () => {
            const fd = new FormData();
            fd.append('initData', tg?.initData || '');
            fd.append('home', m.home || '');
            fd.append('away', m.away || '');
            fd.append('status', sSel.value || 'scheduled');
            sBtn.disabled = true; const old = sBtn.textContent; sBtn.textContent = 'Сохранение...';
            fetch('/api/match/status/set', { method: 'POST', body: fd })
                .then(r => r.json())
                .then(resp => {
                    if (resp?.error) { try { tg?.showAlert?.(resp.error); } catch(_) {} return; }
                    try { tg?.showAlert?.('Статус обновлён'); } catch(_) {}
                    // Обновим LIVE стор для индикации и уведомления
                    try {
                        if (!window.__LIVE_STATUS) window.__LIVE_STATUS = { pairs: new Set(), ts: 0 };
                        const key = `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}`;
                        if (sSel.value === 'live') { window.__LIVE_STATUS.pairs.add(key); }
                        if (sSel.value === 'finished') { window.__LIVE_STATUS.pairs.delete(key); }
                    } catch(_) {}
                })
                .catch(err => { console.error('match status set error', err); try { tg?.showAlert?.('Ошибка сохранения статуса'); } catch(_) {} })
                .finally(()=>{ sBtn.disabled=false; sBtn.textContent = old; });
        });

        save.addEventListener('click', () => {
            const fd = new FormData();
            fd.append('initData', tg?.initData || '');
            fd.append('home', m.home || '');
            fd.append('away', m.away || '');
            if (sel1.value !== '') fd.append('penalty_yes', sel1.value);
            if (sel2.value !== '') fd.append('redcard_yes', sel2.value);
            save.disabled = true; const old = save.textContent; save.textContent = 'Сохранение...';
            fetch('/api/specials/set', { method: 'POST', body: fd })
                .then(r => r.json())
                .then(resp => {
                    if (resp?.error) { try { tg?.showAlert?.(resp.error); } catch(_) {} return; }
                    try { tg?.showAlert?.('Сохранено. Расчёт запущен.'); } catch(_) {}
                })
                .catch(err => { console.error('specials set error', err); try { tg?.showAlert?.('Ошибка сохранения'); } catch(_) {} })
                .finally(()=>{ save.disabled=false; save.textContent = old; });
        });
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
        const linkEl = document.getElementById('referral-link');
        const countEl = document.getElementById('ref-count');
        const linkEl2 = document.getElementById('referral-link-2');
        const countEl2 = document.getElementById('ref-count-2');
        if (!linkEl || !countEl) return;
        if (!tg || !tg.initDataUnsafe?.user) return;
        // Мгновенный рендер из кэша, если есть
        if (_referralCache) {
            linkEl.textContent = _referralCache.referral_link || _referralCache.code || '—';
            countEl.textContent = (_referralCache.invited_count ?? 0).toString();
            if (linkEl2) linkEl2.textContent = linkEl.textContent;
            if (countEl2) countEl2.textContent = countEl.textContent;
        }
        // Актуализируем в фоне
        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        fetch('/api/referral', { method: 'POST', body: formData })
            .then(r => r.json())
            .then(data => {
                _referralCache = data;
                linkEl.textContent = data.referral_link || data.code || '—';
                countEl.textContent = (data.invited_count ?? 0).toString();
                if (linkEl2) linkEl2.textContent = linkEl.textContent;
                if (countEl2) countEl2.textContent = countEl.textContent;
            })
            .catch(err => console.error('referral load error', err));
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

    // При старте запоминаем активную лигу из сессии (по умолчанию НЛО)
    try { setActiveLeague(getActiveLeague()); } catch(_) {}

    // старт
    initApp();
    // Стартовая предзагрузка UFO-данных во время заставки
    preloadUfoData();
    setupEventListeners();

    // ---------- LIVE notifications ----------
    const LiveWatcher = (() => {
        let lastLiveKeys = new Set();
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
        const showToast = (text) => {
            let cont = document.querySelector('.toast-container');
            if (!cont) { cont = document.createElement('div'); cont.className = 'toast-container'; document.body.appendChild(cont); }
            const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
            cont.appendChild(el);
            setTimeout(()=>{ el.remove(); if (cont.childElementCount===0) cont.remove(); }, 3500);
        };
        const scan = async () => {
            // берём из кэша /api/schedule
            try {
                const cached = JSON.parse(localStorage.getItem('schedule:tours') || 'null');
                const tours = cached?.data?.tours || [];
                const currentLive = new Set();
                const pairFlags = await fetchLiveFlags();
                tours.forEach(t => (t.matches||[]).forEach(m => {
                    if (isLive(m) || pairFlags.has(getPair(m))) currentLive.add(getKey(m));
                }));
                // уведомляем о новых LIVE матчах
                currentLive.forEach(k => { if (!lastLiveKeys.has(k)) showToast('Матч начался!'); });
                lastLiveKeys = currentLive;
            } catch(_) {}
        };
        setInterval(scan, 30000); // каждые 30 секунд мягкий опрос клиентского кэша
        // тестовая кнопка для админа
        document.addEventListener('DOMContentLoaded', () => {
            try {
                const adminId = document.body.getAttribute('data-admin');
                const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                if (adminId && currentId && String(adminId) === currentId) {
                    const btn = document.createElement('button');
                    btn.textContent = 'Тест уведомления LIVE';
                    btn.className = 'details-btn';
                    btn.style.position = 'fixed'; btn.style.bottom = '90px'; btn.style.right = '12px'; btn.style.zIndex = '9999';
                    btn.addEventListener('click', () => showToast('Матч начался!'));
                    document.body.appendChild(btn);
                }
            } catch(_) {}
        });
        return { scan };
    })();
});
