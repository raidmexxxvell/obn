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
        currentStreak: document.getElementById('current-streak')
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
        splash.classList.remove('active');
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
            fetchUserData().finally(() => {
                cancelLoading();
                hideSplash();
            });
        }, 1000); // Минимальное время показа заставки
        
        setupEventListeners();
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

    // Отображение профиля
    function renderUserProfile(user) {
        // Аватар (первая буква имени)
        const firstName = user.display_name || tg.initDataUnsafe.user.first_name;
        elements.userAvatar.textContent = firstName.charAt(0).toUpperCase();
        
        // Имя
        elements.userName.textContent = firstName;
        
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
            fetchUserData(); // Обновление данных
        })
        .catch(error => {
            console.error('Ошибка чекина:', error);
            elements.checkinStatus.textContent = 'Ошибка получения награды';
            elements.checkinBtn.disabled = false;
        });
    }

    // Вспомогательные функции
    function showError(message) {
        elements.userName.textContent = 'Ошибка';
        elements.checkinStatus.textContent = message;
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
        document.getElementById('edit-name').addEventListener('click', () => {
            const newName = prompt('Введите новое имя:', elements.userName.textContent);
            if (newName && newName.trim()) {
                // Здесь будет запрос на обновление имени
                elements.userName.textContent = newName;
                elements.userAvatar.textContent = newName.charAt(0).toUpperCase();
            }
        });
    }

    // Запуск приложения
    initApp();
});