// static/js/profile.js
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

    // Управление заставкой вынесено в static/js/splash.js

    // --- Антиспам защиты ---
    // Делегированный троттлинг кликов по элементам с data-throttle (в миллисекундах)
    const _clickThrottle = new WeakMap();
    document.addEventListener('click', (e) => {
        const el = e.target.closest('[data-throttle]');
        if (!el) return;
        const ms = parseInt(el.getAttribute('data-throttle'), 10) || 800;
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
            .then(data => { renderUserProfile(data); renderCheckinSection(data); return data; })
            .catch(err => { console.error('fetchUserData', err); showError('Не удалось загрузить данные'); throw err; });
    }

    function fetchAchievements() {
        if (!tg || !tg.initDataUnsafe?.user) {
            renderAchievements([{ tier:1, name:'Бронза', days:7, icon:'bronze', unlocked:false }]);
            return Promise.resolve();
        }
    const formData = new FormData();
    formData.append('initData', tg.initData || '');

        return fetch('/api/achievements', { method: 'POST', body: formData })
            .then(res => res.json())
            .then(data => renderAchievements(data.achievements || []))
            .catch(err => { console.error('fetchAchievements', err); renderAchievements([{ tier:1, name:'Бронза', days:7, icon:'bronze', unlocked:false }]); });
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

        achievements.forEach(a => {
            const card = document.createElement('div');
            card.className = `achievement-card ${a.unlocked ? '' : 'locked'}`;
            const icon = document.createElement('img');
            setAchievementIcon(icon, a);
            icon.alt = a.name || 'badge';
            const name = document.createElement('div'); name.className='badge-name'; name.textContent = a.name;
            const req = document.createElement('div'); req.className='badge-requirements';
            if (a.group === 'streak') {
                req.textContent = `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${a.value}/${a.target} дней подряд`;
            } else if (a.group === 'credits') {
                req.textContent = `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${(a.value||0).toLocaleString()}/${(a.target||0).toLocaleString()} кредитов`;
            } else if (a.group === 'level') {
                req.textContent = `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${a.value}/${a.target} уровень`;
            } else if (a.group === 'invited') {
                req.textContent = `${a.unlocked ? 'Открыто' : 'Прогресс'}: ${a.value}/${a.target} приглашений`;
            } else {
                req.textContent = '';
            }
            const progressWrap = document.createElement('div');
            progressWrap.className = 'achv-progress-container';
            const progressBar = document.createElement('div');
            progressBar.className = 'achv-progress';
            const pct = Math.max(0, Math.min(100, Math.floor((Math.min(a.value||0, a.target||1) / (a.target||1)) * 100)));
            progressBar.style.width = `${pct}%`;
            progressWrap.appendChild(progressBar);

            card.append(icon, name, req, progressWrap);
            elements.badgesContainer.appendChild(card);
        });
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
        navItems.forEach(item => {
            item.setAttribute('data-throttle', '600');
            item.addEventListener('click', () => {
                const tab = item.getAttribute('data-tab');
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
        const prof = document.getElementById('tab-profile');
        const ufo = document.getElementById('tab-ufo');
        const preds = document.getElementById('tab-predictions');
        const lead = document.getElementById('tab-leaderboard');
        [prof, ufo, preds, lead].forEach(el => { if (el) el.style.display = 'none'; });
        if (tab === 'profile' && prof) prof.style.display = '';
        if (tab === 'ufo' && ufo) { ufo.style.display = ''; loadLeagueTable(); }
        if (tab === 'predictions' && preds) preds.style.display = '';
        if (tab === 'leaderboard' && lead) lead.style.display = '';
                // прокрутка к верху при смене вкладки
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        });

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

    // подвкладки Профиля (Достижения/Список/Реферал)
        const pTabs = document.querySelectorAll('#profile-subtabs .subtab-item');
        const pMap = {
            badges: document.getElementById('profile-pane-badges'),
        catalog: document.getElementById('profile-pane-catalog'),
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
            if (key === 'catalog') loadAchievementsCatalog();
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
                const d = new Date(data.updated_at);
                updatedText.textContent = `Обновлено: ${d.toLocaleString()}`;
            }
            // показать кнопку обновления для админа
            const refreshBtn = document.getElementById('league-refresh-btn');
            const adminId = document.body.getAttribute('data-admin');
            const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
            if (updatedWrap && refreshBtn && adminId && currentId && String(adminId) === currentId) {
                refreshBtn.style.display = '';
                refreshBtn.onclick = () => {
                    const fd = new FormData();
                    fd.append('initData', tg?.initData || '');
                    fetch('/api/league-table/refresh', { method: 'POST', body: fd })
                        .then(r => r.json())
                        .then(resp => {
                            if (resp?.updated_at && updatedText) {
                                const d2 = new Date(resp.updated_at);
                                updatedText.textContent = `Обновлено: ${d2.toLocaleString()}`;
                            }
                            setTimeout(loadLeagueTable, 100);
                        })
                        .catch(err => console.error('league refresh error', err));
                };
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

    // --------- РАСПИСАНИЕ ---------
    let _scheduleLoading = false;
    function loadSchedule() {
        if (_scheduleLoading) return;
        const pane = document.getElementById('ufo-schedule');
        if (!pane) return;
        _scheduleLoading = true;
        pane.innerHTML = '<div class="schedule-loading">Загрузка расписания...</div>';

        // Хелпер: загрузка логотипа команды с фолбэками по названию
        const loadTeamLogo = (imgEl, teamName) => {
            const base = '/static/img/team-logos/';
            const name = (teamName || '').trim();
            const candidates = [];
            if (name) {
                // 1) точное совпадение: "Название команды.png"
                candidates.push(base + encodeURIComponent(name + '.png'));
                // 2) нормализованное: нижний регистр, без пробелов
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
                candidates.push(base + encodeURIComponent(norm + '.png'));
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
        fetch('/api/schedule').then(r => r.json()).then(data => {
            pane.innerHTML = '';
            const tours = data.tours || [];
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
                    const hName = document.createElement('div'); hName.className = 'team-name'; hName.textContent = m.home || '';
                    home.append(hImg, hName);
                    const score = document.createElement('div'); score.className = 'score'; score.textContent = 'VS';
                    const away = document.createElement('div'); away.className = 'team away';
                    const aImg = document.createElement('img'); aImg.className = 'logo'; aImg.alt = m.away || '';
                    loadTeamLogo(aImg, m.away || '');
                    const aName = document.createElement('div'); aName.className = 'team-name'; aName.textContent = m.away || '';
                    away.append(aImg, aName);
                    center.append(home, score, away);
                    card.appendChild(center);

                    const footer = document.createElement('div');
                    footer.className = 'match-footer';
                    const btn = document.createElement('button');
                    btn.className = 'details-btn';
                    btn.textContent = 'Детали';
                    btn.setAttribute('data-throttle', '800');
                    // При клике: используем кэш, затем при необходимости валидируем и открываем детальный экран
                    btn.addEventListener('click', () => {
                        const original = btn.textContent;
                        btn.disabled = true;
                        btn.textContent = 'Загрузка контента...';
                        const params = new URLSearchParams({ home: m.home || '', away: m.away || '' });
                        const cacheKey = `md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`;
                        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
                        const fetchWithETag = (etag) => fetch(`/api/match-details?${params.toString()}`, { headers: etag ? { 'If-None-Match': etag } : {} })
                            .then(async r => {
                                if (r.status === 304 && cached) return cached; // валидный кэш
                                const data = await r.json();
                                const version = data.version || r.headers.get('ETag') || null;
                                const toStore = { data, version, ts: Date.now() };
                                try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_) {}
                                return toStore;
                            });

                        const go = (store) => {
                            openMatchScreen({ home: m.home, away: m.away, date: m.date, time: m.time }, store?.data || store);
                            btn.disabled = false; btn.textContent = original;
                        };

                        const FRESH_TTL = 10 * 60 * 1000; // 10 минут
                        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) {
                            // достаточно свежо — используем сразу без сети
                            go(cached);
                        } else if (cached && cached.version) {
                            // не свежее — мягкая валидация по ETag
                            fetchWithETag(cached.version).then(go).catch(() => { go(cached); });
                        } else if (cached) {
                            // старый формат без версии
                            go(cached);
                        } else {
                            fetchWithETag(null).then(go).catch(err => {
                                console.error('match details load error', err);
                                try { window.Telegram?.WebApp?.showAlert?.('Не удалось загрузить данные матча'); } catch(_) {}
                                btn.disabled = false; btn.textContent = original;
                            });
                        }
                    });
                    footer.appendChild(btn);
                    // Админ-кнопка «Спецсобытия» (пенальти/красная)
                    try {
                        const adminId = document.body.getAttribute('data-admin');
                        const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
                        if (adminId && currentId && String(adminId) === currentId) {
                            const spBtn = document.createElement('button'); spBtn.className = 'details-btn'; spBtn.textContent = 'Спецсобытия'; spBtn.style.marginLeft = '8px';
                            spBtn.addEventListener('click', () => openSpecialsPanel(m));
                            footer.appendChild(spBtn);
                        }
                    } catch(_) {}
                    card.appendChild(footer);

                    tourEl.appendChild(card);
                });

                pane.appendChild(tourEl);
            });
            if (!tours.length) {
                pane.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>';
            }
    }).catch(err => {
            console.error('schedule load error', err);
            pane.innerHTML = '<div class="schedule-error">Не удалось загрузить расписание</div>';
    }).finally(() => { _scheduleLoading = false; });
    }

    // --------- РЕЗУЛЬТАТЫ ---------
    let _resultsLoading = false;
    function loadResults() {
        if (_resultsLoading) return;
        const pane = document.getElementById('ufo-results');
        if (!pane) return;
        _resultsLoading = true;
        pane.innerHTML = '<div class="schedule-loading">Загрузка результатов...</div>';

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
        const CACHE_KEY = 'results:list';
        const FRESH_TTL = 10 * 60 * 1000; // 10 минут
        const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
        const writeCache = (obj) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch(_) {} };
        const cached = readCache();

        const fetchWithETag = (etag) => fetch('/api/results', { headers: etag ? { 'If-None-Match': etag } : {} })
            .then(async r => {
                if (r.status === 304 && cached) return cached; // валидный кэш
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
                writeCache(store);
                return store;
            });

        const renderResults = (data) => {
            pane.innerHTML = '';
            const all = data?.results || [];
            if (!all.length) {
                pane.innerHTML = '<div class="schedule-empty">Нет прошедших матчей</div>';
                return;
            }
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
                    const hName = document.createElement('div'); hName.className = 'team-name'; hName.textContent = m.home || '';
                    home.append(hImg, hName);
                    const score = document.createElement('div'); score.className = 'score';
                    const sH = (m.score_home || '').toString().trim(); const sA = (m.score_away || '').toString().trim();
                    score.textContent = (sH && sA) ? `${sH} : ${sA}` : '— : —';
                    const away = document.createElement('div'); away.className = 'team away';
                    const aImg = document.createElement('img'); aImg.className = 'logo'; aImg.alt = m.away || '';
                    loadTeamLogo(aImg, m.away || '');
                    const aName = document.createElement('div'); aName.className = 'team-name'; aName.textContent = m.away || '';
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
        };

        const go = (store) => { renderResults(store?.data || store); _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady(); };

        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) {
            go(cached);
        } else if (cached && cached.version) {
            fetchWithETag(cached.version).then(go).catch(() => go(cached));
        } else if (cached) {
            go(cached);
        } else {
            fetchWithETag(null).then(go).catch(err => {
                console.error('results load error', err);
                pane.innerHTML = '<div class="schedule-error">Не удалось загрузить результаты</div>';
                _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady();
            });
        }
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
        // Расписание
        fetch('/api/schedule', { headers: { 'Cache-Control': 'no-cache' } })
            .then(r => r.json()).then(() => { _schedulePreloaded = true; trySignalAllReady(); })
            .catch(() => { _schedulePreloaded = true; trySignalAllReady(); });
        // Результаты (не блокируем)
        fetch('/api/results', { headers: { 'Cache-Control': 'no-cache' } })
            .then(r => r.json()).then(() => { _resultsPreloaded = true; trySignalAllReady(); })
            .catch(() => { _resultsPreloaded = true; trySignalAllReady(); });

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
                candidates.push(base + encodeURIComponent(name + '.png'));
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
                candidates.push(base + encodeURIComponent(norm + '.png'));
            }
            candidates.push(base + 'default.png');
            let i = 0;
            const next = () => { if (i >= candidates.length) return; imgEl.onerror = () => { i++; next(); }; imgEl.src = candidates[i]; };
            next();
        };

        hName.textContent = match.home || '';
        aName.textContent = match.away || '';
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

        // вкладки
        mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((el) => el.classList.remove('active'));
        mdPane.querySelector('.modal-subtabs .subtab-item[data-mdtab="home"]').classList.add('active');
        homePane.style.display = '';
        awayPane.style.display = 'none';

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
        if (details && details.rosters) {
            renderRoster(homePane, details.rosters.home);
            renderRoster(awayPane, details.rosters.away);
        } else {
            homePane.textContent = 'Нет данных';
            awayPane.textContent = 'Нет данных';
        }

        // переключение вкладок
        mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((btn) => {
            btn.onclick = () => {
                mdPane.querySelectorAll('.modal-subtabs .subtab-item').forEach((x)=>x.classList.remove('active'));
                btn.classList.add('active');
                const key = btn.getAttribute('data-mdtab');
                if (key === 'home') { homePane.style.display = ''; awayPane.style.display = 'none'; }
                else { homePane.style.display = 'none'; awayPane.style.display = ''; }
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

    // Панель админа для фиксации пенальти/красной
    function openSpecialsPanel(m) {
        const tg = window.Telegram?.WebApp || null;
        const host = document.createElement('div');
        host.className = 'admin-panel';
        host.style.marginTop = '8px'; host.style.padding = '8px'; host.style.border = '1px solid rgba(255,255,255,0.1)'; host.style.borderRadius = '10px';
        const title = document.createElement('div'); title.style.marginBottom = '6px'; title.textContent = 'Спецсобытия матча';
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
        host.append(title, row1, row2, actions);

        // Вставим панель рядом с карточкой матча
        const schedPane = document.getElementById('ufo-schedule');
        const cards = schedPane?.querySelectorAll('.match-card') || [];
        let placeAfter = null;
        cards.forEach(c => {
            const teamEls = c.querySelectorAll('.team-name');
            const h = teamEls[0]?.textContent || '';
            const a = teamEls[1]?.textContent || '';
            if (h === (m.home||'') && a === (m.away||'')) placeAfter = c;
        });
        if (!placeAfter) return;
        // Удалим старые панели
        placeAfter.parentElement.querySelectorAll('.admin-panel').forEach(el => el.remove());
        placeAfter.after(host);

        // Загрузим текущее состояние
        fetch(`/api/specials/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`)
            .then(r=>r.json())
            .then(d => {
                if (d.penalty_yes === 1) sel1.value = '1'; else if (d.penalty_yes === 0) sel1.value = '0'; else sel1.value='';
                if (d.redcard_yes === 1) sel2.value = '1'; else if (d.redcard_yes === 0) sel2.value = '0'; else sel2.value='';
            }).catch(()=>{});

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

    function loadAchievementsCatalog() {
        const table = document.getElementById('achv-catalog-table');
        const updated = document.getElementById('achv-catalog-updated');
        if (!table) return;
    fetch('/api/achievements-catalog').then(r => r.json()).then(data => {
            const tbody = table.querySelector('tbody');
            tbody.innerHTML = '';
            const catalog = data.catalog || [];
            // строим таблицу: шапка из трёх колонок уровней
            catalog.forEach(group => {
                const header = document.createElement('tr');
        const first = document.createElement('td'); first.textContent = group.title;
                const t1 = document.createElement('td'); t1.textContent = `${group.tiers[0].name} ${group.tiers[0].target}`;
                const t2 = document.createElement('td'); t2.textContent = `${group.tiers[1].name} ${group.tiers[1].target}`;
                const t3 = document.createElement('td'); t3.textContent = `${group.tiers[2].name} ${group.tiers[2].target}`;
        header.append(first, t1, t2, t3);
                tbody.appendChild(header);

                const descRow = document.createElement('tr');
                const descTitle = document.createElement('td'); descTitle.textContent = 'Описание';
                const desc = document.createElement('td'); desc.colSpan = 3; desc.textContent = group.description;
                descRow.append(descTitle, desc);
                tbody.appendChild(descRow);
            });
            if (updated) updated.textContent = '';
        }).catch(err => console.error('achv catalog load error', err));
    }

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

    // загружаем таблицу при первом открытии вкладки НЛО также на всякий случай, если событие клика не перехватили
    document.addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item[data-tab="ufo"]');
        if (item) {
            loadLeagueTable();
            // первичная загрузка статистики, чтобы не ждать при переключении
            loadStatsTable();
        }
    }, { once: true });

    // старт
    initApp();
    // Стартовая предзагрузка UFO-данных во время заставки
    preloadUfoData();
    setupEventListeners();

    // ---------- LIVE notifications ----------
    const LiveWatcher = (() => {
        let lastLiveKeys = new Set();
        const getKey = (m) => `${m.home||''}__${m.away||''}__${m.datetime||m.date||''}`;
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
        const showToast = (text) => {
            let cont = document.querySelector('.toast-container');
            if (!cont) { cont = document.createElement('div'); cont.className = 'toast-container'; document.body.appendChild(cont); }
            const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
            cont.appendChild(el);
            setTimeout(()=>{ el.remove(); if (cont.childElementCount===0) cont.remove(); }, 3500);
        };
        const scan = () => {
            // берём из кэша /api/schedule
            try {
                const cached = JSON.parse(localStorage.getItem('schedule:tours') || 'null');
                const tours = cached?.data?.tours || [];
                const currentLive = new Set();
                tours.forEach(t => (t.matches||[]).forEach(m => { if (isLive(m)) currentLive.add(getKey(m)); }));
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
