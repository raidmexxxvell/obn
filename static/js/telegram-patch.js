// Специальный патч для Telegram WebApp на мобильных устройствах
// Добавляем поддержку псевдо-фуллскрина для видео

(function() {
    // Проверяем, что мы в Telegram WebApp
    if (typeof window.Telegram === 'undefined' || !window.Telegram.WebApp) {
        return;
    }
    
    console.log('[TG-PATCH] Initializing Telegram WebApp mobile fullscreen patch');
    
    // Настраиваем Telegram WebApp для лучшей работы с видео
    const tg = window.Telegram.WebApp;
    
    // Расширяем область просмотра
    if (tg.expand) {
        tg.expand();
        console.log('[TG-PATCH] WebApp expanded');
    }
    
    // Включаем закрытие по свайпу вниз
    if (tg.enableClosingConfirmation) {
        tg.enableClosingConfirmation();
    }
    
    // Настраиваем viewport для лучшей работы с видео
    if (tg.setHeaderColor) {
        tg.setHeaderColor('#000000');
    }
    
    // Отключаем вертикальные свайпы при просмотре видео в фуллскрине
    let isVideoFullscreen = false;
    
    function disableSwipes() {
        isVideoFullscreen = true;
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        document.body.style.height = '100%';
        
        // Отключаем свайпы в Telegram
        if (tg.disableVerticalSwipes) {
            tg.disableVerticalSwipes();
        }
    }
    
    function enableSwipes() {
        isVideoFullscreen = false;
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
        document.body.style.height = '';
        
        // Включаем свайпы обратно
        if (tg.enableVerticalSwipes) {
            tg.enableVerticalSwipes();
        }
    }
    
    // Слушаем изменения псевдо-фуллскрина
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                const target = mutation.target;
                if (target.id === 'md-pane-stream') {
                    if (target.classList.contains('fs-mode')) {
                        console.log('[TG-PATCH] Entering pseudo-fullscreen');
                        disableSwipes();
                        
                        // Принудительно поворачиваем в ландшафт если возможно
                        if (window.screen && window.screen.orientation) {
                            window.screen.orientation.lock('landscape').catch(() => {
                                console.log('[TG-PATCH] Orientation lock not available');
                            });
                        }
                    } else {
                        console.log('[TG-PATCH] Exiting pseudo-fullscreen');
                        enableSwipes();
                        
                        // Разблокируем ориентацию
                        if (window.screen && window.screen.orientation) {
                            window.screen.orientation.unlock();
                        }
                    }
                }
            }
        });
    });
    
    // Наблюдаем за изменениями во всем документе
    observer.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['class']
    });
    
    // Добавляем обработчик кнопки "Назад" в Telegram
    tg.onEvent('backButtonClicked', () => {
        const streamPane = document.getElementById('md-pane-stream');
        if (streamPane && streamPane.classList.contains('fs-mode')) {
            // Выходим из фуллскрина вместо закрытия приложения
            streamPane.classList.remove('fs-mode');
            enableSwipes();
            console.log('[TG-PATCH] Exited fullscreen via back button');
        } else {
            // Обычное поведение кнопки "Назад"
            tg.close();
        }
    });
    
    // Показываем кнопку "Назад" когда входим в фуллскрин
    function updateBackButton() {
        const streamPane = document.getElementById('md-pane-stream');
        if (streamPane && streamPane.classList.contains('fs-mode')) {
            if (tg.BackButton && tg.BackButton.show) {
                tg.BackButton.show();
            }
        } else {
            if (tg.BackButton && tg.BackButton.hide) {
                tg.BackButton.hide();
            }
        }
    }
    
    // Периодически проверяем состояние фуллскрина
    setInterval(updateBackButton, 500);
    
    console.log('[TG-PATCH] Telegram WebApp mobile patch initialized');
})();
