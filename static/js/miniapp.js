document.addEventListener('DOMContentLoaded', () => {
    console.log('[INIT] DOMContentLoaded event triggered');
    
    // Инициализация Telegram WebApp (только после загрузки DOM)
    const tg = window.Telegram?.WebApp;
    if (tg && tg.expand && tg.ready) {
        tg.expand();
        tg.ready();
        console.log('[TG] Telegram WebApp API initialized successfully');
    } else {
        console.error('[TG] Telegram WebApp API is not available');
        // Создаем заглушку для тестирования вне Telegram
        window.Telegram = window.Telegram || {};
        window.Telegram.WebApp = {
            expand: () => console.log('[TG] Mock expand() called'),
            ready: () => console.log('[TG] Mock ready() called'),
            HapticFeedback: {
                impactOccurred: () => {}
            },
            initDataUnsafe: {
                user: {
                    id: 123456789,
                    username: "test_user",
                    first_name: "Test",
                    last_name: "User"
                }
            }
        };
    }
    
    // Элементы интерфейса
    const loadingScreen = document.getElementById('loading-screen');
    const appContainer = document.getElementById('app-container');
    const frame = document.getElementById('page-frame');
    
    // Скрываем основной контент до завершения инициализации
    if (frame) {
        frame.style.display = 'none';
        console.log('[INIT] Frame hidden for initialization');
    }
    
    // Таймаут для инициализации (максимум 10 секунд)
    const INIT_TIMEOUT = 10000;
    let initTimeoutId;
    let progressInterval;
    
    // ОБЪЕДИНЕННАЯ функция завершения инициализации (ОПРЕДЕЛЕНА ПЕРВОЙ!)
    const completeInitialization = (success = true) => {
        console.log('[INIT] Completing initialization with success:', success);
        clearTimeout(initTimeoutId);
        if (progressInterval) {
            clearInterval(progressInterval);
        }
        
        // Плавно скрываем экран загрузки
        if (loadingScreen) {
            loadingScreen.style.opacity = '0';
            setTimeout(() => {
                console.log('[INIT] Hiding loading screen');
                if (loadingScreen) {
                    loadingScreen.style.display = 'none';
                }
                if (appContainer) {
                    console.log('[INIT] Showing app container');
                    appContainer.classList.remove('hidden');
                }
                if (frame && success) {
                    console.log('[INIT] Showing frame');
                    frame.style.display = 'block';
                }
            }, 500);
        }
        
        if (success) {
            // Настраиваем интерфейс
            console.log('[INIT] Setting up UI components');
            setupBottomMenu();
            setupSideMenu();
            setupLinkHandlers();
            setupNavigation();
            setupIframeHandler();
            setupErrorHandlers();
            
            // Запускаем опрос уведомлений
            console.log('[INIT] Starting notifications polling');
            pollNotifications();
            pollInterval = setInterval(pollNotifications, 8000);
            
            // Устанавливаем активную вкладку
            const activeTab = getActiveTabFromUrl();
            console.log('[INIT] Active tab:', activeTab);
            setActiveTab(activeTab);
            
            // Загружаем содержимое активной вкладки
            loadActiveTabContent(activeTab);
        } else {
            // Показываем уведомление об ошибке
            console.error('[INIT] Initialization failed');
            showNotification('Не удалось инициализировать приложение. Проверьте соединение и перезагрузите страницу.', 'error');
            
            // Все равно показываем приложение, чтобы пользователь мог перезагрузить
            if (appContainer) {
                console.log('[INIT] Showing app container despite error');
                appContainer.classList.remove('hidden');
            }
            
            // Показываем сообщение об ошибке в основном контенте
            if (frame) {
                frame.style.display = 'block';
                frame.src = 'about:blank';
                frame.onload = function() {
                    const errorContent = `
                        <div style="padding: 20px; text-align: center; color: #ff6b6b;">
                            <h2>Ошибка инициализации</h2>
                            <p>Не удалось загрузить приложение. Пожалуйста, перезагрузите страницу.</p>
                            <button onclick="location.reload()" style="margin-top: 20px; padding: 10px 20px; background: #ff6b6b; color: white; border: none; border-radius: 8px; cursor: pointer;">
                                Перезагрузить
                            </button>
                        </div>
                    `;
                    frame.contentDocument.open();
                    frame.contentDocument.write(errorContent);
                    frame.contentDocument.close();
                };
            }
        }
    };
    
    // Обновление прогресс-бара
    const progressBar = document.getElementById('loading-progress-bar');
    let progress = 0;

    const updateProgress = (value) => {
        progress = Math.min(Math.max(progress, value), 100);
        console.log(`[PROGRESS] Updating progress to ${progress}%`);
        if (progressBar) {
            progressBar.style.width = `${progress}%`;
        }
    };

    // Проверяем, доступен ли Telegram WebApp API
    const checkTelegramApi = () => {
        return new Promise((resolve) => {
            const maxAttempts = 20;
            let attempts = 0;
            
            const check = () => {
                attempts++;
                if (window.Telegram && window.Telegram.WebApp) {
                    console.log('[TG] Telegram WebApp API загружен после попытки', attempts);
                    resolve(true);
                } else if (attempts >= maxAttempts) {
                    console.warn('[TG] Telegram WebApp API не загрузился после', maxAttempts, 'попыток');
                    resolve(false);
                } else {
                    setTimeout(check, 100);
                }
            };
            
            check();
        });
    };
    
    // Инициализация сессии с проверкой Telegram API
    const initSessionWithCheck = async () => {
        console.log('[SESSION] Starting session initialization');
        
        // Сначала проверяем доступность Telegram API
        const isTelegramAvailable = await checkTelegramApi();
        
        if (!isTelegramAvailable) {
            console.error('[SESSION] Telegram WebApp API недоступен');
            throw new Error('Telegram WebApp API недоступен');
        }
        
        try {
            const tg = window.Telegram.WebApp;
            tg.expand();
            tg.ready();
            console.log('[SESSION] Telegram WebApp expanded and ready');
            
            const user = tg.initDataUnsafe?.user || null;
            if (!user) {
                console.error("[SESSION] User data not available from Telegram");
                throw new Error("User data not available");
            }
            
            console.log('[SESSION] User data:', {
                id: user.id,
                username: user.username,
                firstName: user.first_name,
                lastName: user.last_name
            });
            
            // Сохраняем реферальный параметр
            const urlParams = new URLSearchParams(window.location.search);
            const ref = urlParams.get('ref');
            
            // Отправляем данные на сервер
            console.log('[SESSION] Sending init request to /miniapp/init');
            const payload = {
                user_id: user.id,
                username: user.username || "",
                display_name: `${user.first_name} ${user.last_name || ""}`,
                ref: ref
            };
            
            let response;
            try {
                response = await fetch('/miniapp/init', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload)
                });
            } catch (networkError) {
                console.error('[SESSION] Network error:', networkError);
                throw new Error('Network error: Unable to connect to server');
            }
            
            console.log('[SESSION] Init response status:', response.status);
            if (!response.ok) {
                const errorText = await response.text();
                console.error('[SESSION] Server error response:', errorText);
                throw new Error(`Server error ${response.status}: ${errorText}`);
            }
            
            const data = await response.json();
            console.log('[SESSION] Init response data:', data);
            
            if (data.success) {
                console.log('[SESSION] Session initialized successfully');
                // Обновляем информацию о пользователе
                const userMini = document.getElementById('user-mini');
                if (userMini) {
                    userMini.textContent = user.first_name || 'Пользователь';
                }
                return true;
            } else {
                console.error('[SESSION] Session initialization failed:', data.error);
                throw new Error(data.error || 'Session initialization failed');
            }
        } catch (error) {
            console.error('[SESSION] Error initializing session:', error);
            throw error;
        }
    };
    
    // Добавляем функцию для загрузки содержимого вкладки
    function loadActiveTabContent(tabName) {
        console.log('[TAB] Loading active tab content:', tabName);
        if (!frame) {
            console.error('[TAB] Frame element not found');
            return;
        }
        
        switch (tabName) {
            case 'home':
                frame.src = '/miniapp/home';
                break;
            case 'nlo':
                frame.src = '/miniapp/nlo';
                break;
            case 'pred':
                frame.src = '/miniapp/predictions';
                break;
            case 'profile':
                frame.src = '/miniapp/profile';
                break;
            case 'support':
                frame.src = '/miniapp/support';
                break;
            default:
                console.warn('[TAB] Unknown tab name:', tabName);
                frame.src = '/miniapp/home';
        }
        
        // Добавляем небольшую задержку перед показом
        setTimeout(() => {
            if (frame) {
                frame.style.opacity = '1';
                frame.style.transition = 'opacity 0.3s ease';
            }
        }, 300);
    }
    
    // Устанавливаем таймаут для инициализации
    initTimeoutId = setTimeout(() => {
        console.error('[INIT] Инициализация сессии превысила лимит времени');
        completeInitialization(false);
    }, INIT_TIMEOUT);
    
    // Имитация прогресса загрузки
    progressInterval = setInterval(() => {
        if (progress < 100) {
            updateProgress(progress + 2);
        }
    }, 300);
    
    // Запускаем инициализацию
    initSessionWithCheck()
        .then(() => {
            console.log('[INIT] Инициализация сессии завершена успешно');
            completeInitialization(true);
        })
        .catch(error => {
            console.error('[INIT] Ошибка инициализации сессии:', error);
            completeInitialization(false);
        });
    
    // Очистка при разгрузке
    window.addEventListener('beforeunload', () => {
        if (pollInterval) {
            clearInterval(pollInterval);
        }
        clearTimeout(initTimeoutId);
        if (progressInterval) {
            clearInterval(progressInterval);
        }
        console.log('[INIT] Cleanup completed');
    });
    
    // Установка активной вкладки
    function setActiveTab(tabName) {
        console.log('[TAB] Setting active tab:', tabName);
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
        if (activeBtn) {
            activeBtn.classList.add('active');
        }
    }
    
    // Получение активной вкладки из URL
    function getActiveTabFromUrl() {
        const path = window.location.pathname.split('/').pop();
        console.log('[TAB] Getting active tab from URL:', path);
        const tabMap = {
            'home': 'home',
            'nlo': 'nlo',
            'pred': 'pred',
            'predictions': 'pred',
            'profile': 'profile',
            'support': 'support'
        };
        return tabMap[path] || 'home';
    }
    
    // Настройка нижнего меню
    function setupBottomMenu() {
        console.log('[MENU] Setting up bottom menu');
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const tg = window.Telegram?.WebApp;
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.impactOccurred('light');
                }
                const tab = btn.dataset.tab;
                const frame = document.getElementById('page-frame');
                
                console.log('[MENU] Bottom menu item clicked:', tab);
                
                // Обновляем URL без перезагрузки
                if (tab === 'home') {
                    frame.src = '/miniapp/home';
                    window.history.pushState({}, '', '/miniapp');
                } else if (tab === 'nlo') {
                    frame.src = '/miniapp/nlo';
                } else if (tab === 'pred') {
                    frame.src = '/miniapp/predictions';
                } else if (tab === 'profile') {
                    frame.src = '/miniapp/profile';
                } else if (tab === 'support') {
                    frame.src = '/miniapp/support';
                }
                
                setActiveTab(tab);
            });
        });
    }
    
    // Настройка бокового меню
    function setupSideMenu() {
        console.log('[MENU] Setting up side menu');
        const burger = document.getElementById('burger');
        const sideMenu = document.getElementById('side-menu');
        const closeBtn = document.getElementById('close-burger');
        
        if (burger && sideMenu && closeBtn) {
            burger.addEventListener('click', () => {
                const tg = window.Telegram?.WebApp;
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.impactOccurred('medium');
                }
                console.log('[MENU] Burger menu clicked');
                sideMenu.classList.toggle('hidden');
            });
            
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                const tg = window.Telegram?.WebApp;
                if (tg?.HapticFeedback) {
                    tg.HapticFeedback.impactOccurred('light');
                }
                console.log('[MENU] Close burger clicked');
                sideMenu.classList.add('hidden');
            });
            
            // Закрытие меню при клике вне его области
            document.addEventListener('click', (e) => {
                if (!sideMenu.contains(e.target) && 
                    !burger.contains(e.target) && 
                    !sideMenu.classList.contains('hidden')) {
                    console.log('[MENU] Closing menu by clicking outside');
                    sideMenu.classList.add('hidden');
                }
            });
        } else {
            console.warn('[MENU] Some menu elements not found');
        }
    }
    
    // Обработчик кликов по ссылкам
    function setupLinkHandlers() {
        console.log('[LINKS] Setting up link handlers');
        document.addEventListener('click', (e) => {
            let target = e.target;
            while (target && !target.href) {
                target = target.parentElement;
            }
            
            // Проверяем, что это внутренняя ссылка
            if (target && target.href && target.href.includes(window.location.host)) {
                e.preventDefault();
                
                console.log('[LINKS] Internal link clicked:', target.href);
                
                // Открываем ссылку в iframe
                const frame = document.getElementById('page-frame');
                if (frame) {
                    frame.src = target.href;
                    
                    // Обновляем историю браузера
                    if (!target.href.includes('#')) {
                        window.history.pushState({}, '', target.href);
                    }
                    
                    // Закрываем боковое меню при переходе
                    document.getElementById('side-menu').classList.add('hidden');
                }
            }
            // Для внешних ссылок открываем в том же окне
            else if (target && target.href && !target.target) {
                e.preventDefault();
                console.log('[LINKS] External link clicked, opening in same window:', target.href);
                window.location.href = target.href;
            }
        });
    }
    
    // Обработчик навигации
    function setupNavigation() {
        console.log('[NAV] Setting up navigation');
        window.addEventListener('popstate', () => {
            console.log('[NAV] Popstate event triggered');
            const frame = document.getElementById('page-frame');
            if (frame) {
                frame.src = window.location.pathname;
            }
        });
    }
    
    // Обработчик iframe загрузки
    function setupIframeHandler() {
        console.log('[IFRAME] Setting up iframe handler');
        const frame = document.getElementById('page-frame');
        if (frame) {
            frame.onload = function() {
    console.log('[IFRAME] Frame loaded:', frame.src);
    try {
        // Обновляем активную вкладку на основе содержимого iframe
        const src = frame.src;
        if (src.includes('/miniapp/home')) {
            setActiveTab('home');
            
            // Добавляем обработчик для кнопок "Детали" после загрузки страницы
setTimeout(() => {
    try {
        const detailsButtons = frame.contentDocument.querySelectorAll('.details-btn, .match-detail-btn');
        detailsButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Пытаемся найти ID матча разными способами
                let matchId = null;
                
                // 1. Проверяем атрибут data-match-id кнопки
                if (btn.dataset.matchId) {
                    matchId = btn.dataset.matchId;
                    console.log('[MATCH] Found match ID from button:', matchId);
                }
                // 2. Проверяем родительский элемент .match-card
                else if (btn.closest('.match-card')?.dataset.matchId) {
                    matchId = btn.closest('.match-card').dataset.matchId;
                    console.log('[MATCH] Found match ID from .match-card:', matchId);
                }
                // 3. Проверяем родительский элемент tr (для таблицы)
                else if (btn.closest('tr')?.dataset.matchId) {
                    matchId = btn.closest('tr').dataset.matchId;
                    console.log('[MATCH] Found match ID from tr:', matchId);
                }
                // 4. Проверяем атрибут href (если кнопка является ссылкой)
                else if (btn.href && /\/match\/(\d+)/.test(btn.href)) {
                    matchId = btn.href.match(/\/match\/(\d+)/)[1];
                    console.log('[MATCH] Found match ID from href:', matchId);
                }
                // 5. Проверяем скрытое поле в форме
                else {
                    const hiddenInput = btn.closest('form')?.querySelector('input[name="match_id"]');
                    if (hiddenInput && hiddenInput.value) {
                        matchId = hiddenInput.value;
                        console.log('[MATCH] Found match ID from hidden input:', matchId);
                    }
                }
                
                if (matchId) {
                    console.log('[MATCH] Opening details for match ID:', matchId);
                    // Загружаем страницу матча
                    document.getElementById('page-frame').src = `/miniapp/match/${matchId}`;
                    
                    // Закрываем боковое меню, если открыто
                    document.getElementById('side-menu')?.classList.add('hidden');
                } else {
                    console.error('[MATCH] Match ID not found after all attempts');
                    showNotification('Ошибка: не удалось определить матч. Пожалуйста, обновите страницу и попробуйте снова.', 'error');
                }
            });
        });
    } catch (iframeError) {
        console.error('[IFRAME] Error adding details button handlers:', iframeError);
    }
}, 500);
			
        } else if (src.includes('/miniapp/nlo')) {
            setActiveTab('nlo');
        } else if (src.includes('/miniapp/predictions') || 
                   src.includes('/miniapp/pred')) {
            setActiveTab('pred');
        } else if (src.includes('/miniapp/profile')) {
            setActiveTab('profile');
        } else if (src.includes('/miniapp/support')) {
            setActiveTab('support');
        }
    } catch (e) {
        console.error('[IFRAME] Error updating tab state:', e);
    }
};
            
            frame.onerror = function() {
                console.error('[IFRAME] Frame failed to load:', frame.src);
                showNotification('Ошибка загрузки страницы. Проверьте соединение.', 'error');
            };
        }
    }
    
    // Показ уведомлений
    function showNotification(message, type = 'info') {
        console.log(`[NOTIF] Showing notification (${type}):`, message);
        const toast = document.createElement('div');
        toast.className = `toast ${type} show`;
        toast.innerHTML = `
            <div class="toast-content">
                <span class="toast-message">${message}</span>
            </div>
        `;
        
        document.body.appendChild(toast);
        
        // Удаляем уведомление через 3 секунды
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                document.body.removeChild(toast);
            }, 300);
        }, 3000);
    }
    
    // Обработчик ошибок
    function setupErrorHandlers() {
        console.log('[ERROR] Setting up error handlers');
        window.onerror = function(message, source, lineno, colno, error) {
            console.error('Global error:', {
                message,
                source,
                lineno,
                colno,
                error
            });
            return true;
        };
        
        // Обработка необработанных промисов
        window.addEventListener('unhandledrejection', event => {
            console.error('Unhandled promise rejection:', event.reason);
            event.preventDefault();
        });
    }
    
    // Опрос уведомлений
    let pollInterval = null;
    
    async function pollNotifications() {
        try {
            console.log('[NOTIF] Polling notifications');
            const response = await fetch('/miniapp/notifications');
            const data = await response.json();
            
            if (data.length > 0) {
                // Показываем последнее уведомление
                const latest = data[0];
                console.log('[NOTIF] New live notification:', latest);
                showLiveBanner(latest);
            }
        } catch (error) {
            console.error('[NOTIF] Error polling notifications:', error);
        }
    }
    
    function showLiveBanner(note) {
        console.log('[BANNER] Showing live banner:', note);
        const banner = document.getElementById('live-banner');
        if (!banner) {
            console.error('[BANNER] Banner element not found');
            return;
        }
        
        banner.innerHTML = `
            <div class="banner-inner">
                <div class="logos">${note.team1} — ${note.team2}</div>
                <div class="score">${note.score1}:${note.score2}</div>
            </div>
        `;
        
        banner.classList.add('pulse');
        
        // Обработчик клика на баннер
        banner.onclick = function() {
            console.log('[BANNER] Banner clicked, loading match page');
            document.getElementById('page-frame').src = `/miniapp/match/${note.id}`;
            hideLiveBanner();
        };
        
        // Автоматическое скрытие через 10 секунд
        setTimeout(hideLiveBanner, 10000);
    }
    
    function hideLiveBanner() {
        console.log('[BANNER] Hiding live banner');
        const banner = document.getElementById('live-banner');
        if (banner) {
            banner.classList.remove('pulse');
            setTimeout(() => {
                banner.style.opacity = '0';
                setTimeout(() => banner.style.display = 'none', 300);
            }, 300);
        }
    }
});