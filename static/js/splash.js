// static/js/splash.js
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const appContent = document.getElementById('app-content');

    // Если шаблона нет — выходим
    if (!splash) {
        console.error('Элемент #splash не найден!');
        return;
    }

    // Явно показываем заставку
    splash.style.display = 'flex';
    splash.style.opacity = '1';
    
    if (appContent) {
        appContent.style.display = 'none';
    }
    
    console.log('Заставка инициализирована');
});

// Экспортируем функцию скрытия заставки
window.hideSplash = function() {
    const splash = document.getElementById('splash');
    const appContent = document.getElementById('app-content');
    
    if (!splash) {
        console.error('Элемент #splash не найден при попытке скрыть заставку!');
        return;
    }
    
    console.log('Скрытие заставки');
    // Плавно скрываем заставку
    splash.style.opacity = '0';
    setTimeout(() => {
        splash.style.display = 'none';
        if (appContent) {
            appContent.style.display = 'block';
            console.log('Основной контент показан');
        }
        document.body.classList.add('loaded');
    }, 450);
};
