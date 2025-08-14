// profile.js — логика страницы профиля

document.addEventListener('DOMContentLoaded', () => {
    // Инициализация вкладок
    setupTabs();
    
    // Инициализация ежедневного чекина
    setupDailyCheckin();
    
    // Инициализация реферальной системы
    setupReferrals();
    
    // Загрузка данных
    loadProfileData();
});

function setupTabs() {
    const tabs = document.querySelectorAll('.profile-tab');
    const tabContents = document.querySelectorAll('.profile-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Удаляем активный класс со всех вкладок
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Добавляем активный класс текущей вкладке
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelector(`.profile-tab-content[data-tab-content="${tabName}"]`).classList.add('active');
            
            // Загружаем данные для вкладки, если это необходимо
            if (tabName === 'achievements') {
                loadAchievements();
            } else if (tabName === 'referrals') {
                loadReferralStats();
            }
        });
    });
}

function loadAchievements() {
    const container = document.querySelector('.achievements-grid');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/achievements')
        .then(response => response.json())
        .then(achievements => {
            if (achievements.length === 0) {
                container.innerHTML = '<p class="no-achievements">У вас пока нет достижений. Начните делать ставки и получайте награды!</p>';
                return;
            }
            
            let html = '';
            achievements.forEach(achievement => {
                html += `
                    <div class="achievement-card ${achievement.tier}">
                        <div class="achievement-icon">
                            ${getAchievementIcon(achievement.tier)}
                        </div>
                        <div class="achievement-info">
                            <h4>${achievement.name}</h4>
                            <p>${achievement.description}</p>
                            <span class="achievement-date">${achievement.achieved_at}</span>
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        })
        .catch(error => {
            console.error('Error loading achievements:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки достижений</p>';
        });
}

function getAchievementIcon(tier) {
    switch(tier) {
        case 'bronze':
            return '<i class="icon-achievement-bronze">🥉</i>';
        case 'silver':
            return '<i class="icon-achievement-silver">🥈</i>';
        case 'gold':
            return '<i class="icon-achievement-gold">🥇</i>';
        default:
            return '<i class="icon-achievement">⭐</i>';
    }
}

function setupDailyCheckin() {
    const checkinBtn = document.getElementById('daily-checkin-btn');
    if (!checkinBtn) return;
    
    checkinBtn.addEventListener('click', () => {
        fetch('/miniapp/daily_check', {
            method: 'POST'
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showNotification(data.message, 'success');
                
                // Обновляем отображение стрика
                updateStreakDisplay(data.streak);
                
                // Обновляем баланс
                const balanceElement = document.querySelector('.user-balance');
                if (balanceElement) {
                    balanceElement.textContent = `${data.coins} кредитов`;
                }
            } else {
                showNotification(data.error || 'Ошибка при получении бонуса', 'error');
            }
        })
        .catch(error => {
            console.error('Error daily checkin:', error);
            showNotification('Произошла ошибка. Попробуйте позже.', 'error');
        });
    });
}

function updateStreakDisplay(streak) {
    const days = document.querySelectorAll('.streak-day');
    
    days.forEach((day, index) => {
        if (index < streak) {
            day.classList.add('active');
        } else {
            day.classList.remove('active');
        }
    });
}

function setupReferrals() {
    const copyBtn = document.getElementById('copy-referral-link');
    if (!copyBtn) return;
    
    copyBtn.addEventListener('click', () => {
        const linkInput = document.getElementById('referral-link');
        linkInput.select();
        document.execCommand('copy');
        
        // Анимация копирования
        copyBtn.classList.add('copy-animation');
        setTimeout(() => {
            copyBtn.classList.remove('copy-animation');
        }, 500);
        
        showNotification('Ссылка скопирована!', 'success');
    });
}

function loadProfileData() {
    // Загрузка количества рефералов
    loadReferralStats();
}

function loadReferralStats() {
    const referralCount = document.getElementById('referral-count');
    const referralBonus = document.getElementById('referral-bonus');
    
    if (referralCount && referralBonus) {
        fetch('/miniapp/referral_stats')
            .then(response => response.json())
            .then(data => {
                referralCount.textContent = data.count;
                referralBonus.textContent = data.bonus;
            })
            .catch(error => {
                console.error('Error loading referral stats:', error);
            });
    }
}

function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type} show`;
    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-message">${message}</span>
        </div>
    `;
	
	function setupProfileEdit() {
    const saveBtn = document.getElementById('save-profile-btn');
    if (!saveBtn) return;
    
    saveBtn.addEventListener('click', () => {
        const fullName = document.getElementById('full_name').value;
        const birthDate = document.getElementById('birth_date').value;
        const favoriteClub = document.getElementById('favorite_club').value;
        
        // Валидация
        if (!fullName.trim()) {
            showNotification('Пожалуйста, введите ФИО', 'error');
            return;
        }
        
        // Отправка данных
        fetch('/miniapp/profile/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                full_name: fullName,
                birth_date: birthDate,
                favorite_club: favoriteClub
            })
        })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showNotification('Профиль успешно обновлен', 'success');
                
                // Через 1.5 секунды возвращаемся на страницу профиля
                setTimeout(() => {
                    window.location.href = '/miniapp/profile';
                }, 1500);
            } else {
                showNotification('Ошибка при сохранении профиля', 'error');
            }
        })
        .catch(error => {
            console.error('Error saving profile:', error);
            showNotification('Произошла ошибка. Попробуйте позже.', 'error');
        });
    });
}

// Инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    // ... существующий код ...
    
    // Если это страница редактирования профиля, настраиваем форму
    if (document.querySelector('.profile-edit-page')) {
        setupProfileEdit();
    }
});
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}