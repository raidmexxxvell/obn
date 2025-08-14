// static/js/profile.js
document.addEventListener('DOMContentLoaded', () => {
    const tg = window.Telegram?.WebApp;
    tg.expand();
    
    // Элементы интерфейса
    const elements = {
        userName: document.getElementById('user-name'),
        userAvatar: document.getElementById('user-avatar'),
        credits: document.getElementById('credits'),
        level: document.getElementById('level'),
        xp: document.getElementById('xp'),
        xpProgress: document.getElementById('xp-progress'),
        checkinDays: document.getElementById('checkin-days'),
        checkinBtn: document.getElementById('checkin-btn'),
        checkinStatus: document.getElementById('checkin-status')
    };

    // Инициализация приложения
    function initApp() {
        if (!tg || !tg.initDataUnsafe?.user) {
            showError("Ошибка инициализации. Запустите приложение через Telegram");
            return;
        }

        fetchUserData();
        setupEventListeners();
    }

    // Получение данных пользователя
    function fetchUserData() {
        showLoading();
        
        fetch('/api/user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: tg.initDataUnsafe.user })
        })
        .then(response => response.json())
        .then(data => {
            renderUserProfile(data);
            renderCheckinSection(data);
        })
        .catch(error => {
            console.error('Ошибка загрузки данных:', error);
            showError("Не удалось загрузить данные. Проверьте подключение.");
        })
        .finally(() => {
            hideLoading();
        });
    }

    // Отображение профиля
    function renderUserProfile(user) {
        // Аватар
        const avatar = document.createElement('img');
        avatar.src = tg.initDataUnsafe.user.photo_url || 'https://via.placeholder.com/70';
        elements.userAvatar.appendChild(avatar);
        
        // Имя
        elements.userName.textContent = user.display_name;
        
        // Статистика
        elements.credits.textContent = user.credits.toLocaleString();
        elements.level.textContent = user.level;
        
        // XP
        const xpForNextLevel = user.level * 100;
        const currentXp = user.xp % xpForNextLevel;
        elements.xp.textContent = `${currentXp}/${xpForNextLevel}`;
        
        // Прогресс
        const progress = (currentXp / xpForNextLevel) * 100;
        elements.xpProgress.style.width = `${progress}%`;
    }

    // Отображение чекин-секции
    function renderCheckinSection(user) {
        // Генерация дней цикла
        elements.checkinDays.innerHTML = '';
        const cycleDay = (user.consecutive_days % 7) || 7;
        
        for (let i = 1; i <= 7; i++) {
            const dayEl = document.createElement('div');
            dayEl.className = 'day-indicator';
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
        
        fetch('/api/checkin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: tg.initDataUnsafe.user.id })
        })
        .then(response => response.json())
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
    function showLoading() {
        elements.userName.textContent = 'Загрузка...';
    }
    
    function hideLoading() {
        // Ничего не делаем - данные уже отображены
    }
    
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
            }
        });
    }

    // Запуск приложения
    initApp();
});