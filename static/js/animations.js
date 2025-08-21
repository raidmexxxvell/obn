/**
 * Система анимаций для футбольного приложения
 * Включает уведомления, счетчики, награды и переходы
 */

// Система красивых уведомлений вместо tg.showAlert
class NotificationSystem {
    constructor() {
        this.container = this.createContainer();
        this.queue = [];
        this.isShowing = false;
    }

    createContainer() {
        const container = document.createElement('div');
        container.id = 'notification-container';
        container.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 10000;
            pointer-events: none;
            width: 90%;
            max-width: 400px;
        `;
        document.body.appendChild(container);
        return container;
    }

    show(message, type = 'info', duration = 3000) {
        this.queue.push({ message, type, duration });
        if (!this.isShowing) {
            this.processQueue();
        }
    }

    async processQueue() {
        if (this.queue.length === 0) {
            this.isShowing = false;
            return;
        }

        this.isShowing = true;
        const { message, type, duration } = this.queue.shift();

        const notification = this.createNotification(message, type);
        this.container.appendChild(notification);

        // Анимация появления
        await this.animateIn(notification);
        
        // Ждем время показа
        await new Promise(resolve => setTimeout(resolve, duration));
        
        // Анимация исчезновения
        await this.animateOut(notification);
        
        // Удаляем элемент
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }

        // Обрабатываем следующее уведомление
        this.processQueue();
    }

    createNotification(message, type) {
        const notification = document.createElement('div');
        notification.className = `app-notification notification-${type}`;
        
        const icon = this.getIcon(type);
        
        notification.innerHTML = `
            <div class="notification-content">
                <div class="notification-icon">${icon}</div>
                <div class="notification-text">${message}</div>
            </div>
        `;

        return notification;
    }

    getIcon(type) {
        const icons = {
            success: '✅',
            error: '❌',
            warning: '⚠️',
            info: 'ℹ️',
            reward: '🎁'
        };
        return icons[type] || icons.info;
    }

    async animateIn(element) {
        element.style.cssText += `
            opacity: 0;
            transform: translateY(-20px) scale(0.9);
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        `;

        // Запускаем анимацию в следующем кадре
        await new Promise(resolve => {
            requestAnimationFrame(() => {
                element.style.opacity = '1';
                element.style.transform = 'translateY(0) scale(1)';
                setTimeout(resolve, 300);
            });
        });
    }

    async animateOut(element) {
        return new Promise(resolve => {
            element.style.transition = 'all 0.2s ease-in';
            element.style.opacity = '0';
            element.style.transform = 'translateY(-10px) scale(0.95)';
            setTimeout(resolve, 200);
        });
    }
}

// Система анимированных счетчиков
class CounterAnimation {
    static animate(element, startValue, endValue, duration = 1000, formatter = null) {
        return new Promise(resolve => {
            const start = parseFloat(startValue) || 0;
            const end = parseFloat(endValue) || 0;
            const startTime = performance.now();
            
            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                // Easing function (ease-out)
                const easeOut = 1 - Math.pow(1 - progress, 3);
                
                const currentValue = start + (end - start) * easeOut;
                const displayValue = formatter ? formatter(currentValue) : Math.round(currentValue);
                
                element.textContent = displayValue;
                
                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    element.textContent = formatter ? formatter(end) : end;
                    resolve();
                }
            };
            
            requestAnimationFrame(animate);
        });
    }
}

// Система анимации наград
class RewardAnimation {
    static async show(container, xpGain, creditsGain) {
        const overlay = document.createElement('div');
        overlay.className = 'reward-overlay';
        overlay.innerHTML = `
            <div class="reward-modal">
                <div class="reward-title">🎁 Ежедневная награда!</div>
                <div class="reward-items">
                    <div class="reward-item">
                        <div class="reward-icon">⭐</div>
                        <div class="reward-value" data-type="xp">+${xpGain}</div>
                        <div class="reward-label">XP</div>
                    </div>
                    <div class="reward-item">
                        <div class="reward-icon">💰</div>
                        <div class="reward-value" data-type="credits">+${creditsGain}</div>
                        <div class="reward-label">Кредитов</div>
                    </div>
                </div>
                <div class="reward-celebration"></div>
            </div>
        `;

        container.appendChild(overlay);

        // Анимация появления модалки
        await this.animateModalIn(overlay);
        
        // Анимация значений
        await this.animateValues(overlay);
        
        // Эффект празднования
        await this.showCelebration(overlay);
        
        // Ждем 2 секунды
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Анимация исчезновения
        await this.animateModalOut(overlay);
        
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }

    static async animateModalIn(overlay) {
        const modal = overlay.querySelector('.reward-modal');
        
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
            opacity: 0;
            backdrop-filter: blur(5px);
            transition: all 0.3s ease;
        `;

        modal.style.cssText = `
            background: linear-gradient(135deg, var(--primary), var(--accent));
            border-radius: 20px;
            padding: 30px;
            text-align: center;
            color: white;
            transform: scale(0.5) rotateY(90deg);
            transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
        `;

        await new Promise(resolve => {
            requestAnimationFrame(() => {
                overlay.style.opacity = '1';
                modal.style.transform = 'scale(1) rotateY(0deg)';
                setTimeout(resolve, 400);
            });
        });
    }

