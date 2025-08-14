// admin.js — логика админ-панели

document.addEventListener('DOMContentLoaded', () => {
    // Инициализация вкладок
    setupTabs();
    
    // Загрузка данных
    loadOrders();
    loadBets();
    loadMatches();
    
    // Настройка обработчиков
    setupSyncButton();
    setupOrderStatusHandlers();
});

function setupTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    const tabContents = document.querySelectorAll('.admin-tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Удаляем активный класс со всех вкладок
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Добавляем активный класс текущей вкладке
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelector(`.admin-tab-content[data-tab-content="${tabName}"]`).classList.add('active');
        });
    });
}

function loadOrders() {
    const container = document.querySelector('.orders-list');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/admin/orders')
        .then(response => response.json())
        .then(orders => {
            if (orders.length === 0) {
                container.innerHTML = '<p class="no-orders">Нет новых заказов</p>';
                return;
            }
            
            let html = '';
            orders.forEach(order => {
                html += `
                    <div class="order-card">
                        <div class="order-header">
                            <span class="order-user">${order.display_name}</span>
                            <span class="order-date">${formatDate(order.created_at)}</span>
                        </div>
                        <div class="order-details">
                            <span class="order-item">${order.item}</span>
                            <span class="order-price">${order.price} кредитов</span>
                        </div>
                        <div class="order-actions">
                            <select class="order-status" data-order-id="${order.id}">
                                <option value="pending" ${order.status === 'pending' ? 'selected' : ''}>В обработке</option>
                                <option value="processing" ${order.status === 'processing' ? 'selected' : ''}>Готовится</option>
                                <option value="shipped" ${order.status === 'shipped' ? 'selected' : ''}>Отправлен</option>
                                <option value="delivered" ${order.status === 'delivered' ? 'selected' : ''}>Доставлен</option>
                                <option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Отменен</option>
                            </select>
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
            
            // Настройка обработчиков изменения статуса
            setupOrderStatusHandlers();
        })
        .catch(error => {
            console.error('Error loading orders:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки заказов</p>';
        });
}

function loadBets() {
    const container = document.querySelector('.bets-list');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/admin/bets')
        .then(response => response.json())
        .then(bets => {
            if (bets.length === 0) {
                container.innerHTML = '<p class="no-bets">Нет ставок</p>';
                return;
            }
            
            let html = '';
            bets.forEach(bet => {
                html += `
                    <div class="bet-card">
                        <div class="bet-header">
                            <span class="bet-user">${bet.display_name}</span>
                            <span class="bet-match">${bet.team1} vs ${bet.team2}</span>
                        </div>
                        <div class="bet-details">
                            <span class="bet-type">${formatBetType(bet.type)}</span>
                            <span class="bet-amount">${bet.amount} кредитов</span>
                            ${bet.prediction ? `<span class="bet-prediction">Прогноз: ${bet.prediction}</span>` : ''}
                        </div>
                        <div class="bet-status">
                            <span class="status ${getStatusClass(bet.status)}">
                                ${formatStatus(bet.status)}
                            </span>
                        </div>
                        <div class="bet-date">
                            ${formatDate(bet.created_at)}
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
        })
        .catch(error => {
            console.error('Error loading bets:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки ставок</p>';
        });
}

function loadMatches() {
    const container = document.getElementById('matches-container');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/admin/matches')
        .then(response => response.json())
        .then(matches => {
            if (matches.length === 0) {
                container.innerHTML = '<p>Нет матчей</p>';
                return;
            }
            
            let html = '';
            matches.forEach(match => {
                html += `
                    <div class="match-card admin-match-card">
                        <div class="match-header">
                            <div class="match-date">
                                ${formatDate(match.datetime, 'date')}
                            </div>
                            <div class="match-time">
                                ${formatDate(match.datetime, 'time')}
                            </div>
                        </div>
                        
                        <div class="teams">
                            <div class="team team1">
                                <img src="/static/images/team-logos/${match.team1.toLowerCase()}.png" 
                                     onerror="this.src='/static/images/team-logos/default.png'" 
                                     alt="${match.team1}">
                                <span>${match.team1}</span>
                            </div>
                            <div class="vs">-</div>
                            <div class="team team2">
                                <img src="/static/images/team-logos/${match.team2.toLowerCase()}.png" 
                                     onerror="this.src='/static/images/team-logos/default.png'" 
                                     alt="${match.team2}">
                                <span>${match.team2}</span>
                            </div>
                        </div>
                        
                        <div class="match-score">
                            <input type="number" class="score-input score1" value="${match.score1 || 0}" data-match-id="${match.id}" data-team="1">
                            <span>:</span>
                            <input type="number" class="score-input score2" value="${match.score2 || 0}" data-match-id="${match.id}" data-team="2">
                        </div>
                        
                        <div class="match-status">
                            <span class="status ${match.status === 'scheduled' ? 'scheduled' : match.status === 'live' ? 'live' : 'finished'}">
                                ${formatMatchStatus(match.status)}
                            </span>
                        </div>
                        
                        <div class="match-actions">
                            <button class="update-score-btn btn" data-match-id="${match.id}">Обновить счет</button>
                        </div>
                    </div>
                `;
            });
            
            container.innerHTML = html;
            
            // Настройка обработчиков обновления счета
            setupScoreUpdateHandlers();
        })
        .catch(error => {
            console.error('Error loading matches:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки матчей</p>';
        });
}

function setupScoreUpdateHandlers() {
    document.querySelectorAll('.update-score-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const matchId = btn.dataset.matchId;
            const score1 = document.querySelector(`.score1[data-match-id="${matchId}"]`).value;
            const score2 = document.querySelector(`.score2[data-match-id="${matchId}"]`).value;
            
            updateMatchScore(matchId, score1, score2);
        });
    });
}

function updateMatchScore(matchId, score1, score2) {
    fetch('/miniapp/admin/set_match_result', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            match_id: matchId,
            score1: score1,
            score2: score2
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('Счет матча обновлен', 'success');
            loadMatches(); // Перезагружаем матчи
        } else {
            showNotification(data.error || 'Ошибка при обновлении счета', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating match score:', error);
        showNotification('Произошла ошибка. Попробуйте позже.', 'error');
    });
}

function setupOrderStatusHandlers() {
    document.querySelectorAll('.order-status').forEach(select => {
        select.addEventListener('change', () => {
            const orderId = select.dataset.orderId;
            const status = select.value;
            
            updateOrderStatus(orderId, status);
        });
    });
}

function updateOrderStatus(orderId, status) {
    fetch('/miniapp/admin/update_order_status', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            order_id: orderId,
            status: status
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('Статус заказа обновлен', 'success');
        } else {
            showNotification(data.error || 'Ошибка при обновлении статуса', 'error');
        }
    })
    .catch(error => {
        console.error('Error updating order status:', error);
        showNotification('Произошла ошибка. Попробуйте позже.', 'error');
    });
}

