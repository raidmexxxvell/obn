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
    // мгновенно сдвинем прогресс с 0 чтобы избежать визуального залипания
    try {
        if (loadingProgress) loadingProgress.style.width = '1%';
    } catch (_) {}
    try {
        const after = window.getComputedStyle ? window.getComputedStyle(splash) : null;
        log('After show', after ? { display: after.display, opacity: after.opacity } : undefined);
    } catch (_) {}

    // Настройки ожидания готовности (этапы)
    let progress = 0;
    const intervalTime = 50;
    const baseMinMs = 800;           // минимальное время показа, мс
    const maxWaitMs = 10000;         // максимум ожидания, мс
    const stepWait = 1.2;            // базовый шаг
    const stepFinish = 4.5;          // финальный шаг до 100%
    // Целевые пороги этапов
    const stageTargets = {
        base: 50,
        profile: 70,
        data: 90
    };
    // Флаги этапов
    let stageProfileReady = false;   // имя+аватар загружены
    let stageDataReady = false;      // достижения и таблицы загружены
    let ready = false;               // финальная готовность
    const t0 = (performance && performance.now) ? performance.now() : Date.now();
    let finished = false;
    info('Timer config', { intervalTime, baseMinMs, maxWaitMs, stepWait, stepFinish });

    const maybeHide = () => {
        if (finished) return;
        finished = true;
        info('Start fade out');
        splash.style.opacity = '0';
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
    };

    // Логирование прогресса с троттлингом
    let lastLogPct = -10;
    let lastLogTime = 0;

    const interval = setInterval(() => {
        const now = (performance && performance.now) ? performance.now() : Date.now();
        const elapsed = now - t0;

        // Объявляем готовность по таймауту
        if (!ready && elapsed >= maxWaitMs) {
            warn('Max wait exceeded -> forcing ready');
            ready = true;
        }

        // Обеспечиваем минимальную длительность показа
        const minElapsedReached = elapsed >= baseMinMs;

        // Этапное наращивание прогресса
        let currentTarget = stageTargets.base;
        if (stageProfileReady) currentTarget = stageTargets.profile;
        if (stageDataReady) currentTarget = stageTargets.data;
        if (!ready) {
            // стремимся к текущему целевому порогу
            if (progress < currentTarget) {
                progress = Math.min(progress + stepWait, currentTarget);
            } else {
                // ждём наступления следующего этапа
                progress = Math.min(progress + 0.2, currentTarget); // микро-тремор
            }
        } else {
            // финальный добег до 100%
            progress = Math.min(progress + stepFinish, 100);
        }

    if (!isFinite(progress)) progress = 100;
        progress = Math.min(Math.max(progress, 0), 100);
        if (loadingProgress) loadingProgress.style.width = `${progress}%`;

        if (progress - lastLogPct >= 10 || now - lastLogTime >= 500) {
            log('Progress', { progress: Math.round(progress), elapsed: Math.round(elapsed), ready, minElapsedReached });
            lastLogPct = progress;
            lastLogTime = now;
        }

        if (progress >= 100 && minElapsedReached) {
            info('Progress complete -> clearing interval');
            clearInterval(interval);
            // небольшая задержка чтобы анимация дошла до конца полосы
            setTimeout(() => maybeHide(), 200);
        }
    }, intervalTime);

    // страховочный kickstart: если через 400мс прогресс всё ещё 0 — принудительно поставить 5%
    setTimeout(() => {
        try {
            const cur = parseFloat((loadingProgress?.style?.width || '0').replace('%','')) || 0;
            if (cur <= 0.1 && loadingProgress) loadingProgress.style.width = '5%';
        } catch (_) {}
    }, 400);

    // Этапы готовности приходят событиями
    // 1) Профиль (имя + аватар)
    window.addEventListener('app:profile-ready', () => {
        info('Received app:profile-ready');
        stageProfileReady = true;
    }, { once: true });
    // 2) Данные (достижения + таблицы)
    window.addEventListener('app:data-ready', () => {
        info('Received app:data-ready');
        stageDataReady = true;
    }, { once: true });
    // 3) Финальная готовность (когда всё остальное сделано)
    window.addEventListener('app:all-ready', () => {
        info('Received app:all-ready');
        ready = true;
    }, { once: true });

    // Если все прошло штатно — чистим аварийный таймер при скрытии
    // Сохраняем аварийный таймер как ранее, но теперь он только форсит готовность
    const failSafeTimeout = setTimeout(() => {
        if (!ready) {
            warn('Fail-safe timeout -> set ready');
            ready = true;
        } else {
            log('Fail-safe timeout fired but already ready');
        }
    }, maxWaitMs);
    // Чистим аварийный таймер при скрытии
    try {
        const mo = new MutationObserver(() => {
            if (splash.style.display === 'none') {
                try { clearTimeout(failSafeTimeout); } catch (_) {}
                mo.disconnect();
                info('MutationObserver: splash hidden -> fail-safe cleared');
            }
        });
        mo.observe(splash, { attributes: true, attributeFilter: ['style'] });
    } catch (_) { /* no-op */ }
});
