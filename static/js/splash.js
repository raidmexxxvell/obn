// static/js/splash.js
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const appContent = document.getElementById('app-content');

    // Если шаблона нет — выходим
    if (!splash) return;

    // Явно показываем заставку
    splash.style.display = 'flex';
    if (appContent) appContent.style.display = 'none';
});

// Экспортируем функцию скрытия заставки
window.hideSplash = function() {
    const splash = document.getElementById('splash');
    const appContent = document.getElementById('app-content');
    
    if (!splash) return;
    
    // Плавно скрываем заставку
    splash.style.opacity = '0';
    setTimeout(() => {
        splash.style.display = 'none';
        if (appContent) appContent.style.display = 'block';
        document.body.classList.add('loaded');
    }, 450);
};
