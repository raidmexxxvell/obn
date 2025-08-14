// static/js/splash.js
// Заставка с логотипом, надписью и прогресс-баром

document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    let progress = 0;
    const duration = 5000; // 5 секунд
    const intervalTime = 50;
    const step = 100 / (duration / intervalTime);

    splash.style.opacity = '1';
    appContent.style.display = 'none';

    const interval = setInterval(() => {
        progress += step;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            loadingProgress.style.width = '100%';
            setTimeout(() => {
                splash.style.opacity = '0';
                setTimeout(() => {
                    splash.style.display = 'none';
                    appContent.style.display = 'block';
                    document.body.classList.add('loaded');
                }, 700);
            }, 400);
        } else {
            loadingProgress.style.width = `${progress}%`;
        }
    }, intervalTime);
});
