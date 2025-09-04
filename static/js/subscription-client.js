/**
 * Клиент системы автоподписок для оптимизированного получения обновлений
 * - Автоматическая подписка на интересные пользователю объекты
 * - Интеллектуальная подписка по переходам между вкладками
 * - Дедупликация и слияние данных для производительности
 * - Полная совместимость с существующей системой
 */

class SubscriptionClient {
    constructor(socket) {
        this.socket = socket;
        this.activeSubscriptions = new Map(); // тип:объект -> true
        this.dataCache = new Map(); // тип:объект -> данные
        this.handlers = new Map(); // тип -> функция обработчик
        this.autoSubscribe = true; // автоматически подписываться при добавлении обработчиков
        this.debug = localStorage.getItem('subscription_debug') === 'true';
        
        // Настройка обработчика входящих сообщений
        this.socket.on('subscription_update', (message) => this._handleUpdate(message));
        
        // Настройка обработчиков жизненного цикла страницы
        document.addEventListener('visibilitychange', () => this._handleVisibilityChange());
        window.addEventListener('beforeunload', () => this._cleanup());
        
        // Отправляем идентификацию пользователя на сервер
        this._identifyUser();
        
        this._initDefaultHandlers();
        this._log('SubscriptionClient initialized');
    }
    
    // Идентификация пользователя на сервере
    _identifyUser() {
        try {
            const initData = window.Telegram?.WebApp?.initData;
            if (initData) {
                this.socket.emit('user_connected', { initData }, (response) => {
                    if (response && response.success) {
                        this._log('User successfully identified on server');
                    } else {
                        this._log('Failed to identify user on server', true);
                    }
                });
            } else {
                this._log('No Telegram initData available for user identification');
            }
        } catch (error) {
            this._log(`User identification error: ${error}`, true);
        }
    }
    
    // Инициализация обработчиков по умолчанию
    _initDefaultHandlers() {
        // Базовый обработчик обновлений счета
        this.registerHandler('match_score', (data, objectId) => {
            const [home, away] = objectId ? objectId.split('_') : [data.home_team, data.away_team];
            
            // Находим элемент счета на странице и обновляем его
            const scoreSelectors = [
                `[data-match-id="${objectId}"] .match-score`,
                `[data-home="${home}"][data-away="${away}"] .match-score`,
                `.match-score[data-match="${home}_${away}"]`,
                `#score-${home}-${away}`,
                '.live-score'
            ];
            
            for (const selector of scoreSelectors) {
                const scoreElement = document.querySelector(selector);
                if (scoreElement) {
                    const homeScore = data.home_score !== null ? data.home_score : '-';
                    const awayScore = data.away_score !== null ? data.away_score : '-';
                    scoreElement.innerHTML = `${homeScore} : ${awayScore}`;
                    
                    // Применяем анимацию обновления
                    scoreElement.classList.add('score-updated');
                    setTimeout(() => {
                        scoreElement.classList.remove('score-updated');
                    }, 2000);
                    
                    this._log(`Updated score for ${home} vs ${away}: ${homeScore}:${awayScore}`);
                    break;
                }
            }
            
            // Обновляем статус матча если элементы есть
            const statusSelectors = [
                `[data-match-id="${objectId}"] .match-status`,
                `[data-home="${home}"][data-away="${away}"] .match-status`
            ];
            
            for (const selector of statusSelectors) {
                const statusElement = document.querySelector(selector);
                if (statusElement && data.status) {
                    statusElement.textContent = data.status;
                    break;
                }
            }
        });
        
        // Базовый обработчик обновлений составов
        this.registerHandler('match_lineup', (data, objectId) => {
            this._log(`Lineup updated for match ${objectId}`);
            
            // Если пользователь на странице этого матча, перезагружаем составы
            if (window.currentMatchId === objectId || 
                window.location.hash.includes(objectId)) {
                
                const lineupContainer = document.getElementById('match-lineups');
                if (lineupContainer) {
                    // Показываем индикатор обновления
                    const indicator = this._createUpdateIndicator();
                    lineupContainer.appendChild(indicator);
                    
                    // Делаем запрос на обновленные составы
                    fetch(`/api/match/lineups?match_id=${objectId}`)
                        .then(response => response.json())
                        .then(data => {
                            this._renderLineups(lineupContainer, data);
                            indicator.remove();
                        })
                        .catch(error => {
                            console.error('Failed to fetch updated lineups:', error);
                            indicator.remove();
                        });
                }
            }
        });
        
        // Базовый обработчик турнирной таблицы
        this.registerHandler('league_table', (data) => {
            this._log('League table updated');
            
            const tableContainer = document.getElementById('league-table-container');
            if (tableContainer && data.table) {
                this._renderLeagueTable(tableContainer, data.table);
            }
        });
        
        // Базовый обработчик новостей
        this.registerHandler('news', (data) => {
            this._log('News updated');
            
            const newsContainer = document.getElementById('news-feed');
            if (newsContainer && data.items) {
                this._renderNewsFeed(newsContainer, data.items);
            }
        });
        
        // Обработчик персональных уведомлений
        this.registerHandler('user_notif', (data) => {
            this._log('User notification received');
            
            if (data.message) {
                this._showNotification(data.message, data.type || 'info');
            }
        });
        
        // Обработчик обновления баланса
        this.registerHandler('user_credits', (data) => {
            this._log('User credits updated');
            
            const balanceElements = document.querySelectorAll('.user-balance, .credits-display');
            balanceElements.forEach(element => {
                if (data.balance !== undefined) {
                    element.textContent = data.balance;
                    element.classList.add('balance-updated');
                    setTimeout(() => {
                        element.classList.remove('balance-updated');
                    }, 1500);
                }
            });
        });
    }
    
