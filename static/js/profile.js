// static/js/profile.js
// --- Global fetch rate limiter: <= 20 req/sec, limited concurrency ---
(() => {
    try {
        const originalFetch = window.fetch.bind(window);
        const cfg = Object.assign({ tokensPerSec: 20, bucketCapacity: 20, maxConcurrent: 6 }, window.__FETCH_LIMITS__ || {});
        let tokens = cfg.bucketCapacity;
        let inFlight = 0;
        const q = [];
        const schedule = () => {
            while (q.length && tokens > 0 && inFlight < cfg.maxConcurrent) {
                tokens -= 1;
                const job = q.shift();
                inFlight += 1;
                // Ads carousel & top match logic moved to profile-ads-featured.js
                job.run().catch(()=>{}).finally(() => { inFlight -= 1; schedule(); });
            }
        };
        setInterval(() => { tokens = Math.min(cfg.bucketCapacity, tokens + cfg.tokensPerSec); schedule(); }, 1000);
        window.fetch = (input, init) => new Promise((resolve, reject) => { q.push({ run: () => originalFetch(input, init).then(resolve, reject) }); schedule(); });
    } catch(_) {}

    // Legacy achievements полностью вынесены во внешний модуль (profile-achievements.js) или отключены.
    // Чтобы не блокировать триггер готовности приложения, помечаем достижения как уже загруженные.
    const elements = window.__PROFILE_ELEMENTS__ || {};
    const tg = window.Telegram?.WebApp || null;
    let _achLoaded = true; // раньше выставлялось после рендера достижений

    // handleCheckin вынесен в profile-checkin.js

    // Name change feature intentionally removed: name is taken from Telegram and cannot be changed in-app.

    function showError(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--danger)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },3000);} else console.warn(msg); }
    function showSuccessMessage(msg) { if (elements.checkinStatus) { elements.checkinStatus.textContent = msg; elements.checkinStatus.style.color = 'var(--success)'; setTimeout(()=>{ elements.checkinStatus.textContent=''; elements.checkinStatus.style.color=''; },2000);} else console.log(msg); }
    
    // showRewardAnimation и updateUserStatsWithAnimation вынесены в profile-checkin.js

    function setupEventListeners() {
    // обработчик чек-ина перенесён в profile-checkin.js
    // remove any edit-name UI binding: name is read-only from Telegram
    if (elements.editName) { elements.editName.style.display = 'none'; }
        // помечаем элементы для троттлинга кликов
    // троттлинг чек-ина перенесён в profile-checkin.js
        if (elements.editName) elements.editName.setAttribute('data-throttle', '1500');
    // переключение вкладок нижнего меню
        const navItems = document.querySelectorAll('.nav-item');
    let _lastUfoTap = 0;
    const bottomNav = document.getElementById('bottom-nav');
    const leagueBtn = document.getElementById('nav-league-switch');
    const leagueIcon = document.getElementById('nav-league-icon');
    const leagueText = document.getElementById('nav-league-text');
        navItems.forEach(item => {
            const tab = item.getAttribute('data-tab');
            // На НЛО отключаем троттлинг, иначе двойной тап не сработает
            if (tab === 'ufo') item.setAttribute('data-throttle', '0'); else item.setAttribute('data-throttle', '600');
            item.addEventListener('click', () => {
                try { console.log('[nav-click]', tab); } catch(_) {}
                const tab = item.getAttribute('data-tab');
                // Если открыт экран деталей матча — закрываем его при любом переходе по нижнему меню
                try {
                    const mdPane = document.getElementById('ufo-match-details');
                    const sched = document.getElementById('ufo-schedule');
                    if (mdPane && mdPane.style.display !== 'none') {
                        // Сбросить состояние трансляции при покидании экрана матча
                        try { if (window.Streams && typeof window.Streams.resetOnLeave === 'function') window.Streams.resetOnLeave(mdPane); } catch(_) {}
                        mdPane.style.display = 'none';
                        if (sched) sched.style.display = '';
                        const st = document.getElementById('ufo-subtabs'); if (st) st.style.display = '';
                    }
                } catch(_) {}
                // если уходим с профиля — вернуть верхнюю панель
                try { const cont = document.querySelector('.container'); if (cont) cont.classList.remove('profile-hide-top'); const ph = document.querySelector('.profile-header'); if (ph) ph.classList.remove('profile-centered'); } catch(_) {}
                // Обработка двойного тапа для НЛО
        if (tab === 'ufo') {
                    const now = Date.now();
                    if (now - _lastUfoTap < 350) {
            // двойной тап: открыть боковое меню лиг
            try { openLeagueDrawer(); } catch(_) {}
                        _lastUfoTap = 0;
                        return;
                    }
                    _lastUfoTap = now;
                }

                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                item.classList.add('active');
    const home = document.getElementById('tab-home');
    const prof = document.getElementById('tab-profile');
        const ufo = document.getElementById('tab-ufo');
        const preds = document.getElementById('tab-predictions');
        const lead = document.getElementById('tab-leaderboard');
    const shop = document.getElementById('tab-shop');
    const admin = document.getElementById('tab-admin');
    [home, prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
    if (tab === 'home' && home) home.style.display = '';
                if (tab === 'profile' && prof) {
                    prof.style.display = '';
                    try {
                        // спрячем общую шапку лиги и центрируем профиль для мобильного вида
                        const cont = document.querySelector('.container');
                        if (cont) cont.classList.add('profile-hide-top');
                        const ph = document.querySelector('.profile-header'); if (ph) ph.classList.add('profile-centered');
                    } catch(_) {}
                }
    if (tab === 'ufo' && ufo) {
        ufo.style.display = '';
        // Показ контента по активной лиге (без автопоказа оверлея)
        try {
            const act = getActiveLeague();
            if (act === 'BLB') selectBLBLeague(false); else selectUFOLeague(true, false);
            // При входе в НЛО — всегда показываем «Таблица» и скрываем детали матча
            const sub = document.querySelector('#ufo-subtabs .subtab-item[data-subtab="table"]');
            if (sub) sub.click();
        } catch(_) {}
    }
    if (tab === 'predictions' && preds) {
        preds.style.display = '';
        // Если выбрана БЛБ, показываем пусто; иначе — стандартная логика
        if (window.__ACTIVE_LEAGUE__ === 'BLB') {
            const host = document.getElementById('pred-tours');
            if (host) host.textContent = 'Скоро...';
            const myb = document.getElementById('my-bets'); if (myb) myb.textContent = 'Скоро...';
        } else {
            try { window.loadBetTours?.(); } catch(_) {}
        }
    }
    if (tab === 'leaderboard' && lead) { lead.style.display = ''; ensureLeaderboardInit(); }
    if (tab === 'shop' && shop) { shop.style.display = ''; try { window.Shop?.initShopUI?.(); } catch(_) {} }
    if (tab === 'admin' && admin) { admin.style.display = ''; try { window.Admin?.ensureAdminInit?.(); } catch(_) {} }
                // прокрутка к верху при смене вкладки
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            // Поддержка dblclick (десктоп) для оверлея
            if (tab === 'ufo') {
                item.addEventListener('dblclick', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    try { openLeagueDrawer(); } catch(_) {}
                });
                // Явная обработка touchend для надёжного двойного тапа
                let _ufoLastTouch = 0;
                item.addEventListener('touchend', (e) => {
                    const now = Date.now();
                    if (now - _ufoLastTouch < 350) {
                        e.preventDefault(); e.stopPropagation();
                        try { openLeagueDrawer(); } catch(_) {}
                        _ufoLastTouch = 0;
                    } else {
                        _ufoLastTouch = now;
                    }
                }, { passive: false });
            }
        });

        // Наполняем левую панель (иконка/название второй лиги) и кликом переключаем
        function updateNavLeaguePanel() {
            // Всегда показываем подпись «Лига», иконку оставляем текущей альтернативы
            const act = getActiveLeague();
            const other = act === 'BLB' ? 'UFO' : 'BLB';
            leagueIcon.textContent = other === 'UFO' ? '🛸' : '❔';
            leagueText.textContent = 'Лига';
        }
        leagueBtn?.addEventListener('click', () => {
            // Открываем полку выбора лиг по нажатию на мини-кнопку
            try { openLeagueDrawer(); } catch(_) {}
        });
            // Стартовая вкладка: Главная
        try {
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            const homeItem = document.querySelector('.nav-item[data-tab="home"]');
            if (homeItem) homeItem.classList.add('active');
            const home = document.getElementById('tab-home');
            const prof = document.getElementById('tab-profile');
            const ufo = document.getElementById('tab-ufo');
            const preds = document.getElementById('tab-predictions');
            const lead = document.getElementById('tab-leaderboard');
            const shop = document.getElementById('tab-shop');
            const admin = document.getElementById('tab-admin');
            [home, prof, ufo, preds, lead, shop, admin].forEach(el => { if (el) el.style.display = 'none'; });
            if (home) home.style.display = '';
        } catch(_) {}

    // Инициализация рекламной карусели на Главной
    // Ads carousel & top match moved to profile-ads-featured.js

        // подвкладки НЛО
    const subtabItems = document.querySelectorAll('#ufo-subtabs .subtab-item');
        const subtabMap = {
            table: document.getElementById('ufo-table'),
            stats: document.getElementById('ufo-stats'),
            schedule: document.getElementById('ufo-schedule'),
            results: document.getElementById('ufo-results'),
        };
        subtabItems.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                try { console.log('[ufo-subtab-click]', btn.getAttribute('data-subtab')); } catch(_) {}
                // При переключении подвкладок — убеждаемся, что экран деталей скрыт
                try {
                    const mdPane = document.getElementById('ufo-match-details');
                    const sched = document.getElementById('ufo-schedule');
                    if (mdPane && mdPane.style.display !== 'none') { mdPane.style.display = 'none'; if (sched) sched.style.display=''; const st = document.getElementById('ufo-subtabs'); if (st) st.style.display=''; }
                } catch(_) {}
                const key = btn.getAttribute('data-subtab');
                subtabItems.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(subtabMap).forEach(el => { if (el) el.style.display = 'none'; });
                if (subtabMap[key]) {
                    subtabMap[key].style.display = '';
                    if (key === 'table') {
                        loadLeagueTable();
                    } else if (key === 'stats') {
                        loadStatsTable();
                    } else if (key === 'schedule') {
                        loadSchedule();
                    } else if (key === 'results') {
                        loadResults();
                    }
                }
            });
        });

        // Кнопка «Обновить» на вкладке Таблица (для админа): обновляет ВСЕ панели НЛО
        try {
            const refreshBtn = document.getElementById('league-refresh-btn');
            if (refreshBtn) {
                refreshBtn.addEventListener('click', async () => {
                    const original = refreshBtn.textContent;
                    refreshBtn.disabled = true; refreshBtn.textContent = 'Обновляю...';
                    const fd = new FormData(); fd.append('initData', (window.Telegram?.WebApp?.initData || ''));
                    const reqs = [
                        fetch('/api/league-table/refresh', { method: 'POST', body: fd }),
                        fetch('/api/stats-table/refresh', { method: 'POST', body: fd }),
                        fetch('/api/schedule/refresh', { method: 'POST', body: fd }),
                        fetch('/api/results/refresh', { method: 'POST', body: fd })
                    ];
                    try { await Promise.allSettled(reqs); } catch(_) {}
                    // Мгновенно обновим дату локальным временем
                    try {
                        const updatedText = document.getElementById('league-updated-text');
                        if (updatedText) {
                            const now = new Date();
                            // Сохраним ISO в data-атрибут и не дадим перезаписать более старым временем
                            const iso = now.toISOString();
                            updatedText.setAttribute('data-updated-iso', iso);
                            updatedText.textContent = `Обновлено: ${now.toLocaleString()}`;
                        }
                    } catch(_) {}
                    // И параллельно актуализируем по серверу принудительным GET без кэша
                    try {
                        const u = `/api/league-table?_=${Date.now()}`;
                        const r = await fetch(u, { headers: { 'Cache-Control': 'no-store' } });
                        const data = await r.json();
                        const updatedText = document.getElementById('league-updated-text');
                        if (updatedText && data?.updated_at) {
                            setUpdatedLabelSafely(updatedText, data.updated_at);
                        }
                    } catch(_) {}
                    // Перерисуем все панели
                    try { await Promise.allSettled([ Promise.resolve(loadLeagueTable()), Promise.resolve(loadStatsTable()) ]); } catch(_) {}
                    try { localStorage.removeItem('schedule:tours'); localStorage.removeItem('results:list'); } catch(_) {}
                    try { loadSchedule(); } catch(_) {}
                    try { loadResults(); } catch(_) {}
                    refreshBtn.disabled = false; refreshBtn.textContent = original;
                });
            }
        } catch(_) {}

    // подвкладки Профиля (Достижения/Реферал)
        const pTabs = document.querySelectorAll('#profile-subtabs .subtab-item');
        const pMap = {
            badges: document.getElementById('profile-pane-badges'),
            ref: document.getElementById('profile-pane-ref'),
        };
        pTabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-psub');
                pTabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(pMap).forEach(el => { if (el) el.style.display = 'none'; });
                if (pMap[key]) {
                    pMap[key].style.display = '';
                    if (key === 'ref') loadReferralInfo();
                }
            });
        });

    // Админ-вкладки и потоки вынесены в window.Admin.ensureAdminInit()
    // Share referral button logic moved to profile-referral.js
    }

    // Админ-логика вынесена в static/js/admin.js (window.Admin)

    // ---------- Главная: рекламная карусель ----------
    function initHomeAdsCarousel() {
        const track = document.getElementById('ads-track');
        const dots = document.getElementById('ads-dots');
        const box = document.getElementById('ads-carousel');
        if (!track || !dots || !box) return;
        // Слайды можно задать глобально в index.html через window.__HOME_ADS__
        // Пример:
        // window.__HOME_ADS__ = [ { img:'/static/img/foto.png', title:'Здесь может быть ваша лига — нажми', action:'BLB' } ]
        let slides = Array.isArray(window.__HOME_ADS__) ? window.__HOME_ADS__.slice() : null;
        if (!slides || slides.length === 0) {
            slides = [
                { img: '/static/img/ligareklama.webp', title: 'Нажми', action: 'BLB' },
                { img: '/static/img/reklama.webp', title: '', action: '' },
                { img: '/static/img/reklama.webp', title: '', action: '' }
            ];
        }
        // Рендер слайдов
        track.innerHTML = '';
        dots.innerHTML = '';
        slides.forEach((s, idx) => {
            const slide = document.createElement('div');
            slide.className = 'ads-slide';
            const img = document.createElement('img');
            img.loading = 'lazy';
            img.alt = s.title || '';
            img.src = s.img;
            const overlay = document.createElement('div'); overlay.className = 'ads-overlay'; overlay.textContent = s.title || '';
            slide.append(img, overlay);
            slide.addEventListener('click', () => {
                try {
                    if (s.href) { window.open(s.href, '_blank'); return; }
                    const act = (s.action || '').toUpperCase();
                    if (act === 'BLB') {
                        selectBLBLeague(true);
                    } else if (act === 'UFO') {
                        // Плавный переход и подсказка после завершения
                        let hinted = false;
                        const onEnd = () => { if (hinted) return; hinted = true; try { showLeagueHint(); } catch(_) {} };
                        window.addEventListener('league:transition-end', onEnd, { once: true });
                        setTimeout(onEnd, 3300);
                        selectUFOLeague(false, true);
                        // Переключим вкладку на НЛО
                        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                        const navUfo = document.querySelector('.nav-item[data-tab="ufo"]');
                        if (navUfo) navUfo.classList.add('active');
                        const elHome = document.getElementById('tab-home');
                        const elUfo = document.getElementById('tab-ufo');
                        const elPreds = document.getElementById('tab-predictions');
                        const elLead = document.getElementById('tab-leaderboard');
                        const elShop = document.getElementById('tab-shop');
                        const elAdmin = document.getElementById('tab-admin');
                        [elHome, elUfo, elPreds, elLead, elShop, elAdmin].forEach(el => { if (el) el.style.display = 'none'; });
                        if (elUfo) elUfo.style.display = '';
                    }
                } catch(_) {}
            });
            track.appendChild(slide);
            const dot = document.createElement('div'); dot.className = 'ads-dot' + (idx===0?' active':'');
            dots.appendChild(dot);
        });
        // Авто-листание каждые 3 сек (если слайдов больше одного)
        let index = 0;
        const apply = () => {
            // Прокручиваем через scrollLeft (адаптивно)
            const w = box.clientWidth;
            track.scrollTo({ left: index * w, behavior: 'smooth' });
            // Обновляем точки
            const dlist = Array.from(dots.children);
            dlist.forEach((d,i) => d.classList.toggle('active', i===index));
        };
        let timer = null;
    const arm = () => { if (slides.length <= 1) return; if (timer) clearInterval(timer); timer = setInterval(() => { index = (index + 1) % slides.length; apply(); }, 5000); };
        arm();
        // Свайп-поддержка
        let startX = 0; let scx = 0; let dragging = false;
        track.addEventListener('touchstart', (e) => { if (!e.touches || !e.touches[0]) return; startX = e.touches[0].clientX; scx = track.scrollLeft; dragging = true; if (timer) clearInterval(timer); }, { passive: true });
        track.addEventListener('touchmove', (e) => { if (!dragging || !e.touches || !e.touches[0]) return; const dx = startX - e.touches[0].clientX; track.scrollLeft = scx + dx; }, { passive: true });
        track.addEventListener('touchend', (e) => {
            if (!dragging) return; dragging = false;
            const w = box.clientWidth; const cur = Math.round(track.scrollLeft / Math.max(1,w));
            index = Math.max(0, Math.min(slides.length - 1, cur));
            apply(); arm();
        }, { passive: true });
        // На ресайз подправим позицию
        window.addEventListener('resize', () => { apply(); });
        // Инициал
        apply();
    }

    // Блок «Топ матч недели» под рекламой на Главной
    async function renderTopMatchOfWeek() {
        try {
            // Показываем на Главной только для активной лиги (по ТЗ)
            if ((window.__ACTIVE_LEAGUE__ || 'UFO') !== 'UFO') {
                const host = document.getElementById('home-pane');
                if (host) host.innerHTML = '';
                return;
            }
            const res = await fetch(`/api/schedule?_=${Date.now()}`);
            const data = await res.json();
            const m = data?.match_of_week;
            const host = document.getElementById('home-pane');
            if (!host) return;
            host.innerHTML = '';
            if (!m) { host.innerHTML = '<div style="color: var(--gray);">Скоро анонс матча недели</div>'; return; }
            // Карточка
            const card = document.createElement('div'); card.className = 'match-card home-feature';
            const head = document.createElement('div'); head.className = 'match-header';
            // Заголовок: жирный и крупнее
            head.textContent = 'Игра недели';
            card.appendChild(head);
            // Подзаголовок: дата/время тонким шрифтом под заголовком
            const sub = document.createElement('div'); sub.className = 'match-subheader';
            const dtText = (() => {
                try {
                    if (m.datetime) {
                        const dt = new Date(m.datetime);
                        return dt.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                    }
                    if (m.date) {
                        if (m.time) return `${m.date} ${m.time}`;
                        return String(m.date);
                    }
                } catch(_) {}
                return '';
            })();
            if (dtText) { sub.textContent = dtText; card.appendChild(sub); }
            const center = document.createElement('div'); center.className = 'match-center';
            // Локальный загрузчик логотипов (не зависит от других модулей)
            const loadLogo = (imgEl, teamName) => {
                const base = '/static/img/team-logos/';
                const name = (teamName || '').trim();
                const candidates = [];
                try { imgEl.loading = 'lazy'; imgEl.decoding = 'async'; } catch(_) {}
                if (name) {
                    const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
                    candidates.push(base + encodeURIComponent(norm + '.png'));
                }
                candidates.push(base + 'default.png');
                let idx = 0;
                const tryNext = () => { if (idx >= candidates.length) return; imgEl.onerror = () => { idx++; tryNext(); }; imgEl.src = candidates[idx]; };
                tryNext();
            };
            const L = (name) => { const t = document.createElement('div'); t.className = 'team'; const i = document.createElement('img'); i.className='logo'; loadLogo(i, name||''); const n = document.createElement('div'); n.className='team-name'; n.textContent = name||''; t.append(i, n); return t; };
            const scoreEl = document.createElement('div'); scoreEl.className='score'; scoreEl.textContent='VS';
            center.append(L(m.home), scoreEl, L(m.away));
            card.appendChild(center);
            // Если матч идёт — показываем счёт и обновляем
            try {
                const isLive = (window.MatchUtils ? window.MatchUtils.isLiveNow(m) : false);
                if (isLive) {
                    scoreEl.textContent = '0 : 0';
                    const fetchScore = async () => {
                        try {
                            const r = await fetch(`/api/match/score/get?home=${encodeURIComponent(m.home||'')}&away=${encodeURIComponent(m.away||'')}`);
                            const d = await r.json();
                            if (typeof d?.score_home === 'number' && typeof d?.score_away === 'number') { scoreEl.textContent = `${Number(d.score_home)} : ${Number(d.score_away)}`; }
                        } catch(_) {}
                    };
                    fetchScore();
                }
            } catch(_) {}
            // Горизонтальная полоса голосования «П1 • X • П2» (показываем только если на матч есть ставки)
            const wrap = document.createElement('div'); wrap.className = 'vote-inline';
            const title = document.createElement('div'); title.className = 'vote-title'; title.textContent = 'Голосование';
            const bar = document.createElement('div'); bar.className = 'vote-strip';
            const segH = document.createElement('div'); segH.className = 'seg seg-h';
            const segD = document.createElement('div'); segD.className = 'seg seg-d';
            const segA = document.createElement('div'); segA.className = 'seg seg-a';
            bar.append(segH, segD, segA);
            const legend = document.createElement('div'); legend.className = 'vote-legend';
            const btns = document.createElement('div'); btns.className = 'vote-inline-btns';
            const confirm = document.createElement('div'); confirm.className = 'vote-confirm'; confirm.style.fontSize='12px'; confirm.style.color='var(--success)';
            const voteKey = (() => { try { const raw=m.date?String(m.date):(m.datetime?String(m.datetime):''); const d=raw?raw.slice(0,10):''; return `${(m.home||'').toLowerCase().trim()}__${(m.away||'').toLowerCase().trim()}__${d}`; } catch(_) { return `${(m.home||'').toLowerCase()}__${(m.away||'').toLowerCase()}__`; } })();
            const mkBtn = (code, text) => {
                const b = document.createElement('button');
                b.className = 'details-btn';
                b.textContent = text;
        b.addEventListener('click', async (e) => {
                    try { e.stopPropagation(); } catch(_) {}
                    try {
                        const fd = new FormData();
            fd.append('initData', window.Telegram?.WebApp?.initData || '');
            fd.append('home', m.home || '');
            fd.append('away', m.away || '');
            const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
            fd.append('date', dkey);
                        fd.append('choice', code);
                        const r = await fetch('/api/vote/match', { method: 'POST', body: fd });
                        if (!r.ok) throw 0;
                        btns.querySelectorAll('button').forEach(x => x.disabled = true);
                        confirm.textContent = 'Ваш голос учтён';
                        try { localStorage.setItem('voted:'+voteKey, '1'); } catch(_) {}
                        btns.style.display = 'none';
                        await loadAgg(true);
                    } catch (_) {}
                });
                return b;
            };
            btns.append(mkBtn('home','За П1'), mkBtn('draw','За X'), mkBtn('away','За П2'));
            legend.innerHTML = '<span>П1</span><span>X</span><span>П2</span>';
            wrap.append(title, bar, legend, btns, confirm);
            // Покрасим полосы под цвета команд + серый для ничьей (через background, чтобы перекрыть CSS-градиенты)
            try {
                segH.style.background = getTeamColor(m.home || '');
                segA.style.background = getTeamColor(m.away || '');
                segD.style.background = '#8e8e93';
            } catch(_) {}
            // Показываем блок только если матч в ставочных турах
            const toursCache = (() => { try { return JSON.parse(localStorage.getItem('betting:tours') || 'null'); } catch(_) { return null; } })();
            const mkKey = (obj) => { try { const h=(obj?.home||'').toLowerCase().trim(); const a=(obj?.away||'').toLowerCase().trim(); const raw=obj?.date?String(obj.date):(obj?.datetime?String(obj.datetime):''); const d=raw?raw.slice(0,10):''; return `${h}__${a}__${d}`; } catch(_) { return `${(obj?.home||'').toLowerCase()}__${(obj?.away||'').toLowerCase()}__`; } };
            const tourMatches = new Set(); try { const tours=toursCache?.data?.tours || toursCache?.tours || []; tours.forEach(t => (t.matches||[]).forEach(x => tourMatches.add(mkKey(x)))); } catch(_) {}
            if (tourMatches.has(mkKey(m))) { card.appendChild(wrap); }
                        // Клика по карточке всегда открывает детали матча
                        try {
                                card.style.cursor = 'pointer';
                                card.addEventListener('click', (e) => {
                                        // Не реагируем на клики по кнопкам внутри карточки
                                        try { if (e?.target?.closest('button')) return; } catch(_) {}
                                    // Переключаемся на вкладку НЛО, чтобы экран деталей был видим
                                    try {
                                        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                                        const navUfo = document.querySelector('.nav-item[data-tab="ufo"]');
                                        if (navUfo) navUfo.classList.add('active');
                                        const elHome = document.getElementById('tab-home');
                                        const elUfo = document.getElementById('tab-ufo');
                                        const elUfoContent = document.getElementById('ufo-content');
                                        const elPreds = document.getElementById('tab-predictions');
                                        const elLead = document.getElementById('tab-leaderboard');
                                        const elShop = document.getElementById('tab-shop');
                                        const elAdmin = document.getElementById('tab-admin');
                                        [elHome, elUfo, elPreds, elLead, elShop, elAdmin].forEach(el => { if (el) el.style.display = 'none'; });
                                        if (elUfo) elUfo.style.display = '';
                                        if (elUfoContent) elUfoContent.style.display = '';
                                    } catch(_) {}
                                        const params = new URLSearchParams({ home: m.home || '', away: m.away || '' });
                                        const cacheKey = `md:${(m.home||'').toLowerCase()}::${(m.away||'').toLowerCase()}`;
                                        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
                                        const fetchWithETag = (etag) => fetch(`/api/match-details?${params.toString()}`, { headers: etag ? { 'If-None-Match': etag } : {} })
                                            .then(async r => { if (r.status === 304 && cached) return cached; const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; const toStore = { data, version, ts: Date.now() }; try { localStorage.setItem(cacheKey, JSON.stringify(toStore)); } catch(_) {} return toStore; });
                                        const go = (store) => { try { window.openMatchScreen?.({ home: m.home, away: m.away, date: m.date, time: m.time }, store?.data || store); } catch(_) {} };
                                        const FRESH_TTL = 10 * 60 * 1000;
                                        const isEmptyRosters = (()=>{ try { const d=cached?.data; const h=Array.isArray(d?.rosters?.home)?d.rosters.home:[]; const a=Array.isArray(d?.rosters?.away)?d.rosters.away:[]; return h.length===0 && a.length===0; } catch(_) { return false; }})();
                                        if (cached && !isEmptyRosters && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
                                        else if (cached && cached.version) { fetchWithETag(cached.version).then(go).catch(() => { go(cached); }); }
                                        else if (cached) { go(cached); }
                                        else { fetchWithETag(null).then(go).catch(()=>{}); }
                                });
                        } catch(_) {}
            // кнопка перехода в Прогнозы
            const footer = document.createElement('div'); footer.className='match-footer';
            const goPred = document.createElement('button'); goPred.className='details-btn'; goPred.textContent='Сделать прогноз';
            goPred.addEventListener('click', (e)=>{
                try { e.stopPropagation(); } catch(_) {}
                try { document.querySelector('.nav-item[data-tab="predictions"]').click(); } catch(_) {}
            });
            footer.appendChild(goPred); card.appendChild(footer);
            host.appendChild(card);

            async function loadAgg(withInit){
                try {
            const dkey = (m.date ? String(m.date) : (m.datetime ? String(m.datetime) : '')).slice(0,10);
            const params = new URLSearchParams({ home: m.home||'', away: m.away||'', date: dkey });
            if (withInit) params.append('initData', (window.Telegram?.WebApp?.initData || ''));
                    const agg = await fetch(`/api/vote/match-aggregates?${params.toString()}`).then(r=>r.json());
                    const h = Number(agg?.home||0), d = Number(agg?.draw||0), a = Number(agg?.away||0);
                    const sum = Math.max(1, h+d+a);
                    const ph = Math.round(h*100/sum), pd = Math.round(d*100/sum), pa = Math.round(a*100/sum);
                    segH.style.width = ph+'%'; segD.style.width = pd+'%'; segA.style.width = pa+'%';
            if (agg && agg.my_choice) { btns.querySelectorAll('button').forEach(x=>x.disabled=true); btns.style.display='none'; confirm.textContent='Ваш голос учтён'; try { localStorage.setItem('voted:'+voteKey,'1'); } catch(_) {} }
                } catch(_){ segH.style.width='33%'; segD.style.width='34%'; segA.style.width='33%'; }
            }
        try { if (localStorage.getItem('voted:'+voteKey) === '1') { btns.style.display='none'; confirm.textContent='Ваш голос учтён'; } } catch(_) {}
        loadAgg(true);
        } catch(_) {}
    }
    // Сделаем доступной глобально для вызова из других модулей (например, после назначения матча недели)
    try { window.renderTopMatchOfWeek = renderTopMatchOfWeek; } catch(_) {}

    // Магазин вынесен в static/js/shop.js (window.Shop)

    let _leagueLoading = false;
    function loadLeagueTable() {
        if (_leagueLoading) return;
        const table = document.getElementById('league-table');
        const updatedWrap = document.getElementById('league-table-updated');
        const updatedText = document.getElementById('league-updated-text');
        if (!table) return;
        _leagueLoading = true;
        fetch('/api/league-table')
            .then(r => r.json())
            .then(data => {
                try { window.League?.renderLeagueTable?.(table, updatedText, data); } catch(_) {
                    // fallback: nothing, errors are non-fatal
                }
                // показать кнопку обновления для админа (обработчик навешивается один раз выше)
                const refreshBtn = document.getElementById('league-refresh-btn');
                const adminId = document.body.getAttribute('data-admin');
                const currentId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : '';
                if (updatedWrap && refreshBtn && adminId && currentId && String(adminId) === currentId) {
                    refreshBtn.style.display = '';
                }
                _tableLoaded = true;
                trySignalAllReady();
            })
            .catch(err => { console.error('league table load error', err); })
            .finally(() => { _tableLoaded = true; trySignalAllReady(); _leagueLoading = false; });
    }

    // Безопасное обновление метки "Обновлено":
    // - хранит текущий ISO в data-updated-iso
    // - обновляет текст только если новый ts >= текущего
    function setUpdatedLabelSafely(labelEl, newIso) { try { window.League?.setUpdatedLabelSafely?.(labelEl, newIso); } catch(_) {} }

    // Автообновление таблицы и расписания после завершения матча
    try {
        document.addEventListener('app:match-finished', () => {
            try { window.loadLeagueTable?.(); } catch(_) {}
            try { window.loadSchedule?.(); } catch(_) {}
            try { window.loadResults?.(); } catch(_) {}
        });
    } catch(_) {}

    let _statsLoading = false;
    function loadStatsTable() {
        if (_statsLoading) return;
        const table = document.getElementById('stats-table');
        const updated = document.getElementById('stats-table-updated');
        if (!table) return;
        _statsLoading = true;
        fetch('/api/stats-table')
            .then(r => r.json())
            .then(data => { try { window.League?.renderStatsTable?.(table, updated, data); } catch(_) {} })
            .catch(err => { console.error('stats table load error', err); })
            .finally(() => { _statsLoading = false; });
    }

    // --------- ЛИДЕРБОРД ---------
    let _leaderInited = false;
    function ensureLeaderboardInit() {
        if (_leaderInited) return;
        _leaderInited = true;
        // подвкладки
        const tabs = document.querySelectorAll('#leader-subtabs .subtab-item');
        const panes = {
            predictors: document.getElementById('leader-pane-predictors'),
            rich: document.getElementById('leader-pane-rich'),
            server: document.getElementById('leader-pane-server'),
            prizes: document.getElementById('leader-pane-prizes'),
        };
    // бейдж периода: для прогнозистов показываем неделю, для богатства — месяц. Здесь общий monthly бейдж.
        try {
            const badge = document.getElementById('leader-week-badge');
            if (badge) {
        const now = new Date();
        // Переводим now в МСК (UTC+3) без учёта DST
        const mskNow = new Date(now.getTime() + 3*60*60*1000);
        // Начало месяца в МСК 03:00
        const monthStartMsk = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), 1, 3, 0, 0));
        // Конец месяца: начало следующего месяца минус 1 день
        const nextMonthStartMsk = new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth()+1, 1, 3, 0, 0));
        const periodStartUtc = new Date(monthStartMsk.getTime() - 3*60*60*1000);
        const periodEndUtc = new Date(nextMonthStartMsk.getTime() - 3*60*60*1000 - 1);
        const fmt = (d) => `${d.getDate().toString().padStart(2,'0')}.${(d.getMonth()+1).toString().padStart(2,'0')}`;
        badge.textContent = `Месяц: ${fmt(periodStartUtc)} — ${fmt(periodEndUtc)}`;
            }
        } catch(_) {}
        tabs.forEach(btn => {
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-ltab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
                if (key === 'predictors') loadLBPredictors();
                else if (key === 'rich') loadLBRich();
                else if (key === 'server') loadLBServer();
                else if (key === 'prizes') loadLBPrizes();
            });
        });
        // первичная загрузка
        loadLBPredictors();
    }

    function etagFetch(url, cacheKey) {
        const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(_) { return null; } })();
        const ifNone = cached?.version ? { 'If-None-Match': cached.version } : {};
        return fetch(url, { headers: ifNone })
            .then(async r => {
                if (r.status === 304 && cached) return cached; // валидный кэш
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
                try { localStorage.setItem(cacheKey, JSON.stringify(store)); } catch(_) {}
                return store;
            })
            .catch(err => { if (cached) return cached; throw err; });
    }

    function loadLBPredictors() {
        const table = document.querySelector('#lb-predictors tbody');
        const updated = document.getElementById('lb-predictors-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/top-predictors', 'lb:predictors')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${it.bets_total}</td><td>${it.bets_won}</td><td>${it.winrate}%</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb predictors err', err));
    }

    function loadLBRich() {
        const table = document.querySelector('#lb-rich tbody');
        const updated = document.getElementById('lb-rich-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/top-rich', 'lb:rich')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${Number(it.gain||0).toLocaleString()}</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb rich err', err));
    }

    function loadLBServer() {
        const table = document.querySelector('#lb-server tbody');
        const updated = document.getElementById('lb-server-updated');
        if (!table) return;
        etagFetch('/api/leaderboard/server-leaders', 'lb:server')
            .then(store => {
                const items = store?.data?.items || [];
                table.innerHTML = '';
                items.forEach((it, idx) => {
                    const tr = document.createElement('tr');
                    if (idx === 0) tr.classList.add('rank-1');
                    if (idx === 1) tr.classList.add('rank-2');
                    if (idx === 2) tr.classList.add('rank-3');
                    tr.innerHTML = `<td>${idx+1}</td><td>${escapeHtml(it.display_name)}</td><td>${it.level}</td><td>${it.xp}</td><td>${it.streak}</td><td>${it.score}</td>`;
                    table.appendChild(tr);
                });
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb server err', err));
    }

    function loadLBPrizes() {
        const host = document.getElementById('lb-prizes');
        const updated = document.getElementById('lb-prizes-updated');
        if (!host) return;
        // Локальный кэш публичных профилей (5 минут)
        const PUB_CACHE_TTL = 5 * 60 * 1000;
        const nowMs = () => Date.now();
        const pubCacheGet = (uid) => {
            try {
                const raw = localStorage.getItem('public:profile:' + uid);
                if (!raw) return null;
                const obj = JSON.parse(raw);
                if (!obj || !obj.data || !obj.ts) return null;
                if (nowMs() - obj.ts > PUB_CACHE_TTL) return null;
                return obj.data;
            } catch(_) { return null; }
        };
        const pubCacheSet = (uid, data) => {
            try { localStorage.setItem('public:profile:' + uid, JSON.stringify({ ts: nowMs(), data })); } catch(_) {}
        };
        const tryFetchPublic = async (ids) => {
            try {
                const r = await fetch('/api/users/public-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_ids: ids }) });
                if (!r.ok) throw new Error('no');
                const d = await r.json();
                const items = d?.items || [];
                const map = {};
                items.forEach(it => { if (it?.user_id != null) map[String(it.user_id)] = it; });
                // Кэшируем
                Object.values(map).forEach(it => pubCacheSet(String(it.user_id), it));
                return map;
            } catch(_) { return {}; }
        };
    const ensureOverlay = () => {
            let ov = document.getElementById('profile-preview-overlay');
            if (!ov) {
                ov = document.createElement('div'); ov.id='profile-preview-overlay';
                ov.style.position='fixed'; ov.style.inset='0'; ov.style.background='rgba(0,0,0,0.45)'; ov.style.zIndex='2400'; ov.style.display='none';
                const box = document.createElement('div'); box.className='pp-box'; box.style.position='absolute'; box.style.left='50%'; box.style.top='50%'; box.style.transform='translate(-50%,-50%)'; box.style.background='rgba(15,20,35,0.98)'; box.style.border='1px solid rgba(255,255,255,0.08)'; box.style.borderRadius='12px'; box.style.padding='14px'; box.style.width='min(92%, 380px)'; box.style.boxShadow='0 20px 48px rgba(0,0,0,0.45)';
                const close = document.createElement('button'); close.textContent='✕'; close.style.position='absolute'; close.style.right='8px'; close.style.top='8px'; close.style.background='transparent'; close.style.border='0'; close.style.color='#fff'; close.style.fontSize='16px'; close.style.cursor='pointer';
                close.addEventListener('click', () => { ov.style.display='none'; });
        const cnt = document.createElement('div'); cnt.className='pp-content'; cnt.style.display='grid'; cnt.style.gap='10px';
                box.append(close, cnt); ov.appendChild(box); document.body.appendChild(ov);
                ov.addEventListener('click', (e) => { if (e.target === ov) ov.style.display='none'; });
            }
            return ov;
        };
        const renderProfileCard = (data, avatarUrl) => {
            const ov = ensureOverlay();
            const cnt = ov.querySelector('.pp-content');
        cnt.innerHTML='';
        const row = document.createElement('div'); row.style.display='flex'; row.style.gap='12px'; row.style.alignItems='center';
        const img = document.createElement('img'); img.src = avatarUrl || '/static/img/achievements/placeholder.png'; img.alt=''; img.style.width='64px'; img.style.height='64px'; img.style.borderRadius='50%'; img.style.objectFit='cover'; img.style.border='1px solid rgba(255,255,255,0.15)';
            const info = document.createElement('div');
            const name = document.createElement('div'); name.style.fontWeight='800'; name.style.fontSize='16px'; name.textContent = data.display_name || 'Игрок';
            const meta = document.createElement('div'); meta.style.fontSize='12px'; meta.style.color='var(--gray)';
            const parts = [];
            if (data.level != null) parts.push(`Уровень ${data.level}`);
            if (data.xp != null) parts.push(`${data.xp} XP`);
            if (data.consecutive_days != null) parts.push(`Серия ${data.consecutive_days}`);
            meta.textContent = parts.join(' • ');
            info.append(name, meta);
            row.append(img, info);
        cnt.appendChild(row);
            ov.style.display='';
        };
        etagFetch('/api/leaderboard/prizes', 'lb:prizes')
            .then(store => {
                const data = store?.data?.data || {};
                host.innerHTML = '';
                const blocks = [
                    { key: 'predictors', title: 'Топ прогнозистов' },
                    { key: 'rich', title: 'Лидеры месяца' },
                    { key: 'server', title: 'Лидеры сервера' },
                ];
                // загрузим аватарки победителей одним запросом
                const allIds = new Set();
                blocks.forEach(b => { (data[b.key]||[]).forEach(it => { if (it?.user_id) allIds.add(it.user_id); }); });
                const idsParam = Array.from(allIds).join(',');
                const render = (avatars) => {
                    blocks.forEach(b => {
                    const section = document.createElement('div'); section.className = 'prize-block';
                    const h = document.createElement('h3'); h.textContent = b.title; section.appendChild(h);
                    const podium = document.createElement('div'); podium.className = 'podium';
                    const items = data[b.key] || [];
                    // порядок пьедестала: 2-е, 1-е, 3-е для симметрии
                    const order = [1, 0, 2];
                    order.forEach(i => {
                        const it = items[i];
                        const pl = document.createElement('div'); pl.className = 'podium-place';
                        if (i === 0) pl.classList.add('gold');
                        if (i === 1) pl.classList.add('silver');
                        if (i === 2) pl.classList.add('bronze');
                        const avatar = document.createElement('div'); avatar.className = 'podium-avatar';
                        const img = document.createElement('img'); img.alt = it?.display_name || '';
                        // Аватар с бэкенда, если есть; иначе заглушка
                        const key = it?.user_id ? String(it.user_id) : null;
                        const photo = (key && avatars && avatars[key]) ? avatars[key] : '/static/img/achievements/placeholder.png';
                        img.src = photo;
                        avatar.appendChild(img);
                        const name = document.createElement('div'); name.className = 'podium-name'; name.textContent = it ? it.display_name : '—';
                        // Клик по профилю: попробовать получить публичные данные, иначе показать минимум
                        pl.style.cursor = 'pointer';
                        pl.addEventListener('click', async () => {
                            const uid = it?.user_id != null ? String(it.user_id) : null;
                            if (!uid) { renderProfileCard({ display_name: it?.display_name || 'Игрок' }, photo); return; }
                            const cached = pubCacheGet(uid);
                            if (cached) { renderProfileCard(cached, photo); return; }
                            const map = await tryFetchPublic([Number(uid)]);
                            const dataPub = map[uid] || { display_name: it?.display_name || 'Игрок', level: it?.level, xp: it?.xp, consecutive_days: it?.consecutive_days };
                            // если backend не вернул photo_url — используем уже полученный avatars
                            renderProfileCard(dataPub, dataPub.photo_url || photo);
                        });
                        pl.append(avatar, name);
                        podium.appendChild(pl);
                    });
                    section.appendChild(podium);
                    host.appendChild(section);
                    });
                };
                if (idsParam) {
                    fetch(`/api/user/avatars?ids=${encodeURIComponent(idsParam)}`).then(r=>r.json()).then(d => { render(d.avatars||{}); }).catch(()=>{ render({}); });
                } else {
                    render({});
                }
                if (updated && store?.data?.updated_at) {
                    try { updated.textContent = `Обновлено: ${new Date(store.data.updated_at).toLocaleString()}`; } catch(_) {}
                }
            })
            .catch(err => console.error('lb prizes err', err));
    }

    function escapeHtml(s) {
        return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
    }

    // --------- РАСПИСАНИЕ ---------
    let _scheduleLoading = false;
    function loadSchedule() {
        if (_scheduleLoading) return;
        const pane = document.getElementById('ufo-schedule');
        if (!pane) return;
        _scheduleLoading = true;
    const CACHE_KEY = 'schedule:tours';
    const FRESH_TTL = 10 * 60 * 1000; // 10 минут
    const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
    const cached = readCache();
    if (!cached) pane.innerHTML = '<div class="schedule-loading">Загрузка расписания...</div>';

        // Хелпер: загрузка логотипа команды с фолбэками по названию
        const loadTeamLogo = (imgEl, teamName) => {
            const base = '/static/img/team-logos/';
            const name = (teamName || '').trim();
            const candidates = [];
            if (name) {
        // 1) нормализованное: нижний регистр, без пробелов/ё->е
        const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
        const ver = `?v=${Date.now()}`;
        candidates.push(base + encodeURIComponent(norm + '.png') + ver);
        // 2) при желании можно попытаться точным именем (закомментировано для избежания 404-спама)
        // candidates.push(base + encodeURIComponent(name + '.png'));
            }
            // 3) дефолт (с версией)
            candidates.push(base + 'default.png' + `?v=${Date.now()}`);

            let idx = 0;
            const tryNext = () => {
                if (idx >= candidates.length) return;
                imgEl.onerror = () => { idx++; tryNext(); };
                imgEl.src = candidates[idx];
            };
            tryNext();
        };
    const renderSchedule = (data) => {
            try { window.League?.renderSchedule?.(pane, data?.data || data); } catch(_) {
                // fall back: preserve existing empty state
                const ds = data?.tours ? data : (data?.data || {});
                const tours = ds.tours || [];
                if (!tours.length && !(pane.childElementCount > 0 || pane.dataset.hasContent === '1')) {
                    pane.innerHTML = '<div class="schedule-empty">Нет ближайших туров</div>';
                }
            }
        };

        if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) {
            renderSchedule(cached);
        }
        const fetchWithETag = (etag) => fetch('/api/schedule', { headers: etag ? { 'If-None-Match': etag } : {} })
            .then(async r => {
                if (r.status === 304 && cached) return cached;
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
                // Не затираем кэш пустыми турами, если кэш уже есть и свежий
                const incomingTours = Array.isArray(data?.tours) ? data.tours : Array.isArray(data?.data?.tours) ? data.data.tours : [];
                const cachedTours = Array.isArray(cached?.data?.tours) ? cached.data.tours : [];
                const shouldWrite = incomingTours.length > 0 || !cached || cachedTours.length === 0;
                if (shouldWrite) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(store)); } catch(_) {} }
                return store;
            });
        const startNetwork = () => {
            const p = (cached && cached.version) ? fetchWithETag(cached.version) : fetchWithETag(null);
            p.then(renderSchedule)
             .catch(err => { console.error('schedule load error', err); if (!cached && pane.childElementCount === 0) pane.innerHTML = '<div class="schedule-error">Не удалось загрузить расписание</div>'; })
             .finally(() => { _scheduleLoading = false; });
        };
        startNetwork();
    }

    // --------- РЕЗУЛЬТАТЫ ---------
    let _resultsLoading = false;
    function loadResults() {
        if (_resultsLoading) return;
        const pane = document.getElementById('ufo-results');
        if (!pane) return;
    _resultsLoading = true;
    const CACHE_KEY = 'results:list';
    const FRESH_TTL = 10 * 60 * 1000; // 10 минут
    const readCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch(_) { return null; } };
    const cached = readCache();
    if (!cached) pane.innerHTML = '<div class="schedule-loading">Загрузка результатов...</div>';

    const loadTeamLogo = (imgEl, teamName) => {
            const base = '/static/img/team-logos/';
            const name = (teamName || '').trim();
            const candidates = [];
            if (name) {
                const norm = name.toLowerCase().replace(/\s+/g, '').replace(/ё/g, 'е');
        candidates.push(base + encodeURIComponent(norm + '.png') + `?v=${Date.now()}`);
            }
        candidates.push(base + 'default.png' + `?v=${Date.now()}`);
            let idx = 0;
            const tryNext = () => { if (idx >= candidates.length) return; imgEl.onerror = () => { idx++; tryNext(); }; imgEl.src = candidates[idx]; };
            tryNext();
        };

        // ETag-кэш для /api/results
    const writeCache = (obj) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch(_) {} };

    const fetchWithETag = (etag) => fetch('/api/results', { headers: etag ? { 'If-None-Match': etag } : {} })
            .then(async r => {
                if (r.status === 304 && cached) return cached; // валидный кэш
                const data = await r.json();
                const version = data.version || r.headers.get('ETag') || null;
                const store = { data, version, ts: Date.now() };
        // Не перезаписываем кэш пустыми результатами, если уже были
        const incoming = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data?.results) ? data.data.results : [];
        const cachedList = Array.isArray(cached?.data?.results) ? cached.data.results : [];
        const shouldWrite = incoming.length > 0 || !cached || cachedList.length === 0;
        if (shouldWrite) writeCache(store);
                return store;
            });

    const renderResults = (data) => {
            try { window.League?.renderResults?.(pane, data?.data || data); } catch(_) {
                const all = data?.results || data?.data?.results || [];
                if (!all.length && !(pane.childElementCount > 0 || pane.dataset.hasContent === '1')) {
                    pane.innerHTML = '<div class="schedule-empty">Нет прошедших матчей</div>';
                }
            }
        };

        const go = (store) => { renderResults(store?.data || store); _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady(); };

    if (cached && (Date.now() - (cached.ts||0) < FRESH_TTL)) { go(cached); }
    else if (cached) { go(cached); }
    // сеть — в любом случае валидируем/обновляем кэш
    if (cached && cached.version) fetchWithETag(cached.version).then(go).catch(()=>{});
    else fetchWithETag(null).then(go).catch(err => { console.error('results load error', err); if (!cached) pane.innerHTML = '<div class="schedule-error">Не удалось загрузить результаты</div>'; _resultsLoading = false; _resultsPreloaded = true; trySignalAllReady(); });
    }

    ; // separator for parser safety
    // Предзагрузка статистики и расписания во время заставки
    let _resultsPreloaded = false;
    let _schedulePreloaded = false;
    let _statsPreloaded = false;
    function preloadUfoData() {
        // Статистика
        fetch('/api/stats-table', { headers: { 'Cache-Control': 'no-cache' } })
            .then(r => r.json()).then(() => { _statsPreloaded = true; trySignalAllReady(); })
            .catch(() => { _statsPreloaded = true; trySignalAllReady(); });
        // Расписание — сохраним в кэш с версией
        fetch('/api/schedule', { headers: { 'Cache-Control': 'no-cache' } })
            .then(async r => { const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; try { localStorage.setItem('schedule:tours', JSON.stringify({ data, version, ts: Date.now() })); } catch(_) {} })
            .finally(() => { _schedulePreloaded = true; trySignalAllReady(); });
        // Результаты — сохраним в кэш с версией
        fetch('/api/results', { headers: { 'Cache-Control': 'no-cache' } })
            .then(async r => { const data = await r.json(); const version = data.version || r.headers.get('ETag') || null; try { localStorage.setItem('results:list', JSON.stringify({ data, version, ts: Date.now() })); } catch(_) {} })
            .finally(() => { _resultsPreloaded = true; trySignalAllReady(); });

        // Прогнозы/Ставки: предзагрузка ближайшего тура и моих ставок (если в Telegram)
        try {
            const tg = window.Telegram?.WebApp || null;
            const FRESH_TTL = 5 * 60 * 1000; // 5 минут
            // Туры для ставок (публично, GET)
            fetch('/api/betting/tours', { headers: { 'Cache-Control': 'no-cache' } })
                .then(async r => {
                    const data = await r.json();
                    const version = data.version || r.headers.get('ETag') || null;
                    const store = { data, version, ts: Date.now() };
                    try { localStorage.setItem('betting:tours', JSON.stringify(store)); } catch(_) {}
                })
                .catch(()=>{});
            // Мои ставки (только в Telegram)
            if (tg?.initDataUnsafe?.user) {
                const fd = new FormData(); fd.append('initData', tg.initData || '');
                fetch('/api/betting/my-bets', { method: 'POST', body: fd })
                    .then(r => r.json())
                    .then(data => { try { localStorage.setItem('betting:mybets', JSON.stringify({ data, ts: Date.now() })); } catch(_) {} })
                    .catch(()=>{});
            }
        } catch(_) {}
    }

    // ---------- ЛИГИ: НЛО / БЛБ (оверлей над нижним меню) ----------
    function getActiveLeague() {
        try {
            const mem = sessionStorage.getItem('activeLeague');
            if (mem === 'BLB' || mem === 'UFO') return mem;
        } catch(_) {}
        return window.__ACTIVE_LEAGUE__ || 'UFO';
    }
    function setActiveLeague(code) {
        window.__ACTIVE_LEAGUE__ = code;
        try { sessionStorage.setItem('activeLeague', code || 'UFO'); } catch(_) {}
        try { updateNavLeagueIcon(); } catch(_) {}
        // Apply theme based on league
        if (code === 'BLB') {
            document.body.classList.add('blb-theme');
        } else {
            document.body.classList.remove('blb-theme');
        }
    }
    function renderLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        if (!overlay) return;
        const act = getActiveLeague();
        const other = act === 'BLB' ? 'UFO' : 'BLB';
        const ico = other === 'UFO' ? '🛸' : '❔';
        const title = other === 'UFO' ? 'НЛО' : 'ВАША ЛИГА';
        // Рендерим одну иконку как продолжение нижнего меню
        overlay.innerHTML = `
            <div class="league-icons" style="display:flex; align-items:center; justify-content:center; background: rgba(10,18,40,0.96); padding:6px 0; border-radius: 10px 10px 0 0; box-shadow: 0 6px 18px rgba(0,0,0,0.4);">
                <div class="nav-icon" data-league="${other}" title="${title}" style="font-size:22px; cursor:pointer; line-height:1;">${ico}</div>
            </div>
        `;
        // Подгонка позиции/размера под иконку меню
        try {
            const anchor = document.querySelector('.nav-item[data-tab="ufo"]');
            const nav = document.querySelector('nav.nav');
            if (anchor && nav) {
                const r = anchor.getBoundingClientRect();
                const rn = nav.getBoundingClientRect();
                // Ширина как у иконки меню
                const w = Math.max(40, Math.floor(r.width));
                overlay.style.width = `${w}px`;
                // Привязать левый край плашки к левому краю нижнего меню
                const leftEdge = Math.floor(rn.left);
                overlay.style.left = `${leftEdge}px`;
                overlay.style.transform = 'none';
                // Чуть поднять над меню
                const gap = 6;
                const navH = Math.floor(rn.height);
                overlay.style.bottom = `${navH + gap}px`;
            }
        } catch(_) {}
    }
    function showLeagueOverlay() {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!overlay || !ufoTabs || !ufoContent || !blbBlock) return;
    // если уже открыт — не дублируем
    if (overlay.style.display === 'block') return;
        // Обновим содержимое оверлея и покажем
        renderLeagueOverlay();
        overlay.style.display = 'block';
        if (!overlay.__inited) {
            overlay.__inited = true;
        overlay.addEventListener('click', (e) => {
                const ico = e.target.closest('.nav-icon[data-league]');
                if (ico) {
                    const key = ico.getAttribute('data-league');
            // Выбор из оверлея: включаем анимацию перехода
            if (key === 'UFO') selectUFOLeague(false, true);
            if (key === 'BLB') selectBLBLeague(true);
                    overlay.style.display = 'none';
                    return;
                }
            });
            // Клик вне оверлея — закрыть
            document.addEventListener('click', (e) => {
                const isUfoNav = !!e.target.closest('.nav-item[data-tab="ufo"]');
                if (!overlay || overlay.style.display === 'none') return;
                if (e.target.closest('#league-overlay') || isUfoNav) return;
                overlay.style.display = 'none';
            });
            // При ресайзе/смене ориентации — скрыть
            window.addEventListener('resize', () => { if (overlay) overlay.style.display = 'none'; });
            window.addEventListener('orientationchange', () => { if (overlay) overlay.style.display = 'none'; });
        }
        // На всякий случай пересчитать позицию после показа (рендер может занять тик)
        setTimeout(renderLeagueOverlay, 0);
    }

    function selectUFOLeague(_silent, animate=false) {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!ufoTabs || !ufoContent || !blbBlock) return;
    setActiveLeague('UFO');
        // Apply UFO theme
        document.body.classList.remove('blb-theme');
        if (overlay) overlay.style.display = 'none';
        blbBlock.style.display = 'none';
        ufoTabs.style.display = '';
        ufoContent.style.display = '';
        if (!_silent) {
            // Ждём, пока оверлей полностью закроет экран, и ещё 1 сек — затем подгружаем
            const onCovered = () => {
                setTimeout(() => {
                    try { loadLeagueTable(); } catch(_) {}
                    try { loadStatsTable(); } catch(_) {}
                    try { loadSchedule(); } catch(_) {}
                    try { loadResults(); } catch(_) {}
                    try { renderTopMatchOfWeek(); } catch(_) {}
                }, 1000);
                window.removeEventListener('league:transition-covered', onCovered);
            };
            window.addEventListener('league:transition-covered', onCovered);
            // На случай, если анимации нет — фолбэк сразу
            if (!animate) { window.removeEventListener('league:transition-covered', onCovered); onCovered(); }
        }
    if (animate) {
        // Показать подсказку после завершения анимации (один раз для пользователя)
        const onEnd = () => { try { showLeagueHint(); } catch(_) {} };
        window.addEventListener('league:transition-end', onEnd, { once: true });
        playLeagueTransition('UFO');
    }
    }

    function selectBLBLeague(animate=false) {
        const overlay = document.getElementById('league-overlay');
        const ufoTabs = document.getElementById('ufo-subtabs');
        const ufoContent = document.getElementById('ufo-content');
        const blbBlock = document.getElementById('blb-block');
        if (!ufoTabs || !ufoContent || !blbBlock) return;
        setActiveLeague('BLB');
        // Apply BLB theme
        document.body.classList.add('blb-theme');
        if (overlay) overlay.style.display = 'none';
        ufoTabs.style.display = 'none';
        ufoContent.style.display = 'none';
        blbBlock.style.display = '';
        // Небольшая задержка показа контента БЛБ после покрытия оверлеем
        const showBLB = () => { initBLBSubtabs(); window.removeEventListener('league:transition-covered', showBLB); };
        window.addEventListener('league:transition-covered', showBLB);
        if (!animate) { window.removeEventListener('league:transition-covered', showBLB); showBLB(); }
    // Обновим «Матч недели» на Главной в соответствии с активной лигой
    try { renderTopMatchOfWeek(); } catch(_) {}
    if (animate) {
        // Показать подсказку после завершения анимации (один раз для пользователя)
        const onEnd = () => { try { showLeagueHint(); } catch(_) {} };
        window.addEventListener('league:transition-end', onEnd, { once: true });
        playLeagueTransition('BLB');
    }
    }

    function playLeagueTransition(to) {
        try {
            const layer = document.getElementById('league-transition');
            if (!layer) return;
            const content = document.createElement('div');
            content.className = 'lt-content';
            const img = document.createElement('img');
            img.className = 'lt-logo';
            const title = document.createElement('div');
            title.className = 'lt-title';
            // Очистим классы стадий
            layer.classList.remove('lt-fill-bottom','lt-fill-top','lt-unfill-top','lt-unfill-bottom');
            if (to === 'BLB') {
                img.src = '/static/img/placeholderlogo.png';
                title.textContent = 'Здесь может быть ваша лига';
                layer.style.display = 'flex';
                // Используем золотисто-черную палитру BLБ: мягкий градиент к золотистому
                layer.style.background = 'linear-gradient(135deg, #0b0b0b 0%, #1a160c 40%, #8d6e2f 100%)';
                // Фаза 1: заливка снизу вверх (1s)
                layer.classList.add('lt-fill-bottom');
                // Сразу после старта заливки считаем экран покрытым
                try { window.dispatchEvent(new CustomEvent('league:transition-covered', { detail: { to } })); } catch(_) {}
        setTimeout(() => {
                    // Смена темы/топ-бара во время полной заливки (пользователь не видит)
                    document.body.classList.add('theme-blb');
                    const t = document.querySelector('.top-bar .league-title');
                    if (t) t.textContent = 'Название лиги';
                    const logo = document.querySelector('.top-bar .league-logo');
                    if (logo) logo.src = '/static/img/placeholderlogo.png';
                    // Пауза 1s
                    layer.classList.remove('lt-fill-bottom');
                    setTimeout(() => {
                        // Фаза 2: уборка вверх (1s)
                        layer.classList.add('lt-unfill-top');
            setTimeout(() => { layer.style.display = 'none'; layer.classList.remove('lt-unfill-top'); try { window.dispatchEvent(new CustomEvent('league:transition-end', { detail: { to } })); } catch(_) {} }, 1000);
                    }, 1000);
                }, 1000);
            } else {
                img.src = '/static/img/logo.png';
                title.textContent = 'ОБНИНСКАЯ ЛИГА';
                layer.style.display = 'flex';
                // Используем палитру стартовой заставки (splash): var(--dark)->var(--darker)
                // Берём переменные с :root (а не body), чтобы не подмешивалась тема BLB
                const cs = getComputedStyle(document.documentElement);
                const dark = (cs.getPropertyValue('--dark') || '#0f172a').trim();
                const darker = (cs.getPropertyValue('--darker') || '#020617').trim();
                layer.style.background = `linear-gradient(135deg, ${dark}, ${darker})`;
                // Фаза 1: заливка сверху вниз (1s)
                layer.classList.add('lt-fill-top');
                // Сразу после старта заливки считаем экран покрытым
                try { window.dispatchEvent(new CustomEvent('league:transition-covered', { detail: { to } })); } catch(_) {}
                setTimeout(() => {
                    // Смена темы/топ-бара во время полной заливки
                    document.body.classList.remove('theme-blb');
                    const t = document.querySelector('.top-bar .league-title');
                    if (t) t.textContent = 'Лига Обнинска';
                    const logo = document.querySelector('.top-bar .league-logo');
                    if (logo) logo.src = '/static/img/logo.png';
                    // Пауза 1s
                    layer.classList.remove('lt-fill-top');
                    setTimeout(() => {
                        // Фаза 2: уборка вниз (1s)
                        layer.classList.add('lt-unfill-bottom');
                        setTimeout(() => { layer.style.display = 'none'; layer.classList.remove('lt-unfill-bottom'); try { window.dispatchEvent(new CustomEvent('league:transition-end', { detail: { to } })); } catch(_) {} }, 1000);
                    }, 1000);
                }, 1000);
            }
            content.appendChild(img);
            content.appendChild(title);
            layer.innerHTML = '';
            layer.appendChild(content);
        } catch(_) {}
    }

    // Красиво открывающаяся «полка» списка лиг из нижнего меню
    function ensureLeagueShelf() {
        let shelf = document.getElementById('league-shelf');
        if (shelf) return shelf;
        shelf = document.createElement('div');
        shelf.id = 'league-shelf';
        shelf.className = 'league-shelf';
        shelf.style.position = 'fixed';
        shelf.style.left = '50%';
        shelf.style.transform = 'translateX(-50%)';
        shelf.style.bottom = '0';
        shelf.style.zIndex = '1099';
        const inner = document.createElement('div');
        inner.className = 'league-options';
        // Две плитки лиг
        const mkTile = (code, icon, name) => {
            const tile = document.createElement('div'); tile.className = 'league-tile'; tile.setAttribute('data-league', code);
            const ic = document.createElement('div'); ic.className = 'league-icon'; ic.textContent = icon;
            const nm = document.createElement('div'); nm.className = 'league-name'; nm.textContent = name;
            tile.append(ic, nm);
            tile.addEventListener('click', () => {
                try {
                    if (code === 'UFO') selectUFOLeague(false, true); else selectBLBLeague(true);
                } catch(_) {}
                closeLeagueShelf();
            });
            return tile;
        };
        inner.append(
            mkTile('UFO', '🛸', 'НЛО'),
            mkTile('BLB', '❔', 'ВАША ЛИГА')
        );
        shelf.appendChild(inner);
        document.body.appendChild(shelf);
        // Закрытие по клику вне полки
        setTimeout(() => {
            const onDoc = (e) => { if (!shelf.contains(e.target) && !e.target.closest('nav.nav')) { closeLeagueShelf(); } };
            document.addEventListener('click', onDoc, { capture: true });
            shelf.__onDoc = onDoc;
        }, 0);
        return shelf;
    }
    // Старое всплывающее меню лиг больше не используется

    // Боковой drawer лиг
    function openLeagueDrawer() {
        const drawer = document.getElementById('league-drawer');
        const nav = document.getElementById('bottom-nav');
        if (!drawer) return;
        // скрыть нижнее меню быстро
    if (nav) { nav.style.transition = 'transform .12s ease, opacity .12s ease'; nav.style.transform = 'translateX(-50%) translateY(100%)'; nav.style.opacity = '0'; }
        drawer.style.display = 'block';
        requestAnimationFrame(() => { drawer.style.transform = 'translateX(0)'; drawer.setAttribute('aria-hidden', 'false'); });
        const onClick = (e) => {
            const btn = e.target.closest('.drawer-item');
            if (!btn) return;
            const key = btn.getAttribute('data-league');
            // анимация перехода
            if (key === 'UFO') selectUFOLeague(false, true); else if (key === 'BLB') selectBLBLeague(true);
            // сразу закрываем drawer, чтобы не мешал анимации перехода
            closeLeagueDrawer();
        };
        drawer.addEventListener('click', onClick, { once: true });
        // клик вне — закрытие
        const onDoc = (e) => { if (!drawer.contains(e.target)) closeLeagueDrawer(); };
        setTimeout(() => document.addEventListener('click', onDoc, { capture: true, once: true }), 0);
    }
    function closeLeagueDrawer() {
        const drawer = document.getElementById('league-drawer');
        const nav = document.getElementById('bottom-nav');
        if (!drawer) return;
        drawer.style.transform = 'translateX(100%)';
        setTimeout(() => { drawer.style.display = 'none'; drawer.setAttribute('aria-hidden', 'true'); }, 280);
        if (nav) {
            nav.style.transform = 'translateX(-50%) translateY(0)';
            nav.style.opacity = '1';
            // немного отложим сброс transition, чтобы анимация вернулась корректно
            setTimeout(() => { if (nav) nav.style.transition = ''; }, 60);
        }
    }

    function initBLBSubtabs() {
        const tabs = document.querySelectorAll('#blb-subtabs .subtab-item');
        const panes = {
            table: document.getElementById('blb-table'),
            stats: document.getElementById('blb-stats'),
            schedule: document.getElementById('blb-schedule'),
            results: document.getElementById('blb-results')
        };
        tabs.forEach(btn => {
            if (btn.__inited) return; btn.__inited = true;
            btn.setAttribute('data-throttle', '600');
            btn.addEventListener('click', () => {
                const key = btn.getAttribute('data-blbtab');
                tabs.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                Object.values(panes).forEach(p => { if (p) p.style.display = 'none'; });
                if (panes[key]) panes[key].style.display = '';
            });
        });
    }

    // Подсказка: стрелка к вкладке «Лига» с текстом (один раз). Стрелка и текст двигаются синхронно.
    function showLeagueHint() {
        try {
            // Только один раз для пользователя
            try { if (localStorage.getItem('hint:league-shown') === '1') return; } catch(_) {}
            if (document.getElementById('league-hint-tip')) return;
            const target = document.querySelector('.nav-item[data-tab="ufo"]');
            const nav = document.querySelector('nav.nav');
            if (!target || !nav) return;
            const r = target.getBoundingClientRect();
            const rn = nav.getBoundingClientRect();
            const tip = document.createElement('div');
            tip.id = 'league-hint-tip';
            tip.style.position = 'fixed';
            tip.style.zIndex = '1200';
            tip.style.pointerEvents = 'none';
            // Стрелка (анимированная)
            const arrow = document.createElement('div');
            arrow.style.width = '0';
            arrow.style.height = '0';
            arrow.style.borderLeft = '7px solid transparent';
            arrow.style.borderRight = '7px solid transparent';
            arrow.style.borderTop = '12px solid #fff';
            arrow.style.filter = 'drop-shadow(0 1px 2px rgba(0,0,0,.6))';
            arrow.style.position = 'absolute';
            arrow.style.left = '50%';
            arrow.style.transform = 'translateX(-50%)';
            arrow.style.bottom = '14px';
            arrow.style.animation = 'hint-bounce 1s ease-in-out infinite';
            // Текст (появится позже)
            const label = document.createElement('div');
            label.textContent = 'Двойное нажатие — выбор лиги';
            label.style.position = 'absolute';
            label.style.left = '50%';
            // Совместим анимацию с стрелкой: вертикально синхронный bounce
            label.style.transform = 'translateX(-50%)';
            label.style.bottom = '30px';
            label.style.fontSize = '11px';
            label.style.fontWeight = '800';
            label.style.color = '#fff';
            label.style.whiteSpace = 'nowrap';
            label.style.textShadow = '0 1px 2px rgba(0,0,0,.6)';
            // Появление и синхронная анимация
            label.style.opacity = '0';
            label.style.transition = 'opacity .25s ease';
            label.style.animation = 'hint-bounce 1s ease-in-out infinite';
            tip.appendChild(arrow);
            tip.appendChild(label);
            document.body.appendChild(tip);
            // Позиционирование по центру иконки лиги
            let centerX = r.left + r.width / 2;
            tip.style.left = `${Math.round(centerX)}px`;
            // Центрируем контейнер и затем ограничиваем с учётом реальной ширины
            tip.style.transform = 'translateX(-50%)';
            const margin = 16;
            // После рендера измерим и поправим позицию
            requestAnimationFrame(() => {
                try {
                    const bw = tip.getBoundingClientRect().width || 0;
                    const half = bw / 2;
                    const clampedCenter = Math.max(margin + half, Math.min(window.innerWidth - margin - half, centerX));
                    tip.style.left = `${Math.round(clampedCenter)}px`;
                } catch(_) {}
            });
            tip.style.bottom = `${Math.round((window.innerHeight - rn.top) + 6)}px`;
            // Показать текст сразу после завершения перехода (функция вызывается по событию 
            // league:transition-end с once, но оставим лёгкую задержку для плавности)
            setTimeout(() => { label.style.opacity = '1'; }, 200);
            // Убрать подсказку по клику по нижнему меню или через таймаут, и больше не показывать
            const cleanup = () => {
                try { localStorage.setItem('hint:league-shown', '1'); } catch(_) {}
                try { tip.remove(); } catch(_) {}
                document.removeEventListener('click', onDocClick, true);
            };
            const onDocClick = (e) => { if (e.target.closest('nav.nav')) cleanup(); };
            document.addEventListener('click', onDocClick, true);
            setTimeout(cleanup, 6000);
            // Встроенная keyframes-анимация
            if (!document.getElementById('hint-bounce-style')) {
                const st = document.createElement('style');
                st.id = 'hint-bounce-style';
                // Дублируем translateX, чтобы синхронность сохранялась для обоих элементов
                st.textContent = `@keyframes hint-bounce{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-6px)}}`;
                document.head.appendChild(st);
            }
        } catch(_) {}
    }

    // ---------- MATCH DETAILS SCREEN (in-app, not modal) ----------
    // Advanced match screen logic moved to profile-match-advanced.js
    // Keep backward compatibility stub
