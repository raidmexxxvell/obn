// Проверка новых уведомлений
function checkNotifications() {
    fetch('/miniapp/notifications')
        .then(response => response.json())
        .then(notifications => {
            if (notifications.length > 0) {
                showNotification(notifications[0]);
            }
        });
}

// Показ уведомления
function showNotification(notification) {
    const container = document.getElementById('notification-container');
    const score1 = document.getElementById('notif-score1');
    const score2 = document.getElementById('notif-score2');
    const event = document.getElementById('notif-event');
    const watchBtn = document.getElementById('watch-live-btn');
    
    score1.textContent = notification.score1;
    score2.textContent = notification.score2;
    event.textContent = notification.event;
    
    // Настройка кнопки просмотра
    watchBtn.onclick = () => {
        // Переход к трансляции матча
        window.location.href = `/miniapp/match/${notification.match_id}#stream`;
    };
    
    // Показываем уведомление с анимацией
    container.classList.remove('hidden');
    container.classList.add('slide-in');
    
    // Автоматическое скрытие через 10 секунд
    setTimeout(() => {
        hideNotification();
    }, 10000);
    
    // Помечаем уведомление как просмотренное
    fetch(`/miniapp/notification/seen/${notification.id}`);
}

// Скрытие уведомления
function hideNotification() {
    const container = document.getElementById('notification-container');
    container.classList.remove('slide-in');
    container.classList.add('slide-out');
    
    setTimeout(() => {
        container.classList.add('hidden');
        container.classList.remove('slide-out');
    }, 500);
}

// Проверка уведомлений каждые 5 секунд
setInterval(checkNotifications, 5000);

// Инициализация
document.addEventListener('DOMContentLoaded', checkNotifications);
// Показ уведомления
function showNotification(notification) {
    const container = document.getElementById('notification-container');
    const score1 = document.getElementById('notif-score1');
    const score2 = document.getElementById('notif-score2');
    const event = document.getElementById('notif-event');
    const watchBtn = document.getElementById('watch-live-btn');
    
    score1.textContent = notification.score1;
    score2.textContent = notification.score2;
    event.textContent = notification.event;
    
    // Настройка кнопки просмотра
    watchBtn.onclick = () => {
        // Переход к трансляции матча
        window.location.href = `/miniapp/match/${notification.match_id}#stream`;
    };
    
    // Показываем уведомление с анимацией
    container.classList.remove('hidden');
    container.classList.add('slide-in');
    
    // Анимация переворота табло
    setTimeout(() => {
        document.querySelector('.notification-banner').classList.add('flip-animation');
    }, 500);
    
    // Автоматическое скрытие через 10 секунд
    setTimeout(() => {
        hideNotification();
    }, 10000);
    
    // Помечаем уведомление как просмотренное
    fetch(`/miniapp/notification/seen/${notification.id}`);
}

// ... остальной код ...