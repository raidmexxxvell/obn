// static/js/splash.js
document.addEventListener('DOMContentLoaded', () => {
    // --- Логгер -------------------------------------------------------------
    const LOG_PREFIX = '[SPLASH]';
    const debugEnabled = (typeof URL !== 'undefined' && (() => {
        try {
            const params = new URL(window.location.href).searchParams;
            return params.get('debug') === 'splash' || localStorage.getItem('splashDebug') === '1';
        } catch (_) { return false; }
    })());

    const pushLog = (level, msg, data) => {
        const t = new Date().toISOString();
        const entry = { t, level, msg, data: data ?? undefined };
        try {
            window.__SPLASH_LOGS = window.__SPLASH_LOGS || [];
            window.__SPLASH_LOGS.push(entry);
        } catch (_) { /* no-op */ }
        if (!debugEnabled) return;
        const line = `${LOG_PREFIX} ${t} ${level.toUpperCase()}: ${msg}`;
        const c = console[level] || console.log;
        data !== undefined ? c(line, data) : c(line);
    };
    const log = (msg, data) => pushLog('log', msg, data);
    const info = (msg, data) => pushLog('info', msg, data);
    const warn = (msg, data) => pushLog('warn', msg, data);
    const error = (msg, data) => pushLog('error', msg, data);

    info('DOMContentLoaded');

    // Подписка на ошибки страницы для лучшей диагностики
    window.addEventListener('error', (e) => {
        error('window.error', {
            message: e.message,
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno
        });
    });
    window.addEventListener('unhandledrejection', (e) => {
        error('unhandledrejection', { reason: e.reason && (e.reason.stack || e.reason.message || String(e.reason)) });
    });
    document.addEventListener('visibilitychange', () => {
        info('visibilitychange', { hidden: document.hidden });
    });

    const splash = document.getElementById('splash');
    const loadingProgress = document.getElementById('loading-progress');
    const appContent = document.getElementById('app-content');
    info('Elements lookup', {
        splash: !!splash,
        loadingProgress: !!loadingProgress,
        appContent: !!appContent
    });

    // Если шаблона нет — выходим
    if (!splash) {
        warn('No #splash element found. Skip splash flow.');
        return;
    }

    // Защитный фон — явно показываем заставку (если CSS/inline меняли)
    try {
        const before = window.getComputedStyle ? window.getComputedStyle(splash) : null;
        log('Before show', before ? { display: before.display, opacity: before.opacity } : undefined);
    } catch (_) {}
    splash.style.opacity = '1';
    splash.style.display = 'flex';
    if (appContent) appContent.style.display = 'none';
    try {
        const after = window.getComputedStyle ? window.getComputedStyle(splash) : null;
        log('After show', after ? { display: after.display, opacity: after.opacity } : undefined);
    } catch (_) {}

    let progress = 0;
    const duration = 3000; // 3 секунды
    const intervalTime = 50;
    const step = 100 / (duration / intervalTime);
    info('Timer config', { duration, intervalTime, step });

    // Троттлинг логов прогресса
    let lastLogPct = -10;
    let lastLogTime = 0;

    const interval = setInterval(() => {
        progress += step;
        if (!isFinite(progress)) progress = 100;
        progress = Math.min(Math.max(progress, 0), 100);

        if (loadingProgress) loadingProgress.style.width = `${progress}%`;

        const now = performance && performance.now ? performance.now() : Date.now();
        if (progress - lastLogPct >= 10 || now - lastLogTime >= 500) {
            log('Progress', { progress: Math.round(progress) });
            lastLogPct = progress;
            lastLogTime = now;
        }

        if (progress >= 100) {
            info('Progress complete -> clearing interval');
            clearInterval(interval);
            // небольшая задержка чтобы анимация дошла до конца
            setTimeout(() => {
                info('Start fade out');
                splash.style.opacity = '0';
                // переключаем видимость после анимации
                setTimeout(() => {
                    const beforeHide = window.getComputedStyle ? window.getComputedStyle(splash) : null;
                    log('Before hide', beforeHide ? { display: beforeHide.display, opacity: beforeHide.opacity } : undefined);

                    splash.style.display = 'none';
                    if (appContent) {
                        appContent.style.display = 'block';
                    }
                    document.body.classList.add('loaded');

                    const afterHide = window.getComputedStyle ? window.getComputedStyle(splash) : null;
                    log('After hide', afterHide ? { display: afterHide.display, opacity: afterHide.opacity } : undefined);
                    info('Splash hidden, app-content shown');
                }, 450);
            }, 200);
        }
    }, intervalTime);

    // Аварийный таймаут: через 7 секунд гарантированно показываем контент
    const failSafeTimeout = setTimeout(() => {
        const stillVisible = splash && splash.style.display !== 'none';
        if (stillVisible) {
            warn('Fail-safe timeout triggered. Forcing hide splash/show content');
            try { clearInterval(interval); } catch (_) {}
            try { splash.style.opacity = '0'; } catch (_) {}
            try { splash.style.display = 'none'; } catch (_) {}
            try { if (appContent) appContent.style.display = 'block'; } catch (_) {}
            try { document.body.classList.add('loaded'); } catch (_) {}
        } else {
            log('Fail-safe timeout fired but splash already hidden');
        }
    }, 7000);

    // Если все прошло штатно — чистим аварийный таймер при скрытии
    const clearFailSafe = () => {
        try { clearTimeout(failSafeTimeout); } catch (_) {}
    };
    // Патчим setTimeout завершения, чтобы зачистить fail-safe в штатном сценарии
    // (вызовем clearFailSafe в самом конце штатного скрытия)
    // Т.к. выше мы уже логируем окончание — просто перехватим MutationObserver по display
    try {
        const mo = new MutationObserver(() => {
            if (splash.style.display === 'none') {
                clearFailSafe();
                mo.disconnect();
                info('MutationObserver: splash display became none -> fail-safe cleared');
            }
        });
        mo.observe(splash, { attributes: true, attributeFilter: ['style'] });
    } catch (_) { /* no-op */ }
});
