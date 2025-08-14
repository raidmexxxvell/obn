// static/js/profile.js
document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp;
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');
    
    tg.expand();
    tg.ready();
    
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
        badgesContainer: document.getElementById('badges')
    };

    // Анимация загрузки
    function startLoadingAnimation() {
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
        setTimeout(() => {
            loadingProgress.style.width = '100%';
            setTimeout(hideSplash, 300);
        }, 3000);
        
        return () => clearInterval(interval);
    }

    // Скрытие заставки
    function hideSplash() {
        splash.style.opacity = '0';
        setTimeout(() => {
            splash.style.display = 'none';
            appContent.style.display = 'block';
            document.body.classList.add('loaded');
        }, 500);
    }

    // Инициализация приложения
    function initApp() {
        if (!tg || !tg.initDataUnsafe?.user) {
            showError("Ошибка инициализации. Запустите приложение через Telegram");
            return;
        }

        const cancelLoading = startLoadingAnimation();
        
        setTimeout(() => {
            Promise.all([
                fetchUserData(),
                fetchAchievements()
            ]).finally(() => {
                cancelLoading();
                hideSplash();
            });
        }, 1000); // Минимальное время показа заставки
    }

    // Получение данных пользователя
    function fetchUserData() {
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
                tg.close();
                return Promise.reject(new Error("Unauthorized"));
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
        // Подготовка данных для отправки
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
            // Создаем заглушки для достижений
            const stubs = [
                {tier: 1, name: 'Бронза', days: 7, icon: 'bronze', unlocked: false},
                {tier: 2, name: 'Серебро', days: 30, icon: 'silver', unlocked: false},
                {tier: 3, name: 'Золото', days: 120, icon: 'gold', unlocked: false}
            ];
            renderAchievements(stubs);
        });
    }

    // Отображение профиля
    function renderUserProfile(user) {
        // Аватар из Telegram
        if (tg.initDataUnsafe.user.photo_url) {
            elements.userAvatarImg.src = tg.initDataUnsafe.user.photo_url;
        } else {
            // Заглушка если нет фото
            elements.userAvatarImg.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MCIgaGVpZ2h0PSI3MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxZTQwYWYiIHN0cm9rZS13aWR0aD0iMSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0iZmVhdGhlciBmZWF0aGVyLWNpcmNsZSI+PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MCIgaGVpZ2h0PSI3MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxZTQwYWYiIHN0cm9rZS13aWR0aD0iMSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0iZmVhdGhlciBmZWF0aGVyLWNpcmNsZSI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48cGF0aCBkPSJNMTIgMTRhMiAyIDAgMSwwIDAgNEgyYTIgMiAwIDAsMCAwLTRoOGEyIDIgMCAwLDAgMCw0eiIvPjxwYXRoIGQ9Ik0xMiAxOGgxLjJhNCA0IDAgMSwwIDAtOCAwIDQgMCAwLDAgMCw4eiIvPjwvc3ZnPg==';
        }
        
        // Имя
        elements.userName.textContent = user.display_name;
        
        // Статистика
        elements.credits.textContent = user.credits.toLocaleString();
        elements.level.textContent = user.level;
        elements.currentLevel.textContent = user.level;
        
        // XP
        const xpForNextLevel = user.level * 100;
        const currentXp = user.xp % xpForNextLevel;
        elements.xp.textContent = `${currentXp}/${xpForNextLevel}`;
        elements.currentXp.textContent = currentXp;
        elements.xpNeeded.textContent = xpForNextLevel;
        
        // Прогресс
        const progress = (currentXp / xpForNextLevel) * 100;
        elements.xpProgress.style.width = `${progress}%`;
    }

    // Отображение чекин-секции
    function renderCheckinSection(user) {
        // Генерация дней цикла
        elements.checkinDays.innerHTML = '';
        const cycleDay = (user.consecutive_days % 7) || 7;
        elements.currentStreak.textContent = user.consecutive_days;
        
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
        
        // Проверка последнего чекина
        const today = new Date().toISOString().split('T')[0];
        const lastCheckin = user.last_checkin_date?.split('T')[0] || '';
        
        if (lastCheckin === today) {
            elements.checkinBtn.disabled = true;
            elements.checkinStatus.textContent = '✅ Награда получена сегодня';
        } else {
            elements.checkinBtn.disabled = false;
            elements.checkinStatus.textContent = '';
        }
    }

    // Отображение достижений
    function renderAchievements(achievements) {
        elements.badgesContainer.innerHTML = '';
        
        achievements.forEach(achievement => {
            const card = document.createElement('div');
            card.className = `achievement-card ${achievement.icon} ${achievement.unlocked ? 'unlocked' : ''}`;
            
            // Иконка достижения
            const icon = document.createElement('img');
            icon.src = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2MCIgaGVpZ2h0PSI2MCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiM4ODg4ODgiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0iZmVhdGhlciBmZWF0aGVyLXRyb2Z5Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxwb2x5bGluZSBwb2ludHM9IjEyIDYgMTYgMTQgMTIgMTAgOCAxNCAxMiA2Ii8+PC9zdmc+`;
            icon.alt = achievement.name;
            
            // Название
            const name = document.createElement('div');
            name.className = 'badge-name';
            name.textContent = achievement.name;
            
            card.appendChild(icon);
            card.appendChild(name);
            elements.badgesContainer.appendChild(card);
        });
    }

    // Обработка чекина
    function handleCheckin() {
        elements.checkinBtn.disabled = true;
        elements.checkinStatus.textContent = 'Обработка...';
        
        // Подготовка данных для отправки
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
                tg.close();
                return;
            }
            return response.json();
        })
        .then(data => {
            if (data.status === 'already_checked') {
                elements.checkinStatus.textContent = '✅ Награда получена сегодня';
                return;
            }
            
            // Анимация награды
            showRewardAnimation(data.xp, data.credits);
            // Обновляем данные
            fetchUserData();
            fetchAchievements();
        })
        .catch(error => {
            console.error('Ошибка чекина:', error);
            elements.checkinStatus.textContent = 'Ошибка получения награды';
            elements.checkinBtn.disabled = false;
        });
    }

    // Обработка смены имени
    function handleNameChange() {
        const newName = prompt('Введите новое имя:', elements.userName.textContent);
        if (newName && newName.trim() && newName !== elements.userName.textContent) {
            // Показываем индикатор загрузки
            const originalText = elements.userName.textContent;
            elements.userName.textContent = 'Сохранение...';
            
            // Подготовка данных для отправки
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
                // Обновляем отображение
                elements.userName.textContent = data.display_name;
                showSuccessMessage("Имя успешно изменено!");
            })
            .catch(error => {
                console.error('Ошибка обновления имени:', error);
                elements.userName.textContent = originalText;
                showError("Не удалось изменить имя. Попробуйте позже.");
            });
        }
    }

    // Вспомогательные функции
    function showError(message) {
        elements.userName.textContent = 'Ошибка';
        elements.checkinStatus.textContent = message;
    }
    
    function showSuccessMessage(message) {
        const statusEl = elements.checkinStatus;
        statusEl.textContent = message;
        statusEl.style.color = 'var(--success)';
        
        setTimeout(() => {
            statusEl.textContent = '';
            statusEl.style.color = 'var(--light)';
        }, 2000);
    }
    
    function showRewardAnimation(xp, credits) {
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
        elements.checkinBtn.addEventListener('click', handleCheckin);
        
        // Редактирование имени
        document.getElementById('edit-name').addEventListener('click', handleNameChange);
    }

    // Запуск приложения
    initApp();
});