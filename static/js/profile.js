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
            // Показываем прогресс к следующему тиру (если доступен) на основании next_target с бэкенда.
            const val = a.value || 0;
            const curTarget = a.target || 1;
            const tier = a.tier || (a.unlocked ? 1 : 0);
            const nextTarget = (typeof a.next_target !== 'undefined' && a.next_target !== null) ? a.next_target : curTarget;
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
    if (tab === 'shop' && shop) { shop.style.display = ''; try { initShopUI(); } catch(_) {} }
    if (tab === 'admin' && admin) { admin.style.display = ''; ensureAdminInit(); }
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
            const act = getActiveLeague();
            const other = act === 'BLB' ? 'UFO' : 'BLB';
            leagueIcon.textContent = other === 'UFO' ? '🛸' : '❔';
            leagueText.textContent = other === 'UFO' ? 'НЛО' : 'БЛБ';
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

        // --- Админ: подвкладка «Трансляции» ---
        try {
            const adminTabs = document.querySelectorAll('#admin-subtabs .subtab-item');
            const paneService = document.getElementById('admin-pane-service');
            const paneOrders = document.getElementById('admin-pane-orders');
            const paneStreams = document.getElementById('admin-pane-streams');
            const adminWrap = document.getElementById('tab-admin');
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isOwner = !!(adminId && currentId && String(adminId) === currentId);
            if (adminWrap && isOwner) {
                // показать вкладку Админ
                const navAdmin = document.getElementById('nav-admin'); if (navAdmin) navAdmin.style.display = '';
                // переключение подвкладок
                adminTabs.forEach(tab => tab.addEventListener('click', () => {
                    adminTabs.forEach(t => t.classList.remove('active')); tab.classList.add('active');
                    const key = tab.getAttribute('data-atab');
                    paneService.style.display = key==='service' ? '' : 'none';
                    paneOrders.style.display = key==='orders' ? '' : 'none';
                    paneStreams.style.display = key==='streams' ? '' : 'none';
                    if (key==='streams') initAdminStreams();
                }));
                // автопоказ сервиса по умолчанию
            }
        } catch(_) {}

        async function initAdminStreams() {
            const list = document.getElementById('admin-streams-list');
            const msg = document.getElementById('admin-streams-msg');
            const winInput = document.getElementById('admin-streams-window');
            const refreshBtn = document.getElementById('admin-streams-refresh');
            const winMin = Math.max(10, Math.min(240, parseInt(winInput.value||'60',10)));
            const now = Date.now();
            msg.textContent = 'Загружаю расписание...';
            try {
                const res = await fetch('/api/schedule');
                const data = await res.json();
                const tours = data?.tours || [];
                const upcoming = [];
                tours.forEach(t => (t.matches||[]).forEach(m => {
                    let start = 0; try { start = m.datetime ? Date.parse(m.datetime) : 0; } catch(_){}
                    if (start && (start - now) <= winMin*60*1000 && (start - now) > -180*60*1000) {
                        upcoming.push({ tour: t.tour, title: t.title, ...m, start });
                    }
                }));
                upcoming.sort((a,b)=>a.start-b.start);
                list.innerHTML = '';
                if (!upcoming.length) {
                    list.innerHTML = '<div class="store-item" style="opacity:.85"><div class="store-name">В ближайшие '+winMin+' минут матчей нет</div></div>';
                } else {
                    // Получим текущие подтверждения
                    const cur = await (await fetch('/api/streams/list')).json().catch(()=>({ items: [] }));
                    const confirmed = new Set((cur.items||[]).map(x=>`${(x.home||'').toLowerCase()}__${(x.away||'').toLowerCase()}__${(x.date||'')}`));
                    upcoming.forEach(m => {
                        const row = document.createElement('div'); row.className='store-item';
                        const inner = document.createElement('div'); inner.className='stream-row';
                        const title = document.createElement('div'); title.className='title'; title.textContent = `${m.home} — ${m.away}`;
                        const time = document.createElement('div'); time.className='time';
                        try { time.textContent = new Date(m.start).toLocaleString(); } catch(_) { time.textContent = m.datetime || ''; }
                        const input = document.createElement('input'); input.type='text'; input.placeholder='vk video id или URL поста'; input.value='';
                        const btn = document.createElement('button'); btn.className='details-btn confirm'; btn.textContent='Подтвердить';
                        btn.onclick = async () => {
                            const val = (input.value||'').trim(); if (!val) { msg.textContent='Укажите ссылку или id.'; return; }
                            const fd = new FormData();
                            fd.append('initData', window.Telegram?.WebApp?.initData || '');
                            fd.append('home', m.home || '');
                            fd.append('away', m.away || '');
                            fd.append('date', (m.datetime||'').slice(0,10));
                            if (/^[-]?\d+_\d+$/.test(val)) fd.append('vkVideoId', val); else fd.append('vkPostUrl', val);
                            const r = await fetch('/api/streams/confirm', { method: 'POST', body: fd });
                            const j = await r.json().catch(()=>({}));
                            if (!r.ok) { msg.textContent = j?.error || 'Не удалось сохранить'; return; }
                            msg.textContent = 'Сохранено'; btn.disabled = true; input.disabled = true;
                        };
                        inner.append(title, time, input, btn); row.appendChild(inner); list.appendChild(row);
                        // пометка, если уже подтверждено
                        const k = `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__${(m.datetime||'').slice(0,10)}`;
                        if (confirmed.has(k)) { btn.disabled = true; input.disabled = true; }
                    });
                }
                msg.textContent = 'Готово';
            } catch (e) {
                console.error('admin streams load', e); msg.textContent = 'Ошибка загрузки';
            }
            refreshBtn.onclick = initAdminStreams;
            winInput.onchange = initAdminStreams;
        }
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

    // ---------- ADMIN TAB ----------
    let _adminInited = false;
    function ensureAdminInit() {
        if (_adminInited) return; _adminInited = true;
        const btnAll = document.getElementById('admin-refresh-all');
        const btnUsers = document.getElementById('admin-users-refresh');
        const btnSync = document.getElementById('admin-sync-refresh');
        const lblUsers = document.getElementById('admin-users-stats');
        const lblSync = document.getElementById('admin-sync-summary');
        // Подвкладки Админа
        try {
            const tabs = document.querySelectorAll('#admin-subtabs .subtab-item');
            const panes = {
                service: document.getElementById('admin-pane-service'),
                orders: document.getElementById('admin-pane-orders')
            };
            tabs.forEach(btn => {
                btn.setAttribute('data-throttle', '600');
                btn.addEventListener('click', () => {
                    const key = btn.getAttribute('data-atab');
                    tabs.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                    if (panes[key]) panes[key].style.display = '';
                    if (key === 'orders') renderAdminOrders();
                });
            });
        } catch(_) {}
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
                { img: '/static/img/achievements/credits-gold.png', title: 'Здесь может быть ваша лига — нажми', action: 'BLB' },
                { img: '/static/img/achievements/placeholder.png', title: '', action: '' },
                { img: '/static/img/achievements/placeholder.png', title: '', action: '' }
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
        const arm = () => { if (slides.length <= 1) return; if (timer) clearInterval(timer); timer = setInterval(() => { index = (index + 1) % slides.length; apply(); }, 3000); };
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

    // Подвкладки Магазина — инициализация сразу (без вложенного DOMContentLoaded)
    let _shopInited = false;
    function initShopUI() {
        if (_shopInited) { try { updateCartBadge(); } catch(_) {}; return; }
        const tabs = document.querySelectorAll('#shop-subtabs .subtab-item');
    const panes = { store: document.getElementById('shop-pane-store'), cart: document.getElementById('shop-pane-cart'), myorders: document.getElementById('shop-pane-myorders') };
        tabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-stab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
        if (key === 'cart') renderCart();
        if (key === 'myorders') renderMyOrders();
            });
        });
        initShop();
        updateCartBadge();
        _shopInited = true;
    }

    // ---------- МАГАЗИН ----------
    function readCart() {
        try { return JSON.parse(localStorage.getItem('shop:cart') || '[]'); } catch(_) { return []; }
    }
    function writeCart(items) {
        try { localStorage.setItem('shop:cart', JSON.stringify(items)); } catch(_) {}
        try { updateCartBadge(); } catch(_) {}
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
            const qty = Math.max(1, it.qty || 1);
            const name = document.createElement('div'); name.className = 'cart-left'; name.textContent = it.name;
            const qtyWrap = document.createElement('div'); qtyWrap.style.display='flex'; qtyWrap.style.alignItems='center'; qtyWrap.style.gap='6px';
            const minus = document.createElement('button'); minus.className = 'details-btn'; minus.textContent = '−'; minus.style.minWidth='28px'; minus.setAttribute('data-throttle','400');
            const qlbl = document.createElement('div'); qlbl.textContent = String(qty);
            const plus = document.createElement('button'); plus.className = 'details-btn'; plus.textContent = '+'; plus.style.minWidth='28px'; plus.setAttribute('data-throttle','400');
            qtyWrap.append(minus, qlbl, plus);
            const sum = document.createElement('div'); sum.className = 'cart-right'; sum.textContent = `${(it.price * qty).toLocaleString()} кр.`;
            const del = document.createElement('button'); del.className = 'details-btn'; del.textContent = 'Убрать'; del.style.marginLeft = '8px'; del.setAttribute('data-throttle','600');
            del.addEventListener('click', () => removeFromCart(it.id));
            // handlers
            minus.addEventListener('click', () => {
                const items = readCart();
                const idx = items.findIndex(x => x.id === it.id);
                if (idx >= 0) {
                    items[idx].qty = Math.max(0, (items[idx].qty || 1) - 1);
                    if (items[idx].qty === 0) items.splice(idx,1);
                    writeCart(items); renderCart();
                }
            });
            plus.addEventListener('click', () => {
                const items = readCart();
                const idx = items.findIndex(x => x.id === it.id);
                if (idx >= 0) { items[idx].qty = (items[idx].qty || 1) + 1; writeCart(items); renderCart(); }
            });
            const line = document.createElement('div'); line.className = 'cart-line';
            line.append(name, qtyWrap, sum, del);
            wrap.appendChild(line);
        });
        const totalEl = document.createElement('div'); totalEl.className = 'cart-total'; totalEl.textContent = `Итого: ${total.toLocaleString()} кредитов`;
        const checkout = document.createElement('button'); checkout.className = 'details-btn'; checkout.textContent = 'Оформить заказ'; checkout.style.marginTop='8px'; checkout.setAttribute('data-throttle','1200');
        checkout.addEventListener('click', () => placeOrder());
        pane.innerHTML = '';
        pane.appendChild(wrap);
        pane.appendChild(totalEl);
        pane.appendChild(checkout);
    }
    function initShop() {
        // Подвяжем кнопки «В корзину» и метаданные товаров
        const cards = document.querySelectorAll('#shop-pane-store .store-item');
        const catalogue = [];
        cards.forEach((card, i) => {
            const id = card.getAttribute('data-id') || `item_${i+1}`;
            const name = card.getAttribute('data-name') || (card.querySelector('.store-name')?.textContent || `Товар ${i+1}`);
            // Все цены фиксированы на 300
            const price = 300;
            // Обновим видимую цену на карточке
            const priceEl = card.querySelector('.store-price');
            if (priceEl) priceEl.textContent = `${price.toLocaleString()} кредитов`;
            catalogue.push({ id, name, price });
            const btn = card.querySelector('button');
            if (btn) {
                btn.disabled = false;
                btn.setAttribute('data-throttle','600');
                btn.addEventListener('click', () => addToCart({ id, name, price }));
            }
        });
    }

    // -------------- ЗАКАЗЫ (LocalStorage) --------------
    function readOrders() {
        try { return JSON.parse(localStorage.getItem('shop:orders') || '[]'); } catch(_) { return []; }
    }
    function writeOrders(items) {
        try { localStorage.setItem('shop:orders', JSON.stringify(items)); } catch(_) {}
    }
    async function placeOrder() {
        const cart = readCart();
        if (!cart.length) { try { window.Telegram?.WebApp?.showAlert?.('Корзина пуста'); } catch(_) {}; return; }
        const totalLocal = cart.reduce((s, it) => s + (it.price||0) * (it.qty||1), 0);
        const initData = window.Telegram?.WebApp?.initData || '';
        const items = cart.map(it => ({ code: it.id, qty: it.qty||1 }));
        try {
            if (!initData) throw new Error('no-telegram');
            const form = new FormData();
            form.append('initData', initData);
            form.append('items', JSON.stringify(items));
            const resp = await fetch('/api/shop/checkout', { method: 'POST', body: form });
            if (resp.status === 401) throw new Error('unauthorized');
            const data = await resp.json();
            if (!resp.ok) throw new Error(data && data.error || 'Ошибка оформления');
            writeCart([]);
            renderCart();
            try { window.Telegram?.WebApp?.showAlert?.(`Заказ оформлен\n№${data.order_id}\nСумма: ${Number(data.total||0).toLocaleString()}`); } catch(_) {}
            // Обновим баланс, если сервер вернул его
            try {
                if (typeof data.balance === 'number') {
                    const el = document.getElementById('credits');
                    if (el) el.textContent = Number(data.balance||0).toLocaleString();
                }
            } catch(_) {}
            try { renderAdminOrders(); } catch(_) {}
            return;
        } catch (e) {
            console.warn('Checkout failed (server-only mode)', e);
            // В режиме «только сервер» не создаём локальные заказы и не очищаем корзину
            const msg = (e && e.message) ? e.message : 'Не удалось оформить заказ. Попробуйте ещё раз.';
            try { window.Telegram?.WebApp?.showAlert?.(msg); } catch(_) {}
            // Можно дополнительно показать toast, если доступен
        }
    }
    async function renderAdminOrders() {
        const tbody = document.querySelector('#admin-orders-table tbody');
        if (!tbody) return;
        const initData = window.Telegram?.WebApp?.initData || '';
        try {
            if (!initData) throw new Error('no-telegram');
            const form = new FormData(); form.append('initData', initData);
            const resp = await fetch('/api/admin/orders', { method: 'POST', body: form, headers: { 'If-None-Match': window._adminOrdersETag || '' } });
            if (resp.status === 304) return; // unchanged
            const et = resp.headers.get('ETag'); if (et) window._adminOrdersETag = et;
            const data = await resp.json();
            if (!resp.ok) throw new Error(data && data.error || 'Ошибка загрузки заказов');
            const orders = (data && data.orders) ? data.orders.slice() : [];
            orders.sort((a,b) => String(b.created_at||'').localeCompare(String(a.created_at||'')));
            tbody.innerHTML = '';
            orders.forEach((o, idx) => {
                const tr = document.createElement('tr');
                const when = (()=>{ try { return new Date(o.created_at).toLocaleString(); } catch(_) { return o.created_at || ''; } })();
                const userId = String(o.user_id||'');
                const uname = (o.username||'').replace(/^@+/, '');
                const userLabel = uname ? `@${uname}` : `ID ${userId}`;
                const userHref = uname ? `https://t.me/${encodeURIComponent(uname)}` : `https://t.me/user?id=${encodeURIComponent(userId)}`;
                const items = String(o.items_preview || '');
                const qty = Number(o.items_qty || 0);
                // Статус + селект для изменения
        const statusCell = (() => {
                    const td = document.createElement('td');
                    const sel = document.createElement('select');
                    sel.className = 'order-status-select';
                    const opts = [
            { v: 'new', t: 'Новый' },
            { v: 'paid', t: 'Оплачен' },
            { v: 'cancelled', t: 'Отменён' }
                    ];
                    opts.forEach(opt => { const oEl = document.createElement('option'); oEl.value = opt.v; oEl.textContent = opt.t; if ((o.status||'new')===opt.v) oEl.selected = true; sel.appendChild(oEl); });
                    sel.addEventListener('change', async () => {
                        try {
                            sel.disabled = true;
                            const form = new FormData(); form.append('initData', (window.Telegram?.WebApp?.initData || '')); form.append('status', sel.value);
                            const r = await fetch(`/api/admin/orders/${encodeURIComponent(o.id)}/status`, { method: 'POST', body: form });
                            const d = await r.json().catch(()=>({}));
                            if (!r.ok) { throw new Error(d && (d.message||d.error) || 'Ошибка сохранения'); }
                            // ok
                        } catch (e) {
                            console.warn('update status failed', e);
                            try { window.Telegram?.WebApp?.showAlert?.('Не удалось обновить статус'); } catch(_) {}
                        } finally { sel.disabled = false; }
                    });
                    td.appendChild(sel); return td;
                })();
                tr.innerHTML = `<td>${escapeHtml(String(o.id||String(idx+1)))}</td>`+
                               `<td><a href="${userHref}" target="_blank" rel="noopener noreferrer" class="user-link">${escapeHtml(userLabel)}</a></td>`+
                               `<td>${escapeHtml(items)}</td>`+
                               `<td>${qty}</td>`+
                               `<td>${Number(o.total||0).toLocaleString()}</td>`+
                               `<td>${when}</td>`;
                tr.appendChild(statusCell);
                tbody.appendChild(tr);
            });
            const upd = document.getElementById('admin-orders-updated');
            if (upd) { try { upd.textContent = `Обновлено: ${new Date().toLocaleString()}`; } catch(_) {} }
        } catch (e) {
            console.warn('Admin orders fallback to local', e);
            const orders = readOrders().slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
            tbody.innerHTML = '';
            orders.forEach((o, idx) => {
                const tr = document.createElement('tr');
                const when = (()=>{ try { return new Date(o.created_at).toLocaleString(); } catch(_) { return o.created_at || ''; } })();
                // Сводим локальные позиции в preview и qty
                const itemsArr = Array.isArray(o.items) ? o.items : [];
                const itemsPreview = itemsArr.map(it => `${(it.name||it.id||'Товар')}×${Number(it.qty||it.quantity||1)}`).join(', ');
                const itemsQty = itemsArr.reduce((s,it)=> s + Number(it.qty||it.quantity||1), 0);
                const userId = String(o.user_id||'');
                const userLabel = `ID ${userId}`;
                tr.innerHTML = `<td>${escapeHtml(o.id||String(idx+1))}</td>`+
                               `<td><a href="https://t.me/user?id=${encodeURIComponent(userId)}" target="_blank" rel="noopener noreferrer" class="user-link">${escapeHtml(userLabel)}</a></td>`+
                               `<td>${escapeHtml(itemsPreview)}</td>`+
                               `<td>${itemsQty}</td>`+
                               `<td>${Number(o.total||0).toLocaleString()}</td>`+
                               `<td>${when}</td>`;
                tbody.appendChild(tr);
            });
            const upd = document.getElementById('admin-orders-updated');
            if (upd) { try { upd.textContent = `Обновлено: ${new Date().toLocaleString()}`; } catch(_) {} }
        }
    }

    // ---------- Мои заказы ----------
    async function renderMyOrders() {
        const pane = document.getElementById('shop-pane-myorders');
        if (!pane) return;
        pane.innerHTML = '<div style="padding:12px; color: var(--gray);">Загрузка...</div>';
        const initData = window.Telegram?.WebApp?.initData || '';
        try {
            if (!initData) throw new Error('no-telegram');
            const form = new FormData(); form.append('initData', initData);
            const resp = await fetch('/api/shop/my-orders', { method: 'POST', body: form });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data && data.error || 'Ошибка загрузки');
            const orders = (data && data.orders) ? data.orders.slice() : [];
            if (!orders.length) { pane.innerHTML = '<div style="padding:12px; color: var(--gray);">Заказов пока нет.</div>'; return; }
            const wrap = document.createElement('div');
            wrap.className = 'cart-list';
            const statusRu = (s) => ({ new: 'Новый', paid: 'Оплачен', cancelled: 'Отменён' }[s] || s);
            orders.forEach(o => {
                const line = document.createElement('div'); line.className = 'cart-line';
                const id = document.createElement('div'); id.className = 'cart-left'; id.textContent = `Заказ №${o.id}`;
                const sum = document.createElement('div'); sum.className = 'cart-right'; sum.textContent = `${Number(o.total||0).toLocaleString()} кр.`;
                const when = document.createElement('div'); when.style.flex='1'; when.style.textAlign='center'; when.style.color='var(--gray)'; when.textContent = (()=>{ try { return new Date(o.created_at).toLocaleString(); } catch(_) { return o.created_at || ''; } })();
                // Статус
                const st = document.createElement('div'); st.style.minWidth = '84px'; st.style.textAlign = 'right'; st.textContent = statusRu(o.status||'new');
                line.append(id, when, sum, st);
                wrap.appendChild(line);
            });
            pane.innerHTML = '';
            pane.appendChild(wrap);
        } catch (e) {
            console.warn('My orders fallback to local', e);
            const orders = readOrders().slice().sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
            if (!orders.length) { pane.innerHTML = '<div style="padding:12px; color: var(--gray);">Заказов пока нет.</div>'; return; }
            const wrap = document.createElement('div');
            wrap.className = 'cart-list';
            orders.forEach(o => {
                const line = document.createElement('div'); line.className = 'cart-line';
                const id = document.createElement('div'); id.className = 'cart-left'; id.textContent = `${o.id}`;
                const sum = document.createElement('div'); sum.className = 'cart-right'; sum.textContent = `${Number(o.total||0).toLocaleString()} кр.`;
                const when = document.createElement('div'); when.style.flex='1'; when.style.textAlign='center'; when.style.color='var(--gray)'; when.textContent = (()=>{ try { return new Date(o.created_at).toLocaleString(); } catch(_) { return o.created_at || ''; } })();
                line.append(id, when, sum);
                wrap.appendChild(line);
            });
            pane.innerHTML = '';
            pane.appendChild(wrap);
        }
    }

    // -------------- Бейдж корзины --------------
    function updateCartBadge() {
        try {
            const navItem = document.querySelector('.nav-item[data-tab="shop"]');
            if (!navItem) return;
            const cart = readCart();
            const count = cart.reduce((s, it) => s + (it.qty||1), 0);
            // Fallback: update label text for accessibility
            const label = navItem.querySelector('.nav-label');
            if (label) label.textContent = count > 0 ? `Магазин (${count})` : 'Магазин';
            // Badge element
            let badge = navItem.querySelector('.nav-badge');
            if (count > 0) {
                if (!badge) { badge = document.createElement('div'); badge.className = 'nav-badge'; navItem.appendChild(badge); }
                badge.textContent = String(count);
            } else if (badge) {
                badge.remove();
            }
        } catch(_) {}
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
                        const lbl = document.createElement('span'); lbl.textContent = 'В ЭФИРЕ';
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

                    // Блок голосования под логотипами
                    const voteWrap = document.createElement('div');
                    voteWrap.className = 'match-vote';
                    const mkBar = (label) => {
                        const row = document.createElement('div'); row.className = 'vote-row';
                        const lbl = document.createElement('span'); lbl.className = 'vote-label'; lbl.textContent = label;
                        const bar = document.createElement('div'); bar.className = 'vote-bar';
                        const fill = document.createElement('div'); fill.className = 'vote-fill'; bar.appendChild(fill);
                        const pct = document.createElement('span'); pct.className = 'vote-pct'; pct.textContent = '—%';
                        row.append(lbl, bar, pct); return { row, fill, pct };
                    };
                    const homeBar = mkBar('П1');
                    const drawBar = mkBar('X');
                    const awayBar = mkBar('П2');
                    voteWrap.append(homeBar.row, drawBar.row, awayBar.row);
                    card.appendChild(voteWrap);

                    const updateAgg = (agg) => {
                        const h = Number(agg?.home||0), d = Number(agg?.draw||0), a = Number(agg?.away||0);
                        const sum = Math.max(1, h+d+a);
                        const ph = Math.round(h*100/sum), pd = Math.round(d*100/sum), pa = Math.round(a*100/sum);
                        homeBar.fill.style.width = ph+'%'; homeBar.pct.textContent = ph+'%';
                        drawBar.fill.style.width = pd+'%'; drawBar.pct.textContent = pd+'%';
                        awayBar.fill.style.width = pa+'%'; awayBar.pct.textContent = pa+'%';
                    };
                    try {
                        const params = new URLSearchParams({ home: m.home||'', away: m.away||'', date: (m.date||'').slice(0,10) });
                        fetch(`/api/vote/match-aggregates?${params.toString()}`).then(r=>r.json()).then(updateAgg).catch(()=>{});
                    } catch(_) {}

                    // Кнопки голосования
                    const voteBtns = document.createElement('div'); voteBtns.className = 'vote-btns';
                    const mkBtn = (code, text) => { const b = document.createElement('button'); b.className = 'details-btn'; b.textContent = text; b.addEventListener('click', async ()=>{
                        try {
                            const tg = window.Telegram?.WebApp || null; const fd = new FormData();
                            fd.append('initData', tg?.initData || ''); fd.append('home', m.home||''); fd.append('away', m.away||''); fd.append('date', (m.date||'').slice(0,10)); fd.append('choice', code);
                            const r = await fetch('/api/vote/match', { method:'POST', body: fd }); const d = await r.json().catch(()=>({})); if (!r.ok) { throw new Error(d?.error||'Ошибка'); }
                            // перезагрузим агрегаты
                            const params = new URLSearchParams({ home: m.home||'', away: m.away||'', date: (m.date||'').slice(0,10) });
                            const agg = await fetch(`/api/vote/match-aggregates?${params.toString()}`).then(x=>x.json()).catch(()=>null);
                            if (agg) updateAgg(agg);
                        } catch(err) { try { window.Telegram?.WebApp?.showAlert?.('Не удалось сохранить голос'); } catch(_) {} }
                    }); return b; };
                    voteBtns.append(mkBtn('home','За П1'), mkBtn('draw','За X'), mkBtn('away','За П2'));
                    card.appendChild(voteBtns);

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

                    // Подсветка победителя отключена по требованию

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
        if (animate) playLeagueTransition('UFO');
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

    function selectBLBLeague(animate=false) {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!ufoTabs || !ufoContent || !blbBlock) return;
        if (animate) playLeagueTransition('BLB');
        setActiveLeague('BLB');
        if (overlay) overlay.style.display = 'none';
        ufoTabs.style.display = 'none';
        ufoContent.style.display = 'none';
        blbBlock.style.display = '';
        initBLBSubtabs();
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
                // Используем золотисто-черную палитру BLB
                layer.style.background = 'linear-gradient(135deg, #0b0b0b, #000000)';
                // Фаза 1: заливка снизу вверх (1s)
                layer.classList.add('lt-fill-bottom');
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
        if (nav) { nav.style.transition = 'transform .12s ease, opacity .12s ease'; nav.style.transform = 'translateY(100%)'; nav.style.opacity = '0'; }
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
        if (nav) { nav.style.transform = 'translateY(0)'; nav.style.opacity = '1'; nav.style.transition = ''; }
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

    // Подсказка: стрелка к нижнему меню (вкладка ЛИГИ/НЛО) с текстом «щёлкни два раза»
    function showLeagueHint() {
        try {
            // Если уже показана — не дублируем
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
            // Контейнер с текстом над стрелкой
            const label = document.createElement('div');
            label.textContent = 'щёлкни два раза';
            label.style.position = 'absolute';
            label.style.left = '50%';
            label.style.transform = 'translateX(-50%)';
            label.style.bottom = '28px';
            label.style.fontSize = '11px';
            label.style.fontWeight = '800';
            label.style.color = '#fff';
            label.style.whiteSpace = 'nowrap';
            label.style.textShadow = '0 1px 2px rgba(0,0,0,.6)';
            // Стрелка
            const arrow = document.createElement('div');
            arrow.style.width = '0';
            arrow.style.height = '0';
            arrow.style.borderLeft = '6px solid transparent';
            arrow.style.borderRight = '6px solid transparent';
            arrow.style.borderTop = '10px solid #fff';
            arrow.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,.6))';
            arrow.style.position = 'absolute';
            arrow.style.left = '50%';
            arrow.style.transform = 'translateX(-50%)';
            arrow.style.bottom = '14px';
            tip.appendChild(label);
            tip.appendChild(arrow);
            document.body.appendChild(tip);
            // Позиционирование по центру иконки лиги
            const centerX = r.left + r.width / 2;
            tip.style.left = `${Math.round(centerX)}px`;
            tip.style.bottom = `${Math.round((window.innerHeight - rn.top) + 6)}px`;
            // Убрать подсказку по любому клику/тапу по нижнему меню
            const cleanup = () => { try { tip.remove(); } catch(_) {} document.removeEventListener('click', onDocClick, true); };
            const onDocClick = (e) => { if (e.target.closest('nav.nav')) cleanup(); };
            document.addEventListener('click', onDocClick, true);
            setTimeout(cleanup, 6000);
        } catch(_) {}
    }

    // ---------- MATCH DETAILS SCREEN (in-app, not modal) ----------
    function openMatchScreen(match, details) {
    const schedulePane = document.getElementById('ufo-schedule');
        const mdPane = document.getElementById('ufo-match-details');
        if (!schedulePane || !mdPane) return;
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
    // Вкладка «Трансляция»: создаём/находим; показываем, если сервер говорит, что доступна (подтверждена админом и по времени)
        let streamPane = document.getElementById('md-pane-stream');
        if (!streamPane) {
            streamPane = document.createElement('div');
            streamPane.id = 'md-pane-stream';
            streamPane.className = 'md-pane';
            streamPane.style.display = 'none';
            mdPane.querySelector('.modal-body')?.appendChild(streamPane);
        }
        // Очистка плеера при каждом открытии экрана (ленивая вставка при показе)
        streamPane.innerHTML = '<div class="stream-wrap"><div class="stream-skeleton">Трансляция будет доступна здесь</div></div>';
        // Спроси сервер, можно ли показывать вкладку (подтверждено + за N минут до матча)
        try {
            const dateStr = (match?.datetime || match?.date || '').toString().slice(0,10);
            const url = `/api/streams/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}&date=${encodeURIComponent(dateStr)}&window=10`;
            fetch(url).then(r=>r.json()).then(ans => {
                const existing = subtabs?.querySelector('[data-mdtab="stream"]');
                if (ans?.available) {
                    if (!existing) {
                        const tab = document.createElement('div'); tab.className='subtab-item'; tab.setAttribute('data-mdtab','stream'); tab.textContent='Трансляция';
                        subtabs.appendChild(tab);
                    }
                    streamPane.__streamInfo = ans;
                } else if (existing) {
                    existing.remove();
                }
            }).catch(()=>{});
        } catch(_) {}

    // События будут отображаться внутри вкладок составов

        // по умолчанию активируем «Команда 1»
        mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
        homePane.style.display = '';
        awayPane.style.display = 'none';
    specialsPane.style.display = 'none';
    streamPane.style.display = 'none';
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
            const iconImg = (srcHint) => { const img = document.createElement('img'); img.style.width='18px'; img.style.height='18px'; img.style.objectFit='contain'; img.alt='';
                const candidates = [srcHint, '/static/img/icons/photo.png', '/static/img/placeholderlogo.png'].filter(Boolean);
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
                        const srcHint = (type==='yellow')?'/static/img/icons/yellow.png':(type==='red')?'/static/img/icons/red.png':(type==='assist')?'/static/img/shop/boots.png':'/static/img/shop/ball.png';
                        const candidates=[srcHint, '/static/img/icons/photo.png', '/static/img/placeholderlogo.png'];
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
                const srcHint = (type==='yellow')?'/static/img/icons/yellow.png':(type==='red')?'/static/img/icons/red.png':(type==='assist')?'/static/img/shop/boots.png':'/static/img/shop/ball.png';
                const candidates=[srcHint, '/static/img/icons/photo.png', '/static/img/placeholderlogo.png'];
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
        try {
            fetch(`/api/match/status/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
                .then(r=>r.json()).then(s => {
                    if (s?.status === 'live') {
                        const live = document.createElement('span'); live.className = 'live-badge';
                        const dot = document.createElement('span'); dot.className = 'live-dot';
                        const lbl = document.createElement('span'); lbl.textContent = 'В ЭФИРЕ';
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
    if (key === 'home') { homePane.style.display = ''; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; streamPane.style.display = 'none'; }
    else if (key === 'away') { homePane.style.display = 'none'; awayPane.style.display = ''; specialsPane.style.display = 'none'; streamPane.style.display = 'none'; }
                else if (key === 'specials') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = '';
                    // отрисуем спецпанель внутри specialsPane
                    renderSpecialsPane(specialsPane, match);
                    streamPane.style.display = 'none';
                } else if (key === 'stream') {
                    homePane.style.display = 'none'; awayPane.style.display = 'none'; specialsPane.style.display = 'none'; streamPane.style.display = '';
                    // Лениво вставляем VK iframe только при первом показе
                    if (!streamPane.__inited) {
                        try {
                            const st = streamPane.__streamInfo || null;
                            if (st && (st.vkVideoId || st.vkPostUrl)) {
                                const host = document.createElement('div'); host.className = 'stream-wrap';
                                const ratio = document.createElement('div'); ratio.className = 'stream-aspect';
                                // Формирование src. Вариант 1: video id типа "-12345_67890"; Вариант 2: пост.
                                let src = '';
                                if (st.vkVideoId) {
                                    // embed-плеер VK
                                    src = `https://vk.com/video_ext.php?oid=${encodeURIComponent(st.vkVideoId.split('_')[0])}&id=${encodeURIComponent(st.vkVideoId.split('_')[1])}&hd=2&autoplay=${st.autoplay?1:0}`;
                                } else if (st.vkPostUrl) {
                                    // На случай ссылки на пост с видео — VK обычно редиректит на плеер
                                    src = st.vkPostUrl;
                                }
                                const ifr = document.createElement('iframe');
                                ifr.src = src;
                                // Разрешаем полноэкранный режим и управление медиа
                                ifr.setAttribute('allowfullscreen','true');
                                ifr.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; screen-wake-lock;';
                                ifr.referrerPolicy = 'strict-origin-when-cross-origin';
                                ratio.appendChild(ifr); host.appendChild(ratio); streamPane.innerHTML=''; streamPane.appendChild(host);
                                streamPane.__inited = true;
                                // Инициализируем комментарии под плеером
                                initStreamComments(streamPane, match);
                            } else {
                                streamPane.querySelector('.stream-skeleton')?.replaceChildren(document.createTextNode('Трансляция недоступна'));
                            }
                        } catch(_) {}
                    } else {
                        // Если уже инициализирован — убедимся, что поллинг комментариев активен
                        if (typeof streamPane.__startCommentsPoll === 'function') {
                            try { streamPane.__startCommentsPoll(); } catch(_) {}
                        }
                    }
                    }
            };
        });

        // кнопка Назад
        const back = document.getElementById('match-back');
        if (back) back.onclick = () => {
            // очистка
            homePane.innerHTML = '';
            awayPane.innerHTML = '';
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