    static async animateValues(overlay) {
        const values = overlay.querySelectorAll('.reward-value');
        
        for (const value of values) {
            const originalText = value.textContent;
            const number = parseInt(originalText.replace('+', ''));
            
            value.style.cssText = `
                font-size: 24px;
                font-weight: bold;
                color: #FFD700;
                transition: all 0.3s ease;
            `;

            // Анимация пульсации
            value.style.transform = 'scale(1.2)';
            value.style.textShadow = '0 0 10px #FFD700';
            
            await new Promise(resolve => setTimeout(resolve, 300));
            
            value.style.transform = 'scale(1)';
            value.style.textShadow = 'none';
            
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    static async showCelebration(overlay) {
        const celebration = overlay.querySelector('.reward-celebration');
        
        // Создаем частицы конфетти
        for (let i = 0; i < 20; i++) {
            const particle = document.createElement('div');
            particle.style.cssText = `
                position: absolute;
                width: 8px;
                height: 8px;
                background: ${['#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1'][i % 4]};
                border-radius: 50%;
                top: 50%;
                left: 50%;
                pointer-events: none;
                z-index: 1;
            `;
            
            celebration.appendChild(particle);
            
            // Анимация частицы
            const angle = (i / 20) * Math.PI * 2;
            const distance = 100 + Math.random() * 50;
            const duration = 800 + Math.random() * 400;
            
            particle.animate([
                {
                    transform: 'translate(0, 0) scale(0)',
                    opacity: 1
                },
                {
                    transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(1)`,
                    opacity: 0
                }
            ], {
                duration,
                easing: 'ease-out'
            });
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    static async animateModalOut(overlay) {
        const modal = overlay.querySelector('.reward-modal');
        
        modal.style.transition = 'all 0.3s ease';
        modal.style.transform = 'scale(0.8) rotateY(-90deg)';
        overlay.style.opacity = '0';
        
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Система общих анимаций интерфейса
class UIAnimations {
    static fadeIn(element, duration = 300) {
        return new Promise(resolve => {
            element.style.opacity = '0';
            element.style.transition = `opacity ${duration}ms ease`;
            
            requestAnimationFrame(() => {
                element.style.opacity = '1';
                setTimeout(resolve, duration);
            });
        });
    }

    static slideIn(element, direction = 'up', duration = 300) {
        const transforms = {
            up: 'translateY(20px)',
            down: 'translateY(-20px)',
            left: 'translateX(20px)',
            right: 'translateX(-20px)'
        };

        return new Promise(resolve => {
            element.style.opacity = '0';
            element.style.transform = transforms[direction];
            element.style.transition = `all ${duration}ms cubic-bezier(0.34, 1.56, 0.64, 1)`;
            
            requestAnimationFrame(() => {
                element.style.opacity = '1';
                element.style.transform = 'translateY(0) translateX(0)';
                setTimeout(resolve, duration);
            });
        });
    }

    static pulse(element, scale = 1.05, duration = 200) {
        return new Promise(resolve => {
            const originalTransform = element.style.transform;
            element.style.transition = `transform ${duration}ms ease`;
            element.style.transform = `scale(${scale})`;
            
            setTimeout(() => {
                element.style.transform = originalTransform;
                setTimeout(resolve, duration);
            }, duration);
        });
    }

    static shake(element, intensity = 5, duration = 300) {
        return new Promise(resolve => {
            const originalTransform = element.style.transform;
            let startTime = performance.now();
            
            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                
                if (progress < 1) {
                    const shake = Math.sin(progress * Math.PI * 8) * intensity * (1 - progress);
                    element.style.transform = `translateX(${shake}px)`;
                    requestAnimationFrame(animate);
                } else {
                    element.style.transform = originalTransform;
                    resolve();
                }
            };
            
            requestAnimationFrame(animate);
        });
    }
}

// Глобальная инициализация
window.NotificationSystem = new NotificationSystem();
window.CounterAnimation = CounterAnimation;
window.RewardAnimation = RewardAnimation;
window.UIAnimations = UIAnimations;

// Утилитарная функция для создания команды с логотипом
window.createTeamWithLogo = function(teamName, options = {}) {
    const { 
        showLogo = true, 
        logoSize = '20px', 
        className = 'team-with-logo',
        textClassName = 'team-name',
        logoClassName = 'team-logo'
    } = options;
    
    const container = document.createElement('div');
    container.className = className;
    container.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
    `;
    
    if (showLogo) {
        const logo = document.createElement('img');
        logo.className = logoClassName;
        logo.alt = teamName || '';
        logo.style.cssText = `
            width: ${logoSize};
            height: ${logoSize};
            object-fit: contain;
            border-radius: 2px;
            flex-shrink: 0;
        `;
        
        // Устанавливаем логотип команды
        setTeamLogo(logo, teamName);
        container.appendChild(logo);
    }
    
    const nameEl = document.createElement('span');
    nameEl.className = textClassName;
    nameEl.textContent = teamName || '';
    container.appendChild(nameEl);
    
    return container;
};

// Функция для установки логотипа команды
window.setTeamLogo = function(imgEl, teamName) {
    const base = '/static/img/team-logos/';
    const name = (teamName || '').trim();
    const candidates = [];
    
    try { 
        imgEl.loading = 'lazy'; 
        imgEl.decoding = 'async'; 
    } catch(_) {}
    
    if (name) {
        const norm = name.toLowerCase()
            .replace(/\s+/g, '')
            .replace(/ё/g, 'е')
            .replace(/фк/g, '')
            .replace(/fc/g, '')
            .replace(/fk/g, '');
        candidates.push(base + encodeURIComponent(norm + '.png'));
    }
    
    candidates.push(base + 'default.png');
    
    let i = 0;
    const next = () => { 
        if (i >= candidates.length) return; 
        imgEl.onerror = () => { i++; next(); }; 
        imgEl.src = candidates[i]; 
    };
    next();
};

// Функция для добавления логотипов к существующим названиям команд
window.enhanceTeamNames = function(selector = '.team-name, .match-teams, .team-text') {
    document.querySelectorAll(selector).forEach(element => {
        const teamName = element.textContent.trim();
        if (!teamName || element.querySelector('.team-logo')) return; // уже обработано
        
        // Создаем контейнер с логотипом
        const teamContainer = window.createTeamWithLogo(teamName, {
            logoSize: '18px',
            className: 'enhanced-team'
        });
        
        // Заменяем содержимое элемента
        element.innerHTML = '';
        element.appendChild(teamContainer);
    });
};

// Красивая замена для tg.showAlert
window.showAlert = function(message, type = 'info') {
    try {
        // Пытаемся использовать Telegram alert если доступен
        if (window.Telegram?.WebApp?.showAlert && type === 'info') {
            window.Telegram.WebApp.showAlert(message);
        } else {
            // Используем нашу систему уведомлений
            window.NotificationSystem.show(message, type);
        }
    } catch (e) {
        // Fallback на обычный alert
        alert(message);
    }
};

// CSS стили для анимаций
const animationStyles = `
/* Стили для команд с логотипами */
.team-with-logo, .enhanced-team {
    display: inline-flex !important;
    align-items: center;
    gap: 6px;
}

.team-logo {
    width: 18px;
    height: 18px;
    object-fit: contain;
    border-radius: 2px;
    flex-shrink: 0;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
}

.team-logo.large {
    width: 24px;
    height: 24px;
}

.team-logo.small {
    width: 16px;
    height: 16px;
}

/* Анимации для логотипов */
.team-logo {
    transition: all 0.2s ease;
}

.team-logo:hover {
    transform: scale(1.1);
    filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
}

.app-notification {
    background: linear-gradient(135deg, var(--surface-light, #2a2a2a), var(--surface, #1a1a1a));
    color: var(--text, white);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
    backdrop-filter: blur(10px);
    pointer-events: auto;
}

.notification-success {
    border-left: 4px solid var(--success, #4CAF50);
}

.notification-error {
    border-left: 4px solid var(--danger, #f44336);
}

.notification-warning {
    border-left: 4px solid var(--warning, #ff9800);
}

.notification-info {
    border-left: 4px solid var(--primary, #2196F3);
}

.notification-reward {
    border-left: 4px solid var(--accent, #FFD700);
    background: linear-gradient(135deg, rgba(255, 215, 0, 0.1), rgba(255, 193, 7, 0.05));
}

.notification-content {
    display: flex;
    align-items: center;
    gap: 12px;
}

.notification-icon {
    font-size: 20px;
    flex-shrink: 0;
}

.notification-text {
    flex: 1;
    font-size: 14px;
    line-height: 1.4;
}

.reward-title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 20px;
    text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.reward-items {
    display: flex;
    gap: 30px;
    justify-content: center;
    margin-bottom: 20px;
}

.reward-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
}

.reward-icon {
    font-size: 32px;
    margin-bottom: 8px;
}

.reward-value {
    font-size: 24px;
    font-weight: bold;
    color: #FFD700;
}

.reward-label {
    font-size: 12px;
    opacity: 0.9;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.reward-celebration {
    position: relative;
    width: 100%;
    height: 20px;
}

/* Анимации для статистики админа */
.stat-update-animation {
    animation: statPulse 0.3s ease;
}

@keyframes statPulse {
    0% { transform: scale(1); }
    50% { transform: scale(1.1); background-color: var(--accent, #FFD700); }
    100% { transform: scale(1); }
}

/* Улучшенные переходы для кнопок */
.app-btn, .details-btn {
    transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.app-btn:hover, .details-btn:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.app-btn:active, .details-btn:active {
    transform: translateY(0);
    transition: transform 0.1s ease;
}

/* Анимации для загрузки */
.loading-pulse {
    animation: loadingPulse 1.5s ease-in-out infinite;
}

@keyframes loadingPulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
}

/* Плавные переходы для панелей */
.panel-transition {
    transition: all 0.3s ease;
}

.panel-slide-in {
    animation: slideInUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes slideInUp {
    from {
        opacity: 0;
        transform: translateY(20px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}
`;

// Добавляем стили в head
const styleSheet = document.createElement('style');
styleSheet.textContent = animationStyles;
document.head.appendChild(styleSheet);

// Автоматическая инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
    // Добавляем логотипы к существующим названиям команд
    setTimeout(() => {
        if (window.enhanceTeamNames) {
            window.enhanceTeamNames();
        }
    }, 1000); // небольшая задержка для загрузки контента
});

// Периодически проверяем новые элементы (для динамически добавляемого контента)
setInterval(() => {
    if (window.enhanceTeamNames) {
        window.enhanceTeamNames();
    }
}, 5000); // каждые 5 секунд
