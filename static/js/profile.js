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

    function initApp() {
        // если tg есть, но в нём нет user — сообщаем об ошибке
        if (tg && !tg.initDataUnsafe?.user) {
            console.warn('Telegram WebApp present but initDataUnsafe.user missing');
            // не прерываем — будем работать с заглушкой
        }

        // загружаем данные (в dev режиме вернём заглушку)
        setTimeout(() => {
            Promise.all([ fetchUserData(), fetchAchievements() ])
                .then(() => {
                    // триггерим готовность данных пользовательских
                    window.dispatchEvent(new CustomEvent('app:data-ready'));
                })
                .catch(err => console.error('Init error', err));
        }, 400); // минимальное время показа
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
        if (!tg || !tg.initDataUnsafe?.user) { showError('Невозможно обновить имя без Telegram WebApp'); elements.userName.textContent = original; return; }

    const formData = new FormData();
    formData.append('initData', tg.initData || '');
    formData.append('new_name', newName.trim());

        fetch('/api/update-name', { method:'POST', body: formData })
        .then(res => { if (res.status === 401) throw new Error('Unauthorized'); return res.json(); })
        .then(data => { if (elements.userName) elements.userName.textContent = data.display_name; showSuccessMessage('Имя успешно изменено!'); })
        .catch(err => { console.error('update name err', err); if (elements.userName) elements.userName.textContent = original; showError('Не удалось изменить имя.'); });
    }

    function showError(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--danger)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },3000);} else console.warn(msg); }
    function showSuccessMessage(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--success)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },2000);} else console.log(msg); }
    function showRewardAnimation(xp, credits) { if (!elements.checkinStatus) return; elements.checkinStatus.innerHTML = `<div class="reward-animation">+${xp} XP | +${credits} кредитов</div>`; setTimeout(()=>{ elements.checkinStatus.textContent='Награда получена!'; },2000); }

    function setupEventListeners() {
        if (elements.checkinBtn) elements.checkinBtn.addEventListener('click', handleCheckin);
        if (elements.editName) { elements.editName.style.cursor='pointer'; elements.editName.addEventListener('click', handleNameChange); }
        // переключение вкладок
        const navItems = document.querySelectorAll('.nav-item');
        navItems.forEach(item => {
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
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-subtab');
                subtabItems.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(subtabMap).forEach(el => { if (el) el.style.display = 'none'; });
                if (subtabMap[key]) {
                    subtabMap[key].style.display = '';
                    if (key === 'table') {
                        loadLeagueTable();
                    }
                }
            });
        });
    }

    function loadLeagueTable() {
        const table = document.getElementById('league-table');
        const updated = document.getElementById('league-table-updated');
        if (!table) return;
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
            if (updated && data.updated_at) {
                const d = new Date(data.updated_at);
                updated.textContent = `Обновлено: ${d.toLocaleString()}`;
            }
            // после первой успешной загрузки таблицы, если достижения уже готовы — можно сигналить all-ready
            _tableLoaded = true;
            trySignalAllReady();
        }).catch(err => {
            console.error('league table load error', err);
        });
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
        }
    }, { once: true });

    // старт
    initApp();
    setupEventListeners();
});
