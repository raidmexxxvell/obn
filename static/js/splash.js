document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    if (!splash) return; // если нет элемента - выходим

    let progress = 0;
    const duration = 5000; // 5 секунд
    const intervalTime = 50;
    const step = 100 / (duration / intervalTime);

    // Показать заставку (защита на случай, если CSS менял display)
    splash.style.opacity = '1';
    if (appContent) appContent.style.display = 'none';

    const interval = setInterval(() => {
        progress += step;
        if (!isFinite(progress)) progress = 100;
        if (progress >= 100) {
            progress = 100;
            clearInterval(interval);
            if (loadingProgress) loadingProgress.style.width = '100%';
            setTimeout(() => {
                splash.style.opacity = '0';
                setTimeout(() => {
                    splash.style.display = 'none';
                    if (appContent) appContent.style.display = 'block';
                    document.body.classList.add('loaded');
                }, 700);
            }, 400);
        } else {
            if (loadingProgress) loadingProgress.style.width = `${Math.min(Math.max(progress,0),100)}%`;
        }
    }, intervalTime);
});
