// static/js/splash.js
document.addEventListener('DOMContentLoaded', () => {
    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');

    console.log('[SPLASH] DOMContentLoaded');
    if (!splash) { console.warn('[SPLASH] splash element not found'); return; }
    if (!loadingProgress) { console.warn('[SPLASH] loadingProgress element not found'); }
    if (!appContent) { console.warn('[SPLASH] appContent element not found'); }

    splash.style.opacity = '1';
    splash.style.display = 'flex';
    if (appContent) appContent.style.display = 'none';
    console.log('[SPLASH] splash shown, app hidden');

    let progress = 0;
    const duration = 3000; // 3 секунды
    const intervalTime = 50;
    const step = 100 / (duration / intervalTime);

    const interval = setInterval(() => {
        progress += step;
        if (!isFinite(progress)) progress = 100;
        progress = Math.min(Math.max(progress, 0), 100);
        if (loadingProgress) loadingProgress.style.width = `${progress}%`;
        console.log(`[SPLASH] progress: ${progress.toFixed(1)}%`);
        if (progress >= 100) {
            clearInterval(interval);
            console.log('[SPLASH] progress 100%, hiding splash soon');
            setTimeout(() => {
                splash.style.opacity = '0';
                console.log('[SPLASH] splash opacity 0');
                setTimeout(() => {
                    splash.style.display = 'none';
                    if (appContent) appContent.style.display = 'block';
                    document.body.classList.add('loaded');
                    console.log('[SPLASH] splash hidden, app shown');
                }, 450);
            }, 200);
        }
    }, intervalTime);
});