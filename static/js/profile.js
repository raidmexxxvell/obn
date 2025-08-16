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
        const modal = document.getElementById('name-modal');
        if (!modal) {
            // fallback на prompt если по какой-то причине модалки нет
            const newName = prompt('Введите новое имя (внимание: изменить имя можно только 1 раз):', elements.userName.textContent);
            if (!newName || !newName.trim() || newName === elements.userName.textContent) return;
            if (!confirm('Подтвердите смену имени. Изменить можно только один раз. Продолжить?')) return;
            return submitNameChange(newName.trim());
        }

        const input = document.getElementById('name-input');
        const ok = document.getElementById('name-ok');
        const cancel = document.getElementById('name-cancel');
        const confirmChk = document.getElementById('name-confirm');

        input.value = elements.userName.textContent || '';
        confirmChk.checked = false;
        ok.disabled = true;
        modal.style.display = '';

        const updateState = () => {
            const v = (input.value || '').trim();
            ok.disabled = !(v && v !== elements.userName.textContent && confirmChk.checked);
        };
        input.oninput = updateState; confirmChk.onchange = updateState; updateState();

        const close = () => { modal.style.display = 'none'; };
        const onCancel = () => { close(); cleanup(); };
        const onOk = () => {
            const v = (input.value || '').trim();
            if (!v || v === elements.userName.textContent) return;
            close(); cleanup();
            submitNameChange(v);
        };
        const onBackdrop = (e) => { if (e.target?.dataset?.close) { onCancel(); } };

        const backdrop = modal.querySelector('.modal-backdrop');
        backdrop && (backdrop.onclick = onBackdrop);
        cancel && (cancel.onclick = onCancel);
        ok && (ok.onclick = onOk);

        function cleanup() {
            if (backdrop) backdrop.onclick = null;
            if (cancel) cancel.onclick = null;
            if (ok) ok.onclick = null;
        }
    }

    function submitNameChange(newName) {
        const original = elements.userName.textContent;
        elements.userName.textContent = 'Сохранение...';
        if (!tg || !tg.initDataUnsafe?.user) { elements.userName.textContent = original; return; }

        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        formData.append('new_name', newName);

        fetch('/api/update-name', { method:'POST', body: formData })
            .then(async res => { const d = await res.json().catch(()=>({})); if (!res.ok) { const msg = d?.message || 'Не удалось изменить имя'; throw new Error(msg); } return d; })
            .then(data => { if (elements.userName) elements.userName.textContent = data.display_name; })
            .catch(err => {
                console.error('update name err', err);
                if (elements.userName) elements.userName.textContent = original;
                const m = err?.message || 'Не удалось изменить имя';
                try { tg?.showAlert?.(m); } catch (_) { try { alert(m); } catch(_){} }
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
                // Обработка двойного тапа для НЛО
                if (tab === 'ufo') {
                    const now = Date.now();
                    if (now - _lastUfoTap < 350) {
                        // двойной тап: раскрыть левую панель у нижнего меню
                        try { updateNavLeaguePanel(); } catch(_) {}
                        bottomNav?.classList.toggle('nav--show-league');
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
            if (act === 'BLB') selectBLBLeague(false); else selectUFOLeague(true, false);
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
                    try { updateNavLeaguePanel(); } catch(_) {}
                    bottomNav?.classList.toggle('nav--show-league');
                });
                // Явная обработка touchend для надёжного двойного тапа
                let _ufoLastTouch = 0;
                item.addEventListener('touchend', (e) => {
                    const now = Date.now();
                    if (now - _ufoLastTouch < 350) {
                        e.preventDefault(); e.stopPropagation();
                        try { updateNavLeaguePanel(); } catch(_) {}
                        bottomNav?.classList.toggle('nav--show-league');
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
            const act = getActiveLeague();
            if (act === 'BLB') selectUFOLeague(false, true); else selectBLBLeague(true);
            bottomNav?.classList.remove('nav--show-league');
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
                tr.innerHTML = `<td>${escapeHtml(String(o.id||String(idx+1)))}</td>`+
                               `<td><a href="${userHref}" target="_blank" rel="noopener noreferrer" class="user-link">${escapeHtml(userLabel)}</a></td>`+
                               `<td>${escapeHtml(items)}</td>`+
                               `<td>${qty}</td>`+
                               `<td>${Number(o.total||0).toLocaleString()}</td>`+
                               `<td>${when}</td>`;
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
            orders.forEach(o => {
                const line = document.createElement('div'); line.className = 'cart-line';
                const id = document.createElement('div'); id.className = 'cart-left'; id.textContent = `Заказ №${o.id}`;
                const sum = document.createElement('div'); sum.className = 'cart-right'; sum.textContent = `${Number(o.total||0).toLocaleString()} кр.`;
                const when = document.createElement('div'); when.style.flex='1'; when.style.textAlign='center'; when.style.color='var(--gray)'; when.textContent = (()=>{ try { return new Date(o.created_at).toLocaleString(); } catch(_) { return o.created_at || ''; } })();
                line.append(id, when, sum);
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
            let i = 0;
            const next = () => { if (i >= candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
            next();
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
