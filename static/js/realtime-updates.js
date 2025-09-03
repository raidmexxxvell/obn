/**
 * Real-time updates через WebSocket для мгновенного отображения изменений
 * Минимизирует количество polling запросов к серверу
 */

class RealtimeUpdater {
    constructor() {
        this.socket = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.isConnected = false;
        this.callbacks = new Map();
        this.debug = localStorage.getItem('websocket_debug') === 'true';
        
        this.initSocket();
    }
    
    initSocket() {
        try {
            if (!window.__WEBSOCKETS_ENABLED__) {  return; }
            // Проверяем поддержку Socket.IO
            if (typeof io === 'undefined') {
                
                return;
            }
            // Пробный ping на /socket.io/ без апгрейда: если 4xx/5xx — отключаем
            try {
                fetch('/socket.io/?EIO=4&transport=polling&t=' + Date.now(), { method: 'GET' })
                    .then(r => { if (!r.ok) {  window.__WEBSOCKETS_ENABLED__ = false; } });
            } catch(_) {}
            this.socket = io({
                transports: ['websocket','polling'],
                upgrade: true,
                rememberUpgrade: true,
                timeout: 20000,
                forceNew: false
            });
            this.setupEventHandlers();
        } catch (error) {
            
        }
    }
    
    setupEventHandlers() {
        if (!this.socket) return;
        
        this.socket.on('connect', () => {
            
            this.isConnected = true;
            this.reconnectAttempts = 0;
            
            // Уведомляем сервер о подключении пользователя
            const initData = window.Telegram?.WebApp?.initData;
            if (initData) {
                this.socket.emit('user_connected', { initData });
            }
        });
        
        this.socket.on('disconnect', (reason) => {
            
            this.isConnected = false;
            
            if (reason === 'io server disconnect') {
                // Сервер принудительно отключил - переподключаемся
                this.scheduleReconnect();
            }
        });
        
        this.socket.on('connect_error', (error) => {
            
            this.isConnected = false;
            this.scheduleReconnect();
        });
        
        // Основной обработчик обновлений данных
        this.socket.on('data_changed', (message) => {
            this.handleDataUpdate(message);
        });
        
        // Обработчик live обновлений матчей
        this.socket.on('live_update', (message) => {
            this.handleLiveUpdate(message);
        });
        
        if (this.debug) {
            this.socket.onAny((eventName, ...args) => {
                
            });
        }
    }
    
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            
            return;
        }
        
        this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    // Планируем повторное подключение через delay мс (экспоненциальная задержка)
        
        setTimeout(() => {
            if (!this.isConnected) {
                this.socket?.connect();
            }
        }, delay);
    }
    
    handleDataUpdate(message) {
        const { type, data_type, data, timestamp } = message;
        
        if (this.debug) {
            
        }
        
        // Вызываем зарегистрированные callbacks
        const callbacks = this.callbacks.get(data_type) || [];
        callbacks.forEach(callback => {
            try {
                callback(data, timestamp);
            } catch (error) {
                
            }
        });
        
        // Стандартные обновления UI
        this.updateUI(data_type, data, timestamp);
    }
    
    handleLiveUpdate(message) {
        const { home, away, data } = message;
        
        if (this.debug) {
            
        }
        
        // Обновляем счет матча в real-time
        this.updateMatchScore(home, away, data);
        
        // Показываем уведомление
        this.showNotification(`${home} ${data.score_home || 0} - ${data.score_away || 0} ${away}`);
    }
    
    updateUI(dataType, data, timestamp) {
        switch (dataType) {
            case 'league_table':
                this.refreshLeagueTable();
                break;
                
            case 'schedule':
                this.refreshSchedule();
                break;
                
            case 'match_details':
                this.refreshMatchDetails(data);
                break;
                
            case 'betting_odds':
                this.refreshBettingOdds(data);
                break;
            case 'lineups_updated':
                // Авто-обновление составов конкретного матча
                this.handleLineupsUpdated(data);
                break;
                
            default:
                // Общее обновление данных
                this.triggerDataRefresh(dataType);
        }
    }

    handleLineupsUpdated(data){
        try {
            if(!data) return;
            // Проверяем, есть ли на странице что-то связанное с матчем (ростер или карточка матча)
            const selectorMatchCard = `[data-match-home="${data.home}"][data-match-away="${data.away}"]`;
            const rosterPresent = document.querySelector('.roster-table') || document.querySelector(selectorMatchCard);
            if(!rosterPresent){
                // Ничего подходящего – пропускаем тихо
                return;
            }
            // Фетчим свежие детали матча, чтобы получить обновлённые составы
            if(data.home && data.away){
                                const params = new URLSearchParams({ home: data.home, away: data.away });
                                // сначала пробуем новый компактный эндпоинт из БД
                                fetch(`/api/match/lineups?${params.toString()}`, { headers: { 'Cache-Control':'no-store' } })
                                    .then(r=> r.ok? r.json(): Promise.reject(new Error('HTTP '+r.status)))
                                    .then(dbPayload => {
                                            // Трансформируем в формат match-details (минимум, чтобы слушатели отработали)
                                            const details = { rosters: dbPayload.rosters || {home:[],away:[]}, source: 'db' };
                                            this.refreshMatchDetails(details);
                                            this.showNotification(`Обновлены составы: ${data.home} vs ${data.away}`);
                                    })
                                    .catch(_=>{
                                        // fallback на старый эндпоинт, если ошибка
                                        fetch(`/api/match-details?${params.toString()}`, { headers: { 'Cache-Control':'no-store' } })
                                            .then(r=> r.ok? r.json(): Promise.reject(new Error('HTTP '+r.status)))
                                            .then(details => { this.refreshMatchDetails(details); this.showNotification(`Обновлены составы: ${data.home} vs ${data.away}`); })
                                            .catch(()=>{});
                                    });
            }
        } catch(_) {}
    }
    
    updateMatchScore(home, away, data) {
        // Обновляем отображение счета матча
        const matchElements = document.querySelectorAll(`[data-match-home="${home}"][data-match-away="${away}"]`);
        
        matchElements.forEach(element => {
            const scoreElement = element.querySelector('.match-score');
            if (scoreElement && data.score_home !== undefined && data.score_away !== undefined) {
                scoreElement.textContent = `${data.score_home} - ${data.score_away}`;
                
                // Добавляем анимацию обновления
                scoreElement.classList.add('score-updated');
                setTimeout(() => {
                    scoreElement.classList.remove('score-updated');
                }, 2000);
            }
        });
    }
    
    showNotification(message) {
        // system notification (browser) optional
        try {
            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('Лига Обнинска', { body: message, icon: '/static/img/logo.png', silent: true });
            }
        } catch(_) {}
        // Unified UI notification
        if (window.NotificationSystem) {
            window.NotificationSystem.show(message, 'info', 4000);
        } else if (window.showAlert) {
            window.showAlert(message, 'info');
        } else {
            try {  } catch(_) {}
        }
    }
    
    // API для подписки на обновления
    subscribe(dataType, callback) {
        if (!this.callbacks.has(dataType)) {
            this.callbacks.set(dataType, []);
        }
        this.callbacks.get(dataType).push(callback);
    }
    
    unsubscribe(dataType, callback) {
        const callbacks = this.callbacks.get(dataType);
        if (callbacks) {
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
            }
        }
    }
    
    // Методы для принудительного обновления UI
    refreshLeagueTable() {
        if (typeof window.League?.refreshTable === 'function') {
            window.League.refreshTable();
        }
    }
    
    refreshSchedule() {
        if (typeof window.League?.refreshSchedule === 'function') {
            window.League.refreshSchedule();
        }
    }
    
    refreshMatchDetails(data) {
        // Обновляем детали матча
        const event = new CustomEvent('matchDetailsUpdate', { detail: data });
        document.dispatchEvent(event);
    }
    
    refreshBettingOdds(data) {
        // Обновляем коэффициенты ставок
        const event = new CustomEvent('bettingOddsUpdate', { detail: data });
        document.dispatchEvent(event);
    }
    
    triggerDataRefresh(dataType) {
        // Общий триггер обновления данных
        const event = new CustomEvent('dataRefresh', { detail: { type: dataType } });
        document.dispatchEvent(event);
    }
    
    // Подключение к комнате матча для live обновлений
    joinMatchRoom(home, away) {
        if (this.socket && this.isConnected) {
            this.socket.emit('join_match_room', { home, away });
        }
    }
    
    leaveMatchRoom(home, away) {
        if (this.socket && this.isConnected) {
            this.socket.emit('leave_match_room', { home, away });
        }
    }
    
    // Статус подключения
    getConnectionStatus() {
        return {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            socket: !!this.socket
        };
    }
}

// Глобальная инициализация
window.realtimeUpdater = null;

// Инициализируем после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
    // Запрашиваем разрешение на уведомления
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    // Инициализируем updater с небольшой задержкой
    setTimeout(() => {
        window.realtimeUpdater = new RealtimeUpdater();
    }, 1000);
});

// Экспорт для использования в других модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = RealtimeUpdater;
}
