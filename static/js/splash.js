// static/js/splash.js
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    // Если шаблона нет — выходим
    if (!splash) return;

    // Защитный фон — явно показываем заставку (если CSS/inline меняли)
    splash.style.opacity = '1';
    splash.style.display = 'flex';
    if (appContent) appContent.style.display = 'none';

    let progress = 0;
    const duration = 3000; // делаем чуть быстрее — 3 секунды
    const intervalTime = 50;
    const step = 100 / (duration / intervalTime);

    const interval = setInterval(() => {
        progress += step;
        if (!isFinite(progress)) progress = 100;
        // предотвращаем переполнение
        progress = Math.min(Math.max(progress, 0), 100);

        if (loadingProgress) loadingProgress.style.width = `${progress}%`;

        if (progress >= 100) {
            clearInterval(interval);
            // небольшая задержка чтобы анимация дошла до конца
            setTimeout(() => {
                // плавно скрываем заставку
                splash.style.opacity = '0';
                // переключаем видимость после анимации
                setTimeout(() => {
                    splash.style.display = 'none';
                    if (appContent) appContent.style.display = 'block';
                    document.body.classList.add('loaded');
                }, 450);
            }, 200);
        }
    }, intervalTime);
});
