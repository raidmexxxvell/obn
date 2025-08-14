// predictions.js — логика страницы прогнозов

document.addEventListener('DOMContentLoaded', () => {
    // Инициализация вкладок
    setupTabs();
    
    // Инициализация ставок
    setupBets();
    
    // Инициализация моих ставок
    loadUserBets();
    
    // Обработчик изменения типа ставки
    setupBetTypeHandlers();
    
    // Обработчик формы ставки
    setupBetFormHandler();
});

function setupTabs() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Удаляем активный класс со всех вкладок
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Добавляем активный класс текущей вкладке
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            document.querySelector(`.tab-content[data-tab-content="${tabName}"]`).classList.add('active');
        });
    });
}

function setupBets() {
    // Обработчик кликов по типам ставок
    document.querySelectorAll('.bet-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            // Удаляем активный класс со всех кнопок
            document.querySelectorAll('.bet-type-btn').forEach(b => {
                b.classList.remove('active');
            });
            
            // Добавляем активный класс текущей кнопке
            btn.classList.add('active');
            
            // Показываем поле прогноза, если нужно
            const predictionInput = document.querySelector('.bet-prediction');
            if (btn.dataset.type === 'total_goals' || 
                btn.dataset.type === 'penalty' || 
                btn.dataset.type === 'red_card') {
                predictionInput.style.display = 'block';
                
                if (btn.dataset.type === 'total_goals') {
                    predictionInput.placeholder = 'Введите количество голов';
                } else if (btn.dataset.type === 'penalty') {
                    predictionInput.placeholder = 'Да/Нет';
                } else if (btn.dataset.type === 'red_card') {
                    predictionInput.placeholder = 'Да/Нет';
                }
            } else {
                predictionInput.style.display = 'none';
                predictionInput.value = '';
            }
        });
    });
}

function setupBetTypeHandlers() {
    document.querySelectorAll('.bet-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.bet-type-btn').forEach(b => {
                b.classList.remove('active');
            });
            btn.classList.add('active');
        });
    });
}

function setupBetFormHandler() {
    document.querySelectorAll('.place-bet-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const matchId = btn.dataset.matchId;
            const amountInput = btn.closest('.match-card').querySelector('.bet-amount');
            const predictionInput = btn.closest('.match-card').querySelector('.bet-prediction');
            const activeBetTypeBtn = btn.closest('.match-card').querySelector('.bet-type-btn.active');
            
            if (!activeBetTypeBtn) {
                showNotification('Выберите тип ставки', 'error');
                return;
            }
            
            const amount = parseInt(amountInput.value);
            const betType = activeBetTypeBtn.dataset.type;
            let prediction = '';
            
            if (betType === 'total_goals' || betType === 'penalty' || betType === 'red_card') {
                prediction = predictionInput.value.trim();
                
                // Валидация для ставки на тотал голов
                if (betType === 'total_goals' && prediction) {
                    const total = parseFloat(prediction);
                    if (isNaN(total) || total < 0) {
                        showNotification('Введите корректное количество голов', 'error');
                        return;
                    }
                }
                
                // Валидация для ставки на пенальти и удаление
                if ((betType === 'penalty' || betType === 'red_card') && prediction) {
                    if (prediction.toLowerCase() !== 'да' && prediction.toLowerCase() !== 'нет') {
                        showNotification('Введите "да" или "нет"', 'error');
                        return;
                    }
                }
            }
            
            // Валидация
            if (!amount || amount < 10) {
                showNotification('Минимальная сумма ставки 10 кредитов', 'error');
                return;
            }
            
            try {
                const response = await fetch('/miniapp/place_bet', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        match_id: matchId,
                        bet_type: betType,
                        amount: amount,
                        prediction: prediction
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    showNotification(`Ставка на ${amount} кредитов сделана!`, 'success');
                    amountInput.value = '';
                    predictionInput.value = '';
                    
                    // Обновляем баланс
                    const balanceElement = document.querySelector('.user-balance');
                    if (balanceElement) {
                        balanceElement.textContent = `${data.new_balance} кредитов`;
                    }
                } else {
                    showNotification(data.error || 'Ошибка при создании ставки', 'error');
                }
            } catch (error) {
                console.error('Error placing bet:', error);
                showNotification('Произошла ошибка. Попробуйте позже.', 'error');
            }
        });
    });
}

function loadUserBets() {
    const container = document.getElementById('user-bets-container');
    if (!container) return;
    
    container.innerHTML = '<div class="loader"></div>';
    
    fetch('/miniapp/bets')
        .then(response => response.json())
        .then(bets => {
            if (bets.length === 0) {
                container.innerHTML = '<p class="no-bets">У вас пока нет ставок</p>';
                return;
            }
            
            let html = '<div class="bets-list">';
            bets.forEach(bet => {
                html += `
                    <div class="bet-card">
                        <div class="bet-header">
                            <span class="bet-user">Вы</span>
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
                            ${new Date(bet.created_at).toLocaleString()}
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            
            container.innerHTML = html;
        })
        .catch(error => {
            console.error('Error loading bets:', error);
            container.innerHTML = '<p class="error">Ошибка загрузки ставок</p>';
        });
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