    // Метод для регистрации обработчика определенного типа событий
    registerHandler(type, handler, autoSubscribe = true) {
        this.handlers.set(type, handler);
        this._log(`Registered handler for type: ${type}`);
        
        // Автоподписка на данный тип
        if (autoSubscribe && this.autoSubscribe) {
            this.subscribe(type);
        }
        
        return this;
    }
    
    // Подписка на определенный тип событий с опциональным ID объекта
    subscribe(type, objectId = null) {
        const key = this._getSubscriptionKey(type, objectId);
        
        // Не подписываемся повторно на уже подписанные события
        if (this.activeSubscriptions.has(key)) {
            this._log(`Already subscribed to ${key}`);
            return this;
        }
        
        this._log(`Subscribing to ${key}`);
        
        this.socket.emit('subscribe', { 
            type: type, 
            object_id: objectId 
        }, (response) => {
            if (response && response.success) {
                this.activeSubscriptions.set(key, true);
                this._log(`Successfully subscribed to ${key}`);
            } else {
                this._log(`Failed to subscribe to ${key}: ${response?.error || 'Unknown error'}`, true);
            }
        });
        
        return this;
    }
    
    // Отписка от определенного типа событий
    unsubscribe(type, objectId = null) {
        const key = this._getSubscriptionKey(type, objectId);
        
        if (!this.activeSubscriptions.has(key)) {
            this._log(`Not subscribed to ${key}`);
            return this;
        }
        
        this._log(`Unsubscribing from ${key}`);
        
        this.socket.emit('unsubscribe', { 
            type: type, 
            object_id: objectId 
        }, (response) => {
            if (response && response.success) {
                this.activeSubscriptions.delete(key);
                this._log(`Successfully unsubscribed from ${key}`);
            } else {
                this._log(`Failed to unsubscribe from ${key}: ${response?.error || 'Unknown error'}`, true);
            }
        });
        
        return this;
    }
    
    // Автоматическое управление подписками на видимые матчи
    autoSubscribeToVisibleMatches() {
        // Находим все видимые матчи на странице
        const matchElements = document.querySelectorAll('[data-match-id], [data-home][data-away]');
        
        matchElements.forEach(element => {
            let matchId = element.getAttribute('data-match-id');
            
            if (!matchId) {
                const home = element.getAttribute('data-home');
                const away = element.getAttribute('data-away');
                if (home && away) {
                    matchId = `${home}_${away}`;
                }
            }
            
            if (matchId) {
                this.subscribe('match_score', matchId);
            }
        });
    }
    