if(!window.openMatchScreen){
  window.openMatchScreen = function(match, details){
    if(window.MatchAdvanced?.openMatchScreen){
      return window.MatchAdvanced.openMatchScreen(match, details);
    }
    console.warn('MatchAdvanced.openMatchScreen not loaded yet');
  };
}

    // match stats moved to profile-match-stats.js (window.MatchStats.render)
    if(!window.renderMatchStats){
        window.renderMatchStats = function(host, match){
            if(window.MatchStats?.render){
                return window.MatchStats.render(host, match);
            }
            console.warn('MatchStats module not loaded yet');
        };
    }

    // Рендер спецсобытий (внутри деталей матча)
    // specials pane moved to profile-match-specials.js (window.MatchSpecials.render)
    if(!window.renderSpecialsPane){
        window.renderSpecialsPane = function(host, match){
            if(window.MatchSpecials?.render){
                return window.MatchSpecials.render(host, match);
            }
            console.warn('MatchSpecials module not loaded yet');
        };
    }

    // Рендер событий игроков (для обеих команд) + админ-форма добавления
    function renderEventsPane(host, match, cachedEvents) {
        const tg = window.Telegram?.WebApp || null;
        host.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'events-wrap';

        const mkSide = (title) => {
            const col = document.createElement('div');
            col.className = 'events-col';
            const h = document.createElement('div'); h.className = 'events-title'; h.textContent = title;
            const list = document.createElement('div'); list.className = 'events-list';
            col.append(h, list);
            return { col, list };
        };
        const homeBlock = mkSide('Команда 1');
        const awayBlock = mkSide('Команда 2');
        const grid = document.createElement('div'); grid.className = 'events-grid'; grid.style.display='grid'; grid.style.gridTemplateColumns='1fr 1fr'; grid.style.gap='12px';
        grid.append(homeBlock.col, awayBlock.col);
        wrap.appendChild(grid);

        // Админский блок редактирования счёта (live), не влияет на ставки до завершения матча
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            if (isAdmin) {
                const scoreBox = document.createElement('div');
                scoreBox.className = 'admin-panel';
                scoreBox.style.marginTop='12px'; scoreBox.style.padding='8px'; scoreBox.style.border='1px solid rgba(255,255,255,0.1)'; scoreBox.style.borderRadius='10px';
                scoreBox.innerHTML = `
                    <div style="margin-bottom:6px; font-weight:600;">Счёт матча (только отображение)</div>
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <label>Команда 1: <input type="number" id="sc-h" min="0" style="width:80px;" /></label>
                        <label>Команда 2: <input type="number" id="sc-a" min="0" style="width:80px;" /></label>
                        <button class="app-btn" id="sc-save">Сохранить счёт</button>
                        <div class="hint">Ставки будут рассчитаны только после нажатия «Рассчитать матч».</div>
                    </div>
                `;
                wrap.appendChild(scoreBox);
                const inpH = scoreBox.querySelector('#sc-h');
                const inpA = scoreBox.querySelector('#sc-a');
                const btn = scoreBox.querySelector('#sc-save');
                // загрузим текущий счёт
                fetch(`/api/match/score/get?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`)
                    .then(r=>r.json()).then(d => {
                        if (typeof d.score_home === 'number') inpH.value = d.score_home;
                        if (typeof d.score_away === 'number') inpA.value = d.score_away;
                    }).catch(()=>{});
                btn.addEventListener('click', async () => {
                    const tg = window.Telegram?.WebApp || null;
                    const fd = new FormData();
                    fd.append('initData', tg?.initData || '');
                    fd.append('home', match.home || '');
                    fd.append('away', match.away || '');
                    if (inpH.value !== '') fd.append('score_home', inpH.value);
                    if (inpA.value !== '') fd.append('score_away', inpA.value);
                    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Сохранение...';
                    try {
                        const r = await fetch('/api/match/score/set', { method: 'POST', body: fd });
                        const d = await r.json().catch(()=>({}));
                        if (!r.ok || d?.error) throw new Error(d?.error || 'Ошибка сохранения счёта');
                        try { window.showAlert?.('Счёт сохранён', 'success'); } catch(_) {}
                    } catch(e) {
                        console.error('score set error', e);
                        try { window.showAlert?.(e?.message || 'Ошибка', 'error'); } catch(_) {}
                    } finally { btn.disabled=false; btn.textContent = old; }
                });
            }
        } catch(_) {}

        const renderList = (listEl, items) => {
            listEl.innerHTML = '';
            if (!items || !items.length) {
                const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Нет событий';
                listEl.appendChild(empty); return;
            }
            items.forEach(e => {
                const row = document.createElement('div'); row.className = 'event-item';
                const left = document.createElement('div'); left.className = 'event-left';
                const right = document.createElement('div'); right.className = 'event-right';
                left.textContent = (e.minute!=null? `${e.minute}'` : '');
                const typeLabel = { goal:'Гол', assist:'Пас', yellow:'Желтая', red:'Красная' }[e.type] || e.type;
                right.textContent = `${typeLabel}: ${e.player}${e.note? ' — ' + e.note : ''}`;
                row.style.display='flex'; row.style.gap='8px'; row.style.alignItems='center';
                row.append(left, right); listEl.appendChild(row);
            });
        };

        const applyData = (data) => {
            try {
                renderList(homeBlock.list, data?.home || []);
                renderList(awayBlock.list, data?.away || []);
            } catch(_) {
                renderList(homeBlock.list, []); renderList(awayBlock.list, []);
            }
        };

        // начальный рендер
        if (cachedEvents) applyData(cachedEvents);

        // актуализируем с сервера
        const refresh = () => {
            const url = `/api/match/events/list?home=${encodeURIComponent(match.home||'')}&away=${encodeURIComponent(match.away||'')}`;
            fetch(url).then(r=>r.json()).then(d => applyData(d?.items)).catch(()=>{});
        };
        refresh();

        // Админ-форма
        try {
            const adminId = document.body.getAttribute('data-admin');
            const currentId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ? String(window.Telegram.WebApp.initDataUnsafe.user.id) : '';
            const isAdmin = !!(adminId && currentId && String(adminId) === currentId);
            if (isAdmin) {
                const form = document.createElement('div'); form.className = 'admin-panel';
                form.style.marginTop='12px'; form.style.padding='8px'; form.style.border='1px solid rgba(255,255,255,0.1)'; form.style.borderRadius='10px';
                form.innerHTML = `
                    <div style="margin-bottom:6px; font-weight:600;">Добавить событие</div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                        <label>Сторона:
                            <select id="ev-team"><option value="home">Команда 1</option><option value="away">Команда 2</option></select>
                        </label>
                        <label>Минута:
                            <input type="number" id="ev-minute" min="0" max="200" placeholder="мин" style="width:80px;" />
                        </label>
                        <label>Игрок:
                            <input type="text" id="ev-player" placeholder="ФИО" />
                        </label>
                        <label>Тип:
                            <select id="ev-type">
                                <option value="goal">Гол</option>
                                <option value="assist">Пас</option>
                                <option value="yellow">Желтая</option>
                                <option value="red">Красная</option>
                            </select>
                        </label>
                        <label>Заметка:
                            <input type="text" id="ev-note" placeholder="необязательно" />
                        </label>
                        <button class="details-btn" id="ev-save">Добавить</button>
                    </div>
                `;
                wrap.appendChild(form);
                const btn = form.querySelector('#ev-save');
                btn.addEventListener('click', () => {
                    const minuteRaw = form.querySelector('#ev-minute').value;
                    const payload = new FormData();
                    payload.append('initData', tg?.initData || '');
                    payload.append('home', match.home || '');
                    payload.append('away', match.away || '');
                    payload.append('team', form.querySelector('#ev-team').value);
                    const minute = minuteRaw!=='' ? String(parseInt(minuteRaw,10)) : '';
                    if (minute!=='') payload.append('minute', minute);
                    payload.append('player', form.querySelector('#ev-player').value.trim());
                    payload.append('type', form.querySelector('#ev-type').value);
                    const noteVal = form.querySelector('#ev-note').value.trim(); if (noteVal) payload.append('note', noteVal);
                    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Сохранение...';
                    fetch('/api/match/events/add', { method: 'POST', body: payload })
                        .then(r=>r.json())
                        .then(d => {
                            if (d?.error) { try { window.showAlert?.(d.error, 'error'); } catch(_) {} return; }
                            // очистим поля и обновим список
                            form.querySelector('#ev-minute').value='';
                            form.querySelector('#ev-player').value='';
                            form.querySelector('#ev-type').value='goal';
                            form.querySelector('#ev-note').value='';
                            refresh();
                        })
                        .catch(err => { console.error('events/add error', err); try { window.showAlert?.('Ошибка сохранения', 'error'); } catch(_) {} })
                        .finally(()=>{ btn.disabled=false; btn.textContent = old; });
                });
            }
        } catch(_) {}

        host.appendChild(wrap);
    }

    // Удалён каталог достижений

    // Referral logic moved to profile-referral.js

    // _achLoaded уже выставлен выше (legacy achievements removed)
    let _tableLoaded = false;
    function trySignalAllReady() {
        // считаем готовность, когда базовые данные профиля есть, таблица лиги подтянулась,
        // и стартовые данные UFO (stats/schedule/results) прогреты (не обязательно успешны)
        if (_achLoaded && _tableLoaded && _statsPreloaded && _schedulePreloaded && _resultsPreloaded) {
            window.dispatchEvent(new CustomEvent('app:all-ready'));
        }
    }

    // При старте запоминаем активную лигу из сессии (по умолчанию НЛО) и обновляем иконку меню
    try { setActiveLeague(getActiveLeague()); updateNavLeagueIcon(); } catch(_) {}

    function updateNavLeagueIcon() {
        try {
            const item = document.querySelector('.nav-item[data-tab="ufo"]');
            if (!item) return;
            const iconEl = item.querySelector('.nav-icon');
            const labelEl = item.querySelector('.nav-label');
            const act = getActiveLeague();
            if (act === 'BLB') {
                if (iconEl) iconEl.textContent = '❔';
                if (labelEl) labelEl.textContent = 'Лига';
            } else {
                if (iconEl) iconEl.textContent = '🛸';
                if (labelEl) labelEl.textContent = 'НЛО';
            }
        } catch(_) {}
    }

    // старт
    // В некоторых рефакторингах старая initApp была удалена. Создадим лёгкую заглушку, если не определена.
    if (typeof initApp !== 'function') {
        try { window.initApp = function(){ try { updateNavLeagueIcon(); } catch(_) {}; }; } catch(_) {}
    }
    initApp();
    // Стартовая предзагрузка UFO-данных во время заставки
    preloadUfoData();
    setupEventListeners();
    try { window.__NAV_INITIALIZED__ = true; } catch(_) {}
    try { window.Shop?.updateCartBadge?.(); } catch(_) {}

    // Форсируем первичную отрисовку UFO таблицы и лидеров (если пользователь сразу переключится)
    try { loadLeagueTable(); } catch(_) {}
    try { ensureLeaderboardInit?.(); } catch(_) {}
    // Если активна по умолчанию подвкладка таблицы — инициируем остальные ленивые прогревы в фоне
    try { setTimeout(()=>{ try { loadStatsTable(); } catch(_) {} try { loadSchedule(); } catch(_) {} try { loadResults(); } catch(_) {}; }, 400); } catch(_) {}
    try { window.ensureAdminUI?.(); } catch(_) {}

    // Экспорт функций
    window.selectBLBLeague = selectBLBLeague;
    window.selectUFOLeague = selectUFOLeague;
    window.setActiveLeague = setActiveLeague;

    // LIVE notifications перенесены в profile-live.js
})();
