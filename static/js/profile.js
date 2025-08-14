document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp || null;
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    // Безопасные вызовы Telegram API (не ломаем скрипт если WebApp отсутствует)
    tg?.expand?.();
    tg?.ready?.();

    // Элементы интерфейса
    const elements = {
        userName: document.getElementById('user-name'),
        userAvatar: document.getElementById('user-avatar'),
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
        achievementPlaceholder: document.getElementById('achievement-placeholder')
    };

    // Анимация загрузки (с проверками наличия элементов)
    function startLoadingAnimation() {
        if (!loadingProgress) return () => {};
        let progress = 0;
        const interval = setInterval(() => {
            progress += Math.floor(Math.random() * 5) + 1;
            if (progress >= 95) {
                progress = 95;
                clearInterval(interval);
            }
            loadingProgress.style.width = `${progress}%`;
        }, 150);

        // Гарантированная анимация до 100% за 3 секунды
        const timeout = setTimeout(() => {
            if (loadingProgress) loadingProgress.style.width = '100%';
            setTimeout(hideSplash, 300);
        }, 3000);

        return () => {
            clearInterval(interval);
            clearTimeout(timeout);
        };
    }

    // Скрытие заставки (с защитой от null)
    function hideSplash() {
        if (splash) splash.style.opacity = '0';
        setTimeout(() => {
            if (splash) splash.style.display = 'none';
            if (appContent) appContent.style.display = 'block';
            document.body.classList.add('loaded');
        }, 500);
    }

    // Инициализация приложения
    function initApp() {
        // Если WebApp доступен — проверяем initDataUnsafe.user, иначе пытаемся работать в режиме "dev"
        if (tg && !tg.initDataUnsafe?.user) {
            showError("Ошибка инициализации. Запустите приложение через Telegram");
            return;
        }

        const cancelLoading = startLoadingAnimation();

        setTimeout(() => {
            Promise.all([
                fetchUserData(),
                fetchAchievements()
            ]).catch(error => {
                console.error('Ошибка при инициализации:', error);
            }).finally(() => {
                cancelLoading();
                hideSplash();
            });
        }, 1000); // Минимальное время показа заставки
    }

    // Получение данных пользователя
    function fetchUserData() {
        // Если нет WebApp данных — возвращаем заглушку (для локальной разработки)
        if (!tg || !tg.initDataUnsafe?.user) {
            return Promise.resolve({
                user_id: 0,
                display_name: 'Dev User',
                tg_username: '',
                credits: 1000,
                xp: 0,
                level: 1,
                consecutive_days: 0,
                last_checkin_date: ''
            }).then(data => {
                renderUserProfile(data);
                renderCheckinSection(data);
            });
        }

        // Подготовка данных для отправки
        const formData = new FormData();
        formData.append('initData', tg.initData);
        formData.append('user', JSON.stringify(tg.initDataUnsafe.user));

        return fetch('/api/user', {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (response.status === 401) {
                showError("Ошибка авторизации. Перезапустите приложение.");
                tg?.close?.();
                throw new Error("Unauthorized");
            }
            return response.json();
        })
        .then(data => {
            renderUserProfile(data);
            renderCheckinSection(data);
        })
        .catch(error => {
            console.error('Ошибка загрузки данных:', error);
            showError("Не удалось загрузить данные. Проверьте подключение.");
            throw error;
        });
    }

    // Получение достижений
    function fetchAchievements() {
        if (!tg || !tg.initDataUnsafe?.user) {
            const stub = {
                tier: 1,
                name: 'Бронза',
                days: 7,
                icon: 'bronze',
                unlocked: false
            };
            return Promise.resolve(renderAchievements([stub]));
        }

        const formData = new FormData();
        formData.append('initData', tg.initData);
        formData.append('user_id', tg.initDataUnsafe.user.id);

        return fetch('/api/achievements', {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (response.status === 401) {
                console.error("Ошибка авторизации при получении достижений");
                return { achievements: [] };
            }
            return response.json();
        })
        .then(data => {
            renderAchievements(data.achievements);
        })
        .catch(error => {
            console.error('Ошибка загрузки достижений:', error);
            const stub = {
                tier: 1,
                name: 'Бронза',
                days: 7,
                icon: 'bronze',
                unlocked: false
            };
            renderAchievements([stub]);
        });
    }

    // Отображение профиля
    function renderUserProfile(user) {
        if (!user) return;
        if (user && tg?.initDataUnsafe?.user?.photo_url && elements.userAvatarImg) {
            elements.userAvatarImg.src = tg.initDataUnsafe.user.photo_url;
        } else if (elements.userAvatarImg) {
            elements.userAvatarImg.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MCIgaGVpZ2h0PSI3MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxZTQwYWYiIHN0cm9rZS13aWR0aD0iMSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0iZmVhdGhlciBmZWF0aGVyLWNpcmNsZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48cGF0aCBkPSJNMTIgMTRhMiAyIDAgMSwwIDAgNEgyYTIgMiAwIDAsMCAwLTRoOGEyIDIgMCAwLDAgMCw0eiIvPjxwYXRoIGQ9Ik0xMiAxOGgxLjJhNCA0IDAgMSwwIDAtOCAwIDQgMCAwLDAgMCw4eiIvPjwvc3ZnPg==';
        }

        if (elements.userName) elements.userName.textContent = user.display_name || 'User';
        if (elements.credits) elements.credits.textContent = (user.credits || 0).toLocaleString();
        if (elements.level) elements.level.textContent = user.level || 1;
        if (elements.currentLevel) elements.currentLevel.textContent = user.level || 1;

        const lvl = user.level || 1;
        const xpForNextLevel = lvl * 100;
        const currentXp = (user.xp || 0) % xpForNextLevel;
        if (elements.xp) elements.xp.textContent = `${currentXp}/${xpForNextLevel}`;
        if (elements.currentXp) elements.currentXp.textContent = currentXp;
        if (elements.xpNeeded) elements.xpNeeded.textContent = xpForNextLevel;

        const progress = xpForNextLevel ? (currentXp / xpForNextLevel) * 100 : 0;
        if (elements.xpProgress) elements.xpProgress.style.width = `${Math.min(Math.max(progress, 0), 100)}%`;
    }

    // Отображение чекин-секции
    function renderCheckinSection(user) {
        if (!elements.checkinDays) return;
        elements.checkinDays.innerHTML = '';
        const cycleDay = (user.consecutive_days % 7) || 7;
        if (elements.currentStreak) elements.currentStreak.textContent = user.consecutive_days;

        for (let i = 1; i <= 7; i++) {
            const dayEl = document.createElement('div');
            dayEl.className = 'checkin-day';
            dayEl.textContent = i;

            if (i < cycleDay) {
                dayEl.classList.add('completed');
            } else if (i === cycleDay) {
                dayEl.classList.add('active');
            }

            elements.checkinDays.appendChild(dayEl);
        }

        const today = new Date().toISOString().split('T')[0];
        const lastCheckin = user.last_checkin_date?.split('T')[0] || '';

        if (lastCheckin === today) {
            if (elements.checkinBtn) elements.checkinBtn.disabled = true;
            if (elements.checkinStatus) elements.checkinStatus.textContent = '✅ Награда получена сегодня';
        } else {
            if (elements.checkinBtn) elements.checkinBtn.disabled = false;
            if (elements.checkinStatus) elements.checkinStatus.textContent = '';
        }
    }

    // Отображение достижений
    function renderAchievements(achievements) {
        if (elements.achievementPlaceholder) elements.achievementPlaceholder.remove();
        if (!elements.badgesContainer) return;

        if (achievements && achievements.length > 0) {
            const achievement = achievements[0];

            const card = document.createElement('div');
            card.className = `achievement-card ${achievement.unlocked ? '' : 'locked'}`;

            const icon = document.createElement('img');
            icon.src = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4ODg4ODgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0iZmVhdGhlciBmZWF0aGVyLXRyb2Z5Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxwb2x5bGluZSBwb2ludHM9IjEyIDYgMTYgMTQgMTIgMTAgOCAxNCAxMiA2Ii8+PC9zdmc+`;
            icon.alt = achievement.name;

            const name = document.createElement('div');
            name.className = 'badge-name';
            name.textContent = achievement.name;

            const requirements = document.createElement('div');
            requirements.className = 'badge-requirements';
            requirements.textContent = `${achievement.days} дней подряд`;

            card.appendChild(icon);
            card.appendChild(name);
            card.appendChild(requirements);
            elements.badgesContainer.appendChild(card);
        }
    }

    // Обработка чекина
    function handleCheckin() {
        if (!elements.checkinBtn) return;
        elements.checkinBtn.disabled = true;
        if (elements.checkinStatus) elements.checkinStatus.textContent = 'Обработка...';

        if (!tg || !tg.initDataUnsafe?.user) {
            showError("Невозможно выполнить чекин без Telegram WebApp");
            elements.checkinBtn.disabled = false;
            return;
        }

        const formData = new FormData();
        formData.append('initData', tg.initData);
        formData.append('user_id', tg.initDataUnsafe.user.id);

        fetch('/api/checkin', {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (response.status === 401) {
                showError("Ошибка авторизации. Перезапустите приложение.");
                tg?.close?.();
                return;
            }
            return response.json();
        })
        .then(data => {
            if (!data) return;
            if (data.status === 'already_checked') {
                if (elements.checkinStatus) elements.checkinStatus.textContent = '✅ Награда получена сегодня';
                return;
            }
            showRewardAnimation(data.xp, data.credits);
            // Обновляем данные
            fetchUserData();
            fetchAchievements();
        })
        .catch(error => {
            console.error('Ошибка чекина:', error);
            if (elements.checkinStatus) elements.checkinStatus.textContent = 'Ошибка получения награды';
            if (elements.checkinBtn) elements.checkinBtn.disabled = false;
        });
    }

    // Обработка смены имени
    function handleNameChange() {
        if (!elements.userName) return;
        const newName = prompt('Введите новое имя:', elements.userName.textContent);
        if (newName && newName.trim() && newName !== elements.userName.textContent) {
            const originalText = elements.userName.textContent;
            elements.userName.textContent = 'Сохранение...';

            if (!tg || !tg.initDataUnsafe?.user) {
                showError("Невозможно обновить имя без Telegram WebApp");
                elements.userName.textContent = originalText;
                return;
            }

            const formData = new FormData();
            formData.append('initData', tg.initData);
            formData.append('user_id', tg.initDataUnsafe.user.id);
            formData.append('new_name', newName.trim());

            fetch('/api/update-name', {
                method: 'POST',
                body: formData
            })
            .then(response => {
                if (response.status === 401) {
                    throw new Error("Ошибка авторизации");
                }
                return response.json();
            })
            .then(data => {
                if (elements.userName) elements.userName.textContent = data.display_name;
                showSuccessMessage("Имя успешно изменено!");
            })
            .catch(error => {
                console.error('Ошибка обновления имени:', error);
                if (elements.userName) elements.userName.textContent = originalText;
                showError("Не удалось изменить имя. Попробуйте позже.");
            });
        }
    }

    // Вспомогательные функции
    function showError(message) {
        if (elements.checkinStatus) {
            elements.checkinStatus.textContent = message;
            elements.checkinStatus.style.color = 'var(--danger)';
            setTimeout(() => {
                elements.checkinStatus.textContent = '';
                elements.checkinStatus.style.color = 'var(--light)';
            }, 3000);
        } else {
            console.warn(message);
        }
    }

    function showSuccessMessage(message) {
        if (elements.checkinStatus) {
            elements.checkinStatus.textContent = message;
            elements.checkinStatus.style.color = 'var(--success)';
            setTimeout(() => {
                elements.checkinStatus.textContent = '';
                elements.checkinStatus.style.color = 'var(--light)';
            }, 2000);
        } else {
            console.log(message);
        }
    }

    function showRewardAnimation(xp, credits) {
        if (!elements.checkinStatus) return;
        const statusEl = elements.checkinStatus;
        statusEl.innerHTML = `
            <div class="reward-animation">
                +${xp} XP | +${credits} кредитов
            </div>
        `;

        setTimeout(() => {
            statusEl.textContent = 'Награда получена!';
        }, 2000);
    }

    function setupEventListeners() {
        setTimeout(() => {
            elements.checkinBtn = document.getElementById('checkin-btn');
            elements.editName = document.getElementById('edit-name');

            if (elements.checkinBtn) {
                elements.checkinBtn.addEventListener('click', handleCheckin);
            }

            if (elements.editName) {
                elements.editName.addEventListener('click', handleNameChange);
                elements.editName.style.cursor = 'pointer';
            }
        }, 500);
    }

    // Запуск приложения
    initApp();
    setupEventListeners();

    // Дополнительная проверка для редактирования имени
    document.addEventListener('click', (e) => {
        if (e.target.closest('#edit-name')) {
            console.log('Edit name clicked');
        }
    });
});