    // Автоматическое управление подписками при переключении вкладок
    setupTabSubscriptions(tabSelector, contentSelector, subscriptionMap) {
        const tabs = document.querySelectorAll(tabSelector);
        
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Определяем тип вкладки
                const tabType = tab.getAttribute('data-tab') || tab.getAttribute('data-target');
                const subscriptionInfo = subscriptionMap[tabType];
                
                if (subscriptionInfo) {
                    // Отписываемся от неактуальных подписок (опционально)
                    // this._unsubscribeAll();
                    
                    // Подписываемся на новые
                    if (Array.isArray(subscriptionInfo)) {
                        subscriptionInfo.forEach(info => {
                            const { type, objectId, dataAttribute } = info;
                            
                            if (objectId) {
                                // Конкретный ID объекта
                                this.subscribe(type, objectId);
                            } else if (dataAttribute) {
                                // Получаем ID объекта из data-атрибута
                                const container = document.querySelector(contentSelector);
                                if (container) {
                                    const objectIds = Array.from(container.querySelectorAll(`[${dataAttribute}]`))
                                        .map(el => el.getAttribute(dataAttribute));
                                    
                                    objectIds.forEach(id => this.subscribe(type, id));
                                }
                            } else {
                                // Общая подписка на тип
                                this.subscribe(type);
                            }
                        });
                    }
                }
            });
        });
        
        // Инициируем подписки для активной вкладки
        const activeTab = document.querySelector(`${tabSelector}.active, ${tabSelector}[aria-selected="true"]`);
        if (activeTab) {
            activeTab.click();
        }
    }
    
    // Обработка входящих обновлений
    _handleUpdate(message) {
        const { type, object_id: objectId, data, timestamp } = message;
        
        this._log(`Received update for ${type}:${objectId || 'general'}`);
        
        // Обновляем кэш
        const key = this._getSubscriptionKey(type, objectId);
        this.dataCache.set(key, {
            data,
            timestamp,
            received: Date.now()
        });
        
        // Вызываем соответствующий обработчик
        const handler = this.handlers.get(type);
        if (handler) {
            try {
                handler(data, objectId);
            } catch (error) {
                console.error(`Error in handler for ${type}:`, error);
            }
        } else {
            this._log(`No handler registered for type: ${type}`, true);
        }
    }
    
    // Получение ключа подписки
    _getSubscriptionKey(type, objectId = null) {
        return objectId ? `${type}:${objectId}` : type;
    }
    
    // Отписка от всех активных подписок
    _unsubscribeAll() {
        for (const key of this.activeSubscriptions.keys()) {
            const [type, objectId] = key.includes(':') ? key.split(':') : [key, null];
            this.unsubscribe(type, objectId);
        }
    }
    
    // Обработка изменений видимости страницы
    _handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            // Страница скрыта - можно приостановить некоторые подписки
            this._log('Page hidden, keeping critical subscriptions');
        } else {
            // Страница снова видима
            this._log('Page visible, all subscriptions active');
            // Можно добавить логику повторной подписки если нужно
        }
    }
    
    // Очистка при закрытии страницы
    _cleanup() {
        this._log('Cleaning up subscriptions');
        // Не отписываемся при закрытии - сервер сам очистит при disconnect
    }
    
    // Вспомогательные методы для рендеринга
    _renderLineups(container, data) {
        // Простое обновление - можно расширить
        if (data && data.home && data.away) {
            container.innerHTML = `
                <div class="lineup-updated">
                    <p>Составы обновлены</p>
                    <small>${new Date().toLocaleTimeString()}</small>
                </div>
            `;
        }
    }
    
    _renderLeagueTable(container, data) {
        // Базовая реализация - можно расширить
        if (data && Array.isArray(data)) {
            const indicator = this._createUpdateIndicator('Турнирная таблица обновлена');
            container.appendChild(indicator);
            setTimeout(() => indicator.remove(), 3000);
        }
    }
    
    _renderNewsFeed(container, items) {
        // Базовая реализация - можно расширить
        if (items && Array.isArray(items)) {
            const indicator = this._createUpdateIndicator('Новости обновлены');
            container.appendChild(indicator);
            setTimeout(() => indicator.remove(), 3000);
        }
    }
    
    _createUpdateIndicator(text = 'Данные обновлены') {
        const indicator = document.createElement('div');
        indicator.className = 'update-indicator';
        indicator.textContent = text;
        indicator.style.cssText = `
            background: #4CAF50;
            color: white;
            padding: 8px 16px;
            border-radius: 4px;
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 9999;
            font-size: 14px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            animation: slideInRight 0.3s ease-out;
        `;
        return indicator;
    }
    
    _showNotification(message, type = 'info') {
        const colors = {
            'info': '#2196F3',
            'success': '#4CAF50',
            'warning': '#FF9800',
            'error': '#F44336'
        };
        
        const notification = document.createElement('div');
        notification.textContent = message;
        notification.style.cssText = `
            background: ${colors[type] || colors.info};
            color: white;
            padding: 12px 20px;
            border-radius: 4px;
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 10000;
            max-width: 300px;
            font-size: 14px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            animation: slideInRight 0.3s ease-out;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOutRight 0.3s ease-in';
            setTimeout(() => notification.remove(), 300);
        }, 5000);
    }
    
    // Логирование
    _log(message, isError = false) {
        if (this.debug) {
            const method = isError ? 'error' : 'log';
            console[method](`[SubscriptionClient] ${message}`);
        }
    }
    
    // Получение статистики подписок
    getStats() {
        return {
            activeSubscriptions: this.activeSubscriptions.size,
            cachedData: this.dataCache.size,
            registeredHandlers: this.handlers.size,
            subscriptionList: Array.from(this.activeSubscriptions.keys())
        };
    }
}

// Инициализация клиента подписок после загрузки страницы
document.addEventListener('DOMContentLoaded', () => {
    // Убеждаемся что socket.io подключен
    if (!window.socket) {
        console.warn('[SubscriptionClient] Socket.io not initialized. Subscription client disabled.');
        return;
    }
    
    // Ждем подключения сокета перед инициализацией
    if (window.socket.connected) {
        initSubscriptionClient();
    } else {
        window.socket.on('connect', initSubscriptionClient);
    }
    
    function initSubscriptionClient() {
        // Создаем экземпляр клиента
        window.subscriptionClient = new SubscriptionClient(window.socket);
        
        // Включаем отладку в development
        if (localStorage.getItem('subscription_debug') === 'true') {
            window.subscriptionClient.debug = true;
        }
        
        // Автоматически подписываемся на видимые матчи
        window.subscriptionClient.autoSubscribeToVisibleMatches();
        
        // Настраиваем автоподписки для различных вкладок (если есть)
        const tabsExist = document.querySelector('.tab-button, .nav-tab, [role="tab"]');
        if (tabsExist) {
            window.subscriptionClient.setupTabSubscriptions(
                '.tab-button, .nav-tab, [role="tab"]', 
                '.tab-content, .tab-pane', 
                {
                    // Вкладка матчи
                    'matches': [
                        { type: 'match_score', dataAttribute: 'data-match-id' },
                        { type: 'league_table' }
                    ],
                    
                    // Вкладка статистики
                    'statistics': [
                        { type: 'stats_table' }
                    ],
                    
                    // Вкладка профиля
                    'profile': [
                        { type: 'user_notifications' },
                        { type: 'user_credits' }
                    ],
                    
                    // Вкладка новостей
                    'news': [
                        { type: 'news' }
                    ]
                }
            );
        }
        
        console.log('[SubscriptionClient] Initialized successfully');
        
        // Добавляем в глобальную область для отладки
        if (window.subscriptionClient.debug) {
            window.subStats = () => window.subscriptionClient.getStats();
        }
    }
});

// CSS анимации для индикаторов
if (!document.getElementById('subscription-animations')) {
    const style = document.createElement('style');
    style.id = 'subscription-animations';
    style.textContent = `
        @keyframes slideInRight {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes slideOutRight {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        
        .score-updated {
            background-color: rgba(76, 175, 80, 0.2) !important;
            transition: background-color 0.3s ease;
        }
        
        .balance-updated {
            background-color: rgba(255, 193, 7, 0.2) !important;
            transition: background-color 0.3s ease;
        }
        
        .update-indicator {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
    `;
    document.head.appendChild(style);
}