function setupSyncButton() {
    const syncBtn = document.getElementById('sync-data-btn');
    const syncStatus = document.getElementById('sync-status');
    
    if (syncBtn) {
        syncBtn.addEventListener('click', () => {
            syncBtn.disabled = true;
            syncStatus.textContent = 'Синхронизация данных...';
            syncStatus.className = 'sync-status';
            
            fetch('/miniapp/admin/update_data', {
                method: 'POST'
            })
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    syncStatus.textContent = 'Данные успешно синхронизированы!';
                    syncStatus.className = 'sync-status success';
                } else {
                    syncStatus.textContent = `Ошибка синхронизации: ${data.error}`;
                    syncStatus.className = 'sync-status error';
                }
                
                setTimeout(() => {
                    syncBtn.disabled = false;
                    syncStatus.textContent = '';
                    syncStatus.className = 'sync-status';
                }, 3000);
            })
            .catch(error => {
                console.error('Error syncing data:', error);
                syncStatus.textContent = 'Ошибка соединения с сервером';
                syncStatus.className = 'sync-status error';
                
                setTimeout(() => {
                    syncBtn.disabled = false;
                    syncStatus.textContent = '';
                    syncStatus.className = 'sync-status';
                }, 3000);
            });
        });
    }
}

function formatDate(dateString, format = 'full') {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    
    if (format === 'date') {
        return date.toLocaleDateString('ru-RU');
    } else if (format === 'time') {
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else {
        return date.toLocaleString('ru-RU');
    }
}

function formatBetType(type) {
    const types = {
        'team1': 'Победа 1-й команды',
        'team2': 'Победа 2-й команды',
        'draw': 'Ничья',
        'total_goals': 'Тотал голов',
        'penalty': 'Пенальти',
        'red_card': 'Удаление'
    };
    return types[type] || type;
}

function formatStatus(status) {
    const statuses = {
        'active': 'Активна',
        'won': 'Выиграна',
        'lost': 'Проиграна',
        'settled': 'Завершена'
    };
    return statuses[status] || status;
}

function getStatusClass(status) {
    const classes = {
        'active': 'status-active',
        'won': 'status-won',
        'lost': 'status-lost',
        'settled': 'status-settled'
    };
    return classes[status] || 'status-active';
}

function formatMatchStatus(status) {
    const statuses = {
        'scheduled': 'Запланирован',
        'live': 'Идет матч',
        'finished': 'Завершен'
    };
    return statuses[status] || status;
}

function showNotification(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type} show`;
    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-message">${message}</span>
        </div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            document.body.removeChild(toast);
        }, 300);
    }, 3000);
}