// static/js/profile.js
document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp || null;
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    // ПРАВИЛЬНАЯ инициализация Telegram WebApp
    if (tg) {
        try {
            tg.ready(); // Сообщаем Telegram, что приложение готово
            tg.expand(); // Расширяем приложение на весь экран
            console.log('Telegram WebApp инициализирован');
        } catch (e) {
            console.error('Ошибка инициализации Telegram WebApp:', e);
        }
    }

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

    function startLoadingAnimation() {
        if (!loadingProgress) {
            console.warn('Элемент loadingProgress не найден');
            return () => {};
        }
        
        let progress = 0;
        const interval = setInterval(() => {
            progress += Math.floor(Math.random() * 5) + 1;
            if (progress >= 95) {
                progress = 95;
            }
            loadingProgress.style.width = `${progress}%`;
        }, 150);

        return () => { 
            clearInterval(interval); 
            if (loadingProgress) {
                loadingProgress.style.width = '100%';
            }
        };
    }

    function initApp() {
        console.log("🚀 Запуск инициализации приложения");
        
        // если tg есть, но в нём нет user — сообщаем об ошибке
        if (tg && !tg.initDataUnsafe?.user) {
            console.warn('Telegram WebApp present but initDataUnsafe.user missing');
            // не прерываем — будем работать с заглушкой
        }

        const cancelLoading = startLoadingAnimation();
        console.log("⏳ Анимация загрузки запущена");

        // загружаем данные (в dev режиме вернём заглушку)
        Promise.all([fetchUserData(), fetchAchievements()])
            .then(results => {
                console.log("✅ Данные успешно загружены", results);
            })
            .catch(err => {
                console.error('❌ Ошибка инициализации:', err);
                // Показываем ошибку пользователю
                if (elements.checkinStatus) {
                    elements.checkinStatus.textContent = 'Ошибка загрузки данных';
                    setTimeout(() => {
                        if (elements.checkinStatus) elements.checkinStatus.textContent = '';
                    }, 3000);
                }
            })
            .finally(() => {
                console.log("🏁 Завершение инициализации");
                cancelLoading();
                
                // ДОБАВЛЕНА ПРОВЕРКА НАЛИЧИЯ ФУНКЦИИ
                if (typeof window.hideSplash === 'function') {
                    console.log("➡️ Вызов hideSplash");
                    window.hideSplash();
                } else {
                    console.error("❌ Функция hideSplash не определена!");
                    // Альтернативное скрытие заставки
                    if (splash) {
                        splash.style.opacity = '0';
                        setTimeout(() => {
                            splash.style.display = 'none';
                            if (appContent) appContent.style.display = 'block';
                            document.body.classList.add('loaded');
                        }, 450);
                    }
                }
            });
    }

    function fetchUserData() {
        return new Promise((resolve, reject) => {
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
                console.log("📱 Используем dev-заглушку для пользователя");
                renderUserProfile(dev);
                renderCheckinSection(dev);
                resolve(dev);
                return;
            }

            const formData = new FormData();
            formData.append('initData', tg.initData || '');
            formData.append('user', JSON.stringify(tg.initDataUnsafe.user));

            fetch('/api/user', { method: 'POST', body: formData })
                .then(res => {
                    if (res.status === 401) { 
                        console.error('❌ Ошибка авторизации'); 
                        reject(new Error('Unauthorized'));
                        return; 
                    }
                    return res.json();
                })
                .then(data => { 
                    console.log("📊 Данные пользователя получены:", data);
                    renderUserProfile(data); 
                    renderCheckinSection(data); 
                    resolve(data); 
                })
                .catch(err => { 
                    console.error('❌ fetchUserData ошибка:', err); 
                    reject(err); 
                });
        });
    }

    function fetchAchievements() {
        return new Promise((resolve, reject) => {
            if (!tg || !tg.initDataUnsafe?.user) {
                console.log("🏆 Используем dev-заглушку для достижений");
                const achievements = [{ tier:1, name:'Бронза', days:7, icon:'bronze', unlocked:false }];
                renderAchievements(achievements);
                resolve();
                return;
            }

            const formData = new FormData();
            formData.append('initData', tg.initData || '');
            formData.append('user_id', tg.initDataUnsafe.user.id);

            fetch('/api/achievements', { method: 'POST', body: formData })
                .then(res => res.json())
                .then(data => {
                    console.log("🎖️ Достижения получены:", data.achievements);
                    renderAchievements(data.achievements || []);
                    resolve();
                })
                .catch(err => { 
                    console.error('❌ fetchAchievements ошибка:', err); 
                    const achievements = [{ tier:1, name:'Бронза', days:7, icon:'bronze', unlocked:false }];
                    renderAchievements(achievements);
                    resolve();
                });
        });
    }

    function renderUserProfile(user) {
        if (!user) return;
        console.log("👤 Отображение профиля пользователя:", user);
        if (elements.userAvatarImg && tg?.initDataUnsafe?.user?.photo_url) {
            elements.userAvatarImg.src = tg.initDataUnsafe.user.photo_url;
        }
        if (elements.userName) elements.userName.textContent = user.display_name || 'User';
        if (elements.credits) elements.credits.textContent = (user.credits || 0).toLocaleString();
        if (elements.level) elements.level.textContent = user.level || 1;

        const lvl = user.level || 1;
        const xpForNextLevel = lvl * 100;
        const currentXp = (user.xp || 0) % xpForNextLevel;
        if (elements.xp) elements.xp.textContent = `${currentXp}/${xpForNextLevel}`;
        if (elements.currentXp) elements.currentXp.textContent = currentXp;
        if (elements.xpNeeded) elements.xpNeeded.textContent = xpForNextLevel;
        if (elements.xpProgress) elements.xpProgress.style.width = `${Math.min(Math.max((xpForNextLevel ? (currentXp / xpForNextLevel) * 100 : 0),0),100)}%`;
    }

    function renderCheckinSection(user) {
        if (!elements.checkinDays) return;
        console.log("📅 Отображение секции чекина:", user);
        elements.checkinDays.innerHTML = '';
        const cycleDay = (user.consecutive_days % 7) || 7;
        if (elements.currentStreak) elements.currentStreak.textContent = user.consecutive_days || 0;

        for (let i=1; i<=7; i++) {
            const dayEl = document.createElement('div');
            dayEl.className = 'checkin-day';
            dayEl.textContent = i;
            if (i < cycleDay) dayEl.classList.add('completed');
            else if (i === cycleDay) dayEl.classList.add('active');
            elements.checkinDays.appendChild(dayEl);
        }

        const today = new Date().toISOString().split('T')[0];
        const lastCheckin = (user.last_checkin_date || '').split('T')[0];
        if (lastCheckin === today) {
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
        console.log("🏅 Отображение достижений:", achievements);
        elements.badgesContainer.innerHTML = ''; // очищаем
        if (!achievements || achievements.length === 0) return;
        const a = achievements[0];
        const card = document.createElement('div');
        card.className = `achievement-card ${a.unlocked ? '' : 'locked'}`;
        const icon = document.createElement('img');
        if (a.icon === 'bronze') {
            icon.src = '/static/img/achievements/bronze.png';
        } else if (a.icon === 'silver') {
            icon.src = '/static/img/achievements/silver.png';
        } else if (a.icon === 'gold') {
            icon.src = '/static/img/achievements/gold.png';
        } else {
            icon.src = a.icon ? `image/svg+xml;base64,PHN2...` : '';
        }
        icon.alt = a.name || 'badge';
        const name = document.createElement('div'); name.className='badge-name'; name.textContent = a.name;
        const req = document.createElement('div'); req.className='badge-requirements'; req.textContent = `${a.days} дней подряд`;
        card.append(icon, name, req);
        elements.badgesContainer.appendChild(card);
    }

    function handleCheckin() {
        if (!elements.checkinBtn) return;
        console.log("🔄 Обработка чекина");
        elements.checkinBtn.disabled = true;
        if (elements.checkinStatus) elements.checkinStatus.textContent = 'Обработка...';
        if (!tg || !tg.initDataUnsafe?.user) { 
            console.error('❌ Невозможно выполнить чекин без Telegram WebApp');
            if (elements.checkinStatus) elements.checkinStatus.textContent='Ошибка: не авторизован';
            if (elements.checkinBtn) elements.checkinBtn.disabled=false; 
            return; 
        }

        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        formData.append('user_id', tg.initDataUnsafe.user.id);

        fetch('/api/checkin', { method:'POST', body: formData })
            .then(res => {
                if (res.status === 401) { 
                    console.error('❌ Ошибка авторизации'); 
                    if (elements.checkinStatus) elements.checkinStatus.textContent='Ошибка авторизации';
                    tg?.close?.(); 
                    throw new Error('Unauthorized'); 
                }
                return res.json();
            })
            .then(data => {
                if (!data) return;
                if (data.status === 'already_checked') { 
                    if (elements.checkinStatus) elements.checkinStatus.textContent='✅ Награда получена сегодня'; 
                    return; 
                }
                showRewardAnimation(data.xp, data.credits);
                fetchUserData(); fetchAchievements();
            })
            .catch(err => { 
                console.error('❌ checkin err', err); 
                if (elements.checkinStatus) elements.checkinStatus.textContent='Ошибка получения награды'; 
                if (elements.checkinBtn) elements.checkinBtn.disabled=false; 
            });
    }

    function handleNameChange() {
        if (!elements.userName) return;
        console.log("✏️ Изменение имени");
        const newName = prompt('Введите новое имя:', elements.userName.textContent);
        if (!newName || !newName.trim() || newName === elements.userName.textContent) return;
        const original = elements.userName.textContent;
        elements.userName.textContent = 'Сохранение...';
        if (!tg || !tg.initDataUnsafe?.user) { 
            console.error('❌ Невозможно обновить имя без Telegram WebApp'); 
            elements.userName.textContent = original; 
            return; 
        }

        const formData = new FormData();
        formData.append('initData', tg.initData || '');
        formData.append('user_id', tg.initDataUnsafe.user.id);
        formData.append('new_name', newName.trim());

        fetch('/api/update-name', { method:'POST', body: formData })
        .then(res => { 
            if (res.status === 401) throw new Error('Unauthorized'); 
            return res.json(); 
        })
        .then(data => { 
            if (elements.userName) elements.userName.textContent = data.display_name; 
            showSuccessMessage('Имя успешно изменено!'); 
        })
        .catch(err => { 
            console.error('❌ update name err', err); 
            if (elements.userName) elements.userName.textContent = original; 
            showError('Не удалось изменить имя.'); 
        });
    }

    function showError(msg) { 
        if (elements.checkinStatus) { 
            elements.checkinStatus.textContent = msg; 
            elements.checkinStatus.style.color = 'var(--danger)'; 
            setTimeout(()=>{
                if (elements.checkinStatus) {
                    elements.checkinStatus.textContent='';
                    elements.checkinStatus.style.color='';
                }
            },3000);
        } else console.warn(msg); 
    }
    
    function showSuccessMessage(msg) { 
        if (elements.checkinStatus) { 
            elements.checkinStatus.textContent = msg; 
            elements.checkinStatus.style.color = 'var(--success)'; 
            setTimeout(()=>{
                if (elements.checkinStatus) {
                    elements.checkinStatus.textContent='';
                    elements.checkinStatus.style.color='';
                }
            },2000);
        } else console.log(msg); 
    }
    
    function showRewardAnimation(xp, credits) { 
        if (!elements.checkinStatus) return; 
        elements.checkinStatus.innerHTML = `<div class="reward-animation">+${xp} XP | +${credits} кредитов</div>`; 
        setTimeout(()=>{
            if (elements.checkinStatus) elements.checkinStatus.textContent='Награда получена!'; 
        },2000); 
    }

    function setupEventListeners() {
        if (elements.checkinBtn) elements.checkinBtn.addEventListener('click', handleCheckin);
        if (elements.editName) { 
            elements.editName.style.cursor = 'pointer'; 
            elements.editName.addEventListener('click', handleNameChange); 
        }
    }

    // ЗАПУСК ПРИЛОЖЕНИЯ ТОЛЬКО ПОСЛЕ ГОТОВНОСТИ
    if (tg) {
        // Убедимся, что Telegram WebApp полностью инициализирован
        setTimeout(() => {
            console.log("▶️ Запуск приложения после задержки");
            initApp();
        }, 100);
    } else {
        initApp();
    }
    
    setupEventListeners();
});
