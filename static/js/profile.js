// static/js/profile.js
document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp || null;
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

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
            // тёплый прогрев рефералки (не блокирует ничего)
            try { prefetchReferral(); } catch(_) {}
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

        const iconSrc = (icon) => {
            if (icon === 'bronze') return '/static/img/achievements/bronze.png';
            if (icon === 'silver') return '/static/img/achievements/silver.png';
            if (icon === 'gold') return '/static/img/achievements/gold.png';
            return '/static/img/achievements/placeholder.png';
        };

        achievements.forEach(a => {
            const card = document.createElement('div');
            card.className = `achievement-card ${a.unlocked ? '' : 'locked'}`;
            const icon = document.createElement('img');
            icon.src = iconSrc(a.icon);
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
        // переключение вкладок
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
            item.setAttribute('data-throttle', '600');
            item.addEventListener('click', () => {
                const tab = item.getAttribute('data-tab');
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
                const prof = document.getElementById('tab-profile');
                const ufo = document.getElementById('tab-ufo');
                if (tab === 'profile') {
                    if (prof) prof.style.display = '';
                    if (ufo) ufo.style.display = 'none';
                } else if (tab === 'ufo') {
                    if (prof) prof.style.display = 'none';
                    if (ufo) ufo.style.display = '';
                    // сразу загружаем таблицу при входе на вкладку НЛО
                    loadLeagueTable();
                }
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
                    }
                }
            });
        });

        // подвкладки Профиля (Достижения/Список/Реферал)
        const pTabs = document.querySelectorAll('#profile-subtabs .subtab-item');
        const pMap = {
            badges: document.getElementById('profile-pane-badges'),
            catalog: document.getElementById('profile-pane-catalog'),
            referral: document.getElementById('profile-pane-referral'),
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
                    if (key === 'referral') loadReferralInfo();
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
                    header.textContent = `${dateStr}${timeStr ? ' ' + timeStr : ''}`;
                    card.appendChild(header);

                    const center = document.createElement('div');
                    center.className = 'match-center';
                    const home = document.createElement('div'); home.className = 'team home';
                    const hImg = document.createElement('img'); hImg.className = 'logo'; hImg.alt = m.home || '';
                    loadTeamLogo(hImg, m.home || '');
                    const hName = document.createElement('div'); hName.className = 'team-name'; hName.textContent = m.home || '';
                    home.append(hImg, hName);
                    const score = document.createElement('div'); score.className = 'score'; score.textContent = '— : —';
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
                    footer.appendChild(btn);
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
        if (!linkEl || !countEl) return;
        if (!tg || !tg.initDataUnsafe?.user) return;
        // Мгновенный рендер из кэша, если есть
        if (_referralCache) {
            linkEl.textContent = _referralCache.referral_link || _referralCache.code || '—';
            countEl.textContent = (_referralCache.invited_count ?? 0).toString();
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
            })
            .catch(err => console.error('referral load error', err));
    }

    let _achLoaded = false;
    let _tableLoaded = false;
    function trySignalAllReady() {
        if (_achLoaded && _tableLoaded) {
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
    setupEventListeners();
});
