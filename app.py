"""Flask backend for Liga Obninska app with betting, Google Sheets and SQLAlchemy."""
import os
import flask  # added to reference flask.g explicitly
import json
import time
import hashlib
import hmac
from datetime import datetime, date, timezone
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from flask import Flask, request, jsonify, render_template, send_from_directory, g

# Импорты для системы безопасности и мониторинга (Фаза 3)
try:
    from utils.security import InputValidator, TelegramSecurity, RateLimiter, SQLInjectionPrevention
    from utils.decorators import require_telegram_auth, require_admin, rate_limit, validate_input
    from utils.monitoring import PerformanceMetrics, DatabaseMonitor, CacheMonitor, HealthCheck
    from utils.middleware import SecurityMiddleware, PerformanceMiddleware, DatabaseMiddleware, ErrorHandlingMiddleware
    from api.monitoring import monitoring_bp
    from api.security_test import security_test_bp
    from config import Config
    SECURITY_SYSTEM_AVAILABLE = True
    print("[INFO] Phase 3: Security and monitoring system initialized")
except ImportError as e:
    print(f"[WARN] Phase 3 security system not available: {e}")
    SECURITY_SYSTEM_AVAILABLE = False
    # --- Fallback lightweight no-op decorators & stubs so app can still start ---
    def _noop_decorator_factory(*dargs, **dkwargs):
        def _inner(f):
            return f
        # Allow usage both as @decorator and @decorator(...)
        if dargs and callable(dargs[0]) and len(dargs) == 1 and not dkwargs:
            return dargs[0]
        return _inner

    require_telegram_auth = _noop_decorator_factory  # type: ignore
    require_admin = _noop_decorator_factory          # type: ignore
    rate_limit = lambda *a, **k: _noop_decorator_factory  # type: ignore
    validate_input = lambda *a, **k: _noop_decorator_factory  # type: ignore

    class InputValidator:  # minimal stub to avoid attribute errors later
        def __getattr__(self, item):
            def _f(*a, **k):
                return True, ''
            return _f

    class TelegramSecurity:
        def __init__(self, *a, **k):
            pass
        def verify_init_data(self, init_data, bot_token, max_age_seconds):
            return False, None

    class RateLimiter:
        def is_allowed(self, key, max_requests, time_window):
            return True

    class SQLInjectionPrevention: ...


def check_required_environment_variables():
    """Проверяет наличие критически важных переменных окружения при старте приложения"""
    required_vars = {
    # Принимаем либо GOOGLE_CREDENTIALS_B64 (base64 json), либо GOOGLE_SHEETS_CREDENTIALS (raw json)
    'GOOGLE_CREDENTIALS_B64': 'Google Sheets API credentials (required for data sync, or provide GOOGLE_SHEETS_CREDENTIALS)' ,
        'DATABASE_URL': 'PostgreSQL database connection string (required for data persistence)'
    }
    
    optional_vars = {
        'BOT_TOKEN': 'Telegram bot token (required for production Telegram integration)',
        'ADMIN_USER_ID': 'Telegram admin user ID (required for admin functions)',
        'SPREADSHEET_ID': 'Google Sheets spreadsheet ID (required for data sync)'
    }
    
    missing_required = []
    missing_optional = []
    
    for var, description in required_vars.items():
        if var == 'GOOGLE_CREDENTIALS_B64':
            if not (os.environ.get('GOOGLE_CREDENTIALS_B64') or os.environ.get('GOOGLE_SHEETS_CREDENTIALS')):
                missing_required.append(f"  - GOOGLE_CREDENTIALS_B64 or GOOGLE_SHEETS_CREDENTIALS: {description}")
        else:
            if not os.environ.get(var):
                missing_required.append(f"  - {var}: {description}")
    
    for var, description in optional_vars.items():
        if not os.environ.get(var):
            missing_optional.append(f"  - {var}: {description}")
    
    if missing_required:
        print("❌ CRITICAL: Missing required environment variables:")
        for var in missing_required:
            print(var)
        print("\nApplication may not function correctly without these variables!")
        return False
    
    if missing_optional:
        print("⚠️  WARNING: Missing optional environment variables:")
        for var in missing_optional:
            print(var)
        print("Some features may be limited without these variables.")
    
    if not missing_required and not missing_optional:
        print("✅ All environment variables are properly configured")
    
    return True

# Проверяем переменные окружения при импорте модуля
check_required_environment_variables()

# Импорты для новой системы БД
try:
    from database.database_models import db_manager, db_ops, Base, News
    from database.database_api import db_api
    DATABASE_SYSTEM_AVAILABLE = True
    print("[INFO] New database system initialized")
except (ImportError, RuntimeError, ValueError) as e:
    print(f"[WARN] New database system not available: {e}")
    DATABASE_SYSTEM_AVAILABLE = False
    db_manager = None
    db_ops = None
    db_api = None

# Импорты для оптимизации
try:
    from optimizations.multilevel_cache import get_cache
    from optimizations.smart_invalidator import SmartCacheInvalidator, extract_match_context, extract_user_context
    from optimizations.optimized_sheets import get_sheets_manager
    from optimizations.background_tasks import get_task_manager, TaskPriority, background_task
    from optimizations.websocket_manager import WebSocketManager
    from optimizations.subscription_manager import init_subscription_manager, get_subscription_manager, SubscriptionType
    OPTIMIZATIONS_AVAILABLE = True
except ImportError as e:
    print(f"[WARN] Optimizations not available: {e}")
    OPTIMIZATIONS_AVAILABLE = False
# Optional gzip/br compression via flask-compress (lazy/dynamic import to avoid hard dependency in dev)
Compress = None
try:
    import importlib
    if getattr(importlib, 'util', None) and importlib.util.find_spec('flask_compress') is not None:
        _comp_mod = importlib.import_module('flask_compress')
        Compress = getattr(_comp_mod, 'Compress', None)
except Exception:
    Compress = None

import gspread
from google.oauth2.service_account import Credentials

from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime, Date, func, case, and_, Index, text
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker, declarative_base, Session
import threading

# Flask app
app = Flask(__name__, static_folder='static', template_folder='templates')

"""Phase 3 security / monitoring initialization"""
if SECURITY_SYSTEM_AVAILABLE:
    try:
        app.config.from_object(Config)
        input_validator = InputValidator()
        telegram_security = TelegramSecurity()
        rate_limiter = RateLimiter()
        sql_protection = SQLInjectionPrevention()
        performance_metrics = PerformanceMetrics()
        db_monitor = DatabaseMonitor()
        health_check = HealthCheck()
        SecurityMiddleware(app)
        PerformanceMiddleware(app)
        ErrorHandlingMiddleware(app)
        app.register_blueprint(monitoring_bp, url_prefix='/api/monitoring')
        app.register_blueprint(security_test_bp, url_prefix='/api/security-test')
        app.config.update(
            input_validator=input_validator,
            telegram_security=telegram_security,
            rate_limiter=rate_limiter,
            performance_metrics=performance_metrics,
            db_monitor=db_monitor,
            health_check=health_check,
        )
        print('[INFO] Phase 3: Security and monitoring middleware activated')
    except Exception as e:  # noqa: BLE001
        print(f'[ERROR] Failed to initialize Phase 3 security system: {e}')
        SECURITY_SYSTEM_AVAILABLE = False

# Инициализация оптимизаций
if OPTIMIZATIONS_AVAILABLE:
    try:
        # Многоуровневый кэш
        cache_manager = get_cache()
        
        # Менеджер фоновых задач
        task_manager = get_task_manager()
        
        # WebSocket для real-time обновлений
        try:
            from flask_socketio import SocketIO
            # Упрощенная инициализация для совместимости
            socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False)
            websocket_manager = WebSocketManager(socketio)
            # Делаем доступным через current_app.config
            app.config['websocket_manager'] = websocket_manager
            
            # Инициализируем систему автоподписок
            subscription_manager = init_subscription_manager(socketio, websocket_manager)
            app.config['subscription_manager'] = subscription_manager
            print("[INFO] WebSocket system with subscriptions initialized successfully")
        except ImportError:
            print("[WARN] Flask-SocketIO not available, WebSocket disabled")
            socketio = None
            websocket_manager = None
        except Exception as e:
            print(f"[WARN] Failed to initialize WebSocket: {e}")
            socketio = None
            websocket_manager = None
        
        # Система умной инвалидации кэша
        invalidator = SmartCacheInvalidator(cache_manager, websocket_manager)
        
        # Оптимизированный Google Sheets менеджер
        try:
            sheets_manager = get_sheets_manager()
        except Exception as e:
            print(f"[WARN] Optimized Sheets manager failed: {e}")
            sheets_manager = None
            
    except Exception as e:
        print(f"[ERROR] Failed to initialize optimizations: {e}")
        cache_manager = None
        task_manager = None
        websocket_manager = None
        invalidator = None
        sheets_manager = None
        
else:
    cache_manager = None
    task_manager = None 
    websocket_manager = None
    invalidator = None
    sheets_manager = None

# Регистрация новой системы БД
if DATABASE_SYSTEM_AVAILABLE:
    try:
        # Регистрируем API blueprint для новой системы БД
        app.register_blueprint(db_api)
        print("[INFO] Database API registered successfully")
        
        # Инициализируем таблицы БД если нужно
        if os.getenv('INIT_DATABASE_TABLES', '').lower() in ('1', 'true', 'yes'):
            print("[INFO] Initializing database tables...")
            db_manager.create_tables()
            print("[INFO] Database tables initialized")
            
    except Exception as e:
        print(f"[ERROR] Failed to register database API: {e}")
        DATABASE_SYSTEM_AVAILABLE = False
if 'COMPRESS_DISABLE' not in os.environ:
    if Compress is not None:
        try:
            # Включаем сжатие для частых типов; бротли/гзип берёт на себя библиотека
            app.config.setdefault('COMPRESS_MIMETYPES', [
                'text/html','text/css','application/json','application/javascript','text/javascript',
                'image/svg+xml'
            ])
            app.config.setdefault('COMPRESS_LEVEL', 6)
            app.config.setdefault('COMPRESS_MIN_SIZE', 1024)
            # Если доступно br, библиотека использует его автоматически через Accept-Encoding
            Compress(app)
        except Exception:
            pass

# Долгий кэш для статики (/static/*) и базовые security-заголовки
@app.after_request
def _add_static_cache_headers(resp):
    try:
        # Security headers (безопасные значения по умолчанию)
        resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
        resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')

        p = request.path or ''
        if p.startswith('/static/'):
            # годовой кэш + immutable; версии файлов должны меняться при изменениях
            resp.headers.setdefault('Cache-Control', 'public, max-age=31536000, immutable')
    except Exception:
        pass
    return resp

# Database
import re

def _normalize_db_url(url: str) -> str:
    if not url:
        return url
    # Render/Heroku style postgres:// -> postgresql://
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    # Force psycopg3 driver:
    # 1) If legacy psycopg2 driver explicitly specified – rewrite to psycopg
    if url.startswith('postgresql+psycopg2://'):
        url = 'postgresql+psycopg://' + url[len('postgresql+psycopg2://'):]
    # 2) If no driver specified – add psycopg
    if url.startswith('postgresql://') and '+psycopg' not in url and '+psycopg2' not in url:
        url = 'postgresql+psycopg://' + url[len('postgresql://'):]
    return url

DATABASE_URL_RAW = os.environ.get('DATABASE_URL', '').strip()
DATABASE_URL = _normalize_db_url(DATABASE_URL_RAW)
engine = None
SessionLocal = None

if DATABASE_URL:
    try:
        # Пул подключений с pre_ping и таймаутами; параметры можно переопределить через переменные окружения
        _pool_size = int(os.environ.get('DB_POOL_SIZE', '5'))
        _max_overflow = int(os.environ.get('DB_MAX_OVERFLOW', '10'))
        _pool_recycle = int(os.environ.get('DB_POOL_RECYCLE', '1800'))  # 30 минут
        _pool_timeout = int(os.environ.get('DB_POOL_TIMEOUT', '30'))
        
        engine = create_engine(
            DATABASE_URL,
            pool_pre_ping=True,
            pool_size=_pool_size,
            max_overflow=_max_overflow,
            pool_recycle=_pool_recycle,
            pool_timeout=_pool_timeout,
        )
        
        # Проверяем соединение
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
            
        SessionLocal = sessionmaker(bind=engine)
        print("[INFO] PostgreSQL database connected successfully")
        
    except Exception as e:
        print(f"[ERROR] Failed to connect to PostgreSQL: {e}")
        print("[INFO] Application will run without database functionality")
        engine = None
        SessionLocal = None
else:
    print("[WARN] DATABASE_URL not configured, running without database")
Base = declarative_base()

# Caches and TTLs
LEAGUE_TABLE_CACHE = {'data': None, 'ts': 0}
LEAGUE_TABLE_TTL = 30  # сек

SCHEDULE_CACHE = {'data': None, 'ts': 0}
SCHEDULE_TTL = 30  # сек

STATS_TABLE_CACHE = {'data': None, 'ts': 0}
STATS_TABLE_TTL = 30  # сек

MATCH_DETAILS_CACHE = {}
MATCH_DETAILS_TTL = 30  # сек

# Глобальный кэш таблицы бомбардиров
SCORERS_CACHE = {'ts': 0, 'items': []}

# Ranks cache for odds models (avoid frequent Sheets reads)
RANKS_CACHE = {'data': None, 'ts': 0}

# Lightweight in-memory rate limiter (per-identity per-scope)
RATE_BUCKETS = {}
RATE_LOCK = threading.Lock()

def _rl_identity_from_request(allow_pseudo: bool = False) -> str:
    """Best-effort identity for rate limiting: Telegram user_id if present, else pseudo or IP+UA hash."""
    try:
        # Try Telegram initData from form/args
        init_data = request.form.get('initData', '') if request.method == 'POST' else request.args.get('initData', '')
        uid = None
        if init_data:
            try:
                p = parse_and_verify_telegram_init_data(init_data)
                if p and p.get('user'):
                    uid = int(p['user'].get('id'))
            except Exception:
                uid = None
        if uid is not None:
            return f"uid:{uid}"
        if allow_pseudo:
            try:
                pid = _pseudo_user_id()
                return f"pid:{pid}"
            except Exception:
                pass
        # Fallback to IP+UA hash
        ip = request.headers.get('X-Forwarded-For') or request.remote_addr or ''
        ua = request.headers.get('User-Agent') or ''
        raw = f"{ip}|{ua}"
        h = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]
        return f"ipua:{h}"
    except Exception:
        return "anon:0"

# Единый набор целей для всех групп достижений (возрастание)
ACHIEVEMENT_TARGETS = {
    'streak': [7, 30, 120],
    'credits': [10000, 50000, 500000],
    'level': [25, 50, 100],
    'invited': [10, 50, 150],
    'betcount': [10, 50, 200],
    'betwins': [5, 20, 75],
    'bigodds': [3.0, 4.5, 6.0],
    'markets': [2, 3, 4],
    'weeks': [2, 5, 10],
}

def _rate_limit(scope: str, limit: int, window_sec: int, identity: str | None = None, allow_pseudo: bool = False):
    """Returns a Flask response (429) if limited, else None. Sliding window in-memory.
    scope: logical bucket name (e.g., 'betting_place').
    limit/window_sec: max events per window per identity.
    identity: optional explicit identity; if None, derive from request.
    allow_pseudo: when True, identity fallback can use pseudo user id.
    """
    try:
        now = time.time()
        ident = identity or _rl_identity_from_request(allow_pseudo=allow_pseudo)
        key = f"{scope}:{ident}"
        with RATE_LOCK:
            arr = RATE_BUCKETS.get(key)
            if arr is None:
                arr = []
                RATE_BUCKETS[key] = arr
            # prune old
            threshold = now - window_sec
            i = 0
            for i in range(len(arr)):
                if arr[i] >= threshold:
                    break
            if i > 0:
                del arr[:i]
            if len(arr) >= limit:
                retry_after = int(max(1, window_sec - (now - arr[0]))) if arr else window_sec
                resp = jsonify({'error': 'Too Many Requests', 'retry_after': retry_after})
                resp.status_code = 429
                resp.headers['Retry-After'] = str(retry_after)
                return resp
            arr.append(now)
    except Exception:
        # On limiter failure, do not block request
        return None
    return None
RANKS_TTL = 600  # 10 минут

# Версия статики для cache-busting на клиентах (мобилки с жёстким кэшем)
STATIC_VERSION = os.environ.get('STATIC_VERSION') or str(int(time.time()))

# Командные силы (1..10) для усложнения коэффициентов. Можно переопределить через BET_TEAM_STRENGTHS_JSON.
# Ключи должны быть нормализованы: нижний регистр, без пробелов и знаков, 'ё' -> 'е'.
TEAM_STRENGTHS_BASE = {
    # Топ-кластер
    'полет': 9,
    'дождь': 8,
    'фкобнинск': 8,
    'ювелиры': 8,
    # Середина/низ
    'звезда': 6,
    'киборги': 6,
    'серпантин': 5,
    'креатив': 4,
    'фкsetka4real': 4,
}

def _norm_team_key(s: str) -> str:
    try:
        s = (s or '').strip().lower().replace('\u00A0', ' ').replace('ё', 'е')
        return ''.join(ch for ch in s if ch.isalnum())
    except Exception:
        return ''

def _load_team_strengths() -> dict[str, float]:
    """Возвращает словарь нормализованное_имя -> сила (1..N, по умолчанию 1..10).
    Разрешает переопределение через переменную окружения BET_TEAM_STRENGTHS_JSON (map name->int/float).
    Имя команды нормализуется тем же способом, что и для таблицы лиги.
    """
    strengths = dict(TEAM_STRENGTHS_BASE)
    raw = os.environ.get('BET_TEAM_STRENGTHS_JSON', '').strip()
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                for k, v in data.items():
                    nk = _norm_team_key(k)
                    try:
                        val = float(v)
                    except Exception:
                        continue
                    # допустим только разумный диапазон 1..20
                    if nk:
                        strengths[nk] = max(1.0, min(20.0, val))
        except Exception as e:
            app.logger.warning(f"BET_TEAM_STRENGTHS_JSON parse failed: {e}")
    return strengths

def _pick_match_of_week(tours: list[dict]) -> dict|None:
    """Выбирает ближайший по времени матч с максимальной суммарной силой команд.
    Возвращает {home, away, date, datetime} или None.
    """
    try:
        strengths = _load_team_strengths()
        def s(name: str) -> float:
            return float(strengths.get(_norm_team_key(name or ''), 0))
        # Соберём все матчи с датой в будущем
        now = datetime.now()
        candidates = []
        for t in tours or []:
            for m in t.get('matches', []) or []:
                try:
                    dt = None
                    if m.get('datetime'):
                        dt = datetime.fromisoformat(str(m['datetime']))
                    elif m.get('date'):
                        dt = datetime.fromisoformat(str(m['date']))
                    if not dt or dt < now:
                        continue
                    score = s(m.get('home','')) + s(m.get('away',''))
                    candidates.append((dt, score, m))
                except Exception:
                    continue
        if not candidates:
            return None
        # Сначала ближайшие по дате, затем по убыванию силы
        candidates.sort(key=lambda x: (x[0], -x[1]))
        dt, _score, m = candidates[0]
        return {
            'home': m.get('home',''),
            'away': m.get('away',''),
            'date': m.get('date') or None,
            'datetime': m.get('datetime') or None,
        }
    except Exception:
        return None

# ---------------------- METRICS ----------------------
METRICS_LOCK = threading.Lock()
METRICS = {
    'bg_runs_total': 0,
    'bg_runs_errors': 0,
    'last_sync': {},          # key -> iso time
    'last_sync_status': {},   # key -> 'ok'|'error'
    'last_sync_duration_ms': {},
    'sheet_reads': 0,
    'sheet_writes': 0,
    'sheet_rate_limit_hits': 0,
    'sheet_last_error': ''
}

def _metrics_inc(key: str, delta: int = 1):
    try:
        with METRICS_LOCK:
            METRICS[key] = int(METRICS.get(key, 0)) + delta
    except Exception:
        pass

def _metrics_set(map_key: str, key: str, value):
    try:
        with METRICS_LOCK:
            if map_key not in METRICS or not isinstance(METRICS[map_key], dict):
                METRICS[map_key] = {}
            METRICS[map_key][key] = value
    except Exception:
        pass

def _metrics_note_rate_limit(err: Exception):
    try:
        msg = str(err)
        if 'RESOURCE_EXHAUSTED' in msg or 'Read requests' in msg or '429' in msg:
            _metrics_inc('sheet_rate_limit_hits', 1)
            with METRICS_LOCK:
                METRICS['sheet_last_error'] = msg[:500]
    except Exception:
        pass

# Leaderboards caches (обновляются раз в час)
LEADER_PRED_CACHE = {'data': None, 'ts': 0, 'etag': ''}
LEADER_RICH_CACHE = {'data': None, 'ts': 0, 'etag': ''}
LEADER_SERVER_CACHE = {'data': None, 'ts': 0, 'etag': ''}
LEADER_PRIZES_CACHE = {'data': None, 'ts': 0, 'etag': ''}
LEADER_TTL = 60 * 60  # 1 час

def _week_period_start_msk_to_utc(now_utc: datetime|None = None) -> datetime:
    """Возвращает UTC-время начала текущего лидерборд-периода: понедельник 03:00 по МСК (UTC+3).
    Если сейчас до этого момента в понедельник, берём предыдущий понедельник 03:00 МСК.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    # Переводим в псевдо-МСК: UTC+3 (Москва без переходов)
    now_msk = now_utc + timedelta(hours=3)
    # Найти понедельник этой недели
    # Monday = 0; Sunday = 6
    week_monday_msk = (now_msk - timedelta(days=now_msk.weekday())).replace(hour=3, minute=0, second=0, microsecond=0)
    if now_msk < week_monday_msk:
        week_monday_msk = week_monday_msk - timedelta(days=7)
    # Вернуть в UTC
    return week_monday_msk - timedelta(hours=3)

def _month_period_start_msk_to_utc(now_utc: datetime|None = None) -> datetime:
    """Возвращает UTC-временную метку начала текущего месяца по МСК (1-е число 03:00 МСК).
    Если сейчас до 03:00 МСК первого дня — берём предыдущий месяц.
    """
    if now_utc is None:
        now_utc = datetime.now(timezone.utc)
    # Переведём в «логическую МСК» как UTC+3 без DST
    msk = now_utc + timedelta(hours=3)
    # Кандидат: 1-е число текущего месяца, 03:00 МСК
    first_msk = datetime(msk.year, msk.month, 1, 3, 0, 0, tzinfo=timezone.utc)
    # Преобразуем этот момент назад в UTC
    first_utc = first_msk - timedelta(hours=3)
    # Если ещё не наступило 03:00 МСК 1-го — значит период прошлого месяца
    if msk < first_msk:
        # Предыдущий месяц
        prev_year = msk.year
        prev_month = msk.month - 1
        if prev_month == 0:
            prev_month = 12
            prev_year -= 1
        prev_first_msk = datetime(prev_year, prev_month, 1, 3, 0, 0, tzinfo=timezone.utc)
        first_utc = prev_first_msk - timedelta(hours=3)
    return first_utc
# Betting config
BET_MIN_STAKE = int(os.environ.get('BET_MIN_STAKE', '10'))
BET_MAX_STAKE = int(os.environ.get('BET_MAX_STAKE', '10000'))
BET_DAILY_MAX_STAKE = int(os.environ.get('BET_DAILY_MAX_STAKE', '50000'))
BET_MARGIN = float(os.environ.get('BET_MARGIN', '0.06'))  # 6% маржа по умолчанию
_LAST_SETTLE_TS = 0
BET_MATCH_DURATION_MINUTES = int(os.environ.get('BET_MATCH_DURATION_MINUTES', '120'))  # длительность матча для авторасчёта спецрынков (по умолчанию 2 часа)
BET_LOCK_AHEAD_MINUTES = int(os.environ.get('BET_LOCK_AHEAD_MINUTES', '5'))  # за сколько минут до начала матча закрывать ставки


# Core models used across the app
class User(Base):
    __tablename__ = 'users'
    user_id = Column(Integer, primary_key=True)
    display_name = Column(String(255))
    tg_username = Column(String(255))
    credits = Column(Integer, default=0)
    xp = Column(Integer, default=0)
    level = Column(Integer, default=1)
    consecutive_days = Column(Integer, default=0)
    last_checkin_date = Column(Date, nullable=True)
    badge_tier = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class LeagueTableRow(Base):
    __tablename__ = 'league_table'
    row_index = Column(Integer, primary_key=True)
    c1 = Column(String(255), default='')
    c2 = Column(String(255), default='')
    c3 = Column(String(255), default='')
    c4 = Column(String(255), default='')
    c5 = Column(String(255), default='')
    c6 = Column(String(255), default='')
    c7 = Column(String(255), default='')
    c8 = Column(String(255), default='')
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class StatsTableRow(Base):
    __tablename__ = 'stats_table'
    row_index = Column(Integer, primary_key=True)
    c1 = Column(String(255), default='')
    c2 = Column(String(255), default='')
    c3 = Column(String(255), default='')
    c4 = Column(String(255), default='')
    c5 = Column(String(255), default='')
    c6 = Column(String(255), default='')
    c7 = Column(String(255), default='')
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchVote(Base):
    __tablename__ = 'match_votes'
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(String(255), nullable=False)
    away = Column(String(255), nullable=False)
    date_key = Column(String(32), nullable=False)  # YYYY-MM-DD
    user_id = Column(Integer, nullable=False)
    choice = Column(String(8), nullable=False)  # 'home'|'draw'|'away'
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    __table_args__ = (
        Index('ux_vote_match_user', 'home', 'away', 'date_key', 'user_id', unique=True),
        Index('ix_vote_match', 'home', 'away', 'date_key'),
    )

def _match_date_key(m: dict) -> str:
    try:
        if m.get('date'):
            return str(m['date'])[:10]
        if m.get('datetime'):
            return str(m['datetime'])[:10]
    except Exception:
        pass
    return ''

def _pseudo_user_id() -> int:
    """Формирует стабильный псевдо-идентификатор пользователя по IP+User-Agent,
    чтобы позволить голосование вне Telegram при включённом ALLOW_VOTE_WITHOUT_TELEGRAM=1.
    Не используется, если есть валидный Telegram initData.
    """
    try:
        ip = request.headers.get('X-Forwarded-For') or request.remote_addr or ''
        ua = request.headers.get('User-Agent') or ''
        raw = f"{ip}|{ua}"
        h = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]
        return int(h, 16)
    except Exception:
        # Небольшой фиксированный ID как fallback
        return 0


@app.route('/api/betting/place', methods=['POST'])
@require_telegram_auth()
@rate_limit(max_requests=5, time_window=60)  # 5 ставок за минуту
@validate_input(
    initData={'type':'string','required':True,'min_length':1},
    tour={'type':'string','required':True,'min_length':1},
    home={'type':'team_name','required':True},
    away={'type':'team_name','required':True},
    market={'type':'string','required':True,'min_length':1},
    selection={'type':'string','required':True,'min_length':1},
    stake='int'
)
def api_betting_place():
    """Размещает ставку. Маркеты: 
    - 1X2: selection in ['home','draw','away']
    - totals: selection in ['over','under'], требуется поле line (например 3.5)
    - penalty/redcard: selection in ['yes','no']
    Поля: initData, tour, home, away, market, selection, stake, [line]
    """
    # Rate limit: максимум 5 ставок за 60 секунд на пользователя
    limited = _rate_limit('betting_place', limit=5, window_sec=60, allow_pseudo=False)
    if limited is not None:
        return limited
    parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
    if not parsed or not parsed.get('user'):
        return jsonify({'error': 'Недействительные данные'}), 401
    user_id = int(parsed['user'].get('id'))
    if SessionLocal is None:
        return jsonify({'error': 'БД недоступна'}), 500
    market = (request.form.get('market') or '1x2').strip().lower()
    sel = (request.form.get('selection') or '').strip().lower()
    if market not in ('1x2','totals','penalty','redcard'):
        return jsonify({'error': 'Неверный рынок'}), 400
    if market == '1x2':
        if sel not in ('home','draw','away'):
            return jsonify({'error': 'Неверная ставка'}), 400
    elif market == 'totals':
        if sel not in ('over','under'):
            return jsonify({'error': 'Неверная ставка'}), 400
    else:
        if sel not in ('yes','no'):
            return jsonify({'error': 'Неверная ставка'}), 400
    try:
        stake = int(request.form.get('stake') or '0')
    except Exception:
        stake = 0
    if stake < BET_MIN_STAKE:
        return jsonify({'error': f'Минимальная ставка {BET_MIN_STAKE}'}), 400
    if stake > BET_MAX_STAKE:
        return jsonify({'error': f'Максимальная ставка {BET_MAX_STAKE}'}), 400
    tour = request.form.get('tour')
    try:
        tour = int(tour) if tour is not None and str(tour).strip() != '' else None
    except Exception:
        tour = None
    home = (request.form.get('home') or '').strip()
    away = (request.form.get('away') or '').strip()
    if not home or not away:
        return jsonify({'error': 'Не указан матч'}), 400

    # Проверка: матч существует в будущих турах и ещё не начался
    # Сначала читаем туры из снапшота расписания (если есть)
    tours = []
    if SessionLocal is not None:
        try:
            dbx: Session = get_db()
            try:
                snap = _snapshot_get(dbx, 'schedule')
                payload = snap and snap.get('payload')
                tours = payload and payload.get('tours') or []
            finally:
                dbx.close()
        except Exception:
            tours = []
    if not tours:
        tours = _load_all_tours_from_sheet()
    match_dt = None
    found = False
    for t in tours:
        if tour is not None and t.get('tour') != tour:
            continue
        for m in t.get('matches', []):
            if (m.get('home') == home and m.get('away') == away) or (m.get('home') == home and not away):
                found = True
                try:
                    if m.get('datetime'):
                        match_dt = datetime.fromisoformat(m['datetime'])
                    elif m.get('date'):
                        d = datetime.fromisoformat(m['date']).date()
                        match_dt = datetime.combine(d, datetime.min.time())
                except Exception:
                    match_dt = None
                break
        if found:
            break
    if not found:
        return jsonify({'error': 'Матч не найден'}), 404
    if match_dt:
        try:
            tzmin = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
        except Exception:
            tzmin = 0
        if tzmin == 0:
            try:
                tzh = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
            except Exception:
                tzh = 0
            tzmin = tzh * 60
        now_local = datetime.now() + timedelta(minutes=tzmin)
        if match_dt <= now_local:
            return jsonify({'error': 'Ставки на начавшийся матч недоступны'}), 400
        # Закрываем прием ставок за BET_LOCK_AHEAD_MINUTES до старта
        try:
            if match_dt - timedelta(minutes=BET_LOCK_AHEAD_MINUTES) <= now_local:
                return jsonify({'error': 'Ставки закрыты перед началом матча'}), 400
        except Exception:
            pass

    db: Session = get_db()
    try:
        db_user = db.get(User, user_id)
        if not db_user:
            return jsonify({'error': 'Пользователь не найден'}), 404
        # проверка суточного лимита
        start_day = datetime.now(timezone.utc).date()
        start_dt = datetime.combine(start_day, datetime.min.time()).replace(tzinfo=timezone.utc)
        end_dt = datetime.combine(start_day, datetime.max.time()).replace(tzinfo=timezone.utc)
        today_sum = db.query(Bet).filter(Bet.user_id==user_id, Bet.placed_at>=start_dt, Bet.placed_at<=end_dt).with_entities(func.coalesce(func.sum(Bet.stake), 0)).scalar() if engine else 0
        if (today_sum or 0) + stake > BET_DAILY_MAX_STAKE:
            return jsonify({'error': f'Суточный лимит ставок {BET_DAILY_MAX_STAKE}'}), 400
        if (db_user.credits or 0) < stake:
            return jsonify({'error': 'Недостаточно кредитов'}), 400
        # коэффициенты на момент ставки
        if market == '1x2':
            # вычислим date_key из известной даты матча (если есть)
            dk = None
            try:
                if match_dt:
                    dk = (match_dt.date().isoformat())
            except Exception:
                dk = None
            odds_map = _compute_match_odds(home, away, dk)
            k = odds_map.get(sel) or 2.00
            selection_to_store = sel
            market_to_store = '1x2'
        elif market == 'totals':
            # totals: поддерживаем over/under по линиям, при этом короткий код для старой схемы (VARCHAR(8))
            try:
                line = float((request.form.get('line') or '').replace(',', '.'))
            except Exception:
                line = None
            allowed_lines = (3.5, 4.5, 5.5)
            if line not in allowed_lines:
                return jsonify({'error': 'Неверная линия тотала'}), 400
            if sel not in ('over','under'):
                return jsonify({'error': 'Неверный выбор тотала'}), 400
            odds_map = _compute_totals_odds(home, away, line)
            k = odds_map.get(sel) or 2.00
            # Короткое кодирование: O35 / U35, O45 / U45, O55 / U55
            line_token = str(line).replace('.5','5').replace('.','')  # 3.5 -> 35
            base_code = ('O' if sel=='over' else 'U') + line_token  # например O35
            selection_to_store = base_code
            market_to_store = 'totals'
            # safety: если всё же длиннее 8, обрежем (старый столбец может быть VARCHAR(8))
            if len(selection_to_store) > 8:
                selection_to_store = selection_to_store[:8]
        else:
            # спецрынки: пенальти/красная. Простая модель вероятности с поправкой по силам.
            odds_map = _compute_specials_odds(home, away, market)
            k = odds_map.get(sel) or 2.00
            selection_to_store = sel
            market_to_store = market
        # списываем кредиты
        db_user.credits = int(db_user.credits or 0) - stake
        db_user.updated_at = datetime.now(timezone.utc)
        bet = Bet(
            user_id=user_id,
            tour=tour,
            home=home,
            away=away,
            match_datetime=match_dt,
            market=market_to_store,
            selection=selection_to_store,
            odds=f"{k:.2f}",
            stake=stake,
            status='open',
            payout=0,
            updated_at=datetime.now(timezone.utc)
        )
        db.add(bet)
        db.commit()
        db.refresh(db_user)
        db.refresh(bet)
        try:
            mirror_user_to_sheets(db_user)
        except Exception as e:
            app.logger.warning(f"Mirror after bet failed: {e}")
        def _present_selection(market, sel_val):
            # Для рынка 1x2 возвращаем читабельное представление с названием команды
            if market == '1x2':
                if sel_val == 'draw':
                    return 'Ничья'
                if sel_val == 'home':
                    return home or 'П1'
                if sel_val == 'away':
                    return away or 'П2'

            if market=='totals' and sel_val and '_' not in sel_val:
                # O35/U35 -> Over 3.5 / Under 3.5
                if sel_val[0] in ('O','U') and sel_val[1:] in ('35','45','55'):
                    side = 'Over' if sel_val[0]=='O' else 'Under'
                    # проще напрямую по первой цифре
                    mapping={'35':'3.5','45':'4.5','55':'5.5'}
                    return f"{side} {mapping.get(sel_val[1:], sel_val[1:])}"
            if market=='totals' and '_' in (sel_val or ''):
                try:
                    s,l = sel_val.split('_',1)
                    return f"{ 'Over' if s=='over' else 'Under'} {l}"
                except Exception:
                    return sel_val
            return sel_val
        return jsonify({
            'status': 'success',
            'balance': int(db_user.credits or 0),
            'bet': {
                'id': bet.id,
                'tour': bet.tour,
                'home': bet.home,
                'away': bet.away,
                'datetime': (bet.match_datetime.isoformat() if bet.match_datetime else ''),
                'market': bet.market,
                'selection': _present_selection(bet.market, bet.selection),
                'odds': bet.odds,
                'stake': bet.stake,
                'status': bet.status
            }
        })
    finally:
        db.close()

class Referral(Base):
    __tablename__ = 'referrals'
    # user_id совпадает с Telegram user_id и с users.user_id
    user_id = Column(Integer, primary_key=True)
    referral_code = Column(String(32), unique=True, index=True, nullable=False)
    referrer_id = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class Bet(Base):
    __tablename__ = 'bets'
    __table_args__ = (
        # Часто используемые выборки:
        # - суточная сумма по пользователю: (user_id, placed_at)
        # - открытые ставки по матчу: (home, away, status)
        # - проверки времени матча: (home, away, match_datetime)
        Index('idx_bet_user_placed_at', 'user_id', 'placed_at'),
        Index('idx_bet_match_status', 'home', 'away', 'status'),
        Index('idx_bet_match_datetime', 'home', 'away', 'match_datetime'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, index=True, nullable=False)
    tour = Column(Integer, nullable=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    match_datetime = Column(DateTime(timezone=False), nullable=True)
    market = Column(String(16), default='1x2')
    selection = Column(String(32), nullable=False)  # 'home' | 'draw' | 'away' | 'over_3.5' | 'yes'/'no'
    odds = Column(String(16), default='')         # храним как строку для простоты (например, '2.20')
    stake = Column(Integer, nullable=False)
    payout = Column(Integer, default=0)
    status = Column(String(16), default='open')   # open | won | lost | void
    placed_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchSpecials(Base):
    __tablename__ = 'match_specials'
    __table_args__ = (
        # Ищем по home/away — держим индекс
        Index('idx_specials_home_away', 'home', 'away'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    # Фиксация факта события в матче
    penalty_yes = Column(Integer, default=None)   # 1=yes, 0=no, None=не задано
    redcard_yes = Column(Integer, default=None)   # 1=yes, 0=no, None=не задано
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchScore(Base):
    __tablename__ = 'match_scores'
    __table_args__ = (
        # Ищем/обновляем по матчу — индекс
        Index('idx_score_home_away', 'home', 'away'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    score_home = Column(Integer, nullable=True)
    score_away = Column(Integer, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchPlayerEvent(Base):
    __tablename__ = 'match_player_events'
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    team = Column(String(8), nullable=False)  # 'home' | 'away'
    minute = Column(Integer, nullable=True)
    player = Column(Text, nullable=False)
    type = Column(String(16), nullable=False)  # 'goal'|'assist'|'yellow'|'red'
    note = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchLineupPlayer(Base):
    __tablename__ = 'match_lineups'
    __table_args__ = (
        Index('idx_lineup_match_team_player', 'home', 'away', 'team', 'player'),
        Index('idx_lineup_match_team_jersey', 'home', 'away', 'team', 'jersey_number'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    team = Column(String(8), nullable=False)  # 'home' | 'away'
    player = Column(Text, nullable=False)
    jersey_number = Column(Integer, nullable=True)
    position = Column(String(32), nullable=False, default='starting_eleven')  # starting_eleven | substitute
    is_captain = Column(Integer, default=0)  # 1|0
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class TeamPlayerStats(Base):
    __tablename__ = 'team_player_stats'
    __table_args__ = (
        Index('idx_team_player_unique', 'team', 'player', unique=True),
        Index('idx_team_player_team', 'team'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    team = Column(Text, nullable=False)
    player = Column(Text, nullable=False)
    games = Column(Integer, default=0)
    goals = Column(Integer, default=0)
    assists = Column(Integer, default=0)
    yellows = Column(Integer, default=0)
    reds = Column(Integer, default=0)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchStatsAggregationState(Base):
    __tablename__ = 'match_stats_agg_state'
    __table_args__ = (
        Index('idx_match_agg_state_match', 'home', 'away', unique=True),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    lineup_counted = Column(Integer, default=0)  # 0/1
    events_applied = Column(Integer, default=0)  # 0/1
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# --- Расширение: мост к продвинутой модели статистики (database_models.py) ---
try:
    from database.database_models import db_manager as adv_db_manager, Player as AdvPlayer, PlayerStatistics as AdvPlayerStatistics, DatabaseOperations as AdvDatabaseOperations
    from sqlalchemy import func as _sql_func
    # Ленивая инициализация (если DATABASE_URL настроен)
    try:
        adv_db_manager._ensure_initialized()
    except Exception as _adv_init_err:  # noqa: F841
        adv_db_manager = None  # недоступно
    _adv_ops = AdvDatabaseOperations(adv_db_manager) if adv_db_manager and getattr(adv_db_manager, 'SessionLocal', None) else None
except Exception:  # библиотека/файл может отсутствовать в деплое
    adv_db_manager = None
    _adv_ops = None

def _split_player_name(full_name: str):
    parts = [p for p in full_name.strip().split() if p]
    if not parts:
        return ('Unknown', '')
    if len(parts) == 1:
        return (parts[0][:100], '')
    return (parts[0][:100], ' '.join(parts[1:])[:100])

def _ensure_adv_player(session, full_name: str):
    """Найти или создать игрока в расширенной схеме по имени (упрощённо)."""
    first, last = _split_player_name(full_name)
    q = session.query(AdvPlayer).filter(AdvPlayer.first_name==first, (AdvPlayer.last_name==last) | (AdvPlayer.last_name.is_(None) if not last else False))
    obj = q.first()
    if obj:
        return obj
    obj = AdvPlayer(first_name=first, last_name=(last or None))
    session.add(obj)
    session.flush()  # получить id
    return obj

def _update_player_statistics(session, player_obj, event_type: str, tournament_id: int):
    if tournament_id is None:
        return
    stats = session.query(AdvPlayerStatistics).filter(AdvPlayerStatistics.player_id==player_obj.id, AdvPlayerStatistics.tournament_id==tournament_id).first()
    if not stats:
        stats = AdvPlayerStatistics(player_id=player_obj.id, tournament_id=tournament_id, matches_played=0)
        session.add(stats)
    # Инкремент в зависимости от типа события
    if event_type == 'goal':
        stats.goals_scored = (stats.goals_scored or 0) + 1
    elif event_type == 'assist':
        stats.assists = (stats.assists or 0) + 1
    elif event_type == 'yellow':
        stats.yellow_cards = (stats.yellow_cards or 0) + 1
    elif event_type == 'red':
        stats.red_cards = (stats.red_cards or 0) + 1
    stats.last_updated = _sql_func.current_timestamp()

def _maybe_sync_event_to_adv_schema(home: str, away: str, player_name: str, event_type: str):
    """Пытаемся синхронизировать событие в расширенную схему.
    Предположение: существует или создаётся глобальный матч/tournament через простые эвристики.
    Пока упрощённо: используем один турнир (ENV DEFAULT_TOURNAMENT_ID) без привязки к реальному Match.
    """
    if not _adv_ops or not adv_db_manager or not getattr(adv_db_manager, 'SessionLocal', None):
        return
    default_tour = os.environ.get('DEFAULT_TOURNAMENT_ID')
    try:
        tournament_id = int(default_tour) if default_tour else None
    except Exception:
        tournament_id = None
    if tournament_id is None:
        return
    try:
        session = adv_db_manager.get_session()
        try:
            player_obj = _ensure_adv_player(session, player_name)
            _update_player_statistics(session, player_obj, event_type, tournament_id)
            session.commit()
        finally:
            session.close()
    except Exception as sync_err:  # noqa: F841
        # Логируем мягко; не ломаем основной поток
        try:
            app.logger.warning(f"adv_sync_failed: {sync_err}")
        except Exception:
            pass

# Итоговая статистика матча (основные метрики)
class MatchStats(Base):
    __tablename__ = 'match_stats'
    __table_args__ = (
        Index('idx_mstats_home_away', 'home', 'away', unique=True),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    shots_total_home = Column(Integer, nullable=True)
    shots_total_away = Column(Integer, nullable=True)
    shots_on_home = Column(Integer, nullable=True)
    shots_on_away = Column(Integer, nullable=True)
    corners_home = Column(Integer, nullable=True)
    corners_away = Column(Integer, nullable=True)
    yellows_home = Column(Integer, nullable=True)
    yellows_away = Column(Integer, nullable=True)
    reds_home = Column(Integer, nullable=True)
    reds_away = Column(Integer, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class MatchFlags(Base):
    __tablename__ = 'match_flags'
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    status = Column(String(16), default='scheduled')  # scheduled | live | finished
    live_started_at = Column(DateTime(timezone=True), nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class UserPhoto(Base):
    __tablename__ = 'user_photos'
    user_id = Column(Integer, primary_key=True)
    photo_url = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class UserPref(Base):
    __tablename__ = 'user_prefs'
    user_id = Column(Integer, primary_key=True)
    favorite_team = Column(Text, nullable=True)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# Трансляции матчей (подтвержденные админом)
class MatchStream(Base):
    __tablename__ = 'match_streams'
    __table_args__ = (
        # Часто ищем по home/away/date для конкретного матча
        Index('idx_stream_home_away_date', 'home', 'away', 'date'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    date = Column(String(10), nullable=True)  # YYYY-MM-DD
    vk_video_id = Column(Text, nullable=True)
    vk_post_url = Column(Text, nullable=True)
    confirmed_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# Комментарии под матчем (временные, TTL ~10 минут)
class MatchComment(Base):
    __tablename__ = 'match_comments'
    __table_args__ = (
        # Фильтр по матчу и по времени создания для TTL-окна и лимитов
        Index('idx_comment_match_time', 'home', 'away', 'date', 'created_at'),
        Index('idx_comment_user_match_time', 'user_id', 'home', 'away', 'date', 'created_at'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    date = Column(String(10), nullable=True)  # YYYY-MM-DD
    user_id = Column(Integer, index=True, nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)

class CommentCounter(Base):
    __tablename__ = 'comment_counters'
    user_id = Column(Integer, primary_key=True)
    comments_total = Column(Integer, default=0)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class WeeklyCreditBaseline(Base):
    __tablename__ = 'weekly_credit_baselines'
    user_id = Column(Integer, primary_key=True)
    period_start = Column(DateTime(timezone=True), primary_key=True)
    credits_base = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# Месячные базовые снимки кредитов (для лидерборда «богачей» по месяцу)
class MonthlyCreditBaseline(Base):
    __tablename__ = 'monthly_credit_baselines'
    user_id = Column(Integer, primary_key=True)
    period_start = Column(DateTime(timezone=True), primary_key=True)
    credits_base = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

class Snapshot(Base):
    __tablename__ = 'snapshots'
    key = Column(String(64), primary_key=True)
    payload = Column(Text, nullable=False)
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# Ограничения на изменения профиля (одноразовые действия)
class UserLimits(Base):
    __tablename__ = 'user_limits'
    user_id = Column(Integer, primary_key=True)
    name_changes_left = Column(Integer, default=1)
    favorite_changes_left = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

# ---------------------- SHOP: ORDERS MODELS ----------------------
class ShopOrder(Base):
    __tablename__ = 'shop_orders'
    __table_args__ = (
        # Частые выборки: мои заказы (user_id, created_at) и список для админа (created_at)
        Index('idx_shop_order_user_created', 'user_id', 'created_at'),
        Index('idx_shop_order_created', 'created_at'),
    )
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, index=True, nullable=False)
    total = Column(Integer, nullable=False)
    status = Column(String(16), default='new')  # new | cancelled | paid (на будущее)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    # Техническое поле для идемпотентности возврата при отмене
    # (храним метку времени когда вернули; если уже был возврат, больше не возвращаем)
    

class ShopOrderItem(Base):
    __tablename__ = 'shop_order_items'
    id = Column(Integer, primary_key=True, autoincrement=True)
    order_id = Column(Integer, index=True, nullable=False)
    product_code = Column(String(32), nullable=False)
    product_name = Column(String(255), nullable=False)
    unit_price = Column(Integer, nullable=False)
    qty = Column(Integer, nullable=False)
    subtotal = Column(Integer, nullable=False)

# ---------------------- SHOP: HELPERS & API ----------------------
def _shop_catalog() -> dict:
    """Серверный каталог товаров: { code: {name, price} }.
    Цены могут быть переопределены через переменные окружения SHOP_PRICE_*.
    """
    def p(env_key: str, default: int) -> int:
        try:
            return int(os.environ.get(env_key, str(default)))
        except Exception:
            return default
    return {
        'boots': { 'name': 'Бутсы', 'price': p('SHOP_PRICE_BOOTS', 500) },
        'ball': { 'name': 'Мяч', 'price': p('SHOP_PRICE_BALL', 500) },
        'tshirt': { 'name': 'Футболка', 'price': p('SHOP_PRICE_TSHIRT', 500) },
        'cap': { 'name': 'Кепка', 'price': p('SHOP_PRICE_CAP', 500) },
    }

def _normalize_order_items(raw_items) -> list[dict]:
    """Приводит массив позиций к [{code, qty}] с валидными qty>=1. Игнорирует неизвестные коды."""
    out = []
    if not isinstance(raw_items, list):
        return out
    for it in raw_items:
        code = (it.get('id') or it.get('code') or '').strip()
        try:
            qty = int(it.get('qty') or it.get('quantity') or 0)
        except Exception:
            qty = 0
        if not code:
            continue
        qty = max(1, min(99, qty))
        out.append({'code': code, 'qty': qty})
    return out

@app.route('/api/shop/checkout', methods=['POST'])
@require_telegram_auth()
@rate_limit(max_requests=10, time_window=300)  # 10 покупок за 5 минут
@validate_input(
    initData={'type':'string','required':True,'min_length':1},
    items={'type':'string','required':True,'min_length':1}
)
def api_shop_checkout():
    """
    Оформление заказа в магазине. Поля: initData (Telegram), items (JSON-массив [{id|code, qty}]).
    Цены и названия берутся с сервера. При успехе списывает кредиты, создаёт ShopOrder и ShopOrderItems.
    Ответ: { order_id, total, balance }.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        user_id = int(parsed['user'].get('id'))

        # Читаем items: либо из form['items'] (JSON-строка), либо из JSON-тела
        items = []
        try:
            if request.form.get('items'):
                items = json.loads(request.form.get('items'))
            elif request.is_json:
                body = request.get_json(silent=True) or {}
                items = body.get('items') or []
        except Exception:
            items = []
        items = _normalize_order_items(items)
        if not items:
            return jsonify({'error': 'Пустая корзина'}), 400

        catalog = _shop_catalog()
        # Нормализуем по каталогу и считаем сумму
        norm_items = []
        total = 0
        for it in items:
            code = it['code']
            if code not in catalog:
                continue
            unit = int(catalog[code]['price'])
            qty = int(it['qty'])
            subtotal = unit * qty
            total += subtotal
            norm_items.append({
                'code': code,
                'name': catalog[code]['name'],
                'unit_price': unit,
                'qty': qty,
                'subtotal': subtotal
            })
        if not norm_items:
            return jsonify({'error': 'Нет валидных товаров'}), 400
        if total <= 0:
            return jsonify({'error': 'Нулевая сумма заказа'}), 400

        # Идемпотентность: если за последние 2 минуты уже есть заказ с теми же позициями и суммой — вернём его
        # Сигнатура по товарам: code:qty, отсортировано
        try:
            sig_current = '|'.join(sorted([f"{it['code']}:{int(it['qty'])}" for it in norm_items]))
        except Exception:
            sig_current = ''

        db: Session = get_db()
        try:
            # Проверим последние заказы пользователя (до 5 шт) за 2 минуты
            try:
                recent = db.query(ShopOrder).filter(ShopOrder.user_id==user_id).order_by(ShopOrder.created_at.desc()).limit(5).all()
                from datetime import timedelta
                for r in recent:
                    try:
                        if r.created_at and (datetime.now(timezone.utc) - r.created_at) > timedelta(minutes=2):
                            continue
                    except Exception:
                        pass
                    if int(r.total or 0) != int(total):
                        continue
                    # Соберём сигнатуру заказанных позиций
                    its = db.query(ShopOrderItem).filter(ShopOrderItem.order_id==r.id).all()
                    sig = '|'.join(sorted([f"{it.product_code}:{int(it.qty or 0)}" for it in its]))
                    if sig and sig == sig_current:
                        # Заказ совпадает — считаем повторной отправкой, возвращаем существующий
                        u = db.get(User, user_id)
                        bal = int(u.credits or 0) if u else 0
                        return jsonify({'order_id': int(r.id), 'total': int(r.total or 0), 'balance': bal, 'duplicate': True})
            except Exception as _e:
                app.logger.warning(f"Idempotency check failed: {_e}")

            u = db.get(User, user_id)
            if not u:
                return jsonify({'error': 'Пользователь не найден'}), 404
            if int(u.credits or 0) < total:
                return jsonify({'error': 'Недостаточно кредитов'}), 400
            # Списание и создание заказа
            u.credits = int(u.credits or 0) - total
            u.updated_at = datetime.now(timezone.utc)
            order = ShopOrder(user_id=user_id, total=total, status='new', created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
            db.add(order)
            db.flush()  # получить order.id
            for it in norm_items:
                db.add(ShopOrderItem(
                    order_id=order.id,
                    product_code=it['code'],
                    product_name=it['name'],
                    unit_price=it['unit_price'],
                    qty=it['qty'],
                    subtotal=it['subtotal']
                ))
            db.commit()
            db.refresh(u)
            # Зеркалирование пользователя в Sheets best-effort
            try:
                mirror_user_to_sheets(u)
            except Exception as e:
                app.logger.warning(f"Mirror after checkout failed: {e}")
            # Уведомление администратору о новом заказе (best-effort)
            try:
                admin_id = os.environ.get('ADMIN_USER_ID', '')
                bot_token = os.environ.get('BOT_TOKEN', '')
                if admin_id and bot_token:
                    # Сводка товаров
                    items_preview = ', '.join([f"{it['name']}×{it['qty']}" for it in norm_items])
                    uname = parsed['user'].get('username') or ''
                    uid = str(user_id)
                    user_label = f"@{uname}" if uname else f"ID {uid}"
                    text = (
                        f"Новый заказ №{order.id}\n"
                        f"Пользователь: {user_label}\n"
                        f"Сумма: {total}\n"
                        f"Товары: {items_preview}"
                    )
                    import requests
                    requests.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={"chat_id": admin_id, "text": text}, timeout=5
                    )
            except Exception as e:
                app.logger.warning(f"Admin notify failed: {e}")
            return jsonify({'order_id': order.id, 'total': total, 'balance': int(u.credits or 0)})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Shop checkout error: {e}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/admin/orders/<int:order_id>/status', methods=['POST'])
@require_admin()
@rate_limit(max_requests=20, time_window=60)
@validate_input(status={'type':'string','required':True,'min_length':1})
def api_admin_order_set_status(order_id: int):
    """Админ: смена статуса заказа. Поля: initData, status in ['new','accepted','done','cancelled'].
    При переводе в 'cancelled' делаем возврат кредитов, если ранее не был отменен.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        st = (request.form.get('status') or '').strip().lower()
        if st not in ('new','accepted','done','cancelled'):
            return jsonify({'error': 'bad status'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'DB unavailable'}), 500
        db: Session = get_db()
        try:
            row = db.get(ShopOrder, order_id)
            if not row:
                return jsonify({'error': 'not found'}), 404
            prev = (row.status or 'new').lower()
            # Если уже отменён — дальнейшие изменения запрещены (идемпотентно пропускаем одинаковый статус)
            if prev == 'cancelled' and st != 'cancelled':
                return jsonify({'error': 'locked'}), 409
            # Если отмена — вернуть кредиты пользователю (однократно)
            if st == 'cancelled' and prev != 'cancelled':
                u = db.get(User, int(row.user_id))
                if u:
                    u.credits = int(u.credits or 0) + int(row.total or 0)
                    u.updated_at = datetime.now(timezone.utc)
                    # Зеркалим пользователя в Sheets best-effort
                    try:
                        mirror_user_to_sheets(u)
                    except Exception as _e:
                        app.logger.warning(f"Mirror after refund failed: {_e}")
            if prev != st:
                row.status = st
                row.updated_at = datetime.now(timezone.utc)
            db.commit()
            # Уведомление пользователю о смене статуса (best-effort)
            try:
                bot_token = os.environ.get('BOT_TOKEN', '')
                if bot_token:
                    st_map = { 'new': 'новый', 'accepted': 'принят', 'done': 'завершен', 'cancelled': 'отменен' }
                    txt = f"Ваш заказ №{order_id}: статус — {st_map.get(st, st)}."
                    if st == 'cancelled' and prev != 'cancelled':
                        bal = 0
                        try:
                            u2 = db.get(User, int(row.user_id))
                            bal = int(u2.credits or 0)
                        except Exception:
                            pass
                        txt = f"Ваш заказ №{order_id} отменен. Кредиты возвращены (+{int(row.total or 0)}). Баланс: {bal}."
                    import requests
                    requests.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={"chat_id": int(row.user_id), "text": txt}, timeout=5
                    )
            except Exception as _e:
                app.logger.warning(f"Notify user order status failed: {_e}")
            return jsonify({'status': 'ok', 'status_prev': prev, 'status_new': st})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Admin order status error: {e}")
        return jsonify({'error': 'internal'}), 500

@app.route('/api/admin/orders/<int:order_id>/delete', methods=['POST'])
@require_admin()
@rate_limit(max_requests=20, time_window=60)
def api_admin_order_delete(order_id: int):
    """Админ: удалить заказ целиком вместе с позициями. Поля: initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'error': 'DB unavailable'}), 500
        db: Session = get_db()
        try:
            row = db.get(ShopOrder, order_id)
            if not row:
                return jsonify({'error': 'not found'}), 404
            # Удаляем позиции, затем заказ
            db.query(ShopOrderItem).filter(ShopOrderItem.order_id==order_id).delete()
            db.delete(row)
            db.commit()
            return jsonify({'status': 'ok'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Admin order delete error: {e}")
        return jsonify({'error': 'internal'}), 500

# -------------------- ADMIN MATCHES & LINEUPS (missing frontend endpoints) --------------------
@app.route('/api/admin/matches/upcoming', methods=['POST'])
@require_admin()
def api_admin_matches_upcoming():
    """Возвращает список ближайших матчей для админки.
    Формат элемента: {id, home_team, away_team, match_date(iso), lineups?}
    match id: sha1(home|away|date) первые 12 hex.
    """
    try:
        # auth уже прошёл через @require_admin; дополнительно верифицируем initData для единообразия
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'unauthorized'}), 401
        # грузим туры
        try:
            tours = _load_all_tours_from_sheet()
        except Exception as e:
            app.logger.error(f"admin_upcoming: sheet error {e}")
            return jsonify({'error': 'schedule_unavailable'}), 500
        now = datetime.now()
        out = []
        import hashlib
        for t in tours or []:
            for m in t.get('matches', []) or []:
                # Берём будущие или начинающиеся через <= 1 день
                dt = None
                try:
                    if m.get('datetime'):
                        dt = datetime.fromisoformat(str(m['datetime']))
                    elif m.get('date'):
                        dt = datetime.fromisoformat(str(m['date']))
                except Exception:
                    dt = None
                if not dt or dt < (now - timedelta(hours=1)):
                    continue
                home = (m.get('home') or '').strip()
                away = (m.get('away') or '').strip()
                if not home or not away:
                    continue
                date_key = (dt.isoformat())
                h = hashlib.sha1(f"{home}|{away}|{date_key[:10]}".encode('utf-8')).hexdigest()[:12]
                # Попробуем достать уже сохранённые составы из БД (если доступна)
                lineups = None
                if SessionLocal is not None:
                    db: Session = get_db()
                    try:
                        rows = db.query(MatchLineupPlayer).filter(
                            MatchLineupPlayer.home==home, MatchLineupPlayer.away==away
                        ).all()
                        if rows:
                            def pack(team, pos):
                                return [
                                    { 'name': r.player, 'number': r.jersey_number, 'position': r.position if r.position!='starting_eleven' else None }
                                    for r in rows if r.team==team and (pos=='main' and r.position=='starting_eleven' or pos=='sub' and r.position=='substitute')
                                ]
                            lineups = {
                                'home': { 'main': pack('home','main'), 'sub': pack('home','sub') },
                                'away': { 'main': pack('away','main'), 'sub': pack('away','sub') },
                            }
                    except Exception:
                        lineups = None
                    finally:
                        db.close()
                out.append({
                    'id': h,
                    'home_team': home,
                    'away_team': away,
                    'match_date': dt.isoformat() if dt else None,
                    'lineups': lineups
                })
        # отсортируем по дате
        out.sort(key=lambda x: x.get('match_date') or '')
        return jsonify({'matches': out})
    except Exception as e:
        app.logger.error(f"admin matches upcoming error: {e}")
        return jsonify({'error': 'internal'}), 500

def _resolve_match_by_id(match_id: str, tours=None):
    """Восстанавливает (home,away,dt) по match_id (sha1 первые 12)."""
    import hashlib
    if tours is None:
        tours = _load_all_tours_from_sheet()
    for t in tours or []:
        for m in t.get('matches', []) or []:
            home = (m.get('home') or '').strip(); away = (m.get('away') or '').strip()
            if not home or not away:
                continue
            dt = None
            try:
                if m.get('datetime'):
                    dt = datetime.fromisoformat(str(m['datetime']))
                elif m.get('date'):
                    dt = datetime.fromisoformat(str(m['date']))
            except Exception:
                dt = None
            date_key = (dt.isoformat() if dt else '')[:10]
            h = hashlib.sha1(f"{home}|{away}|{date_key}".encode('utf-8')).hexdigest()[:12]
            if h == match_id:
                return home, away, dt
    return None, None, None

@app.route('/api/admin/match/<match_id>/lineups', methods=['POST'])
@require_admin()
def api_admin_get_lineups(match_id: str):
    try:
        home, away, dt = _resolve_match_by_id(match_id)
        if not home:
            return jsonify({'error': 'not found'}), 404
        result = { 'home': { 'main': [], 'sub': [] }, 'away': { 'main': [], 'sub': [] } }
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                rows = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).all()
                for r in rows:
                    entry = { 'name': r.player, 'number': r.jersey_number, 'position': None if r.position=='starting_eleven' else r.position }
                    bucket = 'main' if r.position=='starting_eleven' else 'sub'
                    result[r.team][bucket].append(entry)
                # fallback из team_roster если нет данных по матчу
                if not rows:
                    try:
                        from sqlalchemy import text as _sa_text
                        home_rows = db.execute(_sa_text("SELECT player FROM team_roster WHERE team=:t ORDER BY id ASC"), {'t': home}).fetchall()
                        away_rows = db.execute(_sa_text("SELECT player FROM team_roster WHERE team=:t ORDER BY id ASC"), {'t': away}).fetchall()
                        result['home']['main'] = [ { 'name': r.player, 'number': None, 'position': None } for r in home_rows ]
                        result['away']['main'] = [ { 'name': r.player, 'number': None, 'position': None } for r in away_rows ]
                    except Exception as _fe:
                        app.logger.warning(f"team_roster fallback failed: {_fe}")
            except Exception:
                pass
            finally:
                db.close()
        return jsonify({'lineups': result})
    except Exception as e:
        app.logger.error(f"admin get lineups error: {e}")
        return jsonify({'error': 'internal'}), 500

@app.route('/api/admin/match/<match_id>/lineups/save', methods=['POST'])
@require_admin()
def api_admin_save_lineups(match_id: str):
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'unauthorized'}), 401
        raw = request.form.get('lineups') or ''
        try:
            data = json.loads(raw)
        except Exception:
            return jsonify({'error': 'bad_json'}), 400
        home, away, dt = _resolve_match_by_id(match_id)
        if not home:
            return jsonify({'error': 'not_found'}), 404
        if SessionLocal is None:
            return jsonify({'error': 'db_unavailable'}), 500
        db: Session = get_db()
        try:
            # ensure persistent team_roster table
            try:
                from sqlalchemy import text as _sa_text
                db.execute(_sa_text("""
                    CREATE TABLE IF NOT EXISTS team_roster (
                        id SERIAL PRIMARY KEY,
                        team TEXT NOT NULL,
                        player TEXT NOT NULL,
                        created_at TIMESTAMP DEFAULT (NOW() AT TIME ZONE 'UTC')
                    );
                    CREATE INDEX IF NOT EXISTS ix_team_roster_team ON team_roster(team);
                """))
            except Exception as _te:
                app.logger.warning(f"team_roster ensure failed: {_te}")
            # удаляем прежние (матчевые)
            db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).delete()
            def ins(team, arr, pos_label):
                for p in arr or []:
                    name = (p.get('name') or '').strip()
                    if not name:
                        continue
                    num = p.get('number')
                    try:
                        if num is not None:
                            num = int(num)
                    except Exception:
                        num = None
                    pos = p.get('position') or 'starting_eleven'
                    if pos not in ('starting_eleven','substitute'):
                        # фронт передаёт main/sub -> нормализуем
                        if pos in ('main', 'start'): pos = 'starting_eleven'
                        elif pos in ('sub', 'bench'): pos = 'substitute'
                        else: pos = 'starting_eleven'
                    row = MatchLineupPlayer(home=home, away=away, team=team, player=name, jersey_number=num, position=('starting_eleven' if pos=='starting_eleven' else 'substitute'))
                    db.add(row)
            ins('home', (data.get('home') or {}).get('main'), 'starting_eleven')
            ins('home', (data.get('home') or {}).get('sub'), 'substitute')
            ins('away', (data.get('away') or {}).get('main'), 'starting_eleven')
            ins('away', (data.get('away') or {}).get('sub'), 'substitute')

            # --- Sync persistent roster for both real teams (main lineups only) ---
            import re as _re
            def _norm_player(n: str) -> str:
                n = (n or '').strip()
                n = _re.sub(r'\s+', ' ', n)
                return n
            def _key(n: str) -> str:
                return _norm_player(n).lower()
            from sqlalchemy import text as _sa_text
            def sync_team(real_team: str, payload_label: str):
                main_list = (data.get(payload_label) or {}).get('main') or []
                seen = set(); ordered=[]
                for p in main_list:
                    nm = _norm_player(p.get('name') if isinstance(p, dict) else p)
                    if not nm: continue
                    k=_key(nm)
                    if k in seen: continue
                    seen.add(k); ordered.append((k,nm))
                # load existing
                existing = db.execute(_sa_text("SELECT id, player FROM team_roster WHERE team=:t ORDER BY id ASC"), {'t': real_team}).fetchall()
                existing_map = { _key(r.player): r for r in existing }
                # additions
                for k,nm in ordered:
                    if k not in existing_map:
                        db.execute(_sa_text("INSERT INTO team_roster(team, player) VALUES (:t,:p)"), {'t': real_team, 'p': nm})
                # deletions (player removed)
                new_keys = {k for k,_ in ordered}
                for k_old, row in existing_map.items():
                    if k_old not in new_keys:
                        db.execute(_sa_text("DELETE FROM team_roster WHERE id=:id"), {'id': row.id})
            try:
                sync_team(home, 'home')
                sync_team(away, 'away')
            except Exception as _sr_e:
                app.logger.warning(f"team_roster sync failed: {_sr_e}")

            db.commit()
            # WebSocket уведомление о обновлении составов
            try:
                if 'websocket_manager' in app.config and app.config['websocket_manager']:
                    app.config['websocket_manager'].notify_data_change('lineups_updated', {
                        'match_id': match_id,
                        'home': home,
                        'away': away,
                        'updated_at': datetime.utcnow().isoformat()
                    })
                
                # Публикуем через систему автоподписок
                if 'subscription_manager' in app.config:
                    sub_manager = app.config['subscription_manager']
                    match_key = f"{home}_{away}"
                    sub_manager.publish(
                        SubscriptionType.MATCH_LINEUP,
                        {
                            'match_id': match_id,
                            'home_team': home,
                            'away_team': away,
                            'updated_at': datetime.utcnow().isoformat()
                        },
                        match_key
                    )
            except Exception as e:
                app.logger.warning(f"Failed to send lineup update notification: {e}")
            except Exception as _ws_e:
                app.logger.warning(f"websocket lineup notify failed: {_ws_e}")
            return jsonify({'success': True})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"admin save lineups error: {e}")
        return jsonify({'error': 'internal'}), 500

@app.route('/api/match/lineups', methods=['GET'])
def api_public_match_lineups():
    """Публичный эндпоинт получения составов матча из БД (без Google Sheets).
    Параметры: home, away (строки).
    Формат ответа:
        {
          "rosters": { "home": ["Игрок"...], "away": ["Игрок"...] },
          "source": "db",
          "updated_at": "ISO"
        }
    Если составов нет, возвращает пустые списки.
    """
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home и away обязательны'}), 400
        rosters = {'home': [], 'away': []}
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                rows = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).order_by(MatchLineupPlayer.id.asc()).all()
                for r in rows:
                    # сохраняем порядок вставки и только имя игрока
                    if r.team in ('home','away'):
                        name = (r.player or '').strip()
                        if name:
                            rosters[r.team].append(name)
            finally:
                db.close()
        return jsonify({'rosters': rosters, 'source': 'db', 'updated_at': datetime.utcnow().isoformat()})
    except Exception as e:
        app.logger.error(f"public match lineups error: {e}")
        return jsonify({'error': 'internal'}), 500

@app.route('/api/shop/my-orders', methods=['POST'])
def api_shop_my_orders():
    """Возвращает последние 50 заказов текущего пользователя. Требует initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        user_id = int(parsed['user'].get('id'))
        db: Session = get_db()
        try:
            rows = db.query(ShopOrder).filter(ShopOrder.user_id == user_id).order_by(ShopOrder.created_at.desc()).limit(50).all()
            out = []
            for r in rows:
                out.append({
                    'id': int(r.id),
                    'user_id': int(r.user_id),
                    'total': int(r.total or 0),
                    'status': r.status or 'new',
                    'created_at': (r.created_at or datetime.now(timezone.utc)).isoformat()
                })
            # ETag/304 для экономии трафика
            etag = _etag_for_payload({'orders': out})
            inm = request.headers.get('If-None-Match')
            if inm and inm == etag:
                resp = app.response_class(status=304)
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'private, max-age=60'
                return resp
            resp = jsonify({'orders': out, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag})
            resp.headers['ETag'] = etag
            resp.headers['Cache-Control'] = 'private, max-age=60'
            return resp
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Shop my-orders error: {e}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/admin/orders', methods=['POST'])
def api_admin_orders():
    """Админ: список заказов (ETag поддерживается). Поля: initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'orders': []})
        db: Session = get_db()
        try:
            rows = db.query(ShopOrder).order_by(ShopOrder.created_at.desc()).limit(500).all()
            order_ids = [int(r.id) for r in rows]
            user_ids = list({int(r.user_id) for r in rows}) if rows else []
            usernames = {}
            if user_ids:
                for u in db.query(User.user_id, User.tg_username).filter(User.user_id.in_(user_ids)).all():
                    try:
                        usernames[int(u[0])] = (u[1] or '').lstrip('@')
                    except Exception:
                        pass
            items_by_order = {}
            if order_ids:
                for it in db.query(ShopOrderItem).filter(ShopOrderItem.order_id.in_(order_ids)).all():
                    oid = int(it.order_id)
                    arr = items_by_order.setdefault(oid, [])
                    arr.append({'name': it.product_name, 'qty': int(it.qty or 0)})
            core = []
            for r in rows:
                oid = int(r.id)
                arr = items_by_order.get(oid, [])
                items_preview = ', '.join([f"{x['name']}×{x['qty']}" for x in arr]) if arr else ''
                items_qty = sum([int(x['qty'] or 0) for x in arr]) if arr else 0
                core.append({
                    'id': oid,
                    'user_id': int(r.user_id),
                    'username': usernames.get(int(r.user_id), ''),
                    'total': int(r.total or 0),
                    'status': r.status or 'new',
                    'created_at': (r.created_at or datetime.now(timezone.utc)).isoformat(),
                    'items_preview': items_preview,
                    'items_qty': items_qty
                })
            etag = _etag_for_payload({'orders': core})
            inm = request.headers.get('If-None-Match')
            if inm and inm == etag:
                resp = app.response_class(status=304)
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'private, max-age=60'
                return resp
            resp = jsonify({'orders': core, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag})
            resp.headers['ETag'] = etag
            resp.headers['Cache-Control'] = 'private, max-age=60'
            return resp
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Admin orders error: {e}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/admin/orders/<int:order_id>', methods=['POST'])
def api_admin_order_details(order_id: int):
    """Админ: детали заказа + позиции. Поля: initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            r = db.get(ShopOrder, int(order_id))
            if not r:
                return jsonify({'error': 'Заказ не найден'}), 404
            items = db.query(ShopOrderItem).filter(ShopOrderItem.order_id == int(order_id)).all()
            out_items = [
                {
                    'product_code': it.product_code,
                    'product_name': it.product_name,
                    'unit_price': int(it.unit_price or 0),
                    'qty': int(it.qty or 0),
                    'subtotal': int(it.subtotal or 0)
                } for it in items
            ]
            return jsonify({
                'order': {
                    'id': int(r.id),
                    'user_id': int(r.user_id),
                    'total': int(r.total or 0),
                    'status': r.status or 'new',
                    'created_at': (r.created_at or datetime.now(timezone.utc)).isoformat()
                },
                'items': out_items
            })
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Admin order details error: {e}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

# (Удалено дублирующееся определение маршрута /api/admin/orders/<id>/status)

def ensure_weekly_baselines(db: Session, period_start: datetime):
    """Создаёт снимок credits для всех пользователей в начале недели (если ещё не создан).
    Также добавляет недостающие снимки для новых пользователей, появившихся в середине недели.
    """
    # Если для периода нет ни одной записи — создаём снимки для всех пользователей
    existing_count = db.query(WeeklyCreditBaseline).filter(WeeklyCreditBaseline.period_start == period_start).count()
    if existing_count == 0:
        users = db.query(User.user_id, User.credits).all()
        now = datetime.now(timezone.utc)
        for u in users:
            db.add(WeeklyCreditBaseline(user_id=int(u.user_id), period_start=period_start, credits_base=int(u.credits or 0), created_at=now))
        db.commit()
    else:
        # Добавим для тех, кого нет (новые пользователи)
        user_ids = [uid for (uid,) in db.query(User.user_id).all()]
        if user_ids:
            existing_ids = set(uid for (uid,) in db.query(WeeklyCreditBaseline.user_id).filter(WeeklyCreditBaseline.period_start == period_start).all())
            missing = [uid for uid in user_ids if uid not in existing_ids]
            if missing:
                now = datetime.now(timezone.utc)
                for uid, credits in db.query(User.user_id, User.credits).filter(User.user_id.in_(missing)).all():
                    db.add(WeeklyCreditBaseline(user_id=int(uid), period_start=period_start, credits_base=int(credits or 0), created_at=now))
                db.commit()

def ensure_monthly_baselines(db: Session, period_start: datetime):
    """Создаёт снимок credits для всех пользователей в начале месяца (если ещё не создан).
    Также добавляет недостающие снимки для новых пользователей в середине месяца.
    """
    existing_count = db.query(MonthlyCreditBaseline).filter(MonthlyCreditBaseline.period_start == period_start).count()
    if existing_count == 0:
        users = db.query(User.user_id, User.credits).all()
        now = datetime.now(timezone.utc)
        for u in users:
            db.add(MonthlyCreditBaseline(user_id=int(u.user_id), period_start=period_start, credits_base=int(u.credits or 0), created_at=now))
        db.commit()
    else:
        user_ids = [uid for (uid,) in db.query(User.user_id).all()]
        if user_ids:
            existing_ids = set(uid for (uid,) in db.query(MonthlyCreditBaseline.user_id).filter(MonthlyCreditBaseline.period_start == period_start).all())
            missing = [uid for uid in user_ids if uid not in existing_ids]
            if missing:
                now = datetime.now(timezone.utc)
                for uid, credits in db.query(User.user_id, User.credits).filter(User.user_id.in_(missing)).all():
                    db.add(MonthlyCreditBaseline(user_id=int(uid), period_start=period_start, credits_base=int(credits or 0), created_at=now))
                db.commit()

if engine is not None:
    try:
        Base.metadata.create_all(engine)
        print('[INFO] DB tables ensured')
    except Exception as e:
        print(f'[ERROR] DB init failed: {e}')

def get_db() -> Session:
    if SessionLocal is None:
        raise RuntimeError('База данных не сконфигурирована (DATABASE_URL не задан).')
    # Интеграция с системой мониторинга БД (Фаза 3)
    # Упрощено: просто возвращаем сессию; мониторинг запросов делается через SQLAlchemy events в DatabaseMiddleware
    return SessionLocal()

def _generate_ref_code(uid: int) -> str:
    """Детерминированно генерирует короткий реф-код по user_id и BOT_TOKEN в качестве соли."""
    salt = os.environ.get('BOT_TOKEN', 's')
    digest = hashlib.sha256(f"{uid}:{salt}".encode()).hexdigest()
    return digest[:8]

# Настройка Google Sheets
_GOOGLE_CLIENT = None
_DOC_CACHE = {}
def get_google_client():
    """Создает клиент для работы с Google Sheets API (и кэширует его)."""
    global _GOOGLE_CLIENT
    if _GOOGLE_CLIENT is not None:
        return _GOOGLE_CLIENT
    scopes = [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
    ]
    creds_raw = os.environ.get('GOOGLE_SHEETS_CREDENTIALS', '')
    try:
        creds_data = json.loads(creds_raw) if creds_raw else {}
    except Exception:
        creds_data = {}

    if not creds_data:
        raise ValueError("Отсутствуют данные сервисного аккаунта в переменных окружения")

    credentials = Credentials.from_service_account_info(creds_data, scopes=scopes)
    _GOOGLE_CLIENT = gspread.authorize(credentials)
    return _GOOGLE_CLIENT

def _get_doc(sheet_id: str):
    """Кэширует объект документа Google Sheets, чтобы не открывать каждый раз."""
    client = get_google_client()
    doc = _DOC_CACHE.get(sheet_id)
    if doc is None:
        doc = client.open_by_key(sheet_id)
        _DOC_CACHE[sheet_id] = doc
    return doc

def get_user_sheet():
    """Получает лист пользователей из Google Sheets"""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    return doc.worksheet("users")

def get_achievements_sheet():
    """Возвращает лист достижений, создаёт при отсутствии."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    try:
        ws = doc.worksheet("achievements")
    except gspread.exceptions.WorksheetNotFound:
        ws = doc.add_worksheet(title="achievements", rows=1000, cols=20)
        # user_id | credits_tier | credits_unlocked_at | level_tier | level_unlocked_at | streak_tier | streak_unlocked_at | invited_tier | invited_unlocked_at
        _metrics_inc('sheet_writes', 1)
        ws.update(values=[[
            'user_id',
            'credits_tier','credits_unlocked_at',
            'level_tier','level_unlocked_at',
            'streak_tier','streak_unlocked_at',
            'invited_tier','invited_unlocked_at',
            'betcount_tier','betcount_unlocked_at',
            'betwins_tier','betwins_unlocked_at',
            'bigodds_tier','bigodds_unlocked_at',
            'markets_tier','markets_unlocked_at',
            'weeks_tier','weeks_unlocked_at'
        ]], range_name='A1:S1')
    # Убедимся, что колонки для invited присутствуют
    try:
        headers = ws.row_values(1)
        want = [
            'user_id',
            'credits_tier','credits_unlocked_at',
            'level_tier','level_unlocked_at',
            'streak_tier','streak_unlocked_at',
            'invited_tier','invited_unlocked_at',
            'betcount_tier','betcount_unlocked_at',
            'betwins_tier','betwins_unlocked_at',
            'bigodds_tier','bigodds_unlocked_at',
            'markets_tier','markets_unlocked_at',
            'weeks_tier','weeks_unlocked_at'
        ]
        if headers != want:
            _metrics_inc('sheet_writes', 1)
            ws.update(values=[want], range_name='A1:S1')
    except Exception as e:
        app.logger.warning(f"Не удалось проверить/обновить заголовки achievements: {e}")
    return ws

def get_table_sheet():
    """Возвращает лист таблицы лиги 'ТАБЛИЦА'."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    return doc.worksheet("ТАБЛИЦА")

def _load_league_ranks() -> dict:
    """Возвращает словарь {нормализованное_имя_команды: позиция}.
    ОПТИМИЗИРОВАНО: Использует многоуровневый кэш вместо простых переменных.
    """
    if cache_manager:
        # Используем оптимизированный кэш
        def loader():
            return _load_league_ranks_from_source()
        
        ranks = cache_manager.get('league_table', 'ranks', loader)
        return ranks or {}
    else:
        # Fallback к старой логике
        return _load_league_ranks_from_source()

def _load_league_ranks_from_source() -> dict:
    """Загружает ранги команд из источника данных"""
    def norm(s: str) -> str:
        s = (s or '').strip().lower().replace('\u00A0',' ').replace('ё','е')
        return ''.join(ch for ch in s if ch.isalnum())

    ranks = {}
    # 1) Попробуем из БД снапшота
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'league-table')
            payload = snap and snap.get('payload')
            values = payload and payload.get('values') or None
            if values:
                for i in range(1, len(values)):
                    row = values[i]
                    if not row or len(row) < 2:
                        continue
                    name = (row[1] or '').strip()
                    if not name:
                        continue
                    ranks[norm(name)] = len(ranks) + 1
            else:
                # 2) Из реляционной таблицы, если снапшота нет
                try:
                    rows = db.query(LeagueTableRow).order_by(LeagueTableRow.row_index.asc()).all()
                    for r in rows[1:]:  # пропустим шапку при наличии
                        name = (r.c2 or '').strip()
                        if not name:
                            continue
                        ranks[norm(name)] = len(ranks) + 1
                except Exception as e:
                    app.logger.warning(f"LeagueTableRow read failed: {e}")
        finally:
            db.close()

    # 3) Fallback к Google Sheets только если БД не настроена
    if not ranks:
        try:
            ws = get_table_sheet()
            values = ws.get('A1:H10') or []
            for i in range(1, len(values)):
                row = values[i]
                if not row or len(row) < 2:
                    continue
                name = (row[1] or '').strip()
                if not name:
                    continue
                ranks[norm(name)] = len(ranks) + 1
        except Exception as e:
            app.logger.warning(f"Не удалось загрузить ранги лиги: {e}")
            ranks = {}

    return ranks

def _dc_poisson(k: int, lam: float) -> float:
    try:
        import math
        return (lam ** k) * math.exp(-lam) / math.factorial(k)
    except Exception:
        return 0.0

def _dc_tau(x: int, y: int, lam: float, mu: float, rho: float) -> float:
    # Dixon–Coles low-score correction
    if x == 0 and y == 0:
        return 1.0 - (lam * mu * rho)
    elif x == 0 and y == 1:
        return 1.0 + (lam * rho)
    elif x == 1 and y == 0:
        return 1.0 + (mu * rho)
    elif x == 1 and y == 1:
        return 1.0 - rho
    return 1.0

def _estimate_goal_rates(home: str, away: str) -> tuple[float, float]:
    """Грубая оценка ожидаемых голов (lam, mu) с учётом:
    - базового тотала, домашнего преимущества;
    - разницы сил по таблице (ранги) и по явным силам команд (TEAM_STRENGTHS / BET_TEAM_STRENGTHS_JSON).
    Настройки через env:
    - BET_BASE_TOTAL (средний тотал, по умолчанию 4.2)
    - BET_HOME_ADV (доля в пользу дома, по умолчанию 0.10)
    - BET_RANK_SHARE_SCALE (влияние рангов на долю голов, 0.03)
    - BET_RANK_TOTAL_SCALE (влияние рангов на общий тотал, 0.015)
    - BET_STR_SHARE_SCALE (влияние сил на долю голов, 0.02)
    - BET_STR_TOTAL_SCALE (влияние сил на общий тотал, 0.010)
    - BET_MIN_RATE (минимум для lam/mu), BET_MAX_RATE
    """
    try:
        base_total = float(os.environ.get('BET_BASE_TOTAL', '4.2'))
    except Exception:
        base_total = 4.2
    try:
        # Нейтральное поле: дом. преимущество выключено
        home_adv = float(os.environ.get('BET_HOME_ADV', '0.00'))
    except Exception:
        home_adv = 0.00
    try:
        share_scale = float(os.environ.get('BET_RANK_SHARE_SCALE', '0.03'))
    except Exception:
        share_scale = 0.03
    try:
        total_scale = float(os.environ.get('BET_RANK_TOTAL_SCALE', '0.015'))
    except Exception:
        total_scale = 0.015
    try:
        # Усилим вклад сил, чтобы явный фаворит имел заметно меньший кф
        str_share_scale = float(os.environ.get('BET_STR_SHARE_SCALE', '0.05'))
    except Exception:
        str_share_scale = 0.05
    try:
        str_total_scale = float(os.environ.get('BET_STR_TOTAL_SCALE', '0.015'))
    except Exception:
        str_total_scale = 0.015
    try:
        min_rate = float(os.environ.get('BET_MIN_RATE', '0.15'))
        max_rate = float(os.environ.get('BET_MAX_RATE', '5.0'))
    except Exception:
        min_rate, max_rate = 0.15, 5.0

    def clamp(x, a, b):
        return max(a, min(b, x))
    def norm(s: str) -> str:
        return _norm_team_key(s)

    # Ранги из таблицы (занятые позиции: меньше — сильнее)
    ranks = _load_league_ranks()
    rh = ranks.get(norm(home))
    ra = ranks.get(norm(away))
    nteams = max(8, len(ranks) or 10)

    # Сила: лучше ранг -> выше сила
    def rank_strength(r):
        if not r:
            return 0.5
        return (nteams - (r - 1)) / nteams  # 1.0 для лидера, ~0.1 для последнего

    sh = rank_strength(rh)
    sa = rank_strength(ra)

    # Явные силы команд из словаря
    strengths = _load_team_strengths()
    sh2 = strengths.get(norm(home))
    sa2 = strengths.get(norm(away))
    # Нормируем в [0..1] относительно диапазона сил
    if sh2 is not None and sa2 is not None:
        try:
            s_vals = list(strengths.values()) or [1.0, 10.0]
            s_min, s_max = min(s_vals), max(s_vals)
            span = max(1e-6, float(s_max - s_min))
            shn = (float(sh2) - s_min) / span
            san = (float(sa2) - s_min) / span
        except Exception:
            shn = san = 0.5
    else:
        shn = san = 0.5

    # Совокупная разница сил: учитываем обе компоненты
    diff_rank = sh - sa
    diff_str = shn - san

    # Общий тотал — растёт при большей неравности
    mu_total = base_total
    mu_total *= (1.0 + clamp(abs(diff_rank) * total_scale, 0.0, 0.30))
    mu_total *= (1.0 + clamp(abs(diff_str) * str_total_scale, 0.0, 0.30))

    # Доля голов хозяев: базовая 0.5 + дом.преимущество + вклад рангов и сил
    share_home = 0.5 + home_adv
    share_home += diff_rank * share_scale
    share_home += diff_str * str_share_scale
    # Без перекосов до нелепости, но шире коридор
    share_home = clamp(share_home, 0.10, 0.90)
    lam = clamp(mu_total * share_home, min_rate, max_rate)
    mu = clamp(mu_total * (1.0 - share_home), min_rate, max_rate)
    return lam, mu

def _dc_outcome_probs(lam: float, mu: float, rho: float, max_goals: int = 8) -> tuple[dict, list[list[float]]]:
    """Считает вероятности исходов 1X2 и матрицу вероятностей счётов (для тоталов)."""
    from itertools import product
    P = {'H': 0.0, 'D': 0.0, 'A': 0.0}
    mat = [[0.0]*(max_goals+1) for _ in range(max_goals+1)]
    for x, y in product(range(max_goals+1), repeat=2):
        p = _dc_tau(x, y, lam, mu, rho) * _dc_poisson(x, lam) * _dc_poisson(y, mu)
        mat[x][y] = p
        if x > y: P['H'] += p
        elif x == y: P['D'] += p
        else: P['A'] += p
    # нормализуем, если из-за усечения немного не 1.0
    s = P['H'] + P['D'] + P['A']
    if s > 0:
        P = {k: v/s for k, v in P.items()}
        # и матрицу
        for i in range(max_goals+1):
            for j in range(max_goals+1):
                mat[i][j] = mat[i][j] / s
    return P, mat

def _compute_match_odds(home: str, away: str, date_key: str|None = None) -> dict:
    """Коэффициенты 1X2 по Dixon–Coles (Поассоны с коррекцией)."""
    try:
        rho = float(os.environ.get('BET_DC_RHO', '-0.05'))
    except Exception:
        rho = -0.05
    try:
        max_goals = int(os.environ.get('BET_MAX_GOALS', '8'))
    except Exception:
        max_goals = 8
    # Параметры «заострения» и влияния голосований
    try:
        softmax_gamma = float(os.environ.get('BET_SOFTMAX_GAMMA', '1.30'))
    except Exception:
        softmax_gamma = 1.30
    try:
        fav_target_odds = float(os.environ.get('BET_FAV_TARGET_ODDS', '1.40'))
    except Exception:
        fav_target_odds = 1.40
    try:
        vote_infl_max = float(os.environ.get('BET_VOTE_INFLUENCE_MAX', '0.09'))
    except Exception:
        vote_infl_max = 0.06
    try:
        fav_pull = float(os.environ.get('BET_FAV_PULL', '0.50'))  # 0..1 — доля подтяжки к таргету (0=нет, 1=жестко)
    except Exception:
        fav_pull = 0.50
    try:
        softmax_draw_gamma = float(os.environ.get('BET_SOFTMAX_DRAW_GAMMA', '1.00'))  # отдельная гамма для ничьей
    except Exception:
        softmax_draw_gamma = 1.00
    # Доп. усиление вероятности ничьей для "равных" команд
    try:
        draw_boost_max = float(os.environ.get('BET_DRAW_BOOST_MAX', '0.25'))  # максимум увеличения pD при паритете
    except Exception:
        draw_boost_max = 0.25
    try:
        draw_max_prob = float(os.environ.get('BET_DRAW_MAX_PROB', '0.35'))   # верхняя граница pD после буста
    except Exception:
        draw_max_prob = 0.35

    lam, mu = _estimate_goal_rates(home, away)
    probs, _mat = _dc_outcome_probs(lam, mu, rho=rho, max_goals=max_goals)
    # Нормализуем вероятности и ограничим минимум/максимум для реалистичности на нейтральном поле
    pH = min(0.92, max(0.05, probs['H']))
    pD = min(0.60, max(0.05, probs['D']))
    pA = min(0.92, max(0.05, probs['A']))
    s = pH + pD + pA
    if s > 0:
        pH, pD, pA = pH/s, pD/s, pA/s

    # Дополнительно сгладим pH/pA к среднему при паритете, чтобы кэфы были ближе к равным
    try:
        # мера близости: 1.0 при pH≈pA, 0.0 при сильном перекосе
        close = 1.0 - min(1.0, abs(pH - pA) / 0.35)
        if close > 0:
            # коэффициент сглаживания до 30% при почти полном паритете
            smooth_k = 0.30 * max(0.0, min(1.0, close))
            avg_hp = 0.5 * (pH + pA)
            pH = pH + smooth_k * (avg_hp - pH)
            pA = pA + smooth_k * (avg_hp - pA)
            # нормализация с сохранением pD как есть на этом шаге
            s2 = pH + pD + pA
            if s2 > 0:
                pH, pD, pA = pH/s2, pD/s2, pA/s2
    except Exception:
        pass

    # Усиливаем pD (ничью), если команды равные: оцениваем паритет по близости pH и pA
    try:
        parity = 1.0 - min(1.0, abs(pH - pA) / 0.30)  # 1.0 при pH≈pA; 0.0 при сильном перекосе
        if draw_boost_max > 0 and parity > 0:
            pD_boosted = pD * (1.0 + draw_boost_max * max(0.0, min(1.0, parity)))
            # Нормируем, уменьшая pH/pA пропорционально, чтобы сумма = 1
            others = max(1e-9, (pH + pA))
            scale = max(1e-9, (1.0 - pD_boosted) / others)
            pH = max(0.01, pH * scale)
            pA = max(0.01, pA * scale)
            pD = max(0.01, min(draw_max_prob, pD_boosted))
            # Финальная нормализация
            s3 = pH + pD + pA
            if s3 > 0:
                pH, pD, pA = pH/s3, pD/s3, pA/s3
    except Exception:
        pass

    # Влияние голосований (если есть дата и БД)
    if SessionLocal is not None and date_key:
        try:
            db = get_db()
            try:
                rows = db.query(MatchVote.choice, func.count(MatchVote.id)).filter(
                    MatchVote.home==home, MatchVote.away==away, MatchVote.date_key==date_key
                ).group_by(MatchVote.choice).all()
            finally:
                db.close()
            agg = {'home':0,'draw':0,'away':0}
            for c, cnt in rows:
                k = str(c).lower()
                if k in agg: agg[k] = int(cnt)
            total = max(1, agg['home']+agg['draw']+agg['away'])
            vh, vd, va = agg['home']/total, agg['draw']/total, agg['away']/total
            dh, dd, da = (vh-1/3), (vd-1/3), (va-1/3)
            k = max(0.0, min(1.0, vote_infl_max))
            pH *= (1.0 + k*dh)
            pD *= (1.0 + k*dd)
            pA *= (1.0 + k*da)
            s2 = pH + pD + pA
            if s2 > 0:
                pH, pD, pA = pH/s2, pD/s2, pA/s2
        except Exception:
            pass

    # «Заострим» распределение, чтобы фаворит получал короче кэф (для ничьей отдельная гамма)
    try:
        if softmax_gamma and softmax_gamma > 1.0:
            _ph = max(1e-9,pH) ** softmax_gamma
            _pd = max(1e-9,pD) ** max(1.0, softmax_draw_gamma)
            _pa = max(1e-9,pA) ** softmax_gamma
            z = _ph + _pd + _pa
            if z>0:
                pH, pD, pA = _ph/z, _pd/z, _pa/z
    except Exception:
        pass

    # Мягкая подтяжка к целевому кэфу фаворита (например, 1.40), но оставляем "плавающим"
    overround = 1.0 + BET_MARGIN
    try:
        arr = [pH,pD,pA]
        fav_idx = max(range(3), key=lambda i: arr[i])
        pmax = arr[fav_idx]
        cur_odds = 1.0 / max(1e-9, pmax*overround)
        target = max(1.10, fav_target_odds)
        if cur_odds > target and fav_pull > 0:
            need_p = min(0.92, max(0.05, 1.0/(target*overround)))
            # Сместим pmax лишь частично в сторону need_p
            p_new = pmax + fav_pull * (need_p - pmax)
            p_new = min(0.98, max(pmax, p_new))
            others_sum = (pH+pD+pA) - pmax
            if others_sum > 1e-9 and p_new < 0.98:
                scale = (1.0 - p_new)/others_sum
                pH, pD, pA = [ (p_new if i==fav_idx else max(0.01, v*scale)) for i,v in enumerate([pH,pD,pA]) ]
    except Exception:
        pass

    # Для "равных" команд заставляем П1 и П2 быть одинаковыми и около 2.0–2.5
    try:
        # высокая степень паритета: различие менее ~0.08 абсолютных пунктов
        parity2 = 1.0 - min(1.0, abs(pH - pA) / 0.08)
        if parity2 > 0.8:
            try:
                min_odd = float(os.environ.get('BET_PARITY_MIN_ODD', '2.00'))
            except Exception:
                min_odd = 2.00
            try:
                max_odd = float(os.environ.get('BET_PARITY_MAX_ODD', '2.50'))
            except Exception:
                max_odd = 2.50
            try:
                mid_odd = float(os.environ.get('BET_PARITY_MID_ODD', '2.20'))
            except Exception:
                mid_odd = 2.20
            target_odd = max(min_odd, min(max_odd, ( (1.0/(max(1e-9, pH*overround)) + 1.0/(max(1e-9, pA*overround)) )/2.0 )))
            # Подтягиваем в район середины 2.2 (в пределах [min_odd; max_odd])
            target_odd = max(min_odd, min(max_odd, (target_odd*0.5 + mid_odd*0.5)))
            p_t = max(0.05, min(0.49, 1.0 / (target_odd * overround)))
            # Равным командам отдаем одинаковые вероятности побед, ничью подстраиваем под остаток
            pH = pA = p_t
            pD = max(0.02, 1.0 - 2.0 * p_t)
            s4 = pH + pD + pA
            if s4 > 0 and abs(s4 - 1.0) > 1e-6:
                pH, pD, pA = pH/s4, pD/s4, pA/s4
    except Exception:
        pass
    def to_odds(p):
        try:
            return round(max(1.10, 1.0 / (p * overround)), 2)
        except Exception:
            return 1.10
    return {
        'home': to_odds(pH),
        'draw': to_odds(pD),
        'away': to_odds(pA)
    }

def _compute_totals_odds(home: str, away: str, line: float) -> dict:
    """Коэффициенты тотала (Over/Under) по Dixon–Coles. Возвращает {'over': k, 'under': k}."""
    try:
        rho = float(os.environ.get('BET_DC_RHO', '-0.05'))
    except Exception:
        rho = -0.05
    try:
        max_goals = int(os.environ.get('BET_MAX_GOALS', '8'))
    except Exception:
        max_goals = 8
    lam, mu = _estimate_goal_rates(home, away)
    _probs, mat = _dc_outcome_probs(lam, mu, rho=rho, max_goals=max_goals)
    try:
        threshold = float(line)
    except Exception:
        threshold = 3.5
    # Для 3.5 -> >=4; для 4.5 -> >=5 и т.п.
    import math
    need = int(math.floor(threshold + 1.0))
    p_over = 0.0
    total_sum = 0.0
    for x in range(max_goals+1):
        for y in range(max_goals+1):
            p = mat[x][y]
            total_sum += p
            if (x + y) >= need:
                p_over += p
    p_over = min(max(p_over, 0.0001), 0.9999)
    p_under = max(0.0001, min(0.9999, 1.0 - p_over))
    overround = 1.0 + BET_MARGIN
    def to_odds(p):
        try:
            return round(max(1.10, 1.0 / (p * overround)), 2)
        except Exception:
            return 1.10
    return {'over': to_odds(p_over), 'under': to_odds(p_under) }

def _compute_specials_odds(home: str, away: str, market: str) -> dict:
    """Да/Нет события: биномиальная модель с базовой вероятностью и лёгкой поправкой по разнице сил."""
    base_yes = 0.30
    if market == 'penalty':
        base_yes = float(os.environ.get('BET_BASE_PENALTY', '0.35'))
    elif market == 'redcard':
        base_yes = float(os.environ.get('BET_BASE_REDCARD', '0.22'))
    def norm(s: str) -> str:
        return _norm_team_key(s)
    ranks = _load_league_ranks()
    rh = ranks.get(norm(home))
    ra = ranks.get(norm(away))
    # Поправка от рангов
    adj = 0.0
    if rh and ra:
        # Небольшая прибавка вероятности в дерби/неравных матчах
        delta = abs(rh - ra)
        adj += min(0.06, delta * 0.004)
    # Поправка от явных сил команд
    try:
        str_adj_scale = float(os.environ.get('BET_STR_SPECIALS_SCALE', '0.020'))
    except Exception:
        str_adj_scale = 0.020
    strengths = _load_team_strengths()
    sh2 = strengths.get(norm(home))
    sa2 = strengths.get(norm(away))
    if sh2 is not None and sa2 is not None:
        try:
            s_vals = list(strengths.values()) or [1.0, 10.0]
            s_min, s_max = min(s_vals), max(s_vals)
            span = max(1e-6, float(s_max - s_min))
            shn = (float(sh2) - s_min) / span
            san = (float(sa2) - s_min) / span
            delta_str = abs(shn - san)
        except Exception:
            delta_str = 0.0
        # Немного повышаем вероятность события при большой разнице сил
        adj += min(0.08, delta_str * str_adj_scale)
    p_yes = max(0.02, min(0.97, base_yes + adj))
    p_no = max(0.02, 1.0 - p_yes)
    overround = 1.0 + BET_MARGIN
    def to_odds(p):
        try:
            return round(max(1.10, 1.0 / (p * overround)), 2)
        except Exception:
            return 1.10
    return { 'yes': to_odds(p_yes), 'no': to_odds(p_no) }

def get_referrals_sheet():
    """Возвращает лист 'referrals', создаёт при отсутствии."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    try:
        ws = doc.worksheet("referrals")
    except gspread.exceptions.WorksheetNotFound:
        ws = doc.add_worksheet(title="referrals", rows=1000, cols=6)
        ws.update(values=[[
            'user_id', 'referral_code', 'referrer_id', 'invited_count', 'created_at', 'updated_at'
        ]], range_name='A1:F1')
    return ws

def mirror_referral_to_sheets(user_id: int, referral_code: str, referrer_id: int|None, invited_count: int, created_at_iso: str|None = None):
    """Создаёт/обновляет строку в листе referrals."""
    try:
        ws = get_referrals_sheet()
    except Exception as e:
        app.logger.warning(f"Не удалось получить лист referrals: {e}")
        return
    try:
        cell = ws.find(str(user_id), in_column=1)
    except Exception:
        cell = None
    updated_at = datetime.now(timezone.utc).isoformat()
    created_at = created_at_iso or updated_at
    if not cell:
        try:
            _metrics_inc('sheet_writes', 1)
            ws.append_row([
                str(user_id), referral_code or '', str(referrer_id or ''), str(invited_count or 0), created_at, updated_at
            ])
        except Exception as e:
            app.logger.warning(f"Не удалось добавить referral в лист: {e}")
    else:
        row = cell.row
        try:
            _metrics_inc('sheet_writes', 1)
            ws.batch_update([
                {'range': f'B{row}', 'values': [[referral_code or '']]},
                {'range': f'C{row}', 'values': [[str(referrer_id or '')]]},
                {'range': f'D{row}', 'values': [[str(invited_count or 0)]]},
                {'range': f'F{row}', 'values': [[updated_at]]},
            ])
        except Exception as e:
            app.logger.warning(f"Не удалось обновить referral в листе: {e}")

def get_stats_sheet():
    """Возвращает лист статистики 'СТАТИСТИКА'."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    return doc.worksheet("СТАТИСТИКА")

def get_schedule_sheet():
    """Возвращает лист расписания 'РАСПИСАНИЕ ИГР'."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    return doc.worksheet("РАСПИСАНИЕ ИГР")

def get_rosters_sheet():
    """Возвращает лист составов 'СОСТАВЫ'. В первой строке заголовки с названиями команд."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = _get_doc(sheet_id)
    return doc.worksheet("СОСТАВЫ")

# Запись счёта матча в лист "РАСПИСАНИЕ ИГР" в колонки B (home) и D (away)
def mirror_match_score_to_schedule(home: str, away: str, score_home: int|None, score_away: int|None) -> bool:
    try:
        if score_home is None or score_away is None:
            return False
        ws = get_schedule_sheet()
        _metrics_inc('sheet_reads', 1)
        rows = ws.get_all_values() or []
        # Ищем первую строку с совпадением home в A и away в E (как в билдере расписания)
        target_row_idx = None
        for i, r in enumerate(rows, start=1):
            a = (r[0] if len(r) > 0 else '').strip()
            e = (r[4] if len(r) > 4 else '').strip()
            if a == home and e == away:
                target_row_idx = i
                break
        if target_row_idx is None:
            return False
        # Пишем как числа с USER_ENTERED, чтобы не было ведущего апострофа в ячейках
        rng = f"B{target_row_idx}:D{target_row_idx}"
        try:
            # gspread Worksheet.update поддерживает value_input_option
            ws.update(rng, [[int(score_home), '', int(score_away)]], value_input_option='USER_ENTERED')
        except Exception:
            # fallback, если вдруг не поддерживается — обычный update (может оставить строку)
            ws.update(rng, [[int(score_home), '', int(score_away)]])
        _metrics_inc('sheet_writes', 1)
        return True
    except Exception as e:
        _metrics_note_rate_limit(e)
        app.logger.warning(f"Mirror match score to schedule failed: {e}")
        return False

def get_user_achievements_row(user_id):
    """Читает или инициализирует строку достижений пользователя."""
    ws = get_achievements_sheet()
    try:
        cell = ws.find(str(user_id), in_column=1)
        if cell:
            row_vals = ws.row_values(cell.row)
            # Гарантируем длину до 19 колонок (A..S)
            row_vals = list(row_vals) + [''] * (19 - len(row_vals))
            return cell.row, {
                'credits_tier': int(row_vals[1] or 0),
                'credits_unlocked_at': row_vals[2] or '',
                'level_tier': int(row_vals[3] or 0),
                'level_unlocked_at': row_vals[4] or '',
                'streak_tier': int(row_vals[5] or 0),
                'streak_unlocked_at': row_vals[6] or '',
                'invited_tier': int(row_vals[7] or 0),
                'invited_unlocked_at': row_vals[8] or '',
                'betcount_tier': int((row_vals[9] or 0)),
                'betcount_unlocked_at': row_vals[10] or '',
                'betwins_tier': int((row_vals[11] or 0)),
                'betwins_unlocked_at': row_vals[12] or '',
                'bigodds_tier': int((row_vals[13] or 0)),
                'bigodds_unlocked_at': row_vals[14] or '',
                'markets_tier': int((row_vals[15] or 0)),
                'markets_unlocked_at': row_vals[16] or '',
                'weeks_tier': int((row_vals[17] or 0)),
                'weeks_unlocked_at': row_vals[18] if len(row_vals) > 18 else ''
            }
    except gspread.exceptions.APIError as e:
        app.logger.error(f"Ошибка API при чтении достижений: {e}")
    # Создаём новую строку (включая invited_tier/unlocked_at)
    # Инициализируем 19 колонок: user_id + 9 пар (tier, unlocked_at)
    ws.append_row([
        str(user_id),
        '0','',  # credits
        '0','',  # level
        '0','',  # streak
        '0','',  # invited
        '0','',  # betcount
        '0','',  # betwins
        '0','',  # bigodds
        '0','',  # markets
        '0',''   # weeks
    ])
    # Найдём только что добавленную (последняя строка)
    last_row = len(ws.get_all_values())
    return last_row, {
        'credits_tier': 0,
        'credits_unlocked_at': '',
        'level_tier': 0,
        'level_unlocked_at': '',
        'streak_tier': 0,
        'streak_unlocked_at': '',
        'invited_tier': 0,
        'invited_unlocked_at': '',
        'betcount_tier': 0,
        'betcount_unlocked_at': '',
        'betwins_tier': 0,
        'betwins_unlocked_at': '',
        'bigodds_tier': 0,
        'bigodds_unlocked_at': '',
        'markets_tier': 0,
        'markets_unlocked_at': '',
        'weeks_tier': 0,
        'weeks_unlocked_at': ''
    }

def compute_tier(value: int, thresholds) -> int:
    """Возвращает tier по убывающим порогам. thresholds: [(threshold, tier), ...]"""
    for thr, tier in thresholds:
        if value >= thr:
            return tier
    return 0

def _thresholds_from_targets(targets):
    """Преобразует список целей [t1<t2<t3] в список порогов [(t3,3),(t2,2),(t1,1)]."""
    try:
        if not targets:
            return []
        # берём последние три (на случай большего списка) и сортируем по убыванию
        ts = list(targets)[-3:]
        ts_sorted = sorted(ts)
        # Возвращаем убывающие пороги
        return [(ts_sorted[2], 3), (ts_sorted[1], 2), (ts_sorted[0], 1)]
    except Exception:
        return []

# Вспомогательные функции
def find_user_row(user_id):
    """Ищет строку пользователя по user_id"""
    sheet = get_user_sheet()
    try:
        cell = sheet.find(str(user_id), in_column=1)
        return cell.row if cell else None
    except gspread.exceptions.APIError as e:
        app.logger.error(f"Ошибка API при поиске пользователя: {e}")
        return None

def mirror_user_to_sheets(db_user: 'User'):
    """Создаёт или обновляет запись пользователя в Google Sheets по данным из БД."""
    try:
        sheet = get_user_sheet()
    except Exception as e:
        app.logger.warning(f"Не удалось получить лист users для зеркалирования: {e}")
        return
    row_num = find_user_row(db_user.user_id)
    # Подготовка значений под формат таблицы
    last_checkin_str = db_user.last_checkin_date.isoformat() if isinstance(db_user.last_checkin_date, date) else ''
    created_at = (db_user.created_at or datetime.now(timezone.utc)).isoformat()
    updated_at = (db_user.updated_at or datetime.now(timezone.utc)).isoformat()
    if not row_num:
        new_row = [
            str(db_user.user_id),
            db_user.display_name or 'Игрок',
            db_user.tg_username or '',
            str(db_user.credits or 0),
            str(db_user.xp or 0),
            str(db_user.level or 1),
            str(db_user.consecutive_days or 0),
            last_checkin_str,
            str(db_user.badge_tier or 0),
            '',  # badge_unlocked_at (не ведём в БД)
            created_at,
            updated_at
        ]
        try:
            _metrics_inc('sheet_writes', 1)
            sheet.append_row(new_row)
        except Exception as e:
            app.logger.warning(f"Не удалось добавить пользователя в лист users: {e}")
    else:
        try:
            _metrics_inc('sheet_writes', 1)
            sheet.batch_update([
                {'range': f'B{row_num}', 'values': [[db_user.display_name or 'Игрок']]},
                {'range': f'C{row_num}', 'values': [[db_user.tg_username or '']]},
                {'range': f'D{row_num}', 'values': [[str(db_user.credits or 0)]]},
                {'range': f'E{row_num}', 'values': [[str(db_user.xp or 0)]]},
                {'range': f'F{row_num}', 'values': [[str(db_user.level or 1)]]},
                {'range': f'G{row_num}', 'values': [[str(db_user.consecutive_days or 0)]]},
                {'range': f'H{row_num}', 'values': [[last_checkin_str]]},
                {'range': f'L{row_num}', 'values': [[updated_at]]}
            ])
        except Exception as e:
            app.logger.warning(f"Не удалось обновить пользователя в листе users: {e}")

def _to_int(val, default=0):
    try:
        return int(val)
    except Exception:
        return default

def serialize_user(db_user: 'User'):
    return {
        'user_id': db_user.user_id,
    'display_name': db_user.display_name or 'Игрок',
        'tg_username': db_user.tg_username or '',
        'credits': int(db_user.credits or 0),
        'xp': int(db_user.xp or 0),
        'level': int(db_user.level or 1),
        'consecutive_days': int(db_user.consecutive_days or 0),
        'last_checkin_date': (db_user.last_checkin_date.isoformat() if isinstance(db_user.last_checkin_date, date) else ''),
        'badge_tier': int(db_user.badge_tier or 0),
        'created_at': (db_user.created_at or datetime.now(timezone.utc)).isoformat(),
        'updated_at': (db_user.updated_at or datetime.now(timezone.utc)).isoformat(),
    }

def _get_teams_from_snapshot(db: Session) -> list[str]:
    """Возвращает список команд из снапшота 'league-table' (колонка с названиями, 9 шт.)."""
    teams = []
    snap = _snapshot_get(db, 'league-table')
    payload = snap and snap.get('payload')
    values = payload and payload.get('values') or []
    for i in range(1, min(len(values), 10)):
        row = values[i] or []
        name = (row[1] if len(row) > 1 else '').strip()
        if name:
            teams.append(name)
    # Fallback: если снапшота нет / пусто — используем TEAM_STRENGTHS_BASE
    if not teams:
        try:
            teams = sorted({k for k in TEAM_STRENGTHS_BASE.keys()})
        except Exception:
            teams = []
    return teams

@app.route('/api/teams', methods=['GET'])
def api_teams():
    """Возвращает список команд из таблицы НЛО и счётчики любимых клубов пользователей.
    Формат: { teams: [..], counts: { teamName: n }, updated_at: iso }
    """
    if SessionLocal is None:
        return jsonify({'teams': [], 'counts': {}, 'updated_at': None})
    db: Session = get_db()
    try:
        teams = _get_teams_from_snapshot(db)
        # counts
        rows = db.query(UserPref.favorite_team, func.count(UserPref.user_id)).filter(UserPref.favorite_team.isnot(None)).group_by(UserPref.favorite_team).all()
        counts = { (t or ''): int(n or 0) for (t, n) in rows if t }
        return jsonify({'teams': teams, 'counts': counts, 'updated_at': datetime.now(timezone.utc).isoformat()})
    finally:
        db.close()

@app.route('/api/user/favorite-team', methods=['POST'])
def api_set_favorite_team():
    """Сохраняет любимый клуб пользователя. Поля: initData, team (строка или пусто для очистки)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = int(parsed['user'].get('id'))
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        raw_team = (request.form.get('team') or '').strip()
        db: Session = get_db()
        try:
            # валидация по текущему списку команд
            teams = _get_teams_from_snapshot(db)
            team = raw_team if raw_team in teams else ('' if raw_team == '' else None)
            if team is None:
                return jsonify({'error': 'Некорректная команда'}), 400
            pref = db.get(UserPref, user_id)
            # Лимиты
            lim = db.get(UserLimits, user_id)
            if not lim:
                lim = UserLimits(user_id=user_id, name_changes_left=1, favorite_changes_left=1)
                db.add(lim)
                db.flush()
            if pref and (pref.favorite_team is not None) and (lim.favorite_changes_left or 0) <= 0 and team != (pref.favorite_team or ''):
                return jsonify({'error': 'limit', 'message': 'Сменить любимый клуб можно только один раз'}), 429
            when = datetime.now(timezone.utc)
            prev_team = (pref.favorite_team or '') if pref else ''
            if not pref:
                pref = UserPref(user_id=user_id, favorite_team=(team or None), updated_at=when)
                db.add(pref)
            else:
                pref.favorite_team = (team or None)
                pref.updated_at = when
            # уменьшить лимит при установке/смене на непустое значение, если реально меняем
            if team != '' and prev_team != team:
                lim.favorite_changes_left = max(0, (lim.favorite_changes_left or 0) - 1)
                lim.updated_at = when
            db.commit()
            return jsonify({'status': 'ok', 'favorite_team': (team or '')})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка favorite-team: {e}")
        return jsonify({'error': 'Не удалось сохранить'}), 500

# ---------------------- LEADERBOARDS API ----------------------
def _etag_for_payload(payload: dict) -> str:
    try:
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode('utf-8')
        return hashlib.sha1(raw).hexdigest()
    except Exception:
        return str(int(time.time()))

def _cache_fresh(cache_obj: dict, ttl: int) -> bool:
    return bool(cache_obj.get('data') is not None and (time.time() - (cache_obj.get('ts') or 0) < ttl))

# ---------------------- DB SNAPSHOTS HELPERS ----------------------
def _snapshot_get(db: Session, key: str):
    attempts = 0
    while attempts < 3:
        try:
            row = db.get(Snapshot, key)
            if not row:
                return None
            try:
                data = json.loads(row.payload)
            except Exception:
                data = None
            return {
                'key': key,
                'payload': data,
                'updated_at': (row.updated_at or datetime.now(timezone.utc)).isoformat()
            }
        except Exception as e:
            # OperationalError / EOF: rollback and retry
            try:
                db.rollback()
            except Exception:
                pass
            attempts += 1
            if attempts >= 3:
                app.logger.warning(f"Snapshot get failed for {key} (attempt {attempts}): {e}")
                return None
            # small backoff
            time.sleep(0.1 * attempts)
    return None

def _snapshot_set(db: Session, key: str, payload: dict):
    attempts = 0
    while attempts < 3:
        try:
            raw = json.dumps(payload, ensure_ascii=False)
            row = db.get(Snapshot, key)
            now = datetime.now(timezone.utc)
            if row:
                row.payload = raw
                row.updated_at = now
            else:
                row = Snapshot(key=key, payload=raw, updated_at=now)
                db.add(row)
            db.commit()
            return True
        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            attempts += 1
            if attempts >= 3:
                app.logger.warning(f"Snapshot set failed for {key} (attempt {attempts}): {e}")
                return False
            time.sleep(0.1 * attempts)
    return False

# ---------------------- BUILDERS FROM SHEETS ----------------------
@app.route('/api/feature-match/set', methods=['POST'])
def api_feature_match_set():
    """Админ: вручную назначить «Матч недели» для главной. Поля: initData, home, away, [date], [datetime].
    Хранится в снапшоте 'feature-match' и используется до завершения этого матча; после завершения автоподбор.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        date_key = (request.form.get('date') or '').strip()[:10]
        dt_str = (request.form.get('datetime') or '').strip() or None
        if not home or not away:
            return jsonify({'error': 'match required'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'DB unavailable'}), 500
        db: Session = get_db()
        try:
            payload = {
                'match': {
                    'home': home,
                    'away': away,
                    'date': (date_key or None),
                    'datetime': dt_str,
                },
                'set_by': user_id,
                'set_at': datetime.now(timezone.utc).isoformat()
            }
            ok = _snapshot_set(db, 'feature-match', payload)
            if not ok:
                return jsonify({'error': 'store failed'}), 500
            return jsonify({'status': 'ok'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"feature-match set error: {e}")
        return jsonify({'error': 'server error'}), 500

@app.route('/api/feature-match/clear', methods=['POST'])
def api_feature_match_clear():
    """Админ: сбросить ручной выбор «Матча недели». Поля: initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Unauthorized'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'error': 'DB unavailable'}), 500
        db: Session = get_db()
        try:
            ok = _snapshot_set(db, 'feature-match', {'match': None, 'set_by': user_id, 'set_at': datetime.now(timezone.utc).isoformat()})
            if not ok:
                return jsonify({'error': 'store failed'}), 500
            return jsonify({'status': 'ok'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"feature-match clear error: {e}")
        return jsonify({'error': 'server error'}), 500

# ---------------------- BUILDERS FROM SHEETS ----------------------
def _build_league_payload_from_sheet():
    ws = get_table_sheet()
    _metrics_inc('sheet_reads', 1)
    try:
        values = ws.get('A1:H10') or []
    except Exception as e:
        _metrics_note_rate_limit(e)
        raise
    normalized = []
    for i in range(10):
        row = values[i] if i < len(values) else []
        row = list(row) + [''] * (8 - len(row))
        normalized.append(row[:8])
    payload = {
        'range': 'A1:H10',
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'values': normalized
    }
    return payload

def _build_stats_payload_from_sheet():
    # Build stats payload from DB (TeamPlayerStats). Returns same shape as previous Sheets payload.
    header = ['Игрок', 'Матчи', 'Голы', 'Пасы', 'ЖК', 'КК', 'Очки']
    rows_out = [header]
    # Prefer DB as source
    try:
        if SessionLocal is not None:
            db = get_db()
            try:
                rows = db.query(TeamPlayerStats).all()
                # sort by goals+assists desc, then goals desc
                rows_sorted = sorted(rows, key=lambda r: ( -((r.goals or 0) + (r.assists or 0)), -(r.goals or 0) ))
                for r in rows_sorted[:10]:
                    name = (r.player or '')
                    matches = int(r.games or 0)
                    goals = int(r.goals or 0)
                    assists = int(r.assists or 0)
                    yellows = int(r.yellows or 0)
                    reds = int(r.reds or 0)
                    points = goals + assists
                    rows_out.append([name, matches, goals, assists, yellows, reds, points])
            finally:
                try:
                    db.close()
                except Exception:
                    pass
    except Exception:
        # Fall back to empty placeholders if DB read fails
        rows_out = [header]

    # Ensure we have 10 player rows (header + 10 rows = 11)
    while len(rows_out) < 11:
        idx = len(rows_out)
        rows_out.append([f'Игрок {idx}', 0, 0, 0, 0, 0, 0])

    payload = {
        'range': 'A1:G11',
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'values': rows_out
    }
    return payload

def _build_schedule_payload_from_sheet():
    ws = get_schedule_sheet()
    _metrics_inc('sheet_reads', 1)
    try:
        rows = ws.get_all_values() or []
    except Exception as e:
        _metrics_note_rate_limit(e)
        raise

    def parse_date(d: str):
        d = (d or '').strip()
        if not d:
            return None
        for fmt in ("%d.%m.%y", "%d.%m.%Y"):
            try:
                return datetime.strptime(d, fmt).date()
            except Exception:
                continue
        return None

    def parse_time(t: str):
        t = (t or '').strip()
        try:
            return datetime.strptime(t, "%H:%M").time()
        except Exception:
            return None

    tours = []
    current_tour = None
    current_title = None
    current_matches = []

    def flush_curr():
        nonlocal current_tour, current_title, current_matches
        if current_tour is not None and current_matches:
            start_dts = []
            for m in current_matches:
                ds = m.get('datetime')
                if ds:
                    try:
                        start_dts.append(datetime.fromisoformat(ds))
                    except Exception:
                        pass
                elif m.get('date'):
                    try:
                        dd = datetime.fromisoformat(m['date']).date()
                        tt = parse_time(m.get('time','00:00') or '00:00') or datetime.min.time()
                        start_dts.append(datetime.combine(dd, tt))
                    except Exception:
                        pass
            start_at = start_dts and min(start_dts).isoformat() or ''
            tours.append({'tour': current_tour, 'title': current_title, 'start_at': start_at, 'matches': current_matches})
        current_tour = None
        current_title = None
        current_matches = []

    for r in rows:
        a = (r[0] if len(r) > 0 else '').strip()
        header_num = None
        if a:
            parts = a.replace('\u00A0', ' ').strip().split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].lower().startswith('тур'):
                header_num = int(parts[0])
        if header_num is not None:
            flush_curr()
            current_tour = header_num
            current_title = a
            current_matches = []
            continue

        if current_tour is not None:
            home = (r[0] if len(r) > 0 else '').strip()
            score_home = (r[1] if len(r) > 1 else '').strip()
            score_away = (r[3] if len(r) > 3 else '').strip()
            away = (r[4] if len(r) > 4 else '').strip()
            date_str = (r[5] if len(r) > 5 else '').strip()
            time_str = (r[6] if len(r) > 6 else '').strip()
            if not home and not away:
                continue
            d = parse_date(date_str)
            tm = parse_time(time_str)
            dt = None
            if d:
                try:
                    dt = datetime.combine(d, tm or datetime.min.time())
                except Exception:
                    dt = None
            current_matches.append({
                'home': home,
                'away': away,
                'score_home': score_home,
                'score_away': score_away,
                'date': (d.isoformat() if d else ''),
                'time': time_str,
                'datetime': (dt.isoformat() if dt else '')
            })

    flush_curr()

    # ближайшие 3 тура (как в api), исключая матчи, завершённые более 3 часов назад
    # now с учётом смещения расписания
    try:
        _tz_min = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
    except Exception:
        _tz_min = 0
    if _tz_min == 0:
        try:
            _tz_h = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
        except Exception:
            _tz_h = 0
        _tz_min = _tz_h * 60
    now_local = datetime.now() + timedelta(minutes=_tz_min)
    today = now_local.date()
    # Снимок завершенности: (home, away, tour) и последний номер тура с прошедшими матчами
    finished_triples = set()
    last_finished_tour = 0
    if SessionLocal is not None:
        dbx = get_db()
        try:
            snap_res = _snapshot_get(dbx, 'results')
            payload_res = snap_res and snap_res.get('payload') or {}
            for r in (payload_res.get('results') or []):
                try:
                    tr = r.get('tour')
                    finished_triples.add(((r.get('home') or ''), (r.get('away') or ''), int(tr) if isinstance(tr, int) else tr))
                    if isinstance(tr, int):
                        if tr > last_finished_tour:
                            last_finished_tour = tr
                except Exception:
                    continue
        except Exception:
            pass
        finally:
            dbx.close()
    def tour_is_upcoming(t):
        # 1) по времени
        for m in t.get('matches', []):
            try:
                if m.get('datetime'):
                    dt = datetime.fromisoformat(m['datetime'])
                    # Убираем 3-часовой буфер: матч остаётся в расписании только до времени начала
                    if dt >= now_local:
                        return True
                elif m.get('date'):
                    if datetime.fromisoformat(m['date']).date() >= today:
                        return True
            except Exception:
                continue
        # 2) fallback: если тур строго больше последнего завершённого, показываем его даже без дат
        try:
            trn = t.get('tour')
            if isinstance(trn, int) and last_finished_tour and trn > last_finished_tour:
                return True
        except Exception:
            pass
        return False
    upcoming = [t for t in tours if tour_is_upcoming(t)]
    # Внутри каждого тура также отфильтруем сами матчи по этому правилу
    for t in upcoming:
        new_matches = []
        for m in t.get('matches', []):
            try:
                keep = False
                if m.get('datetime'):
                    dt = datetime.fromisoformat(m['datetime'])
                    # Убираем 3-часовой буфер: матч остаётся в расписании только до времени начала
                    keep = (dt >= now_local)
                elif m.get('date'):
                    d = datetime.fromisoformat(m['date']).date()
                    keep = (d >= today)
                else:
                    # Нет даты/времени: если тур впереди (после последнего завершённого) — оставляем
                    trn = t.get('tour')
                    if isinstance(trn, int) and last_finished_tour and trn > last_finished_tour:
                        keep = True
                # скрыть, если матч уже попал в «Результаты» в этом же туре (совпадают home/away/tour)
                if keep:
                    try:
                        trn = t.get('tour')
                        key = ((m.get('home') or ''), (m.get('away') or ''), int(trn) if isinstance(trn, int) else trn)
                        if key in finished_triples:
                            keep = False
                    except Exception:
                        pass
                if keep:
                    new_matches.append(m)
            except Exception:
                new_matches.append(m)
        t['matches'] = new_matches
    # Убираем туры, в которых после фильтрации не осталось матчей — чтобы не показывать пустые заголовки
    upcoming = [t for t in upcoming if t.get('matches') and len(t.get('matches')) > 0]
    def tour_sort_key(t):
        # Приоритизируем ближайшие по номеру после последнего завершённого тура,
        # чтобы показывать, например, 4/5/6 даже если у 7/8/9 есть даты, а у 4/5/6 нет.
        trn = t.get('tour') or 10**9
        try:
            dist = (trn - last_finished_tour) if (isinstance(trn, int) and last_finished_tour) else 10**9
        except Exception:
            dist = 10**9
        try:
            sa = t.get('start_at') or ''
            sa_dt = datetime.fromisoformat(sa) if sa else datetime(2100,1,1)
        except Exception:
            sa_dt = datetime(2100,1,1)
        # Сортируем по расстоянию в турах, затем по дате старта (если есть), затем по номеру тура
        return (dist if dist > 0 else 10**9, sa_dt, trn)
    upcoming.sort(key=tour_sort_key)
    upcoming = upcoming[:3]

    payload = { 'updated_at': datetime.now(timezone.utc).isoformat(), 'tours': upcoming }
    return payload

def _build_results_payload_from_sheet():
    ws = get_schedule_sheet()
    _metrics_inc('sheet_reads', 1)
    try:
        rows = ws.get_all_values() or []
    except Exception as e:
        _metrics_note_rate_limit(e)
        raise

    def parse_date(d: str):
        d = (d or '').strip()
        if not d:
            return None
        for fmt in ("%d.%m.%y", "%d.%m.%Y"):
            try:
                return datetime.strptime(d, fmt).date()
            except Exception:
                continue
        return None

    def parse_time(t: str):
        t = (t or '').strip()
        try:
            return datetime.strptime(t, "%H:%M").time()
        except Exception:
            return None

    results = []
    current_tour = None
    for r in rows:
        a = (r[0] if len(r) > 0 else '').strip()
        header_num = None
        if a:
            parts = a.replace('\u00A0', ' ').strip().split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].lower().startswith('тур'):
                header_num = int(parts[0])
        if header_num is not None:
            current_tour = header_num
            continue

        if current_tour is not None:
            home = (r[0] if len(r) > 0 else '').strip()
            score_home = (r[1] if len(r) > 1 else '').strip()
            score_away = (r[3] if len(r) > 3 else '').strip()
            away = (r[4] if len(r) > 4 else '').strip()
            date_str = (r[5] if len(r) > 5 else '').strip()
            time_str = (r[6] if len(r) > 6 else '').strip()
            if not home and not away:
                continue

            d = parse_date(date_str)
            tm = parse_time(time_str)
            dt = None
            if d:
                try:
                    dt = datetime.combine(d, tm or datetime.min.time())
                except Exception:
                    dt = None

            # now с учётом смещения расписания (как в _build_schedule_payload_from_sheet)
            try:
                _tz_min = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
            except Exception:
                _tz_min = 0
            if _tz_min == 0:
                try:
                    _tz_h = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
                except Exception:
                    _tz_h = 0
                _tz_min = _tz_h * 60
            now_local = datetime.now() + timedelta(minutes=_tz_min)
            is_past = False
            try:
                if dt:
                    # Матч считается прошедшим сразу после времени начала (без 3-часового буфера)
                    is_past = dt <= now_local
                elif d:
                    is_past = d <= now_local.date()
            except Exception:
                is_past = False

            if is_past:
                results.append({
                    'tour': current_tour,
                    'home': home,
                    'away': away,
                    'score_home': score_home,
                    'score_away': score_away,
                    'date': (d.isoformat() if d else ''),
                    'time': time_str,
                    'datetime': (dt.isoformat() if dt else '')
                })

    def sort_key(m):
        try:
            if m.get('datetime'):
                return datetime.fromisoformat(m['datetime'])
            if m.get('date'):
                return datetime.fromisoformat(m['date'])
        except Exception:
            return datetime.min
        return datetime.min
    results.sort(key=sort_key, reverse=True)
    payload = { 'updated_at': datetime.now(timezone.utc).isoformat(), 'results': results }
    return payload

# ---------------------- BACKGROUND SYNC ----------------------
_BG_THREAD = None

def _should_start_bg() -> bool:
    # Avoid double-start under reloader; start in main runtime only in debug
    debug = os.environ.get('FLASK_DEBUG', '') in ('1','true','True')
    if debug:
        return os.environ.get('WERKZEUG_RUN_MAIN') == 'true'
    return True

def _bg_sync_once():
    """Оптимизированная фоновая синхронизация с использованием новых систем"""
    if SessionLocal is None:
        return
    
    # Используем фоновые задачи для параллельной обработки
    if task_manager:
        # Запускаем синхронизацию разных типов данных параллельно
        task_manager.submit_task("sync_league_table", _sync_league_table, priority=TaskPriority.HIGH)
        task_manager.submit_task("sync_stats_table", _sync_stats_table, priority=TaskPriority.HIGH) 
        task_manager.submit_task("sync_schedule", _sync_schedule, priority=TaskPriority.HIGH)
        task_manager.submit_task("sync_results", _sync_results, priority=TaskPriority.NORMAL)
        task_manager.submit_task("sync_betting_tours", _sync_betting_tours, priority=TaskPriority.NORMAL)
        task_manager.submit_task("sync_leaderboards", _sync_leaderboards, priority=TaskPriority.LOW)
    else:
        # Fallback к старой синхронной логике
        _bg_sync_once_legacy()

def _sync_league_table():
    """Синхронизация таблицы лиги"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        # Используем оптимизированный Sheets менеджер
        if sheets_manager:
            values = sheets_manager.read_range('ТАБЛИЦА', 'A:H')
            league_payload = {'values': values or [], 'updated_at': datetime.now(timezone.utc).isoformat()}
        else:
            league_payload = _build_league_payload_from_sheet()
            
        _snapshot_set(db, 'league-table', league_payload)
        _metrics_set('last_sync', 'league-table', datetime.now(timezone.utc).isoformat())
        _metrics_set('last_sync_status', 'league-table', 'ok')
        _metrics_set('last_sync_duration_ms', 'league-table', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('league_table')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('league_table', league_payload)
        
        # Публикуем через систему автоподписок
        try:
            if app and 'subscription_manager' in app.config:
                sub_manager = app.config['subscription_manager']
                sub_manager.publish(
                    SubscriptionType.LEAGUE_TABLE,
                    {
                        'table': league_payload.get('values', []),
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    }
                )
        except Exception as e:
            app.logger.warning(f"Failed to publish league table update: {e}")
            
        # Сохраняем в реляционную таблицу (фоновая задача низкого приоритета)
        if task_manager:
            task_manager.submit_task("persist_league_table", _persist_league_table, 
                                   league_payload.get('values', []), priority=TaskPriority.BACKGROUND)
            
    except Exception as e:
        app.logger.warning(f"League table sync failed: {e}")
        _metrics_set('last_sync_status', 'league-table', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _persist_league_table(normalized_values):
    """Сохраняет данные таблицы лиги в реляционную таблицу"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        when = datetime.now(timezone.utc)
        for idx, r in enumerate(normalized_values, start=1):
            if len(r) < 8:
                r.extend([''] * (8 - len(r)))  # Дополняем пустыми значениями
            row = db.get(LeagueTableRow, idx)
            if not row:
                row = LeagueTableRow(
                    row_index=idx,
                    c1=str(r[0] or ''), c2=str(r[1] or ''), c3=str(r[2] or ''), c4=str(r[3] or ''),
                    c5=str(r[4] or ''), c6=str(r[5] or ''), c7=str(r[6] or ''), c8=str(r[7] or ''),
                    updated_at=when
                )
                db.add(row)
            else:
                row.c1, row.c2, row.c3, row.c4 = str(r[0] or ''), str(r[1] or ''), str(r[2] or ''), str(r[3] or '')
                row.c5, row.c6, row.c7, row.c8 = str(r[4] or ''), str(r[5] or ''), str(r[6] or ''), str(r[7] or '')
                row.updated_at = when
        db.commit()
    finally:
        db.close()

def _sync_stats_table():
    """Синхронизация таблицы статистики"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        # Используем оптимизированный Sheets менеджер
        if sheets_manager:
            values = sheets_manager.read_range('СТАТИСТИКА', 'A:G')
            stats_payload = {'values': values or [], 'updated_at': datetime.now(timezone.utc).isoformat()}
        else:
            stats_payload = _build_stats_payload_from_sheet()
            
        _snapshot_set(db, 'stats-table', stats_payload)
        _metrics_set('last_sync', 'stats-table', datetime.now(timezone.utc).isoformat())
        _metrics_set('last_sync_status', 'stats-table', 'ok')
        _metrics_set('last_sync_duration_ms', 'stats-table', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('stats_table')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('stats_table', stats_payload)
            
    except Exception as e:
        app.logger.warning(f"Stats table sync failed: {e}")
        _metrics_set('last_sync_status', 'stats-table', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _sync_schedule():
    """Синхронизация расписания"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        # Используем оптимизированный Sheets менеджер
        if sheets_manager:
            schedule_payload = _build_schedule_payload_from_sheet()
        else:
            schedule_payload = _build_schedule_payload_from_sheet()
            
        _snapshot_set(db, 'schedule', schedule_payload)
        _metrics_set('last_sync', 'schedule', datetime.now(timezone.utc).isoformat())
        _metrics_set('last_sync_status', 'schedule', 'ok')
        _metrics_set('last_sync_duration_ms', 'schedule', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('schedule')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('schedule', schedule_payload)
            
    except Exception as e:
        app.logger.warning(f"Schedule sync failed: {e}")
        _metrics_set('last_sync_status', 'schedule', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _sync_results():
    """Синхронизация результатов"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        results_payload = _build_results_payload_from_sheet()
        _snapshot_set(db, 'results', results_payload)
        _metrics_set('last_sync', 'results', datetime.now(timezone.utc).isoformat())
        _metrics_set('last_sync_status', 'results', 'ok')
        _metrics_set('last_sync_duration_ms', 'results', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('results')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('results', results_payload)
            
    except Exception as e:
        app.logger.warning(f"Results sync failed: {e}")
        _metrics_set('last_sync_status', 'results', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _sync_betting_tours():
    """Синхронизация туров ставок"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        tours_payload = _build_betting_tours_payload()
        _snapshot_set(db, 'betting-tours', tours_payload)
        _metrics_set('last_sync', 'betting-tours', datetime.now(timezone.utc).isoformat())
        _metrics_set('last_sync_status', 'betting-tours', 'ok')
        _metrics_set('last_sync_duration_ms', 'betting-tours', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('betting_tours')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('betting_tours', tours_payload)
            
    except Exception as e:
        app.logger.warning(f"Betting tours sync failed: {e}")
        _metrics_set('last_sync_status', 'betting-tours', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _sync_leaderboards():
    """Синхронизация лидербордов"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        t0 = time.time()
        
        lb_payloads = _build_leaderboards_payloads(db)
        _snapshot_set(db, 'leader-top-predictors', lb_payloads['top_predictors'])
        _snapshot_set(db, 'leader-top-rich', lb_payloads['top_rich'])
        _snapshot_set(db, 'leader-server-leaders', lb_payloads['server_leaders'])
        _snapshot_set(db, 'leader-prizes', lb_payloads['prizes'])
        
        now_iso = datetime.now(timezone.utc).isoformat()
        _metrics_set('last_sync', 'leaderboards', now_iso)
        _metrics_set('last_sync_status', 'leaderboards', 'ok')
        _metrics_set('last_sync_duration_ms', 'leaderboards', int((time.time()-t0)*1000))
        
        # Инвалидируем соответствующий кэш
        if cache_manager:
            cache_manager.invalidate('leaderboards')
            
        # Отправляем WebSocket уведомление
        if websocket_manager:
            websocket_manager.notify_data_change('leaderboards', lb_payloads)
            
    except Exception as e:
        app.logger.warning(f"Leaderboards sync failed: {e}")
        _metrics_set('last_sync_status', 'leaderboards', 'error')
        _metrics_note_rate_limit(e)
    finally:
        db.close()

def _bg_sync_once_legacy():
    """Старая логика синхронизации (fallback)"""
    if SessionLocal is None:
        return
    db = get_db()
    try:
        _metrics_inc('bg_runs_total', 1)
        
        # Stats table
        try:
            t0 = time.time()
            stats_payload = _build_stats_payload_from_sheet()
            _snapshot_set(db, 'stats-table', stats_payload)
            _metrics_set('last_sync', 'stats-table', datetime.now(timezone.utc).isoformat())
            _metrics_set('last_sync_status', 'stats-table', 'ok')
            _metrics_set('last_sync_duration_ms', 'stats-table', int((time.time()-t0)*1000))
            # persist relational
            normalized = stats_payload.get('values') or []
            when = datetime.now(timezone.utc)
            for idx, r in enumerate(normalized, start=1):
                row = db.get(StatsTableRow, idx)
                if not row:
                    row = StatsTableRow(
                        row_index=idx,
                        c1=str(r[0] or ''), c2=str(r[1] or ''), c3=str(r[2] or ''), c4=str(r[3] or ''),
                        c5=str(r[4] or ''), c6=str(r[5] or ''), c7=str(r[6] or ''),
                        updated_at=when
                    )
                    db.add(row)
                else:
                    row.c1, row.c2, row.c3, row.c4 = str(r[0] or ''), str(r[1] or ''), str(r[2] or ''), str(r[3] or '')
                    row.c5, row.c6, row.c7 = str(r[4] or ''), str(r[5] or ''), str(r[6] or '')
                    row.updated_at = when
            db.commit()
        except Exception as e:
            app.logger.warning(f"BG sync stats failed: {e}")
            _metrics_set('last_sync_status', 'stats-table', 'error')
            _metrics_note_rate_limit(e)

        # Schedule
        try:
            t0 = time.time()
            schedule_payload = _build_schedule_payload_from_sheet()
            _snapshot_set(db, 'schedule', schedule_payload)
            _metrics_set('last_sync', 'schedule', datetime.now(timezone.utc).isoformat())
            _metrics_set('last_sync_status', 'schedule', 'ok')
            _metrics_set('last_sync_duration_ms', 'schedule', int((time.time()-t0)*1000))
            # После обновления расписания: синхронизировать match_datetime у открытых ставок
            try:
                sched_map = {}
                for t in schedule_payload.get('tours') or []:
                    for m in (t.get('matches') or []):
                        key = (m.get('home') or '', m.get('away') or '')
                        dt = None
                        try:
                            if m.get('datetime'):
                                dt = datetime.fromisoformat(m['datetime'])
                            elif m.get('date'):
                                d = datetime.fromisoformat(m['date']).date()
                                tm = datetime.strptime((m.get('time') or '00:00') or '00:00', '%H:%M').time()
                                dt = datetime.combine(d, tm)
                        except Exception:
                            dt = None
                        sched_map[key] = dt
                open_bets = db.query(Bet).filter(Bet.status=='open').all()
                updates = 0
                for b in open_bets:
                    new_dt = sched_map.get((b.home, b.away))
                    if new_dt is None:
                        continue
                    if (b.match_datetime or None) != new_dt:
                        b.match_datetime = new_dt
                        b.updated_at = datetime.now(timezone.utc)
                        updates += 1
                if updates:
                    db.commit()
                    app.logger.info(f"BG sync: updated match_datetime for {updates} open bets")
            except Exception as _e:
                app.logger.warning(f"BG bet sync failed: {_e}")
        except Exception as e:
            app.logger.warning(f"BG sync schedule failed: {e}")
            _metrics_set('last_sync_status', 'schedule', 'error')
            _metrics_note_rate_limit(e)

        # Results
        try:
            t0 = time.time()
            results_payload = _build_results_payload_from_sheet()
            _snapshot_set(db, 'results', results_payload)
            _metrics_set('last_sync', 'results', datetime.now(timezone.utc).isoformat())
            _metrics_set('last_sync_status', 'results', 'ok')
            _metrics_set('last_sync_duration_ms', 'results', int((time.time()-t0)*1000))
        except Exception as e:
            app.logger.warning(f"BG sync results failed: {e}")
            _metrics_set('last_sync_status', 'results', 'error')
            _metrics_note_rate_limit(e)

        # Betting tours (enriched with odds/markets/locks for nearest tour)
        try:
            t0 = time.time()
            tours_payload = _build_betting_tours_payload()
            _snapshot_set(db, 'betting-tours', tours_payload)
            _metrics_set('last_sync', 'betting-tours', datetime.now(timezone.utc).isoformat())
            _metrics_set('last_sync_status', 'betting-tours', 'ok')
            _metrics_set('last_sync_duration_ms', 'betting-tours', int((time.time()-t0)*1000))
        except Exception as e:
            app.logger.warning(f"BG sync betting-tours failed: {e}")
            _metrics_set('last_sync_status', 'betting-tours', 'error')

        # Leaderboards precompute (hourly semantics; run on each loop, responses are cached by clients)
        try:
            t0 = time.time()
            lb_payloads = _build_leaderboards_payloads(db)
            _snapshot_set(db, 'leader-top-predictors', lb_payloads['top_predictors'])
            _snapshot_set(db, 'leader-top-rich', lb_payloads['top_rich'])
            _snapshot_set(db, 'leader-server-leaders', lb_payloads['server_leaders'])
            _snapshot_set(db, 'leader-prizes', lb_payloads['prizes'])
            now_iso = datetime.now(timezone.utc).isoformat()
            _metrics_set('last_sync', 'leaderboards', now_iso)
            _metrics_set('last_sync_status', 'leaderboards', 'ok')
            _metrics_set('last_sync_duration_ms', 'leaderboards', int((time.time()-t0)*1000))
        except Exception as e:
            app.logger.warning(f"BG sync leaderboards failed: {e}")
            _metrics_set('last_sync_status', 'leaderboards', 'error')
    finally:
        db.close()

def _bg_sync_loop(interval_sec: int):
    while True:
        try:
            _bg_sync_once()
        except Exception as e:
            app.logger.warning(f"BG sync loop error: {e}")
            _metrics_inc('bg_runs_errors', 1)
        try:
            time.sleep(interval_sec)
        except Exception:
            pass

def start_background_sync():
    global _BG_THREAD
    if _BG_THREAD is not None:
        return
    try:
        enabled = os.environ.get('ENABLE_SCHEDULER', '1') in ('1','true','True')
        if not enabled or SessionLocal is None:
            return
        if not _should_start_bg():
            return
        interval = int(os.environ.get('SYNC_INTERVAL_SEC', '600'))
        t = threading.Thread(target=_bg_sync_loop, args=(interval,), daemon=True)
        t.start()
        _BG_THREAD = t
        app.logger.info(f"Background sync started, interval={interval}s")
    except Exception as e:
        app.logger.warning(f"Failed to start background sync: {e}")

# (removed) Background settle worker per new requirement

# ---------------------- Builders for betting tours and leaderboards ----------------------
def _build_betting_tours_payload():
    # Build nearest tour with odds, markets, and locks for each match.
    # Также открываем следующий тур заранее, если до его первого матча осталось <= 2 дней.
    all_tours = _load_all_tours_from_sheet()
    today = datetime.now().date()

    def is_relevant(t):
        for m in t.get('matches', []):
            try:
                if m.get('datetime'):
                    if datetime.fromisoformat(m['datetime']).date() >= today:
                        return True
                elif m.get('date'):
                    if datetime.fromisoformat(m['date']).date() >= today:
                        return True
            except Exception:
                continue
        return False

    tours = [t for t in all_tours if is_relevant(t)]
    def sort_key(t):
        try:
            return (datetime.fromisoformat(t.get('start_at') or '2100-01-01T00:00:00'), t.get('tour') or 10**9)
        except Exception:
            return (datetime(2100,1,1), t.get('tour') or 10**9)
    tours.sort(key=sort_key)
    # Выбираем ближайший тур
    primary = tours[:1]
    # Логика раннего открытия следующего тура: берём второй по порядку, если он стартует в ближайшие 2 дня
    early_open = []
    if len(tours) >= 2:
        try:
            next_t = tours[1]
            # Вычислим самое раннее время среди матчей следующего тура
            earliest = None
            for m in next_t.get('matches', []):
                dt = None
                if m.get('datetime'):
                    dt = datetime.fromisoformat(m['datetime'])
                elif m.get('date'):
                    try:
                        d = datetime.fromisoformat(m['date']).date()
                        tm_str = (m.get('time') or '00:00')
                        tm = datetime.strptime(tm_str, "%H:%M").time()
                        dt = datetime.combine(d, tm)
                    except Exception:
                        dt = None
                if dt is not None:
                    if earliest is None or dt < earliest:
                        earliest = dt
            if earliest is not None:
                if earliest - datetime.now() <= timedelta(days=2):
                    early_open = [next_t]
        except Exception:
            early_open = []
    tours = primary + early_open

    now_local = datetime.now()
    for t in tours:
        for m in t.get('matches', []):
            try:
                lock = False
                if m.get('datetime'):
                    lock = datetime.fromisoformat(m['datetime']) - timedelta(minutes=BET_LOCK_AHEAD_MINUTES) <= now_local
                elif m.get('date'):
                    d = datetime.fromisoformat(m['date']).date()
                    lock = datetime.combine(d, datetime.max.time()) <= now_local
                # Если матч помечен как live/finished админом — обязательно закрываем
                if SessionLocal is not None:
                    db = get_db()
                    try:
                        row = db.query(MatchFlags).filter(MatchFlags.home==m.get('home',''), MatchFlags.away==m.get('away','')).first()
                        if row and row.status in ('live','finished'):
                            # Учитываем статус только относительно даты/времени именно этого матча,
                            # чтобы не закрывать будущие реванши из-за прошлого статуса тех же команд.
                            match_dt = None
                            try:
                                if m.get('datetime'):
                                    match_dt = datetime.fromisoformat(m['datetime'])
                                elif m.get('date'):
                                    dd = datetime.fromisoformat(m['date']).date()
                                    tm = datetime.strptime((m.get('time') or '00:00') or '00:00', '%H:%M').time()
                                    match_dt = datetime.combine(dd, tm)
                            except Exception:
                                match_dt = None
                            if match_dt is not None:
                                if row.status == 'live':
                                    if match_dt - timedelta(minutes=10) <= now_local < match_dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                        lock = True
                                elif row.status == 'finished':
                                    if now_local >= match_dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                        lock = True
                    finally:
                        db.close()
                m['lock'] = bool(lock)
                # date_key для влияния голосования
                dk = None
                try:
                    if m.get('datetime'):
                        dk = datetime.fromisoformat(m['datetime']).date().isoformat()
                    elif m.get('date'):
                        dk = datetime.fromisoformat(m['date']).date().isoformat()
                except Exception:
                    dk = None
                m['odds'] = _compute_match_odds(m.get('home',''), m.get('away',''), dk)
                totals = []
                for ln in (3.5, 4.5, 5.5):
                    totals.append({'line': ln, 'odds': _compute_totals_odds(m.get('home',''), m.get('away',''), ln)})
                sp_pen = _compute_specials_odds(m.get('home',''), m.get('away',''), 'penalty')
                sp_red = _compute_specials_odds(m.get('home',''), m.get('away',''), 'redcard')
                m['markets'] = {
                    'totals': totals,
                    'specials': {
                        'penalty': { 'available': True, 'odds': sp_pen },
                        'redcard': { 'available': True, 'odds': sp_red }
                    }
                }
            except Exception:
                m['lock'] = True
    return { 'tours': tours, 'updated_at': datetime.now(timezone.utc).isoformat() }

def _build_leaderboards_payloads(db: Session) -> dict:
    # predictors (неделя), rich (месяц)
    won_case = case((Bet.status == 'won', 1), else_=0)
    week_start = _week_period_start_msk_to_utc()
    month_start = _month_period_start_msk_to_utc()
    q = (
        db.query(
            User.user_id.label('user_id'),
            (User.display_name).label('display_name'),
            (User.tg_username).label('tg_username'),
            func.count(Bet.id).label('bets_total'),
            func.sum(won_case).label('bets_won')
        )
        .join(Bet, Bet.user_id == User.user_id)
    .filter(Bet.placed_at >= week_start)
        .group_by(User.user_id, User.display_name, User.tg_username)
        .having(func.count(Bet.id) > 0)
    )
    rows_pred = []
    for r in q:
        total = int(r.bets_total or 0)
        won = int(r.bets_won or 0)
        pct = round((won / total) * 100, 1) if total > 0 else 0.0
        rows_pred.append({
            'user_id': int(r.user_id),
            'display_name': r.display_name or 'Игрок',
            'tg_username': r.tg_username or '',
            'bets_total': total,
            'bets_won': won,
            'winrate': pct
        })
    rows_pred.sort(key=lambda x: (-x['winrate'], -x['bets_total'], x['display_name']))
    rows_pred = rows_pred[:10]

    # rich (месячный прирост кредитов)
    ensure_monthly_baselines(db, month_start)
    bases = { int(r.user_id): int(r.credits_base or 0) for r in db.query(MonthlyCreditBaseline).filter(MonthlyCreditBaseline.period_start == month_start).all() }
    rows_rich = []
    for u in db.query(User).all():
        base = bases.get(int(u.user_id), int(u.credits or 0))
        gain = int(u.credits or 0) - base
        rows_rich.append({'user_id': int(u.user_id), 'display_name': u.display_name or 'Игрок', 'tg_username': u.tg_username or '', 'gain': int(gain)})
    rows_rich.sort(key=lambda x: (-x['gain'], x['display_name']))
    rows_rich = rows_rich[:10]

    # server leaders
    rows_serv = []
    for u in db.query(User).all():
        score = int(u.xp or 0) + int(u.level or 0) * 100 + int(u.consecutive_days or 0) * 5
        rows_serv.append({ 'user_id': int(u.user_id), 'display_name': u.display_name or 'Игрок', 'tg_username': u.tg_username or '', 'xp': int(u.xp or 0), 'level': int(u.level or 1), 'streak': int(u.consecutive_days or 0), 'score': score })
    rows_serv.sort(key=lambda x: (-x['score'], -x['level'], -x['xp']))
    rows_serv = rows_serv[:10]

    # prizes
    preds3 = [ {k:v for k,v in item.items() if k in ('user_id','display_name','tg_username','winrate') } for item in rows_pred[:3] ]
    rich3 = [ {k:v for k,v in item.items() if k in ('user_id','display_name','tg_username','gain') } for item in rows_rich[:3] ]
    serv3 = [ {k:v for k,v in item.items() if k in ('user_id','display_name','tg_username','score') } for item in rows_serv[:3] ]
    prizes_payload = { 'predictors': preds3, 'rich': rich3, 'server': serv3 }

    return {
        'top_predictors': { 'items': rows_pred, 'updated_at': datetime.now(timezone.utc).isoformat() },
        'top_rich': { 'items': rows_rich, 'updated_at': datetime.now(timezone.utc).isoformat() },
        'server_leaders': { 'items': rows_serv, 'updated_at': datetime.now(timezone.utc).isoformat() },
        'prizes': { 'data': prizes_payload, 'updated_at': datetime.now(timezone.utc).isoformat() }
    }

# --------- Admin: матч статус (scheduled | live | finished) ---------
@app.route('/api/match/status/set', methods=['POST'])
def api_match_status_set():
    """Установка статуса матча админом: scheduled|live|finished. Поля: initData, home, away, status"""
    parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
    if not parsed or not parsed.get('user'):
        return jsonify({'error':'Unauthorized'}), 401
    user_id = str(parsed['user'].get('id'))
    admin_id = os.environ.get('ADMIN_USER_ID','')
    if not admin_id or user_id != admin_id:
        return jsonify({'error':'Forbidden'}), 403
    home = (request.form.get('home') or '').strip()
    away = (request.form.get('away') or '').strip()
    status = (request.form.get('status') or 'scheduled').strip().lower()
    if status not in ('scheduled','live','finished'):
        return jsonify({'error':'Bad status'}), 400
    if SessionLocal is None:
        return jsonify({'error':'DB unavailable'}), 500
    db = get_db()
    try:
        row = db.query(MatchFlags).filter(MatchFlags.home==home, MatchFlags.away==away).first()
        now = datetime.now(timezone.utc)
        if not row:
            row = MatchFlags(home=home, away=away)
            db.add(row)
        row.status = status
        if status == 'live' and not row.live_started_at:
            row.live_started_at = now
        if status != 'live' and row.live_started_at is None:
            row.live_started_at = None
        row.updated_at = now
        db.commit()
        # Перестроим снапшот туров (lock может зависеть от статуса)
        try:
            payload = _build_betting_tours_payload()
            _snapshot_set(db, 'betting-tours', payload)
        except Exception as e:
            app.logger.warning(f"Failed to build betting tours payload: {e}")
        if status == 'finished':
            try: 
                _settle_open_bets()
            except Exception as e:
                app.logger.error(f"Failed to settle open bets: {e}")
        return jsonify({'ok': True, 'status': status})
    finally:
        db.close()

@app.route('/api/match/status/get', methods=['GET'])
def api_match_status_get():
    """Авто: scheduled/soon/live/finished по времени начала матча.
    soon: за 10 минут до старта.
    finished: строго через BET_MATCH_DURATION_MINUTES после старта.
    """
    home = (request.args.get('home') or '').strip()
    away = (request.args.get('away') or '').strip()
    dt = _get_match_datetime(home, away)
    try:
        tz_m = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
    except Exception:
        tz_m = 0
    if tz_m == 0:
        try:
            tz_hh = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
        except Exception:
            tz_hh = 0
        tz_m = tz_hh * 60
    now = datetime.now() + timedelta(minutes=tz_m)
    if not dt:
        return jsonify({'status':'scheduled', 'soon': False, 'live_started_at': ''})
    if (dt - timedelta(minutes=10)) <= now < dt:
        return jsonify({'status':'scheduled', 'soon': True, 'live_started_at': ''})
    if dt <= now < dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
        return jsonify({'status':'live', 'soon': False, 'live_started_at': dt.isoformat()})
    if now >= dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
        return jsonify({'status':'finished', 'soon': False, 'live_started_at': dt.isoformat()})
    return jsonify({'status':'scheduled', 'soon': False, 'live_started_at': ''})

@app.route('/api/match/status/set-live', methods=['POST'])
def api_match_status_set_live():
    """Админ: отметить матч как начавшийся (инициализировать счёт 0:0 в БД и в Sheets). Поля: initData, home, away"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchScore).filter(MatchScore.home==home, MatchScore.away==away).first()
            if not row:
                row = MatchScore(home=home, away=away)
                db.add(row)
            # Инициализируем 0:0 только если счёт ещё не выставлен
            if row.score_home is None and row.score_away is None:
                row.score_home = 0
                row.score_away = 0
                row.updated_at = datetime.now(timezone.utc)
                db.commit()
                try:
                    mirror_match_score_to_schedule(home, away, 0, 0)
                except Exception:
                    pass
            return jsonify({'status': 'ok', 'score_home': row.score_home, 'score_away': row.score_away})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"match/status/set-live error: {e}")
        return jsonify({'error': 'Не удалось установить live-статус'}), 500

@app.route('/api/match/status/live', methods=['GET'])
def api_match_status_live():
    """Список live-матчей по расписанию (без ручных флагов)."""
    items = []
    now = datetime.now()
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'betting-tours')
            payload = snap and snap.get('payload')
            tours = payload and payload.get('tours') or []
            for t in tours:
                for m in (t.get('matches') or []):
                    dt_str = m.get('datetime')
                    if not dt_str:
                        continue
                    try:
                        dtm = datetime.fromisoformat(dt_str)
                    except Exception:
                        continue
                    if dtm <= now < dtm + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                        items.append({ 'home': m.get('home',''), 'away': m.get('away',''), 'live_started_at': dtm.isoformat() })
        finally:
            db.close()
    return jsonify({'items': items, 'updated_at': datetime.now(timezone.utc).isoformat()})

@app.route('/api/leaderboard/top-predictors')
def api_leader_top_predictors():
    """Топ-10 прогнозистов: имя, всего ставок, выигрышных, % выигрышных. Кэш 1 час."""
    # Сначала пытаемся отдать предвычисленный снапшот
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'leader-top-predictors')
            if snap and snap.get('payload'):
                payload = snap['payload']
                _core = {'items': payload.get('items')}
                etag = _etag_for_payload(_core)
                inm = request.headers.get('If-None-Match')
                if inm and inm == etag:
                    return ('', 304)
                resp = jsonify({ **payload, 'version': etag })
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
                return resp
        finally:
            db.close()
    global LEADER_PRED_CACHE
    if _cache_fresh(LEADER_PRED_CACHE, LEADER_TTL):
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == LEADER_PRED_CACHE.get('etag'):
            return ('', 304)
        return jsonify({
            'items': LEADER_PRED_CACHE['data'],
            'updated_at': datetime.fromtimestamp(LEADER_PRED_CACHE['ts']).isoformat(),
            'version': LEADER_PRED_CACHE.get('etag')
        })
    if SessionLocal is None:
        return jsonify({'items': [], 'updated_at': None}), 200
    db: Session = get_db()
    try:
        # Посчитаем по таблице ставок
        # won: status='won'
        won_case = case((Bet.status == 'won', 1), else_=0)
        period_start = _week_period_start_msk_to_utc()
        q = (
            db.query(
                User.user_id.label('user_id'),
                (User.display_name).label('display_name'),
                (User.tg_username).label('tg_username'),
                func.count(Bet.id).label('bets_total'),
                func.sum(won_case).label('bets_won')
            )
            .join(Bet, Bet.user_id == User.user_id)
            .filter(Bet.placed_at >= period_start)
            .group_by(User.user_id, User.display_name, User.tg_username)
            .having(func.count(Bet.id) > 0)
        )
        rows = []
        for r in q:
            total = int(r.bets_total or 0)
            won = int(r.bets_won or 0)
            pct = round((won / total) * 100, 1) if total > 0 else 0.0
            rows.append({
                'user_id': int(r.user_id),
                'display_name': r.display_name or 'Игрок',
                'tg_username': r.tg_username or '',
                'bets_total': total,
                'bets_won': won,
                'winrate': pct
            })
        # Сортировка: по % выигрышных, затем по количеству ставок, затем по имени
        rows.sort(key=lambda x: (-x['winrate'], -x['bets_total'], x['display_name']))
        rows = rows[:10]
        payload = {'items': rows}
        etag = _etag_for_payload(payload)
        LEADER_PRED_CACHE = { 'data': rows, 'ts': time.time(), 'etag': etag }
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == etag:
            return ('', 304)
        resp = jsonify({ 'items': rows, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag })
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
        return resp
    finally:
        db.close()

@app.route('/api/leaderboard/top-rich')
def api_leader_top_rich():
    """Топ-10 по приросту кредитов за текущий месяц (с 1-го числа 03:00 МСК)."""
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'leader-top-rich')
            if snap and snap.get('payload'):
                payload = snap['payload']
                _core = {'items': payload.get('items')}
                etag = _etag_for_payload(_core)
                inm = request.headers.get('If-None-Match')
                if inm and inm == etag:
                    return ('', 304)
                resp = jsonify({ **payload, 'version': etag })
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
                return resp
        finally:
            db.close()
    global LEADER_RICH_CACHE
    if _cache_fresh(LEADER_RICH_CACHE, LEADER_TTL):
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == LEADER_RICH_CACHE.get('etag'):
            return ('', 304)
        return jsonify({
            'items': LEADER_RICH_CACHE['data'],
            'updated_at': datetime.fromtimestamp(LEADER_RICH_CACHE['ts']).isoformat(),
            'version': LEADER_RICH_CACHE.get('etag')
        })
    if SessionLocal is None:
        return jsonify({'items': [], 'updated_at': None}), 200
    db: Session = get_db()
    try:
        period_start = _month_period_start_msk_to_utc()
        ensure_monthly_baselines(db, period_start)
        # прирост = current_credits - baseline
        users = db.query(User).all()
        # получим baseline'ы пачкой
        bases = {int(r.user_id): int(r.credits_base or 0) for r in db.query(MonthlyCreditBaseline).filter(MonthlyCreditBaseline.period_start == period_start).all()}
        rows = []
        for u in users:
            base = bases.get(int(u.user_id), int(u.credits or 0))
            gain = int(u.credits or 0) - base
            rows.append({
                'user_id': int(u.user_id),
                'display_name': u.display_name or 'Игрок',
                'tg_username': u.tg_username or '',
                'gain': int(gain),
            })
        # сортировка по gain убыв.
        rows.sort(key=lambda x: (-x['gain'], x['display_name']))
        rows = rows[:10]
        payload = {'items': rows}
        etag = _etag_for_payload(payload)
        LEADER_RICH_CACHE = {'data': rows, 'ts': time.time(), 'etag': etag}
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == etag:
            return ('', 304)
        resp = jsonify({'items': rows, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag})
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
        return resp
    finally:
        db.close()

@app.route('/api/leaderboard/server-leaders')
def api_leader_server_leaders():
    """Лидеры сервера: пример метрики — суммарный XP + streak (или уровень).
    Можно настроить по-другому: например, активность (кол-во чек-инов за месяц) или приглашённые.
    Возвращаем топ-10 по score = xp + level*100 + consecutive_days*5.
    """
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'leader-server-leaders')
            if snap and snap.get('payload'):
                payload = snap['payload']
                _core = {'items': payload.get('items')}
                etag = _etag_for_payload(_core)
                inm = request.headers.get('If-None-Match')
                if inm and inm == etag:
                    return ('', 304)
                resp = jsonify({ **payload, 'version': etag })
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
                return resp
        finally:
            db.close()
    global LEADER_SERVER_CACHE
    if _cache_fresh(LEADER_SERVER_CACHE, LEADER_TTL):
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == LEADER_SERVER_CACHE.get('etag'):
            return ('', 304)
        return jsonify({
            'items': LEADER_SERVER_CACHE['data'],
            'updated_at': datetime.fromtimestamp(LEADER_SERVER_CACHE['ts']).isoformat(),
            'version': LEADER_SERVER_CACHE.get('etag')
        })
    if SessionLocal is None:
        return jsonify({'items': [], 'updated_at': None}), 200
    db: Session = get_db()
    try:
        users = db.query(User).all()
        rows = []
        for u in users:
            score = int(u.xp or 0) + int(u.level or 0) * 100 + int(u.consecutive_days or 0) * 5
            rows.append({
                'user_id': int(u.user_id),
                'display_name': u.display_name or 'Игрок',
                'tg_username': u.tg_username or '',
                'xp': int(u.xp or 0),
                'level': int(u.level or 1),
                'streak': int(u.consecutive_days or 0),
                'score': score
            })
        rows.sort(key=lambda x: (-x['score'], -x['level'], -x['xp']))
        rows = rows[:10]
        payload = {'items': rows}
        etag = _etag_for_payload(payload)
        LEADER_SERVER_CACHE = { 'data': rows, 'ts': time.time(), 'etag': etag }
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == etag:
            return ('', 304)
        resp = jsonify({ 'items': rows, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag })
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
        return resp
    finally:
        db.close()

@app.route('/api/leaderboard/prizes')
def api_leader_prizes():
    """Возвращает пьедесталы по трем категориям: прогнозисты, богачи, лидеры сервера (по 3 места).
    Включаем только display_name и user_id (фото на фронте через Telegram).
    """
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'leader-prizes')
            if snap and snap.get('payload'):
                payload = snap['payload']
                _core = {'data': payload.get('data')}
                etag = _etag_for_payload(_core)
                inm = request.headers.get('If-None-Match')
                if inm and inm == etag:
                    return ('', 304)
                resp = jsonify({ **payload, 'version': etag })
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
                return resp
        finally:
            db.close()
    global LEADER_PRIZES_CACHE
    if _cache_fresh(LEADER_PRIZES_CACHE, LEADER_TTL):
        client_etag = request.headers.get('If-None-Match')
        if client_etag and client_etag == LEADER_PRIZES_CACHE.get('etag'):
            return ('', 304)
        return jsonify({
            'data': LEADER_PRIZES_CACHE['data'],
            'updated_at': datetime.fromtimestamp(LEADER_PRIZES_CACHE['ts']).isoformat(),
            'version': LEADER_PRIZES_CACHE.get('etag')
        })
    # Собираем топы, как в отдельных эндпоинтах
    preds = []
    rich = []
    serv = []
    if SessionLocal is None:
        payload = {'predictors': preds, 'rich': rich, 'server': serv}
        return jsonify({'data': payload, 'updated_at': None})
    db: Session = get_db()
    try:
        # predictors (только за период недели)
        period_start = _week_period_start_msk_to_utc()
        won_case = case((Bet.status == 'won', 1), else_=0)
        q1 = (
            db.query(
                User.user_id.label('user_id'),
                User.display_name.label('display_name'),
                User.tg_username.label('tg_username'),
                func.count(Bet.id).label('bets_total'),
                func.sum(won_case).label('bets_won')
            )
            .join(Bet, Bet.user_id == User.user_id)
            .filter(Bet.placed_at >= period_start)
            .group_by(User.user_id, User.display_name, User.tg_username)
            .having(func.count(Bet.id) > 0)
        )
        tmp = []
        for r in q1:
            total = int(r.bets_total or 0); won = int(r.bets_won or 0)
            pct = round((won / total) * 100, 1) if total > 0 else 0.0
            tmp.append({'user_id': int(r.user_id), 'display_name': r.display_name or 'Игрок', 'tg_username': (r.tg_username or ''), 'winrate': pct, 'total': total})
        tmp.sort(key=lambda x: (-x['winrate'], -x['total'], x['display_name']))
        preds = tmp[:3]

        # rich — месячный прирост кредитов с 1-го числа 03:00 МСК
        period_start = _month_period_start_msk_to_utc()
        ensure_monthly_baselines(db, period_start)
        bases = { int(r.user_id): int(r.credits_base or 0) for r in db.query(MonthlyCreditBaseline).filter(MonthlyCreditBaseline.period_start == period_start).all() }
        tmp_rich = []
        for u in db.query(User).all():
            base = bases.get(int(u.user_id), int(u.credits or 0))
            gain = int(u.credits or 0) - base
            tmp_rich.append({ 'user_id': int(u.user_id), 'display_name': u.display_name or 'Игрок', 'tg_username': (u.tg_username or ''), 'value': int(gain) })
        tmp_rich.sort(key=lambda x: (-x['value'], x['display_name']))
        rich = tmp_rich[:3]

        # server
        users = db.query(User).all()
        tmp2 = []
        for u in users:
            score = int(u.xp or 0) + int(u.level or 0) * 100 + int(u.consecutive_days or 0) * 5
            tmp2.append({ 'user_id': int(u.user_id), 'display_name': u.display_name or 'Игрок', 'tg_username': (u.tg_username or ''), 'score': score })
        tmp2.sort(key=lambda x: -x['score'])
        serv = tmp2[:3]
    finally:
        db.close()

    payload = {'predictors': preds, 'rich': rich, 'server': serv}
    etag = _etag_for_payload(payload)
    LEADER_PRIZES_CACHE = { 'data': payload, 'ts': time.time(), 'etag': etag }
    client_etag = request.headers.get('If-None-Match')
    if client_etag and client_etag == etag:
        return ('', 304)
    resp = jsonify({ 'data': payload, 'updated_at': datetime.now(timezone.utc).isoformat(), 'version': etag })
    resp.headers['ETag'] = etag
    resp.headers['Cache-Control'] = 'public, max-age=3600, stale-while-revalidate=600'
    return resp
_BOT_TOKEN_WARNED = False
def parse_and_verify_telegram_init_data(init_data: str, max_age_seconds: int = 24*60*60):
    """Парсит и проверяет initData из Telegram WebApp.
    Возвращает dict с полями 'user', 'auth_date', 'raw' при успехе, иначе None.
    """
    bot_token = os.environ.get('BOT_TOKEN')
    if not bot_token:
        # В dev окружении можем работать без Telegram — возвращаем None вместо исключения
        global _BOT_TOKEN_WARNED
        if not _BOT_TOKEN_WARNED:
            try: 
                app.logger.warning('BOT_TOKEN не установлен — initData будет игнорироваться')
            except Exception as e:
                print(f"Warning: Failed to log BOT_TOKEN warning: {e}")
            _BOT_TOKEN_WARNED = True
        return None

    if not init_data:
        # Fallback: эмуляция admin пользователя по cookie (для браузерного входа без Telegram)
        try:
            from flask import request as _rq
            cookie_token = _rq.cookies.get('admin_auth')
            admin_id = os.environ.get('ADMIN_USER_ID','')
            admin_pass = os.environ.get('ADMIN_PASSWORD','')
            if cookie_token and admin_id and admin_pass:
                expected = hmac.new(admin_pass.encode('utf-8'), admin_id.encode('utf-8'), hashlib.sha256).hexdigest()
                if hmac.compare_digest(cookie_token, expected):
                    # Возвращаем псевдо auth структуру
                    return {
                        'user': {'id': int(admin_id) if admin_id.isdigit() else admin_id, 'first_name': 'Admin', 'username': 'admin', 'auth_via': 'cookie'},
                        'auth_date': int(time.time()),
                        'raw': ''
                    }
        except Exception:
            pass
        return None

    parsed = parse_qs(init_data)
    if 'hash' not in parsed:
        return None

    received_hash = parsed.pop('hash')[0]
    # Строка для подписи — все пары (key=value) кроме hash, отсортированные по ключу
    data_check_string = '\n'.join([f"{k}={v[0]}" for k, v in sorted(parsed.items())])

    # Секретный ключ по требованиям Telegram WebApp:
    # secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
    # Затем calculated_hash = HMAC_SHA256(key=secret_key, data=data_check_string)
    # Важно: первым параметром в hmac.new идёт ключ (key), вторым — сообщение (msg)
    # Ранее здесь был перепутан порядок аргументов, из-за чего валидация всегда падала
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if calculated_hash != received_hash:
        return None

    # Проверка возраста auth_date
    try:
        auth_date = int(parsed.get('auth_date', ['0'])[0])
    except Exception:
        auth_date = 0
    if auth_date:
        now = int(time.time())
        if now - auth_date > max_age_seconds:
            return None

    # Парсим user из initData (подписанный JSON)
    user = None
    try:
        if 'user' in parsed:
            user = json.loads(parsed['user'][0])
    except Exception:
        user = None

    return {
        'user': user,
        'auth_date': auth_date,
        'raw': parsed
    }

# Основные маршруты
@app.route('/')
def index():
    """Главная страница приложения"""
    return render_template('index.html', admin_user_id=os.environ.get('ADMIN_USER_ID', ''), static_version=STATIC_VERSION)

@app.route('/api/user', methods=['POST'])
@require_telegram_auth()
@rate_limit(max_requests=60, time_window=60)  # 60 запросов за минуту для данных пользователя
def get_user():
    """Получает данные пользователя (исправленная версия без конфликтов отступов)."""
    try:
        parsed = {}
        if hasattr(flask.g, 'auth_data') and getattr(flask.g, 'auth_data', {}).get('user'):
            user_data = flask.g.auth_data['user']
        else:
            init_data = (request.form.get('initData') or request.form.get('init_data') or (request.get_json(silent=True) or {}).get('initData') if request.is_json else None or request.args.get('initData') or request.headers.get('X-Telegram-Init-Data') or '')
            parsed = parse_and_verify_telegram_init_data(init_data or '')
            if not parsed or not parsed.get('user'):
                return jsonify({'error': 'Недействительные данные'}), 401
            user_data = parsed['user']
        if SessionLocal is None:
            row_num = find_user_row(user_data['id'])
            sheet = get_user_sheet()
            if not row_num:
                new_row = [user_data['id'], user_data.get('first_name', 'User'), user_data.get('username',''), '1000','0','1','0','', '0','', datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()]
                sheet.append_row(new_row)
                row = new_row
            else:
                row = sheet.row_values(row_num)
            row = list(row)+['']*(12-len(row))
            return jsonify({'user_id': _to_int(row[0]), 'display_name': row[1], 'tg_username': row[2], 'credits': _to_int(row[3]), 'xp': _to_int(row[4]), 'level': _to_int(row[5],1), 'consecutive_days': _to_int(row[6]), 'last_checkin_date': row[7], 'badge_tier': _to_int(row[8]), 'created_at': row[10], 'updated_at': row[11]})
        db: Session = get_db()
        try:
            db_user = db.get(User, int(user_data['id']))
            now = datetime.now(timezone.utc)
            if not db_user:
                db_user = User(user_id=int(user_data['id']), display_name=user_data.get('first_name') or 'User', tg_username=user_data.get('username') or '', credits=1000, xp=0, level=1, consecutive_days=0, last_checkin_date=None, badge_tier=0, created_at=now, updated_at=now)
                db.add(db_user)
                try:
                    raw = parsed.get('raw') or {}
                    start_param = raw.get('start_param',[None])[0] if isinstance(raw.get('start_param'), list) else None
                except Exception:
                    start_param = None
                try:
                    code = _generate_ref_code(int(user_data['id']))
                    referrer_id=None
                    if start_param and start_param!=code:
                        existing = db.query(Referral).filter(Referral.referral_code==start_param).first()
                        if existing and existing.user_id!=int(user_data['id']):
                            referrer_id=existing.user_id
                    db.add(Referral(user_id=int(user_data['id']), referral_code=code, referrer_id=referrer_id))
                except Exception as re:
                    app.logger.warning(f"Create referral row failed: {re}")
            else:
                db_user.updated_at = now
            db.commit(); db.refresh(db_user)
        finally:
            db.close()
        # mirror photo
        try:
            if parsed.get('user') and parsed['user'].get('photo_url') and SessionLocal is not None:
                dbp = get_db();
                try:
                    r = dbp.get(UserPhoto, int(user_data['id']))
                    url = parsed['user'].get('photo_url'); nnow=datetime.now(timezone.utc)
                    if r:
                        if url and r.photo_url!=url:
                            r.photo_url=url; r.updated_at=nnow; dbp.commit()
                    else:
                        dbp.add(UserPhoto(user_id=int(user_data['id']), photo_url=url, updated_at=nnow)); dbp.commit()
                finally:
                    dbp.close()
        except Exception as pe:
            app.logger.warning(f"Mirror user photo failed: {pe}")
        fav=''
        if SessionLocal is not None:
            dbf=get_db();
            try:
                pref=dbf.get(UserPref, int(user_data['id'])); fav=(pref.favorite_team or '') if pref else ''
            finally:
                dbf.close()
        u=serialize_user(db_user); u['favorite_team']=fav
        return jsonify(u)
    except Exception as e:
        app.logger.error(f"Ошибка получения пользователя: {e}")
        return jsonify({'error':'Внутренняя ошибка сервера'}),500

@app.route('/api/user/avatars')
def api_user_avatars():
    """Возвращает словарь { user_id: photo_url } для запрошенных ID (через ids=1,2,3).
    Пустые/None не включаем. Кэш браузера допустим на 1 час.
    """
    ids_param = request.args.get('ids', '').strip()
    if not ids_param or SessionLocal is None:
        return jsonify({'avatars': {}})
    try:
        ids = [int(x) for x in ids_param.split(',') if x.strip().isdigit()]
    except Exception:
        ids = []
    if not ids:
        return jsonify({'avatars': {}})
    db: Session = get_db()
    try:
        rows = db.query(UserPhoto).filter(UserPhoto.user_id.in_(ids)).all()
        out = {}
        for r in rows:
            if r.photo_url:
                out[str(int(r.user_id))] = r.photo_url
        resp = jsonify({'avatars': out})
        resp.headers['Cache-Control'] = 'public, max-age=3600'
        return resp
    finally:
        db.close()

@app.route('/api/referral', methods=['POST'])
def api_referral():
    """Возвращает реферальную ссылку и статистику приглашений пользователя."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = int(parsed['user'].get('id'))
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            ref = db.get(Referral, user_id)
            if not ref:
                code = _generate_ref_code(user_id)
                ref = Referral(user_id=user_id, referral_code=code)
                db.add(ref)
                db.commit()
                db.refresh(ref)
            # посчитаем приглашённых: засчитываются только те, кто достиг уровня >= 2
            invited_count = db.query(func.count(Referral.user_id)) \
                .join(User, User.user_id == Referral.user_id) \
                .filter(Referral.referrer_id == user_id, (User.level >= 2)) \
                .scalar() or 0
        finally:
            db.close()
        bot_username = os.environ.get('BOT_USERNAME', '').lstrip('@')
        link = f"https://t.me/{bot_username}?start={ref.referral_code}" if bot_username else f"(Укажите BOT_USERNAME в env) Код: {ref.referral_code}"
        # Зеркалим в Google Sheets (лист referrals)
        try:
            mirror_referral_to_sheets(user_id, ref.referral_code, ref.referrer_id, invited_count, (ref.created_at or datetime.now(timezone.utc)).isoformat())
        except Exception as e:
            app.logger.warning(f"Mirror referral to sheets failed: {e}")
        return jsonify({
            'code': ref.referral_code,
            'referral_link': link,
            'invited_count': invited_count
        })
    except Exception as e:
        app.logger.error(f"Ошибка referral: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/achievements-catalog', methods=['GET'])
def api_achievements_catalog():
    """Возвращает каталог достижений для табличного отображения (группы, пороги и описания)."""
    try:
        catalog = [
            {
                'group': 'streak',
                'title': 'Серия дней',
                'tiers': [
                    {'tier':1, 'name':'Бронза', 'target':7},
                    {'tier':2, 'name':'Серебро', 'target':30},
                    {'tier':3, 'name':'Золото', 'target':120}
                ],
                'description': 'ОПИСАНИЕ что нужно сделать для достижения'
            },
            {
                'group': 'credits',
                'title': 'Кредиты',
                'tiers': [
                    {'tier':1, 'name':'Бедолага', 'target':10000},
                    {'tier':2, 'name':'Мажор', 'target':50000},
                    {'tier':3, 'name':'Олигарх', 'target':500000}
                ],
                'description': 'ОПИСАНИЕ что нужно сделать: накопить кредитов на общую сумму 10/50/500 тысяч'
            },
            {
                'group': 'level',
                'title': 'Уровень',
                'tiers': [
                    {'tier':1, 'name':'Новобранец', 'target':25},
                    {'tier':2, 'name':'Ветеран', 'target':50},
                    {'tier':3, 'name':'Легенда', 'target':100}
                ],
                'description': 'ОПИСАНИЕ: достигайте уровней за счёт опыта'
            },
            {
                'group': 'invited',
                'title': 'Приглашения',
                'tiers': [
                    {'tier':1, 'name':'Рекрутер', 'target':10},
                    {'tier':2, 'name':'Посол', 'target':50},
                    {'tier':3, 'name':'Легенда', 'target':150}
                ],
                'description': 'Пригласите друзей через реферальную ссылку (10/50/150)'
            },
            {
                'group': 'betcount',
                'title': 'Количество ставок',
                'tiers': [
                    {'tier':1, 'name':'Новичок ставок', 'target':10},
                    {'tier':2, 'name':'Профи ставок', 'target':50},
                    {'tier':3, 'name':'Марафонец', 'target':200}
                ],
                'description': 'Сделайте 10/50/200 ставок'
            },
            {
                'group': 'betwins',
                'title': 'Победы в ставках',
                'tiers': [
                    {'tier':1, 'name':'Счастливчик', 'target':5},
                    {'tier':2, 'name':'Снайпер', 'target':20},
                    {'tier':3, 'name':'Чемпион', 'target':75}
                ],
                'description': 'Выиграйте 5/20/75 ставок'
            },
            {
                'group': 'bigodds',
                'title': 'Крупный коэффициент',
                'tiers': [
                    {'tier':1, 'name':'Рисковый', 'target':3.0},
                    {'tier':2, 'name':'Хайроллер', 'target':4.5},
                    {'tier':3, 'name':'Легенда кэфов', 'target':6.0}
                ],
                'description': 'Выиграйте ставку с коэффициентом не ниже 3.0/4.5/6.0'
            },
            {
                'group': 'markets',
                'title': 'Разнообразие рынков',
                'tiers': [
                    {'tier':1, 'name':'Универсал I', 'target':2},
                    {'tier':2, 'name':'Универсал II', 'target':3},
                    {'tier':3, 'name':'Универсал III', 'target':4}
                ],
                'description': 'Ставьте на разные рынки: 1x2, тоталы, пенальти, красные (2/3/4 типа)'
            },
            {
                'group': 'weeks',
                'title': 'Регулярность по неделям',
                'tiers': [
                    {'tier':1, 'name':'Регуляр', 'target':2},
                    {'tier':2, 'name':'Постоянный', 'target':5},
                    {'tier':3, 'name':'Железный', 'target':10}
                ],
                'description': 'Делайте ставки в разные недели (2/5/10 недель)'
            }
        ]
        # Добавим агрегированное поле all_targets из констант
        for item in catalog:
            g = item.get('group')
            item['all_targets'] = ACHIEVEMENT_TARGETS.get(g, [t['target'] for t in item.get('tiers', [])])
        return jsonify({'catalog': catalog})
    except Exception as e:
        app.logger.error(f"Ошибка achievements-catalog: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/update-name', methods=['POST'])
def update_name():
    """Обновляет отображаемое имя пользователя"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = parsed['user'].get('id')
        new_name = request.form.get('new_name')
        
        if not user_id or not new_name:
            return jsonify({'error': 'user_id и new_name обязательны'}), 400
        
        if SessionLocal is None:
            # Fallback в лист (если нет БД)
            row_num = find_user_row(user_id)
            if not row_num:
                return jsonify({'error': 'Пользователь не найден'}), 404
            sheet = get_user_sheet()
            sheet.batch_update([
                {'range': f'B{row_num}', 'values': [[new_name]]},
                {'range': f'L{row_num}', 'values': [[datetime.now(timezone.utc).isoformat()]]}
            ])
            return jsonify({'status': 'success', 'display_name': new_name})

        db: Session = get_db()
        try:
            # Проверим лимиты
            lim = db.get(UserLimits, int(user_id))
            if not lim:
                lim = UserLimits(user_id=int(user_id), name_changes_left=1, favorite_changes_left=1)
                db.add(lim)
                db.flush()
            if (lim.name_changes_left or 0) <= 0:
                return jsonify({'error': 'limit', 'message': 'Сменить имя можно только один раз'}), 429
            db_user = db.get(User, int(user_id))
            if not db_user:
                return jsonify({'error': 'Пользователь не найден'}), 404
            db_user.display_name = new_name
            db_user.updated_at = datetime.now(timezone.utc)
            # уменьшаем лимит
            lim.name_changes_left = max(0, (lim.name_changes_left or 0) - 1)
            lim.updated_at = datetime.now(timezone.utc)
            db.commit()
            db.refresh(db_user)
        finally:
            db.close()

        # Зеркалим в Google Sheets
        try:
            mirror_user_to_sheets(db_user)
        except Exception as e:
            app.logger.warning(f"Mirror user name to sheets failed: {e}")

        return jsonify({'status': 'success', 'display_name': new_name})
    
    except Exception as e:
        app.logger.error(f"Ошибка обновления имени: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/checkin', methods=['POST'])
def daily_checkin():
    """Обрабатывает ежедневный чекин"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = parsed['user'].get('id')

        if SessionLocal is None:
            # Fallback: старая логика через лист
            row_num = find_user_row(user_id)
            if not row_num:
                return jsonify({'error': 'Пользователь не найден'}), 404
            sheet = get_user_sheet()
            row = sheet.row_values(row_num)
            # Гарантируем длину
            row = list(row) + [''] * (12 - len(row))
            user = {
                'user_id': _to_int(row[0]), 'display_name': row[1], 'tg_username': row[2],
                'credits': _to_int(row[3]), 'xp': _to_int(row[4]), 'level': _to_int(row[5], 1),
                'consecutive_days': _to_int(row[6]), 'last_checkin_date': row[7]
            }
        else:
            db: Session = get_db()
            try:
                db_user = db.get(User, int(user_id))
                if not db_user:
                    return jsonify({'error': 'Пользователь не найден'}), 404
                user = serialize_user(db_user)
            finally:
                db.close()

        # Проверка даты чекина
        today = datetime.now(timezone.utc).date()
        try:
            last_checkin = datetime.fromisoformat(user['last_checkin_date']).date() if user['last_checkin_date'] else None
        except Exception:
            last_checkin = None

        if last_checkin == today:
            return jsonify({
                'status': 'already_checked',
                'message': 'Вы уже получили награду сегодня'
            })

        # Расчет дня цикла
        cycle_day = (user['consecutive_days'] % 7) + 1
        if last_checkin and (today - last_checkin).days > 1:
            # Пропуск дня - сброс цикла
            cycle_day = 1
            new_consecutive = 1
        else:
            new_consecutive = user['consecutive_days'] + 1

        # Начисление наград
        xp_reward = 10 * cycle_day
        credits_reward = 50 * cycle_day

        # Обновление данных
        new_xp = int(user['xp']) + xp_reward
        new_credits = int(user['credits']) + credits_reward

        # Расчет уровня
        new_level = int(user['level'])
        while new_xp >= new_level * 100:
            new_xp -= new_level * 100
            new_level += 1

        if SessionLocal is None:
            # Обновление в Google Sheets (fallback)
            sheet.batch_update([
                {'range': f'H{row_num}', 'values': [[today.isoformat()]]},       # last_checkin_date
                {'range': f'G{row_num}', 'values': [[str(new_consecutive)]]},    # consecutive_days
                {'range': f'E{row_num}', 'values': [[str(new_xp)]]},             # xp
                {'range': f'D{row_num}', 'values': [[str(new_credits)]]},        # credits
                {'range': f'F{row_num}', 'values': [[str(new_level)]]},          # level
                {'range': f'L{row_num}', 'values': [[datetime.now(timezone.utc).isoformat()]]}  # updated_at
            ])
        else:
            # Обновляем в БД
            db: Session = get_db()
            try:
                db_user = db.get(User, int(user_id))
                if not db_user:
                    return jsonify({'error': 'Пользователь не найден'}), 404
                db_user.last_checkin_date = today
                db_user.consecutive_days = new_consecutive
                db_user.xp = new_xp
                db_user.credits = new_credits
                db_user.level = new_level
                db_user.updated_at = datetime.now(timezone.utc)
                db.commit()
                db.refresh(db_user)
            finally:
                db.close()
            # Зеркалим в Google Sheets
            try:
                mirror_user_to_sheets(db_user)
            except Exception as e:
                app.logger.warning(f"Mirror checkin to sheets failed: {e}")

        return jsonify({
            'status': 'success',
            'xp': xp_reward,
            'credits': credits_reward,
            'cycle_day': cycle_day,
            'new_consecutive': new_consecutive,
            'new_level': new_level
        })

    except Exception as e:
        app.logger.error(f"Ошибка чекина: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/api/achievements', methods=['POST'])
def get_achievements():
    """Получает достижения пользователя"""
    try:
        global ACHIEVEMENTS_CACHE
        if 'ACHIEVEMENTS_CACHE' not in globals():
            ACHIEVEMENTS_CACHE = {}
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = parsed['user'].get('id')
        cache_key = f"ach:{user_id}"
        now_ts = time.time()
        ce = ACHIEVEMENTS_CACHE.get(cache_key)
        if ce and (now_ts - ce.get('ts',0) < 30):
            return jsonify(ce['data'])

        # User fetch (DB or Sheets)
        if SessionLocal is None:
            row_num = find_user_row(user_id)
            if not row_num:
                return jsonify({'error': 'Пользователь не найден'}), 404
            sheet = get_user_sheet()
            row = sheet.row_values(row_num)
            row = list(row) + [''] * (12 - len(row))
            user = {
                'user_id': _to_int(row[0]), 'display_name': row[1], 'tg_username': row[2], 'credits': _to_int(row[3]), 'xp': _to_int(row[4]), 'level': _to_int(row[5],1), 'consecutive_days': _to_int(row[6]), 'last_checkin_date': row[7], 'badge_tier': _to_int(row[8])
            }
        else:
            db = get_db();
            try:
                db_user = db.get(User, int(user_id))
                if not db_user:
                    return jsonify({'error': 'Пользователь не найден'}), 404
                user = serialize_user(db_user)
            finally:
                db.close()

        # Targets & thresholds
        groups = ['streak','credits','level','invited','betcount','betwins','bigodds','markets','weeks']
        streak_targets = ACHIEVEMENT_TARGETS['streak']; credits_targets = ACHIEVEMENT_TARGETS['credits']; level_targets = ACHIEVEMENT_TARGETS['level']; invited_targets = ACHIEVEMENT_TARGETS['invited']; betcount_targets = ACHIEVEMENT_TARGETS['betcount']; betwins_targets = ACHIEVEMENT_TARGETS['betwins']; bigodds_targets = ACHIEVEMENT_TARGETS['bigodds']; markets_targets = ACHIEVEMENT_TARGETS['markets']; weeks_targets = ACHIEVEMENT_TARGETS['weeks']
        streak_thresholds = _thresholds_from_targets(streak_targets); credits_thresholds=_thresholds_from_targets(credits_targets); level_thresholds=_thresholds_from_targets(level_targets); invited_thresholds=_thresholds_from_targets(invited_targets); betcount_thresholds=_thresholds_from_targets(betcount_targets); betwins_thresholds=_thresholds_from_targets(betwins_targets); bigodds_thresholds=_thresholds_from_targets(bigodds_targets); markets_thresholds=_thresholds_from_targets(markets_targets); weeks_thresholds=_thresholds_from_targets(weeks_targets)

        def _next_target_by_value(value, targets_list):
            for t in targets_list:
                if value < t:
                    return t
            return None

        streak_tier = compute_tier(user['consecutive_days'], streak_thresholds)
        credits_tier = compute_tier(user['credits'], credits_thresholds)
        level_tier = compute_tier(user['level'], level_thresholds)
        invited_count = 0
        if SessionLocal is not None:
            db = get_db();
            try:
                invited_count = db.query(func.count(Referral.user_id)).join(User, User.user_id==Referral.user_id).filter(Referral.referrer_id==int(user_id),(User.level>=2)).scalar() or 0
            finally:
                db.close()
        invited_tier = compute_tier(invited_count, invited_thresholds)

        bet_stats = {'total':0,'won':0,'max_win_odds':0.0,'markets_used':set(),'weeks_active':set()}
        if SessionLocal is not None:
            db = get_db();
            try:
                for b in db.query(Bet).filter(Bet.user_id==int(user_id)).all():
                    bet_stats['total'] += 1
                    try:
                        if (b.status or '').lower()=='won':
                            bet_stats['won'] += 1
                            k=float((b.odds or '0').replace(',','.'))
                            if k>bet_stats['max_win_odds']: bet_stats['max_win_odds']=k
                    except Exception: pass
                    mk=(b.market or '1x2').lower();
                    if mk in ('penalty','redcard'): mk='specials'
                    bet_stats['markets_used'].add(mk)
                    if b.placed_at:
                        try:
                            start=_week_period_start_msk_to_utc(b.placed_at.astimezone(timezone.utc))
                            bet_stats['weeks_active'].add(start.date().isoformat())
                        except Exception: pass
            finally:
                db.close()
        betcount_tier=compute_tier(bet_stats['total'], betcount_thresholds); betwins_tier=compute_tier(bet_stats['won'], betwins_thresholds); bigodds_tier=compute_tier(bet_stats['max_win_odds'], bigodds_thresholds); markets_tier=compute_tier(len(bet_stats['markets_used']), markets_thresholds); weeks_tier=compute_tier(len(bet_stats['weeks_active']), weeks_thresholds)

        ach_row, ach = get_user_achievements_row(user_id); updates=[]; now_iso=datetime.now(timezone.utc).isoformat()
        def upd(cond, rng_val_pairs):
            if cond:
                for rng,val in rng_val_pairs: updates.append({'range': rng, 'values': [[val]]})
        upd(credits_tier>ach['credits_tier'], [(f'B{ach_row}', str(credits_tier)), (f'C{ach_row}', now_iso)])
        upd(level_tier>ach['level_tier'], [(f'D{ach_row}', str(level_tier)), (f'E{ach_row}', now_iso)])
        upd(streak_tier>ach['streak_tier'], [(f'F{ach_row}', str(streak_tier)), (f'G{ach_row}', now_iso)])
        upd(invited_tier>ach.get('invited_tier',0), [(f'H{ach_row}', str(invited_tier)), (f'I{ach_row}', now_iso)])
        upd(betcount_tier>ach.get('betcount_tier',0), [(f'J{ach_row}', str(betcount_tier)), (f'K{ach_row}', now_iso)])
        upd(betwins_tier>ach.get('betwins_tier',0), [(f'L{ach_row}', str(betwins_tier)), (f'M{ach_row}', now_iso)])
        upd(bigodds_tier>ach.get('bigodds_tier',0), [(f'N{ach_row}', str(bigodds_tier)), (f'O{ach_row}', now_iso)])
        upd(markets_tier>ach.get('markets_tier',0), [(f'P{ach_row}', str(markets_tier)), (f'Q{ach_row}', now_iso)])
        upd(weeks_tier>ach.get('weeks_tier',0), [(f'R{ach_row}', str(weeks_tier)), (f'S{ach_row}', now_iso)])
        if updates: get_achievements_sheet().batch_update(updates)

        achievements=[]
        def add(group, tier, name_map, value, targets, icon_map, unlocked):
            if unlocked:
                achievements.append({'group':group,'tier':tier,'name':name_map[tier],'value':value,'target':{1:targets[0],2:targets[1],3:targets[2]}[tier],'next_target':_next_target_by_value(value, targets),'all_targets':targets,'icon':icon_map[tier],'unlocked':True})
            else:
                achievements.append({'group':group,'tier':1,'name':list(name_map.values())[0],'value':value,'target':targets[0],'next_target':_next_target_by_value(value, targets),'all_targets':targets,'icon':icon_map[1],'unlocked':False})
        add('streak', streak_tier, {1:'Бронза',2:'Серебро',3:'Золото'}, user['consecutive_days'], streak_targets, {1:'bronze',2:'silver',3:'gold'}, bool(streak_tier))
        add('credits', credits_tier, {1:'Бедолага',2:'Мажор',3:'Олигарх'}, user['credits'], credits_targets, {1:'bronze',2:'silver',3:'gold'}, bool(credits_tier))
        add('level', level_tier, {1:'Новобранец',2:'Ветеран',3:'Легенда'}, user['level'], level_targets, {1:'bronze',2:'silver',3:'gold'}, bool(level_tier))
        add('invited', invited_tier, {1:'Рекрутер',2:'Посол',3:'Легенда'}, invited_count, invited_targets, {1:'bronze',2:'silver',3:'gold'}, bool(invited_tier))
        add('betcount', betcount_tier, {1:'Новичок ставок',2:'Профи ставок',3:'Марафонец'}, bet_stats['total'], betcount_targets, {1:'bronze',2:'silver',3:'gold'}, bool(betcount_tier))
        add('betwins', betwins_tier, {1:'Счастливчик',2:'Снайпер',3:'Чемпион'}, bet_stats['won'], betwins_targets, {1:'bronze',2:'silver',3:'gold'}, bool(betwins_tier))
        add('bigodds', bigodds_tier, {1:'Рисковый',2:'Хайроллер',3:'Легенда кэфов'}, bet_stats['max_win_odds'], bigodds_targets, {1:'bronze',2:'silver',3:'gold'}, bool(bigodds_tier))
        add('markets', markets_tier, {1:'Универсал I',2:'Универсал II',3:'Универсал III'}, len(bet_stats['markets_used']), markets_targets, {1:'bronze',2:'silver',3:'gold'}, bool(markets_tier))
        add('weeks', weeks_tier, {1:'Регуляр',2:'Постоянный',3:'Железный'}, len(bet_stats['weeks_active']), weeks_targets, {1:'bronze',2:'silver',3:'gold'}, bool(weeks_tier))
        resp={'achievements':achievements}; ACHIEVEMENTS_CACHE[cache_key]={'ts':now_ts,'data':resp}; return jsonify(resp)
    except Exception as e:
        app.logger.error(f"Ошибка получения достижений: {e}")
        return jsonify({'error':'Внутренняя ошибка сервера'}),500

        # Кредиты: 10k/50k/500k
        if credits_tier:
            achievements.append({ 'group': 'credits', 'tier': credits_tier, 'name': {1:'Бедолага',2:'Мажор',3:'Олигарх'}[credits_tier], 'value': user['credits'], 'target': {1:10000,2:50000,3:500000}[credits_tier], 'next_target': _next_target_by_value(user['credits'], credits_targets), 'all_targets': credits_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[credits_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'credits', 'tier': 1, 'name': 'Бедолага', 'value': user['credits'], 'target': 10000, 'next_target': _next_target_by_value(user['credits'], credits_targets), 'all_targets': credits_targets, 'icon': 'bronze', 'unlocked': False })

        # Уровень: 25/50/100
        if level_tier:
            achievements.append({ 'group': 'level', 'tier': level_tier, 'name': {1:'Новобранец',2:'Ветеран',3:'Легенда'}[level_tier], 'value': user['level'], 'target': {1:25,2:50,3:100}[level_tier], 'next_target': _next_target_by_value(user['level'], level_targets), 'all_targets': level_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[level_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'level', 'tier': 1, 'name': 'Новобранец', 'value': user['level'], 'target': 25, 'next_target': _next_target_by_value(user['level'], level_targets), 'all_targets': level_targets, 'icon': 'bronze', 'unlocked': False })

        # Приглашённые: 10/50/150
        if invited_tier:
            achievements.append({ 'group': 'invited', 'tier': invited_tier, 'name': {1:'Рекрутер',2:'Посол',3:'Легенда'}[invited_tier], 'value': invited_count, 'target': {1:10,2:50,3:150}[invited_tier], 'next_target': _next_target_by_value(invited_count, invited_targets), 'all_targets': invited_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[invited_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'invited', 'tier': 1, 'name': 'Рекрутер', 'value': invited_count, 'target': 10, 'next_target': _next_target_by_value(invited_count, invited_targets), 'all_targets': invited_targets, 'icon': 'bronze', 'unlocked': False })

        # Количество ставок: 10/50/200
        if betcount_tier:
            achievements.append({ 'group': 'betcount', 'tier': betcount_tier, 'name': {1:'Новичок ставок',2:'Профи ставок',3:'Марафонец'}[betcount_tier], 'value': bet_stats['total'], 'target': {1:10,2:50,3:200}[betcount_tier], 'next_target': _next_target_by_value(bet_stats['total'], betcount_targets), 'all_targets': betcount_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[betcount_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'betcount', 'tier': 1, 'name': 'Новичок ставок', 'value': bet_stats['total'], 'target': 10, 'next_target': _next_target_by_value(bet_stats['total'], betcount_targets), 'all_targets': betcount_targets, 'icon': 'bronze', 'unlocked': False })

        # Победы в ставках: 5/20/75
        if betwins_tier:
            achievements.append({ 'group': 'betwins', 'tier': betwins_tier, 'name': {1:'Счастливчик',2:'Снайпер',3:'Чемпион'}[betwins_tier], 'value': bet_stats['won'], 'target': {1:5,2:20,3:75}[betwins_tier], 'next_target': _next_target_by_value(bet_stats['won'], betwins_targets), 'all_targets': betwins_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[betwins_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'betwins', 'tier': 1, 'name': 'Счастливчик', 'value': bet_stats['won'], 'target': 5, 'next_target': _next_target_by_value(bet_stats['won'], betwins_targets), 'all_targets': betwins_targets, 'icon': 'bronze', 'unlocked': False })

        # Крупный коэффициент: 3.0/4.5/6.0
        if bigodds_tier:
            achievements.append({ 'group': 'bigodds', 'tier': bigodds_tier, 'name': {1:'Рисковый',2:'Хайроллер',3:'Легенда кэфов'}[bigodds_tier], 'value': bet_stats['max_win_odds'], 'target': {1:3.0,2:4.5,3:6.0}[bigodds_tier], 'next_target': _next_target_by_value(bet_stats['max_win_odds'], bigodds_targets), 'all_targets': bigodds_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[bigodds_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'bigodds', 'tier': 1, 'name': 'Рисковый', 'value': bet_stats['max_win_odds'], 'target': 3.0, 'next_target': _next_target_by_value(bet_stats['max_win_odds'], bigodds_targets), 'all_targets': bigodds_targets, 'icon': 'bronze', 'unlocked': False })

        # Разнообразие рынков: 2/3/4
        if markets_tier:
            achievements.append({ 'group': 'markets', 'tier': markets_tier, 'name': {1:'Универсал I',2:'Универсал II',3:'Универсал III'}[markets_tier], 'value': len(bet_stats['markets_used']), 'target': {1:2,2:3,3:4}[markets_tier], 'next_target': _next_target_by_value(len(bet_stats['markets_used']), markets_targets), 'all_targets': markets_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[markets_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'markets', 'tier': 1, 'name': 'Универсал I', 'value': len(bet_stats['markets_used']), 'target': 2, 'next_target': _next_target_by_value(len(bet_stats['markets_used']), markets_targets), 'all_targets': markets_targets, 'icon': 'bronze', 'unlocked': False })

        # Регулярность по неделям: 2/5/10
        if weeks_tier:
            achievements.append({ 'group': 'weeks', 'tier': weeks_tier, 'name': {1:'Регуляр',2:'Постоянный',3:'Железный'}[weeks_tier], 'value': len(bet_stats['weeks_active']), 'target': {1:2,2:5,3:10}[weeks_tier], 'next_target': _next_target_by_value(len(bet_stats['weeks_active']), weeks_targets), 'all_targets': weeks_targets, 'icon': {1:'bronze',2:'silver',3:'gold'}[weeks_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'weeks', 'tier': 1, 'name': 'Регуляр', 'value': len(bet_stats['weeks_active']), 'target': 2, 'next_target': _next_target_by_value(len(bet_stats['weeks_active']), weeks_targets), 'all_targets': weeks_targets, 'icon': 'bronze', 'unlocked': False })
        resp = {'achievements': achievements}
        ACHIEVEMENTS_CACHE[cache_key] = { 'ts': now_ts, 'data': resp }
        return jsonify(resp)

    except Exception as e:
        app.logger.error(f"Ошибка получения достижений: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/health')
def health():
    """Healthcheck для Render.com"""
    return jsonify(status="healthy"), 200

@app.route('/health/sync')
def health_sync():
    """Показывает статус фонового синка и квоты Sheets (метрики)."""
    try:
        with METRICS_LOCK:
            data = {
                'status': 'ok',
                'bg_runs_total': METRICS.get('bg_runs_total', 0),
                'bg_runs_errors': METRICS.get('bg_runs_errors', 0),
                'last_sync': METRICS.get('last_sync', {}),
                'last_sync_status': METRICS.get('last_sync_status', {}),
                'last_sync_duration_ms': METRICS.get('last_sync_duration_ms', {}),
                'sheet_reads': METRICS.get('sheet_reads', 0),
                'sheet_writes': METRICS.get('sheet_writes', 0),
                'sheet_rate_limit_hits': METRICS.get('sheet_rate_limit_hits', 0),
                'sheet_last_error': METRICS.get('sheet_last_error', '')
            }
        return jsonify(data), 200
    except Exception as e:
        return jsonify({'status': 'error', 'error': str(e)}), 500

# Telegram webhook handler with proper validation and logging.
# ВАЖНО: ранее использовался маршрут '/<path:maybe_token>' который перехватывал ВСЕ многоуровневые POST пути
# (например '/api/admin/matches/upcoming'), из-за чего реальные API возвращали 404 и логировались как Invalid webhook path.
# Теперь ограничиваем webhook на префикс '/telegram/<maybe_token>' чтобы исключить конфликт.
@app.route('/telegram/<maybe_token>', methods=['POST'])
def telegram_webhook_handler(maybe_token: str):
    """
    Обработчик Telegram webhook с валидацией токена и логированием
    Если токен корректный - обрабатываем webhook, иначе возвращаем 404
    """
    try:
        # Проверяем формат токена Telegram (должен содержать ':' и быть достаточно длинным)
        if ':' in maybe_token and len(maybe_token) >= 40:
            app.logger.info(f"Received Telegram webhook for token: {maybe_token[:10]}...")
            webhook_data = request.get_json(silent=True)
            if webhook_data:
                return jsonify({'ok': True, 'status': 'webhook_received'}), 200
            app.logger.warning("Webhook received but no JSON data found")
            return jsonify({'error': 'no data'}), 400
        # Некорректный токен по нашему шаблону
        app.logger.warning(f"Invalid telegram webhook token accessed: {maybe_token}")
        return jsonify({'error': 'not found'}), 404
    except Exception as e:
        app.logger.error(f"Telegram webhook handler error: {e}")
        return jsonify({'error': 'internal error'}), 500

# Простой ping endpoint для keepalive
@app.route('/ping')
def ping():
    return jsonify({'pong': True, 'ts': datetime.now(timezone.utc).isoformat()}), 200

# -------- Public profiles (batch) for prizes overlay --------
@app.route('/api/users/public-batch', methods=['POST'])
def api_users_public_batch():
    """Возвращает публичные поля профиля пачкой.
    Вход (JSON): { user_ids: [int, ...] }
    Выход: { items: [{ user_id, display_name, level, xp, consecutive_days, photo_url }] }
    """
    try:
        # Лёгкий rate-limit на IP/UA, чтобы не спамили
        limited = _rate_limit('pub_batch', limit=10, window_sec=30, allow_pseudo=True)
        if limited is not None:
            return limited
        if not request.is_json:
            return jsonify({'items': []})
        body = request.get_json(silent=True) or {}
        raw_ids = body.get('user_ids') or []
        if not isinstance(raw_ids, list):
            return jsonify({'items': []})
        # Нормализуем список ID и ограничим размер
        ids = []
        for x in raw_ids[:100]:
            try:
                ids.append(int(x))
            except Exception:
                continue
        ids = list({i for i in ids if i > 0})[:100]
        if not ids or SessionLocal is None:
            return jsonify({'items': []})
        db: Session = get_db()
        try:
            users = db.query(User).filter(User.user_id.in_(ids)).all()
            # фото — отдельной пачкой
            photos = {}
            for r in db.query(UserPhoto).filter(UserPhoto.user_id.in_(ids)).all():
                if r.photo_url:
                    photos[int(r.user_id)] = r.photo_url
            out = []
            for u in users:
                out.append({
                    'user_id': int(u.user_id),
                    'display_name': u.display_name or 'Игрок',
                    'level': int(u.level or 1),
                    'xp': int(u.xp or 0),
                    'consecutive_days': int(u.consecutive_days or 0),
                    'photo_url': photos.get(int(u.user_id), '')
                })
            return jsonify({'items': out})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"public-batch error: {e}")
        return jsonify({'items': []}), 200

@app.route('/api/league-table', methods=['GET'])
def api_league_table():
    """Возвращает таблицу лиги из снапшота БД; при отсутствии — bootstrap из Sheets. ETag/304 поддерживаются."""
    try:
        # 1) Пытаемся отдать снапшот
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                snap = _snapshot_get(db, 'league-table')
                if snap and snap.get('payload'):
                    payload = snap['payload']
                    _core = {'range': payload.get('range'), 'values': payload.get('values')}
                    _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                    inm = request.headers.get('If-None-Match')
                    if inm and inm == _etag:
                        resp = app.response_class(status=304)
                        resp.headers['ETag'] = _etag
                        resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
                        return resp
                    resp = jsonify({**payload, 'version': _etag})
                    resp.headers['ETag'] = _etag
                    resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
                    return resp
            finally:
                db.close()
        # 2) Bootstrap из Sheets, если снапшот отсутствует
        payload = _build_league_payload_from_sheet()
        _core = {'range': 'A1:H10', 'values': payload.get('values')}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        # сохраним снапшот для будущих запросов
        if SessionLocal is not None:
            db = get_db()
            try:
                _snapshot_set(db, 'league-table', payload)
            finally:
                db.close()
        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы лиги: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить таблицу'}), 500

@app.route('/api/schedule', methods=['GET'])
def api_schedule():
    """Возвращает ближайшие 3 тура из снапшота БД; при отсутствии — bootstrap из Sheets. ETag/304 поддерживаются."""
    try:
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                snap = _snapshot_get(db, 'schedule')
                if snap and snap.get('payload'):
                    payload = snap['payload']
                    # Если снапшот пустой (нет туров) — форсируем перестройку из Sheets
                    tours_in_snap = (payload.get('tours') or []) if isinstance(payload, dict) else []
                    total_matches = 0
                    try:
                        total_matches = sum(len(t.get('matches') or []) for t in tours_in_snap)
                    except Exception:
                        total_matches = 0
                    if (not tours_in_snap) or total_matches == 0:
                        try:
                            payload = _build_schedule_payload_from_sheet()
                            _snapshot_set(db, 'schedule', payload)
                        except Exception:
                            pass
                    else:
                        _core = {'tours': payload.get('tours')}
                        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                        inm = request.headers.get('If-None-Match')
                        if inm and inm == _etag:
                            resp = app.response_class(status=304)
                            resp.headers['ETag'] = _etag
                            resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
                            return resp
                    # «Матч недели»: сначала пытаемся взять ручной выбор админа из снапшота 'feature-match'
                    try:
                        manual = None
                        if SessionLocal is not None:
                            db2 = get_db()
                            try:
                                fm = _snapshot_get(db2, 'feature-match') or {}
                                manual = (fm.get('payload') or {}).get('match') or None
                            finally:
                                db2.close()
                        # если есть ручной выбор — проверим, не завершился ли матч
                        use_manual = False
                        if manual and isinstance(manual, dict):
                            mh, ma = manual.get('home'), manual.get('away')
                            if mh and ma:
                                st = api_match_status_get.__wrapped__ if hasattr(api_match_status_get, '__wrapped__') else None
                                # безопасная проверка статуса без HTTP-ответа: используем внутреннюю функцию времени матча
                                try:
                                    status = 'scheduled'
                                    dt = _get_match_datetime(mh, ma)
                                    now = datetime.now()
                                    if dt:
                                        if dt <= now < dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                            status = 'live'
                                        elif now >= dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                            status = 'finished'
                                    # показываем manual, если не finished
                                    if status != 'finished':
                                        use_manual = True
                                except Exception:
                                    use_manual = True
                        if use_manual:
                            payload = dict(payload)
                            payload['match_of_week'] = manual
                        else:
                            # fallback: автоподбор по ближайшему туру ставок
                            if SessionLocal is not None:
                                db3 = get_db()
                                try:
                                    bt = _snapshot_get(db3, 'betting-tours')
                                    tours_src = (bt or {}).get('payload', {}).get('tours') or payload.get('tours') or []
                                finally:
                                    db3.close()
                            else:
                                tours_src = payload.get('tours') or []
                            best = _pick_match_of_week(tours_src)
                            if best:
                                payload = dict(payload)
                                payload['match_of_week'] = best
                    except Exception:
                        pass
                    # Пересчитаем ETag для (возможно) обновлённого payload
                    _core2 = {'tours': payload.get('tours')}
                    _etag2 = hashlib.md5(json.dumps(_core2, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                    resp = jsonify({**payload, 'version': _etag2})
                    resp.headers['ETag'] = _etag2
                    resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
                    return resp
            finally:
                db.close()
        # Bootstrap
        payload = _build_schedule_payload_from_sheet()
        try:
            # При первом построении тоже используем ручной выбор, если есть и матч не завершён
            manual = None
            if SessionLocal is not None:
                db2 = get_db()
                try:
                    fm = _snapshot_get(db2, 'feature-match') or {}
                    manual = (fm.get('payload') or {}).get('match') or None
                finally:
                    db2.close()
            use_manual = False
            if manual and isinstance(manual, dict):
                mh, ma = manual.get('home'), manual.get('away')
                if mh and ma:
                    try:
                        status = 'scheduled'
                        dt = _get_match_datetime(mh, ma)
                        now = datetime.now()
                        if dt:
                            if dt <= now < dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                status = 'live'
                            elif now >= dt + timedelta(minutes=BET_MATCH_DURATION_MINUTES):
                                status = 'finished'
                        if status != 'finished':
                            use_manual = True
                    except Exception:
                        use_manual = True
            if use_manual:
                payload = dict(payload)
                payload['match_of_week'] = manual
            else:
                # автоподбор
                tours_src = payload.get('tours') or []
                if SessionLocal is not None:
                    db3 = get_db()
                    try:
                        bt = _snapshot_get(db3, 'betting-tours')
                        tours_src = (bt or {}).get('payload', {}).get('tours') or tours_src
                    finally:
                        db3.close()
                best = _pick_match_of_week(tours_src)
                if best:
                    payload = dict(payload)
                    payload['match_of_week'] = best
        except Exception:
            pass
        _core = {'tours': payload.get('tours')}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if SessionLocal is not None:
            db = get_db()
            try:
                _snapshot_set(db, 'schedule', payload)
            finally:
                db.close()
        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки расписания: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить расписание'}), 500

@app.route('/api/vote/match', methods=['POST'])
def api_vote_match():
    """Сохранить голос пользователя за исход матча (home/draw/away). Требует initData Telegram.
    Поля: initData, home, away, date (YYYY-MM-DD), choice in ['home','draw','away']
    """
    try:
        # Rate limit: 10 голосов за 60 секунд на идентичность (учёт псевдо-ID если разрешено)
        limited = _rate_limit('vote_match', limit=10, window_sec=60, allow_pseudo=True)
        if limited is not None:
            return limited
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        uid = None
        if parsed and parsed.get('user'):
            uid = int(parsed['user'].get('id'))
        else:
            # Разрешим голосование без Telegram, если включено явно
            if os.environ.get('ALLOW_VOTE_WITHOUT_TELEGRAM', '0') in ('1','true','True'):
                uid = _pseudo_user_id()
            else:
                return jsonify({'error': 'Недействительные данные'}), 401
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        date_key = (request.form.get('date') or '').strip()[:10]
        choice = (request.form.get('choice') or '').strip().lower()
        if choice not in ('home','draw','away'):
            return jsonify({'error': 'Неверный выбор'}), 400
        if not home or not away or not date_key:
            return jsonify({'error': 'Не указан матч'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db = get_db()
        try:
            # upsert по уникальному индексу
            existing = db.query(MatchVote).filter(
                MatchVote.home==home, MatchVote.away==away, MatchVote.date_key==date_key, MatchVote.user_id==uid
            ).first()
            if existing:
                # Запрещаем менять голос: просто сообщаем, что уже голосовал
                return jsonify({'status': 'exists', 'choice': existing.choice}), 200
            try:
                db.add(MatchVote(home=home, away=away, date_key=date_key, user_id=uid, choice=choice))
                db.commit()
                return jsonify({'status': 'ok'})
            except IntegrityError:
                db.rollback()
                # Дубликат по уникальному индексу — считаем, что уже голосовал
                return jsonify({'status': 'exists'}), 200
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"vote save error: {e}")
        return jsonify({'error': 'Не удалось сохранить голос'}), 500

@app.route('/api/vote/match-aggregates', methods=['GET'])
def api_vote_match_aggregates():
    """Вернёт агрегаты голосов по матчу: counts {home,draw,away}.
    Параметры: home, away, date (YYYY-MM-DD)
    """
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        date_key = (request.args.get('date') or '').strip()[:10]
        if not home or not away or not date_key:
            return jsonify({'error': 'Не указан матч'}), 400
        # Опционально узнаем мой голос
        my_choice = None
        parsed = None
        # Разбираем Telegram initData (опционально)
        try:
            init_data = request.args.get('initData', '')
            if init_data:
                parsed = parse_and_verify_telegram_init_data(init_data)
        except Exception:
            parsed = None
        if SessionLocal is None:
            # Без БД отдадим нули и без персонализации
            resp = {'home':0,'draw':0,'away':0}
            if parsed and parsed.get('user'):
                resp['my_choice'] = None
            return jsonify(resp)
        db = get_db()
        try:
            rows = db.query(MatchVote.choice, func.count(MatchVote.id)).filter(
                MatchVote.home==home, MatchVote.away==away, MatchVote.date_key==date_key
            ).group_by(MatchVote.choice).all()
            agg = {'home':0,'draw':0,'away':0}
            for c, cnt in rows:
                k = str(c).lower()
                if k in agg: agg[k] = int(cnt)
            # Мой голос: если есть initData или разрешён псевдо-ID
            try:
                uid = None
                if parsed and parsed.get('user'):
                    uid = int(parsed['user'].get('id'))
                elif os.environ.get('ALLOW_VOTE_WITHOUT_TELEGRAM', '0') in ('1','true','True'):
                    uid = _pseudo_user_id()
                if uid is not None:
                    mine = db.query(MatchVote).filter(
                        MatchVote.home==home, MatchVote.away==away, MatchVote.date_key==date_key, MatchVote.user_id==uid
                    ).first()
                    if mine:
                        my_choice = str(mine.choice)
            except Exception:
                pass
            if my_choice is not None:
                agg['my_choice'] = my_choice
            return jsonify(agg)
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"vote agg error: {e}")
        return jsonify({'error': 'Не удалось получить голоса'}), 500

@app.route('/api/vote/aggregates/batch', methods=['POST'])
def api_vote_aggregates_batch():
    """Батч-эндпоинт: на вход JSON { matches: [{home, away, date}], initData?: string }
    Возвращает { items: { key -> {home,draw,away, my_choice?} } }, где key = lower(home)+'__'+lower(away)+'__'+YYYY-MM-DD.
    """
    try:
        payload = request.get_json(silent=True) or {}
        matches = payload.get('matches') or []
        init_data = payload.get('initData') or ''
        # Разберём initData (опционально)
        parsed = None
        try:
            if init_data:
                parsed = parse_and_verify_telegram_init_data(init_data)
        except Exception:
            parsed = None
        my_uid = None
        if parsed and parsed.get('user'):
            try: my_uid = int(parsed['user'].get('id'))
            except Exception: my_uid = None
        elif os.environ.get('ALLOW_VOTE_WITHOUT_TELEGRAM', '0') in ('1','true','True'):
            my_uid = _pseudo_user_id()

        def norm(s: str) -> str:
            try:
                return ''.join(ch for ch in (s or '').strip().lower().replace('ё','е') if ch.isalnum())
            except Exception:
                return ''

        def key_of(home: str, away: str, date_key: str) -> str:
            return f"{norm(home)}__{norm(away)}__{(date_key or '')[:10]}"

        # Подготовим набор уникальных ключей
        req = []
        seen = set()
        for m in matches:
            h = (m.get('home') or '').strip()
            a = (m.get('away') or '').strip()
            d = (m.get('date') or m.get('datetime') or '').strip()[:10]
            if not h or not a or not d:
                continue
            k = key_of(h, a, d)
            if k in seen:
                continue
            seen.add(k)
            req.append((k, h, a, d))

        items = {}
        if not req or SessionLocal is None:
            return jsonify({ 'items': items })

        db = get_db()
        try:
            # По каждому запросу выполним агрегат и (опц.) мой голос
            for k, h, a, d in req:
                rows = db.query(MatchVote.choice, func.count(MatchVote.id)).filter(
                    MatchVote.home==h, MatchVote.away==a, MatchVote.date_key==d
                ).group_by(MatchVote.choice).all()
                agg = {'home':0,'draw':0,'away':0}
                for c, cnt in rows:
                    kk = str(c).lower()
                    if kk in agg: agg[kk] = int(cnt)
                # мой голос
                if my_uid is not None:
                    mine = db.query(MatchVote).filter(
                        MatchVote.home==h, MatchVote.away==a, MatchVote.date_key==d, MatchVote.user_id==my_uid
                    ).first()
                    if mine:
                        agg['my_choice'] = str(mine.choice)
                items[k] = agg
            return jsonify({ 'items': items })
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"vote batch error: {e}")
        return jsonify({'error': 'Не удалось получить агрегаты'}), 500

def _load_all_tours_from_sheet():
    """Читает лист расписания и возвращает список всех туров с матчами.
    Формат тура: { tour:int, title:str, start_at:iso, matches:[{home,away,date,time,datetime,score_home,score_away}] }
    """
    ws = get_schedule_sheet()
    _metrics_inc('sheet_reads', 1)
    try:
        rows = ws.get_all_values() or []
    except Exception as e:
        _metrics_note_rate_limit(e)
        raise

    def parse_date(d: str):
        d = (d or '').strip()
        if not d:
            return None
        for fmt in ("%d.%m.%y", "%d.%m.%Y"):
            try:
                return datetime.strptime(d, fmt).date()
            except Exception:
                continue
        return None

    def parse_time(t: str):
        t = (t or '').strip()
        try:
            return datetime.strptime(t, "%H:%M").time()
        except Exception:
            return None

    tours = []
    current_tour = None
    current_title = None
    current_matches = []

    def close_current():
        nonlocal current_tour, current_title, current_matches
        if current_tour is not None and current_matches:
            start_dts = []
            for m in current_matches:
                ds = m.get('datetime')
                if ds:
                    try:
                        start_dts.append(datetime.fromisoformat(ds))
                    except Exception:
                        pass
                elif m.get('date'):
                    try:
                        dd = datetime.fromisoformat(m['date']).date()
                        tt = parse_time(m.get('time','00:00') or '00:00') or datetime.min.time()
                        start_dts.append(datetime.combine(dd, tt))
                    except Exception:
                        pass
            start_at = start_dts and min(start_dts).isoformat() or ''
            tours.append({'tour': current_tour, 'title': current_title, 'start_at': start_at, 'matches': current_matches})
        current_tour = None
        current_title = None
        current_matches = []

    for r in rows:
        a = (r[0] if len(r) > 0 else '').strip()
        header_num = None
        if a:
            parts = a.replace('\u00A0', ' ').strip().split()
            if len(parts) >= 2 and parts[0].isdigit() and parts[1].lower().startswith('тур'):
                header_num = int(parts[0])
        if header_num is not None:
            # закрыть предыдущий
            close_current()
            current_tour = header_num
            current_title = a
            current_matches = []
            continue

        if current_tour is not None:
            home = (r[0] if len(r) > 0 else '').strip()
            score_home = (r[1] if len(r) > 1 else '').strip()
            score_away = (r[3] if len(r) > 3 else '').strip()
            away = (r[4] if len(r) > 4 else '').strip()
            date_str = (r[5] if len(r) > 5 else '').strip()
            time_str = (r[6] if len(r) > 6 else '').strip()
            if not home and not away:
                continue
            d = parse_date(date_str)
            tm = parse_time(time_str)
            dt = None
            if d:
                try:
                    dt = datetime.combine(d, tm or datetime.min.time())
                except Exception:
                    dt = None
            current_matches.append({
                'home': home,
                'away': away,
                'score_home': score_home,
                'score_away': score_away,
                'date': (d.isoformat() if d else ''),
                'time': time_str,
                'datetime': (dt.isoformat() if dt else '')
            })

    # закрыть последний
    close_current()
    return tours

@app.route('/api/betting/tours', methods=['GET'])
def api_betting_tours():
    """Возвращает ближайший тур для ставок, из снапшота БД; при отсутствии — собирает on-demand.
    Для матчей в прошлом блокируем ставки (поле lock: true). Поддерживает ETag/304."""
    try:
        # авто-расчёт открытых ставок (раз в 5 минут)
        global _LAST_SETTLE_TS
        now_ts = int(time.time())
        if now_ts - _LAST_SETTLE_TS > 300:
            try:
                _settle_open_bets()
            except Exception as e:
                app.logger.warning(f"Авторасчёт ставок: {e}")
            _LAST_SETTLE_TS = now_ts

        # 1) Отдать снапшот, если есть
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                snap = _snapshot_get(db, 'betting-tours')
                if snap and snap.get('payload'):
                    payload = snap['payload']
                    _core = {'tours': payload.get('tours')}
                    etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                    inm = request.headers.get('If-None-Match')
                    if inm and inm == etag:
                        resp = app.response_class(status=304)
                        resp.headers['ETag'] = etag
                        resp.headers['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=300'
                        return resp
                    resp = jsonify({ **payload, 'version': etag })
                    resp.headers['ETag'] = etag
                    resp.headers['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=300'
                    return resp
            finally:
                db.close()

        # 2) On-demand сборка и запись снапшота
        payload = _build_betting_tours_payload()
        _core = {'tours': payload.get('tours')}
        etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if SessionLocal is not None:
            db = get_db()
            try:
                _snapshot_set(db, 'betting-tours', payload)
            finally:
                db.close()
        resp = jsonify({ **payload, 'version': etag })
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'public, max-age=300, stale-while-revalidate=300'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка betting tours: {e}")
        return jsonify({'error': 'Не удалось загрузить туры для ставок'}), 500

 

@app.route('/api/betting/my-bets', methods=['POST'])
@require_telegram_auth()
@rate_limit(max_requests=30, time_window=60)  # 30 запросов за минуту для просмотра ставок
def api_betting_my_bets():
    """Список ставок пользователя (последние 50)."""
    import flask
    try:
        # Декоратор require_telegram_auth уже сохранил auth_data в flask.g
        if hasattr(flask.g, 'auth_data') and flask.g.auth_data.get('user'):
            user_id = int(flask.g.auth_data['user'].get('id'))
        else:
            # Fallback: попытка извлечения initData (на случай если маршрут вызван без декоратора в будущем)
            init_data = (request.form.get('initData') or request.form.get('init_data') or
                         (request.get_json(silent=True) or {}).get('initData') if request.is_json else None or
                         request.args.get('initData') or request.headers.get('X-Telegram-Init-Data') or '')
            parsed = parse_and_verify_telegram_init_data(init_data or '')
            if not parsed or not parsed.get('user'):
                return jsonify({'error': 'Недействительные данные'}), 401
            user_id = int(parsed['user'].get('id'))
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            rows = db.query(Bet).filter(Bet.user_id == user_id).order_by(Bet.placed_at.desc()).limit(50).all()
            data = []
            # Соберём карту текущих дат матчей из снапшота betting-tours (фоллбэк к листу)
            match_dt_map = {}
            try:
                snap = _snapshot_get(db, 'betting-tours')
                payload = snap and snap.get('payload')
                tours_src = payload and payload.get('tours') or []
            except Exception:
                tours_src = []
            if not tours_src:
                try:
                    tours_src = _load_all_tours_from_sheet() or []
                except Exception:
                    tours_src = []
            for t in (tours_src or []):
                tour_key = str(t.get('tour') or '')
                for m in (t.get('matches') or []):
                    try:
                        h = (m.get('home') or '').strip().lower()
                        a = (m.get('away') or '').strip().lower()
                        dt = m.get('datetime')
                        if not dt and m.get('date'):
                            try:
                                if m.get('time'):
                                    dd = datetime.fromisoformat(m['date']).date()
                                    tm = datetime.strptime(m.get('time') or '00:00', '%H:%M').time()
                                    dt = datetime.combine(dd, tm).isoformat()
                                else:
                                    dt = datetime.fromisoformat(m['date']).date().isoformat()
                            except Exception:
                                dt = None
                        if h and a and dt:
                            match_dt_map[(h, a, tour_key)] = dt
                            # также сохраняем без тура для простого поиска
                            match_dt_map[(h, a, '')] = dt
                    except Exception:
                        continue

            def _decode_totals(sel_val: str):
                if not sel_val:
                    return None, None
                # Возможные форматы: over_3.5 / under_4.5 или O35 / U45
                if '_' in sel_val:
                    try:
                        side, line_str = sel_val.split('_', 1)
                        return side, line_str
                    except Exception:
                        return None, None
                if sel_val[0] in ('O','U') and sel_val[1:].isdigit():
                    mapping = {'35': '3.5', '45': '4.5', '55': '5.5'}
                    return ('over' if sel_val[0]=='O' else 'under'), mapping.get(sel_val[1:], sel_val[1:])
                return None, None

            def _present(market, selection, home=None, away=None):
                # Для рынка 1x2 показываем более читабельный формат:
                # - для 'home'/'away' -> market: 'Победа', selection: название команды
                # - для 'draw' -> market и selection: 'Ничья'
                if market == '1x2':
                    if selection == 'draw':
                        return 'Ничья', 'Ничья'
                    if selection == 'home':
                        return 'Победа', home or 'П1'
                    if selection == 'away':
                        return 'Победа', away or 'П2'
                    # fallback
                    return 'Победа/Ничья', {'home':'П1','draw':'Х','away':'П2'}.get(selection, selection)

                market_display = {
                    'totals': 'Тотал',
                    'penalty': 'Пенальти',
                    'redcard': 'Красная карточка'
                }.get(market, market)
                selection_display = selection
                if market == 'totals':
                    side, line = _decode_totals(selection)
                    if side and line:
                        selection_display = f"Больше {line}" if side=='over' else f"Меньше {line}"
                elif market in ('penalty','redcard'):
                    selection_display = {'yes':'Да','no':'Нет'}.get(selection, selection)
                return market_display, selection_display

            for b in rows:
                mdisp, sdisp = _present(b.market, b.selection, b.home, b.away)
                # попытка взять актуальную дату матча из карты
                try:
                    key_t = str(b.tour or '')
                    k1 = ((b.home or '').strip().lower(), (b.away or '').strip().lower(), key_t)
                    k2 = ((b.home or '').strip().lower(), (b.away or '').strip().lower(), '')
                    cur_dt = match_dt_map.get(k1) or match_dt_map.get(k2)
                except Exception:
                    cur_dt = None
                dt_out = cur_dt or (b.match_datetime.isoformat() if b.match_datetime else '')
                data.append({
                    'id': b.id,
                    'tour': b.tour,
                    'home': b.home,
                    'away': b.away,
                    'datetime': dt_out,
                    'market': b.market,
                    'market_display': mdisp,
                    'selection': b.selection,  # сырое значение (для обратной совместимости)
                    'selection_display': sdisp,
                    'odds': b.odds,
                    'stake': b.stake,
                    'status': b.status,
                    'payout': b.payout,
                    'winnings': (b.payout - b.stake if b.payout and b.stake and b.status == 'won' else None),
                    'placed_at': (b.placed_at.isoformat() if b.placed_at else '')
                })
            return jsonify({ 'bets': data })
        except Exception as _e:
            app.logger.error(f"DB error (place bet): {_e}")
            raise
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка списка ставок: {e}")
        return jsonify({'error': 'Не удалось загрузить ставки'}), 500

# ---------- Авторасчёт исходов ставок ----------
from sqlalchemy import func

def _parse_score(val: str):
    try:
        return int(str(val).strip())
    except Exception:
        return None

def _winner_from_scores(sh: str, sa: str):
    h = _parse_score(sh)
    a = _parse_score(sa)
    if h is None or a is None:
        return None
    if h > a:
        return 'home'
    if h < a:
        return 'away'
    return 'draw'

def _get_match_result(home: str, away: str):
    """Возвращает 'home'|'draw'|'away' если найден счёт.
    Приоритет: снапшот 'results' из БД, затем fallback к листу.
    """
    # 1) Snapshot 'results'
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'results')
            payload = snap and snap.get('payload')
            results = payload and payload.get('results') or []
            for m in results:
                if m.get('home') == home and m.get('away') == away:
                    return _winner_from_scores(m.get('score_home',''), m.get('score_away',''))
        finally:
            db.close()
    # 2) Fallback: read from sheet (rare)
    tours = _load_all_tours_from_sheet()
    for t in tours:
        for m in t.get('matches', []):
            if (m.get('home') == home and m.get('away') == away):
                return _winner_from_scores(m.get('score_home',''), m.get('score_away',''))
    return None

def _get_match_total_goals(home: str, away: str):
    # 1) Snapshot 'results'
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'results')
            payload = snap and snap.get('payload')
            results = payload and payload.get('results') or []
            for m in results:
                if m.get('home') == home and m.get('away') == away:
                    h = _parse_score(m.get('score_home',''))
                    a = _parse_score(m.get('score_away',''))
                    if h is None or a is None:
                        try:
                            app.logger.warning(f"_get_match_total_goals: Found match {home} vs {away} in results snapshot but invalid scores: {m.get('score_home','')} - {m.get('score_away','')}")
                        except: pass
                        return None
                    total = h + a
                    try:
                        app.logger.info(f"_get_match_total_goals: Found {home} vs {away} in results snapshot: {h}+{a}={total}")
                    except: pass
                    return total
        finally:
            db.close()
    # 2) Fallback to sheet
    tours = _load_all_tours_from_sheet()
    for t in tours:
        for m in t.get('matches', []):
            if (m.get('home') == home and m.get('away') == away):
                h = _parse_score(m.get('score_home',''))
                a = _parse_score(m.get('score_away',''))
                if h is None or a is None:
                    try:
                        app.logger.warning(f"_get_match_total_goals: Found match {home} vs {away} in sheet but invalid scores: {m.get('score_home','')} - {m.get('score_away','')}")
                    except: pass
                    return None
                total = h + a
                try:
                    app.logger.info(f"_get_match_total_goals: Found {home} vs {away} in sheet: {h}+{a}={total}")
                except: pass
                return total
    try:
        app.logger.warning(f"_get_match_total_goals: No match found for {home} vs {away}")
    except: pass
    return None

@app.route('/api/match/score/get', methods=['GET'])
def api_match_score_get():
    """Текущий счёт матча из БД (live правки админа). Параметры: home, away."""
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'score_home': None, 'score_away': None})
        db: Session = get_db()
        try:
            row = db.query(MatchScore).filter(MatchScore.home==home, MatchScore.away==away).first()
            return jsonify({'score_home': (None if not row else row.score_home), 'score_away': (None if not row else row.score_away), 'updated_at': (row.updated_at.isoformat() if row else '')})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"match/score/get error: {e}")
        return jsonify({'score_home': None, 'score_away': None})

@app.route('/api/match/score/set', methods=['POST'])
def api_match_score_set():
    """Админ меняет текущий счёт (не влияет на ставки до завершения матча). Поля: initData, home, away, score_home, score_away."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        try:
            sh = int(request.form.get('score_home')) if request.form.get('score_home') not in (None, '') else None
        except Exception:
            sh = None
        try:
            sa = int(request.form.get('score_away')) if request.form.get('score_away') not in (None, '') else None
        except Exception:
            sa = None
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchScore).filter(MatchScore.home==home, MatchScore.away==away).first()
            if not row:
                row = MatchScore(home=home, away=away)
                db.add(row)
            row.score_home = sh
            row.score_away = sa
            row.updated_at = datetime.now(timezone.utc)
            db.commit()
            # Зеркалим счёт в Google Sheets (best-effort), как числовые значения
            try:
                if (row.score_home is not None) and (row.score_away is not None):
                    mirror_match_score_to_schedule(home, away, int(row.score_home), int(row.score_away))
            except Exception:
                pass
            
            # Публикуем обновление через систему автоподписок
            try:
                if 'subscription_manager' in app.config:
                    sub_manager = app.config['subscription_manager']
                    match_key = f"{home}_{away}"
                    sub_manager.publish(
                        SubscriptionType.MATCH_SCORE,
                        {
                            'home_team': home,
                            'away_team': away,
                            'home_score': row.score_home,
                            'away_score': row.score_away,
                            'updated_at': row.updated_at.isoformat()
                        },
                        match_key
                    )
                    # Также публикуем в legacy формате для совместимости
                    sub_manager.publish_legacy('match_score', {
                        'home': home,
                        'away': away,
                        'home_score': row.score_home,
                        'away_score': row.score_away,
                        'updated_at': row.updated_at.isoformat()
                    })
            except Exception as e:
                print(f"[WARN] Failed to publish match score update: {e}")
            
            return jsonify({'status': 'ok', 'score_home': row.score_home, 'score_away': row.score_away})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"match/score/set error: {e}")
        return jsonify({'error': 'Не удалось сохранить счёт'}), 500

def _get_special_result(home: str, away: str, market: str):
    """Возвращает True/False для исхода спецрынка, если зафиксирован, иначе None.
    market: 'penalty' | 'redcard'
    """
    if SessionLocal is None:
        return None
    db: Session = get_db()
    try:
        row = db.query(MatchSpecials).filter(MatchSpecials.home==home, MatchSpecials.away==away).first()
        if not row:
            return None
        if market == 'penalty':
            return (True if row.penalty_yes == 1 else (False if row.penalty_yes == 0 else None))
        if market == 'redcard':
            return (True if row.redcard_yes == 1 else (False if row.redcard_yes == 0 else None))
        return None
    finally:
        db.close()

def _get_match_datetime(home: str, away: str):
    """Вернуть datetime матча из снапшота туров или из листа (ISO в naive datetime)."""
    # 1) betting-tours snapshot
    if SessionLocal is not None:
        db = get_db()
        try:
            snap = _snapshot_get(db, 'betting-tours')
            payload = snap and snap.get('payload')
            tours = payload and payload.get('tours') or []
            for t in tours:
                for m in (t.get('matches') or []):
                    if m.get('home') == home and m.get('away') == away:
                        dt_str = m.get('datetime')
                        if dt_str:
                            try:
                                return datetime.fromisoformat(dt_str)
                            except Exception:
                                pass
        finally:
            db.close()
    # 2) fallback to sheet
    tours = _load_all_tours_from_sheet()
    for t in tours:
        for m in t.get('matches', []):
            if m.get('home') == home and m.get('away') == away:
                dt_str = m.get('datetime')
                if dt_str:
                    try:
                        return datetime.fromisoformat(dt_str)
                    except Exception:
                        pass
    return None

def _settle_open_bets():
    if SessionLocal is None:
        return
    db: Session = get_db()
    try:
        now = datetime.now()
        open_bets = db.query(Bet).filter(Bet.status=='open').all()
        changed = 0
        for b in open_bets:
            # матч должен быть уже начат/сыгран
            if b.match_datetime and b.match_datetime > now:
                continue
            if b.market == '1x2':
                res = _get_match_result(b.home, b.away)
                if not res:
                    continue
                won = (res == b.selection)
            elif b.market == 'totals':
                sel_raw = (b.selection or '').strip()
                side = None; line = None
                if '_' in sel_raw:  # старый формат over_3.5
                    parts = sel_raw.split('_', 1)
                    if len(parts)==2:
                        side, line_str = parts[0], parts[1]
                        try:
                            line = float(line_str)
                        except Exception:
                            line = None
                else:  # новый код O35 / U45 / O55
                    if len(sel_raw) in (3,4) and sel_raw[0] in ('O','U'):
                        side = 'over' if sel_raw[0]=='O' else 'under'
                        num_part = sel_raw[1:]
                        # ожидаем '35','45','55'
                        if num_part in ('35','45','55'):
                            try:
                                line = float(num_part[0]+'.5')  # '35' -> 3.5
                            except Exception:
                                line = None
                if side not in ('over','under') or line is None:
                    continue
                total = _get_match_total_goals(b.home, b.away)
                if total is None:
                    continue
                won = (total > line) if side == 'over' else (total < line)
            elif b.market in ('penalty','redcard'):
                # Да/Нет по записи в MatchSpecials; если к моменту расчёта не внесено —
                # считаем «Нет» только после окончания матча:
                #  - по времени (match_datetime + BET_MATCH_DURATION_MINUTES)
                #  - или по факту наличия результата/счёта в снапшоте/таблице
                res = _get_special_result(b.home, b.away, b.market)
                if res is None:
                    finished = False
                    if b.match_datetime:
                        # Если знаем время начала — ждём строго окончания окна (2 часа по умолчанию)
                        try:
                            end_dt = b.match_datetime + timedelta(minutes=BET_MATCH_DURATION_MINUTES)
                        except Exception:
                            end_dt = b.match_datetime
                        if end_dt <= now:
                            finished = True
                    else:
                        # Если не знаем время начала, допускаем завершение по факту появления результата/счёта
                        r = _get_match_result(b.home, b.away)
                        if r is not None:
                            finished = True
                        else:
                            tg = _get_match_total_goals(b.home, b.away)
                            if tg is not None:
                                finished = True
                    if not finished:
                        continue
                    res = False
                # selection: 'yes'|'no'
                won = ((res is True) and b.selection == 'yes') or ((res is False) and b.selection == 'no')
            else:
                # не поддерживаемый рынок
                continue

            if won:
                # выигрыш
                try:
                    odd = float(b.odds or '2.0')
                except Exception:
                    odd = 2.0
                payout = int(round(b.stake * odd))
                b.status = 'won'
                b.payout = payout
                # начислить кредиты
                u = db.get(User, b.user_id)
                if u:
                    u.credits = int(u.credits or 0) + payout
                    u.updated_at = datetime.now(timezone.utc)
            else:
                b.status = 'lost'
                b.payout = 0
            b.updated_at = datetime.now(timezone.utc)
            changed += 1
        if changed:
            db.commit()
    finally:
        db.close()

@app.route('/api/results', methods=['GET'])
def api_results():
    """Возвращает прошедшие матчи из снапшота БД; при отсутствии — bootstrap из Sheets. ETag/304 поддерживаются."""
    try:
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                snap = _snapshot_get(db, 'results')
                if snap and snap.get('payload'):
                    payload = snap['payload']
                    _core = {'results': (payload.get('results') or [])[:200]}
                    _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                    inm = request.headers.get('If-None-Match')
                    if inm and inm == _etag:
                        resp = app.response_class(status=304)
                        resp.headers['ETag'] = _etag
                        resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
                        return resp
                    resp = jsonify({**payload, 'version': _etag})
                    resp.headers['ETag'] = _etag
                    resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
                    return resp
            finally:
                db.close()
        # Bootstrap
        payload = _build_results_payload_from_sheet()
        _core = {'results': (payload.get('results') or [])[:200]}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if SessionLocal is not None:
            db = get_db()
            try:
                _snapshot_set(db, 'results', payload)
            finally:
                db.close()
        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'public, max-age=900, stale-while-revalidate=600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки результатов: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить результаты'}), 500

@app.route('/api/match-details', methods=['GET'])
def api_match_details():
    """Возвращает составы двух команд из листа 'СОСТАВЫ' по их названиям.
    Параметры: home, away (строки). Ищем соответствующие колонки в первой строке.
    """
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home и away обязательны'}), 400

        def norm(s: str) -> str:
            """Нормализует название команды:
            - нижний регистр, замена ё->е
            - приведение латинских «похожих» букв к кириллице, если строка кириллическая (боремся с Звeзда и т.п.)
            - удаление не буквенно-цифровых
            - удаление префикса 'фк' / 'fc' / 'fk'
            """
            s = (s or '').lower().strip()
            s = s.replace('\u00A0', ' ').replace('ё', 'е')
            # Если строка содержит кириллицу, заменим похожие латинские символы на кириллицу
            try:
                has_cyr = any('а' <= ch <= 'я' or ch in ('ё') for ch in s)
            except Exception:
                has_cyr = False
            if has_cyr:
                # наиболее частые пары латиница -> кириллица
                trans_map = str.maketrans({
                    'a': 'а',  # a -> а
                    'e': 'е',  # e -> е
                    'o': 'о',  # o -> о
                    'c': 'с',  # c -> с
                    'p': 'р',  # p -> р
                    'x': 'х',  # x -> х
                    'y': 'у',  # y -> у
                    'k': 'к',  # k -> к
                    'b': 'в',  # b -> в
                    'm': 'м',  # m -> м
                    't': 'т',  # t -> т
                    'h': 'н',  # h -> н
                })
                s = s.translate(trans_map)
            # уберём пробелы и префикс 'фк'/'fc' в начале
            s0 = s.replace(' ', '')
            if s0.startswith('фк'):
                s = s0[2:]
            elif s0.startswith('fc') or s0.startswith('fk'):
                s = s0[2:]
            else:
                s = s0
            return ''.join(ch for ch in s if ch.isalnum())

        def base_key(k: str) -> str:
            """Базовая форма: без хвостовых цифр (Ювелиры2 -> Ювелиры)."""
            k = k or ''
            i = len(k)
            while i > 0 and k[i-1].isdigit():
                i -= 1
            return k[:i]

        # Ключ кеша по нормализованным названиям
        home_key = norm(home)
        away_key = norm(away)
        cache_key = f"{home_key}|{away_key}"
        now_ts = int(time.time())
        cached = MATCH_DETAILS_CACHE.get(cache_key)
        inm = request.headers.get('If-None-Match')
        if cached and (now_ts - cached['ts'] < MATCH_DETAILS_TTL):
            if inm and inm == cached.get('etag'):
                resp = app.response_class(status=304)
                resp.headers['ETag'] = cached['etag']
                resp.headers['Cache-Control'] = 'private, max-age=3600'
                return resp
            resp = jsonify({ **cached['payload'], 'version': cached['etag'] })
            resp.headers['ETag'] = cached['etag']
            resp.headers['Cache-Control'] = 'private, max-age=3600'
            return resp

        ws = get_rosters_sheet()
        # Сначала попробуем получить фиксированный диапазон, чтобы сохранить реальные индексы колонок (A=1..ZZ)
        headers = []
        try:
            _metrics_inc('sheet_reads', 1)
            arr = ws.get('A1:ZZ1') or [[]]
            headers = (arr[0] if arr and len(arr) > 0 else []) or []
        except Exception:
            headers = []
        # Фолбэк — row_values(1), если предыдущий способ не сработал
        if not headers:
            try:
                _metrics_inc('sheet_reads', 1)
                headers = ws.row_values(1) or []
            except Exception:
                headers = []
        # карта нормализованных заголовков -> индекс (1-based)
        idx_map = {}
        for i, h in enumerate(headers, start=1):
            key = norm(h)
            if not key:
                continue
            idx_map[key] = i
            # алиас по базовой форме (без хвостовых цифр), чтобы "ювелиры (2)" сопоставлялись с "ювелиры"
            bk = base_key(key)
            if bk and bk not in idx_map:
                idx_map[bk] = i
            # убираем любые круглые скобки и содержимое как дополнительный алиас: "дождь (ю-1)" -> "дождь"
            try:
                simple = key.split('(')[0].strip()
                if simple and simple not in idx_map:
                    idx_map[simple] = i
            except Exception:
                pass

        def extract(team_name: str):
            key = norm(team_name)
            col_idx = idx_map.get(key)
            if col_idx is None:
                # попробуем базовую форму без цифр в хвосте (например, Ювелиры2 -> Ювелиры)
                bk = base_key(key)
                col_idx = idx_map.get(bk)
            if col_idx is None:
                # подстрочное совпадение среди известных ключей (и их базовых форм)
                for k, i in idx_map.items():
                    if key and (key in k or k in key):
                        col_idx = i
                        break
            if col_idx is None:
                # не нашли — попробуем нестрогое сравнение (fuzzy) по похожести
                try:
                    import difflib
                    best_ratio = 0.0
                    best_idx = None
                    for k, i in idx_map.items():
                        r = difflib.SequenceMatcher(None, key, k).ratio()
                        if r > best_ratio:
                            best_ratio = r
                            best_idx = i
                    if best_idx is not None and best_ratio >= 0.8:
                        col_idx = best_idx
                except Exception:
                    pass
            if col_idx is None:
                return {'team': team_name, 'players': []}
            _metrics_inc('sheet_reads', 1)
            col_vals = ws.col_values(col_idx)
            # убираем заголовок
            players = [v.strip() for v in col_vals[1:] if v and v.strip()]
            return {'team': headers[col_idx-1] or team_name, 'players': players}

        home_data = extract(home)
        away_data = extract(away)
        # Если обе пустые, попробуем ещё раз с перестановкой (редкий кейс кросс-алиасов)
        if not home_data['players'] and not away_data['players']:
            alt_home = extract(away)
            alt_away = extract(home)
            # Если после перестановки появились игроки, используем их
            if alt_home['players'] or alt_away['players']:
                home_data, away_data = alt_home, alt_away

        # Версионируем содержимое через хеш, чтобы поддержать ETag/кэш
        import hashlib, json as _json
        # Подтянем события игроков из БД (если доступна)
        events = {'home': [], 'away': []}
        if SessionLocal is not None:
            try:
                dbx = get_db()
                try:
                    rows = dbx.query(MatchPlayerEvent).filter(MatchPlayerEvent.home==home, MatchPlayerEvent.away==away).order_by(MatchPlayerEvent.minute.asc().nulls_last()).all()
                    for e in rows:
                        side = 'home' if (e.team or 'home') == 'home' else 'away'
                        events[side].append({
                            'minute': (int(e.minute) if e.minute is not None else None),
                            'player': e.player,
                            'type': e.type,
                            'note': e.note or ''
                        })
                finally:
                    dbx.close()
            except Exception:
                events = {'home': [], 'away': []}
        # Попробуем заменить составы на данные из таблицы match_lineups если есть
        extended_lineups = None
        if SessionLocal is not None:
            try:
                dbx = get_db()
                try:
                    lrows = dbx.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).all()
                    if lrows:
                        ext = { 'home': {'starting_eleven': [], 'substitutes': []}, 'away': {'starting_eleven': [], 'substitutes': []} }
                        for r in lrows:
                            side = 'home' if (r.team or 'home')=='home' else 'away'
                            bucket = 'starting_eleven' if r.position=='starting_eleven' else 'substitutes'
                            ext[side][bucket].append({
                                'player': r.player,
                                'jersey_number': r.jersey_number,
                                'is_captain': bool(r.is_captain)
                            })
                        # Отсортируем по номеру внутри категорий
                        for s in ('home','away'):
                            for b in ('starting_eleven','substitutes'):
                                ext[s][b].sort(key=lambda x: (999 if x['jersey_number'] is None else x['jersey_number'], (x['player'] or '').lower()))
                        extended_lineups = ext
                finally:
                    dbx.close()
            except Exception:
                extended_lineups = None
        if extended_lineups:
            # Используем расширенный формат + плоские списки для обратной совместимости
            flat_home = [p['player'] for p in extended_lineups['home']['starting_eleven']] + [p['player'] for p in extended_lineups['home']['substitutes']]
            flat_away = [p['player'] for p in extended_lineups['away']['starting_eleven']] + [p['player'] for p in extended_lineups['away']['substitutes']]
            payload_core = {
                'teams': {'home': home_data['team'], 'away': away_data['team']},
                'rosters': {'home': flat_home, 'away': flat_away},
                'lineups': extended_lineups,
                'events': events
            }
        else:
            payload_core = {
                'teams': {'home': home_data['team'], 'away': away_data['team']},
                'rosters': {'home': home_data['players'], 'away': away_data['players']},
                'events': events
            }
        etag = hashlib.md5(_json.dumps(payload_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        # Если обе команды пустые, залогируем доступные ключи для отладки
        if not home_data['players'] and not away_data['players']:
            try:
                app.logger.info("Rosters not found for %s vs %s; keys: %s", home, away, ','.join(sorted(set(idx_map.keys()))))
            except Exception:
                pass
        # Сохраняем в кеш
        MATCH_DETAILS_CACHE[cache_key] = { 'ts': now_ts, 'etag': etag, 'payload': payload_core }
        resp = jsonify({ **payload_core, 'version': etag })
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'private, max-age=3600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка получения составов: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить составы'}), 500

@app.route('/api/match/events/add', methods=['POST'])
def api_match_events_add():
    """Админ добавляет событие игрока: поля initData, home, away, team(home|away), minute?, player, type(goal|assist|yellow|red), note?"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        team = (request.form.get('team') or 'home').strip().lower()
        try:
            minute = int(request.form.get('minute')) if request.form.get('minute') not in (None, '') else None
        except Exception:
            minute = None
        player = (request.form.get('player') or '').strip()
        etype = (request.form.get('type') or '').strip().lower()
        note = (request.form.get('note') or '').strip()
        if not home or not away or not player or etype not in ('goal','assist','yellow','red'):
            return jsonify({'error': 'Некорректные данные'}), 400
        if team not in ('home','away'):
            team = 'home'
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = MatchPlayerEvent(home=home, away=away, team=team, minute=minute, player=player, type=etype, note=(note or None))
            db.add(row)
            db.commit()
            # Попытка синхронизации в расширенную схему (не критично при ошибке)
            _maybe_sync_event_to_adv_schema(home, away, player, etype)
            return jsonify({'status': 'ok', 'id': int(row.id)})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка events/add: {e}")
        return jsonify({'error': 'Не удалось сохранить событие'}), 500

@app.route('/api/match/events/remove', methods=['POST'])
def api_match_events_remove():
    """Удалить последнее событие указанного типа по игроку и стороне (только админ).
    Поля: initData, home, away, team(home|away), player, type(goal|assist|yellow|red)
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        team = (request.form.get('team') or 'home').strip().lower()
        player = (request.form.get('player') or '').strip()
        etype = (request.form.get('type') or '').strip().lower()
        if not home or not away or not player or etype not in ('goal','assist','yellow','red'):
            return jsonify({'error': 'Некорректные данные'}), 400
        if team not in ('home','away'):
            team = 'home'
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchPlayerEvent).filter(
                MatchPlayerEvent.home==home,
                MatchPlayerEvent.away==away,
                MatchPlayerEvent.team==team,
                MatchPlayerEvent.player==player,
                MatchPlayerEvent.type==etype
            ).order_by(MatchPlayerEvent.id.desc()).first()
            if not row:
                return jsonify({'status': 'ok', 'removed': 0})
            rid = int(row.id)
            db.delete(row)
            db.commit()
            return jsonify({'status': 'ok', 'removed': 1, 'id': rid})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка events/remove: {e}")
        return jsonify({'error': 'Не удалось удалить событие'}), 500

@app.route('/api/match/events/list', methods=['GET'])
def api_match_events_list():
    """Список событий для матча. Параметры: home, away."""
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'items': {'home': [], 'away': []}})
        if SessionLocal is None:
            return jsonify({'items': {'home': [], 'away': []}})
        db: Session = get_db()
        try:
            rows = db.query(MatchPlayerEvent).filter(MatchPlayerEvent.home==home, MatchPlayerEvent.away==away).order_by(MatchPlayerEvent.minute.asc().nulls_last(), MatchPlayerEvent.id.asc()).all()
            out = {'home': [], 'away': []}
            for e in rows:
                side = 'home' if (e.team or 'home') == 'home' else 'away'
                out[side].append({
                    'id': int(e.id),
                    'minute': (int(e.minute) if e.minute is not None else None),
                    'player': e.player,
                    'type': e.type,
                    'note': e.note or ''
                })
            return jsonify({'items': out})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка events/list: {e}")

@app.route('/api/players/scorers', methods=['GET'])
def api_players_scorers():
    """Таблица бомбардиров.
    Параметры (опционально): tournament_id (если расширенная схема), limit.
    Порядок сортировки: (голы+ассисты) desc, матчи asc, голы desc.
    Fallback: если расширенная схема недоступна, агрегируем по legacy событиям (MatchPlayerEvent type in goal/assist).
    """
    try:
        limit_param = request.args.get('limit')
        try:
            limit = int(limit_param) if limit_param else None
        except Exception:
            limit = None
        tournament_id = request.args.get('tournament_id')
        # Путь 1: расширенная схема
        if _adv_ops and adv_db_manager and getattr(adv_db_manager, 'SessionLocal', None) and tournament_id:
            try:
                tid = int(tournament_id)
            except Exception:
                tid = None
            if tid is not None:
                try:
                    rankings = _adv_ops.get_player_rankings(tid, limit=limit)
                    return jsonify({'items': rankings, 'mode': 'advanced'})
                except Exception as adv_err:  # noqa: F841
                    app.logger.warning(f"scorers_advanced_failed: {adv_err}")
        # Fallback: legacy
        if SessionLocal is None:
            return jsonify({'items': [], 'mode': 'legacy', 'error': 'db_unavailable'})
        db: Session = get_db()
        try:
            from collections import defaultdict
            stats = defaultdict(lambda: {'player': '', 'goals': 0, 'assists': 0, 'matches': set()})
            rows = db.query(MatchPlayerEvent).filter(MatchPlayerEvent.type.in_(['goal','assist'])).all()
            for r in rows:
                key = (r.player or '').strip()
                if not key:
                    continue
                rec = stats[key]
                rec['player'] = key
                # match key для подсчёта сыгранных матчей
                try:
                    dkey = ''
                    # попытка извлечь дату/время матча из расписания (не храним тут напрямую) опускается — используем home+away
                    dkey = f"{(r.home or '').lower().strip()}__{(r.away or '').lower().strip()}"
                except Exception:
                    dkey = f"{(r.home or '')}__{(r.away or '')}"
                rec['matches'].add(dkey)
                if r.type == 'goal':
                    rec['goals'] += 1
                elif r.type == 'assist':
                    rec['assists'] += 1
            scored = []
            for rec in stats.values():
                total_points = rec['goals'] + rec['assists']
                scored.append({
                    'player': rec['player'],
                    'goals': rec['goals'],
                    'assists': rec['assists'],
                    'total_points': total_points,
                    'matches_played': len(rec['matches'])
                })
            scored.sort(key=lambda x: (-x['total_points'], x['matches_played'], -x['goals']))
            if limit:
                scored = scored[:limit]
            # добавим rank
            for i, item in enumerate(scored, 1):
                item['rank'] = i
            return jsonify({'items': scored, 'mode': 'legacy'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка scorers: {e}")
        return jsonify({'error': 'internal'}), 500
        return jsonify({'items': {'home': [], 'away': []}})

@app.route('/api/league-table/refresh', methods=['POST'])
def api_league_table_refresh():
    """Принудительно обновляет таблицу лиги (только админ)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403

        # Форсируем синхронизацию через тот же код, что используется в фоновом sync —
        # это гарантирует, что снапшоты будут построены из актуальных источников (БД/оптимизированных билдов),
        # и выполнится инвалидация кэша и WebSocket-уведомления.
        try:
            _sync_league_table()
        except Exception as _e:
            app.logger.warning(f"league-table forced sync failed: {_e}")
        updated_at = None
        if SessionLocal is not None:
            db = get_db()
            try:
                snap = _snapshot_get(db, 'league-table') or {}
                payload = snap.get('payload') or {}
                updated_at = payload.get('updated_at')
            finally:
                db.close()
        if not updated_at:
            updated_at = datetime.now(timezone.utc).isoformat()
        return jsonify({'status': 'ok', 'updated_at': updated_at})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления лиги: {str(e)}")
        return jsonify({'error': 'Не удалось обновить таблицу'}), 500

@app.route('/api/stats-table/refresh', methods=['POST'])
def api_stats_table_refresh():
    """Принудительно обновляет таблицу статистики (только админ)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        # Используем тот же механизм, что и в фоне — вызов _sync_stats_table соберёт данные отовсюду и обновит снапшот
        try:
            _sync_stats_table()
        except Exception as _e:
            app.logger.warning(f"stats-table forced sync failed: {_e}")
        updated_at = None
        if SessionLocal is not None:
            db = get_db()
            try:
                snap = _snapshot_get(db, 'stats-table') or {}
                payload = snap.get('payload') or {}
                updated_at = payload.get('updated_at')
            finally:
                db.close()
        if not updated_at:
            updated_at = datetime.now(timezone.utc).isoformat()
        return jsonify({'status': 'ok', 'updated_at': updated_at})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления статистики: {e}")
        return jsonify({'error': 'Не удалось обновить статистику'}), 500

@app.route('/api/schedule/refresh', methods=['POST'])
def api_schedule_refresh():
    """Принудительно обновляет расписание (только админ)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        # Вызовем синхронизацию расписания, которая установит снапшот и выполнит инвалидацию/уведомления
        try:
            _sync_schedule()
        except Exception as _e:
            app.logger.warning(f"schedule forced sync failed: {_e}")
        updated_at = None
        if SessionLocal is not None:
            db = get_db()
            try:
                snap = _snapshot_get(db, 'schedule') or {}
                payload = snap.get('payload') or {}
                updated_at = payload.get('updated_at')
            finally:
                db.close()
        if not updated_at:
            updated_at = datetime.now(timezone.utc).isoformat()
        return jsonify({'status': 'ok', 'updated_at': updated_at})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления расписания: {e}")
        return jsonify({'error': 'Не удалось обновить расписание'}), 500

@app.route('/api/results/refresh', methods=['POST'])
def api_results_refresh():
    """Принудительно обновляет результаты (только админ)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        try:
            _sync_results()
        except Exception as _e:
            app.logger.warning(f"results forced sync failed: {_e}")
        updated_at = None
        if SessionLocal is not None:
            db = get_db()
            try:
                snap = _snapshot_get(db, 'results') or {}
                payload = snap.get('payload') or {}
                updated_at = payload.get('updated_at')
            finally:
                db.close()
        if not updated_at:
            updated_at = datetime.now(timezone.utc).isoformat()
        return jsonify({'status': 'ok', 'updated_at': updated_at})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления результатов: {e}")
        return jsonify({'error': 'Не удалось обновить результаты'}), 500

@app.route('/api/betting/tours/refresh', methods=['POST'])
def api_betting_tours_refresh():
    """Принудительно обновляет снапшот туров для ставок (только админ).
    Нужен для корректного обновления раздела прогнозов и подбора "матча недели"
    после изменения времени матчей в Google Sheets.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        try:
            _sync_betting_tours()
        except Exception as _e:
            app.logger.warning(f"betting-tours forced sync failed: {_e}")
        updated_at = None
        if SessionLocal is not None:
            db = get_db()
            try:
                snap = _snapshot_get(db, 'betting-tours') or {}
                payload = snap.get('payload') or {}
                updated_at = payload.get('updated_at')
            finally:
                db.close()
        if not updated_at:
            updated_at = datetime.now(timezone.utc).isoformat()
        return jsonify({'status': 'ok', 'updated_at': updated_at})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления betting-tours: {e}")
        return jsonify({'error': 'Не удалось обновить туры для ставок'}), 500

@app.route('/api/streams/confirm', methods=['POST'])
def api_streams_confirm():
    """Админ подтверждает трансляцию для матча.
    Поля: initData, home, away, date(YYYY-MM-DD optional), [vkVideoId]|[vkPostUrl]
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID','')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        def _norm_team(v:str)->str:
            return ' '.join(v.strip().split()).lower()
        home_raw = (request.form.get('home') or '').strip()
        away_raw = (request.form.get('away') or '').strip()
        home = _norm_team(home_raw)
        away = _norm_team(away_raw)
        date_str = (request.form.get('date') or '').strip()  # YYYY-MM-DD
        vk_id = (request.form.get('vkVideoId') or '').strip()
        vk_url = (request.form.get('vkPostUrl') or '').strip()
        # Если прислали embed-ссылку video_ext.php — извлечём oid/id и сохраним как vkVideoId
        try:
            if vk_url and 'video_ext.php' in vk_url:
                u = urlparse(vk_url)
                q = parse_qs(u.query)
                oid = (q.get('oid',[None])[0])
                vid = (q.get('id',[None])[0])
                if oid and vid:
                    vk_id = f"{oid}_{vid}"
                    vk_url = ''
        except Exception:
            pass
        # Также поддержим прямую ссылку вида https://vk.com/video-123456_654321
        try:
            if vk_url and '/video' in vk_url:
                path = urlparse(vk_url).path or ''
                # /video-123456_654321 или /video123_456
                import re as _re
                m = _re.search(r"/video(-?\d+_\d+)", path)
                if m:
                    vk_id = m.group(1)
                    vk_url = ''
        except Exception:
            pass
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if not vk_id and not vk_url:
            return jsonify({'error': 'нужен vkVideoId или vkPostUrl'}), 400
        if vk_id and not re.match(r'^-?\d+_\d+$', vk_id):
            return jsonify({'error': 'vkVideoId должен быть формата oid_id'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            from sqlalchemy import func
            row = db.query(MatchStream).filter(func.lower(MatchStream.home)==home, func.lower(MatchStream.away)==away, MatchStream.date==(date_str or None)).first()
            now = datetime.now(timezone.utc)
            if not row:
                row = MatchStream(home=home, away=away, date=(date_str or None))
                db.add(row)
            row.vk_video_id = vk_id or None
            row.vk_post_url = vk_url or None
            row.confirmed_at = now
            row.updated_at = now
            db.commit()
            return jsonify({'status': 'ok', 'home': home_raw, 'away': away_raw, 'date': date_str, 'vkVideoId': row.vk_video_id, 'vkPostUrl': row.vk_post_url})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/confirm error: {e}")
        return jsonify({'error': 'Не удалось сохранить трансляцию'}), 500

@app.route('/api/streams/list', methods=['GET'])
def api_streams_list():
    """Возвращает список подтвержденных трансляций (минимальный набор)."""
    try:
        if SessionLocal is None:
            return jsonify({'items': []})
        db: Session = get_db()
        try:
            rows = db.query(MatchStream).all()
            items = []
            for r in rows:
                items.append({'home': r.home, 'away': r.away, 'date': r.date or '', 'vkVideoId': r.vk_video_id or '', 'vkPostUrl': r.vk_post_url or ''})
            return jsonify({'items': items})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/list error: {e}")
        return jsonify({'items': []})

@app.route('/api/streams/upcoming', methods=['GET'])
def api_streams_upcoming():
    """Админ: список матчей рядом со стартом.
    Параметры:
      - window_min: показать матчи, которые начнутся в ближайшие N минут (по умолчанию 60, минимум 60, максимум 240)
      - include_started_min: также включить матчи, которые уже начались за последние N минут (по умолчанию 30)
    Возвращает: { matches: [{home, away, datetime}] }
    """
    try:
        try:
            window_min = int(request.args.get('window_min') or '360')
        except Exception:
            window_min = 360
        # Минимум 60 минут, максимум 480 (8 часов)
        window_min = max(60, min(480, window_min))
        try:
            include_started_min = int(request.args.get('include_started_min') or '30')
        except Exception:
            include_started_min = 30
        include_started_min = max(0, min(180, include_started_min))
        # Сдвиг локального времени расписания относительно системного времени сервера
        try:
            tz_min = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
        except Exception:
            tz_min = 0
        if tz_min == 0:
            try:
                tz_h = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
            except Exception:
                tz_h = 0
            tz_min = tz_h * 60
        now = datetime.now() + timedelta(minutes=tz_min)
        until = now + timedelta(minutes=window_min)
        since = now - timedelta(minutes=include_started_min)
        # Достаём расписание из снапшота; если пусто — из таблицы
        tours = []
        if SessionLocal is not None:
            dbx = get_db()
            try:
                snap = _snapshot_get(dbx, 'schedule')
                payload = snap and snap.get('payload')
                tours = payload and payload.get('tours') or []
            finally:
                dbx.close()
        if not tours:
            tours = _load_all_tours_from_sheet()
        matches = []
        for t in tours or []:
            for m in (t.get('matches') or []):
                try:
                    dt = None
                    if m.get('datetime'):
                        dt = datetime.fromisoformat(str(m['datetime']))
                    elif m.get('date'):
                        d = datetime.fromisoformat(str(m['date'])).date()
                        try:
                            tm = datetime.strptime((m.get('time') or '00:00'), "%H:%M").time()
                        except Exception:
                            tm = datetime.min.time()
                        dt = datetime.combine(d, tm)
                    if not dt:
                        continue
                    # Показываем матчи, которые начнутся в течение окна, а также те, что уже начались не ранее чем include_started_min минут назад
                    if since <= dt <= until:
                        matches.append({ 'home': m.get('home',''), 'away': m.get('away',''), 'datetime': dt.isoformat() })
                except Exception:
                    continue
        # Отсортируем по времени начала
        try:
            matches.sort(key=lambda x: x.get('datetime') or '')
        except Exception:
            pass
        return jsonify({ 'matches': matches })
    except Exception as e:
        app.logger.error(f"streams/upcoming error: {e}")
        return jsonify({ 'matches': [] }), 200

@app.route('/api/streams/set', methods=['POST'])
def api_streams_set():
    """Админский эндпоинт (совместим с фронтом): сохранить ссылку на трансляцию.
    Поля: initData, home, away, datetime(iso optional), vk (строка: video_ext или прямая ссылка)
    """
    try:
        import re as _re
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        def _norm_team(v:str)->str:
            return ' '.join(v.strip().split()).lower()
        home_raw = (request.form.get('home') or '').strip()
        away_raw = (request.form.get('away') or '').strip()
        home = _norm_team(home_raw)
        away = _norm_team(away_raw)
        dt_raw = (request.form.get('datetime') or '').strip()
        # Поддержка ISO форматов с суффиксом Z
        if dt_raw.endswith('Z'):
            dt_raw = dt_raw[:-1] + '+00:00'
        vk_raw = (request.form.get('vk') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        # Определим дату для ключа
        date_str = ''
        try:
            if dt_raw:
                # Попробуем разные варианты разделения даты
                date_str = datetime.fromisoformat(dt_raw).date().isoformat()
        except Exception:
            try:
                date_part = dt_raw.split('T')[0]
                datetime.fromisoformat(date_part)  # проверка
                date_str = date_part
            except Exception:
                date_str = ''
        # Разобрать vk_raw в vkVideoId или vkPostUrl
        vk_id = ''
        vk_url = ''
        s = (vk_raw or '').strip()
        try:
            # Если админ вставил целиком <iframe ...>, извлечём src
            if '<iframe' in s.lower():
                m = _re.search(r"src\s*=\s*['\"]([^'\"]+)['\"]", s, _re.IGNORECASE)
                if m:
                    s = m.group(1).strip()
            # Если где-то в строке встречаются oid и id (даже без корректного URL)
            m2_oid = _re.search(r"(?:[?&#]|\b)oid=([-\d]+)\b", s)
            m2_id = _re.search(r"(?:[?&#]|\b)id=(\d+)\b", s)
            if m2_oid and m2_id:
                vk_id = f"{m2_oid.group(1)}_{m2_id.group(1)}"
            else:
                # Пробуем как URL (vk.com или vkvideo.ru неважно)
                u = urlparse(s)
                if 'video_ext.php' in (u.path or ''):
                    q = parse_qs(u.query)
                    oid = (q.get('oid', [None])[0])
                    vid = (q.get('id', [None])[0])
                    if oid and vid:
                        vk_id = f"{oid}_{vid}"
                elif '/video' in (u.path or ''):
                    m = _re.search(r"/video(-?\d+_\d+)", u.path or '')
                    if m:
                        vk_id = m.group(1)
            # Если так и не получили vk_id, но похоже на ссылку — сохраним как постовую URL
            if not vk_id:
                # Принимаем только валидные http(s) ссылки, иначе игнор
                if s.startswith('http://') or s.startswith('https://'):
                    vk_url = s
        except Exception:
            # Если не смогли распарсить — сохраним как есть, но только если это URL
            if s.startswith('http://') or s.startswith('https://'):
                vk_url = s
        if not vk_id and not vk_url:
            return jsonify({'error': 'vk ссылка пуста'}), 400
        if vk_id and not _re.match(r'^-?\d+_\d+$', vk_id):
            return jsonify({'error': 'vkVideoId должен быть формата oid_id'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            from sqlalchemy import func
            row = db.query(MatchStream).filter(
                func.lower(MatchStream.home) == home,
                func.lower(MatchStream.away) == away,
                MatchStream.date == (date_str or None)
            ).first()
            if not row and not date_str:
                # Разрешим перезапись самой свежей записи, даже если она без даты, если совпали команды
                row = db.query(MatchStream).filter(
                    func.lower(MatchStream.home) == home,
                    func.lower(MatchStream.away) == away
                ).order_by(MatchStream.updated_at.desc()).first()
            now_ts = datetime.now(timezone.utc)
            prev_id = None
            prev_url = None
            if not row:
                row = MatchStream(home=home, away=away, date=(date_str or None))
                db.add(row)
            else:
                try:
                    prev_id = row.vk_video_id or None
                    prev_url = row.vk_post_url or None
                except Exception:
                    prev_id = None
                    prev_url = None
            row.vk_video_id = vk_id or None
            row.vk_post_url = vk_url or None
            row.confirmed_at = now_ts
            row.updated_at = now_ts
            db.commit()
            # Логирование факта сохранения для аудита
            try:
                app.logger.info(
                    f"streams/set by admin {user_id}: {home} vs {away} ({date_str or '-'}) -> "
                    f"vkVideoId={row.vk_video_id or ''} vkPostUrl={row.vk_post_url or ''} "
                    f"(prev: id={prev_id or ''} url={prev_url or ''})"
                )
            except Exception:
                pass
            msg = 'Ссылка принята и сохранена'
            try:
                app.logger.info(f"streams/set saved: home_raw='{home_raw}' away_raw='{away_raw}' norm=('{home}','{away}') date='{date_str}' vk_id='{row.vk_video_id}' vk_url='{row.vk_post_url}'")
            except Exception:
                pass
            return jsonify({
                'status': 'ok',
                'message': msg,
                'home': home_raw,
                'away': away_raw,
                'date': date_str,
                'vkVideoId': row.vk_video_id or '',
                'vkPostUrl': row.vk_post_url or '',
                'prev': {'vkVideoId': prev_id or '', 'vkPostUrl': prev_url or ''}
            })
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/set error: {e}")
        return jsonify({'error': 'Не удалось сохранить'}), 500

@app.route('/api/streams/get', methods=['GET'])
def api_streams_get():
    """Вернёт ссылку на трансляцию матча.

    Логика:
    1. Нормализуем названия команд (пробелы + lowercase).
    2. Сначала отдаём последнюю сохранённую ссылку (если она актуальна <=48ч), БЕЗ проверки окна – чтобы админ сразу видел результат.
    3. Если явной ссылки нет – сверяемся с расписанием и, если до матча осталось <= window минут, повторно ищем ссылку (на случай несовпадения даты).
    4. Иначе available=False.
    """
    if SessionLocal is None:
        return jsonify({'available': False})

    # --- Входные параметры ---
    def _norm_team(v: str) -> str:
        try:
            return ' '.join(v.strip().replace('ё','е').split()).lower()
        except Exception:
            return (v or '').strip().lower()

    home_raw = (request.args.get('home') or '').strip()
    away_raw = (request.args.get('away') or '').strip()
    home = _norm_team(home_raw)
    away = _norm_team(away_raw)
    date_str = (request.args.get('date') or '').strip()
    try:
        win = int(request.args.get('window') or '60')
    except Exception:
        win = 60
    win = max(10, min(240, win))

    from sqlalchemy import func

    # --- 1. Немедленный возврат сохранённой ссылки ---
    force_any = (request.args.get('any') == '1')
    try:
        db = get_db()
        try:
            base_q = db.query(MatchStream).filter(
                func.lower(MatchStream.home) == home,
                func.lower(MatchStream.away) == away
            )
            row = base_q.filter(MatchStream.date == (date_str or None)).first()
            if not row:
                # Берём самую свежую вне зависимости от даты
                row_latest = base_q.order_by(MatchStream.updated_at.desc()).first()
                if row_latest:
                    if force_any:
                        row = row_latest
                    else:
                        try:
                            if row_latest.updated_at and (datetime.now(timezone.utc) - row_latest.updated_at) <= timedelta(hours=48):
                                row = row_latest
                        except Exception:
                            row = row_latest
            if row and ((row.vk_video_id and row.vk_video_id.strip()) or (row.vk_post_url and row.vk_post_url.strip())):
                try:
                    app.logger.info(f"streams/get immediate link id='{row.vk_video_id}' url='{row.vk_post_url}' home='{home}' away='{away}' date='{date_str}' force_any={force_any}")
                except Exception:
                    pass
                return jsonify({'available': True, 'vkVideoId': row.vk_video_id or '', 'vkPostUrl': row.vk_post_url or ''})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/get immediate lookup error: {e}")

    # --- 2. Загрузка расписания (snapshot -> fallback sheet) ---
    tours = []
    try:
        dbs = get_db()
        try:
            snap = _snapshot_get(dbs, 'schedule')
            payload = snap and snap.get('payload')
            tours = (payload and payload.get('tours')) or []
        finally:
            dbs.close()
    except Exception:
        pass
    if not tours:
        try:
            tours = _load_all_tours_from_sheet()
        except Exception:
            tours = []

    # --- 3. Поиск матча в расписании ---
    start_ts = None
    if tours:
        for t in tours:
            matches = t.get('matches') or []
            for m in matches:
                try:
                    if _norm_team(m.get('home','')) != home or _norm_team(m.get('away','')) != away:
                        continue
                    if m.get('datetime'):
                        dt_obj = datetime.fromisoformat(str(m['datetime']).replace('Z', '+00:00'))
                    elif m.get('date'):
                        d_obj = datetime.fromisoformat(str(m['date'])).date()
                        try:
                            tm = datetime.strptime((m.get('time') or '00:00'), '%H:%M').time()
                        except Exception:
                            tm = datetime.min.time()
                        dt_obj = datetime.combine(d_obj, tm)
                    else:
                        continue
                    start_ts = int(dt_obj.timestamp() * 1000)
                    raise StopIteration  # выходим из всех циклов
                except StopIteration:
                    break
                except Exception:
                    continue
            if start_ts is not None:
                break

    # --- 4. Проверка окна ---
    try:
        tz_min = int(os.environ.get('SCHEDULE_TZ_SHIFT_MIN') or '0')
    except Exception:
        tz_min = 0
    if tz_min == 0:
        try:
            tz_h = int(os.environ.get('SCHEDULE_TZ_SHIFT_HOURS') or '0')
        except Exception:
            tz_h = 0
        tz_min = tz_h * 60
    now_ms = int((time.time() + tz_min * 60) * 1000)
    if not start_ts or (start_ts - now_ms) > win * 60 * 1000:
        return jsonify({'available': False})

    # --- 5. Повторный поиск ссылки в окне ---
    try:
        db = get_db()
        try:
            row2 = db.query(MatchStream).filter(
                func.lower(MatchStream.home) == home,
                func.lower(MatchStream.away) == away,
                MatchStream.date == (date_str or None)
            ).first()
            if not row2 and date_str:
                row2 = db.query(MatchStream).filter(
                    func.lower(MatchStream.home) == home,
                    func.lower(MatchStream.away) == away
                ).order_by(MatchStream.updated_at.desc()).first()
            if row2 and ((row2.vk_video_id and row2.vk_video_id.strip()) or (row2.vk_post_url and row2.vk_post_url.strip())):
                return jsonify({'available': True, 'vkVideoId': row2.vk_video_id or '', 'vkPostUrl': row2.vk_post_url or ''})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/get window lookup error: {e}")
    return jsonify({'available': False})

@app.route('/api/streams/reset', methods=['POST'])
def api_streams_reset():
    """Админ: сбросить ссылку на трансляцию для конкретного матча (home/away/date)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID','')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        date_str = (request.form.get('date') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchStream).filter(MatchStream.home==home, MatchStream.away==away, MatchStream.date==(date_str or None)).first()
            if not row and date_str:
                # поддержка старых записей без даты
                row = db.query(MatchStream).filter(MatchStream.home==home, MatchStream.away==away).order_by(MatchStream.updated_at.desc()).first()
            if not row:
                return jsonify({'error': 'Запись не найдена'}), 404
            row.vk_video_id = None
            row.vk_post_url = None
            row.confirmed_at = None
            row.updated_at = datetime.now(timezone.utc)
            db.commit()
            return jsonify({'status': 'ok'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"streams/reset error: {e}")
        return jsonify({'error': 'Не удалось сбросить ссылку'}), 500

COMMENT_TTL_MINUTES = 60  # хранить комментарии трансляции 60 минут
COMMENT_RATE_MINUTES = 5

@app.route('/api/match/comments/list', methods=['GET'])
def api_match_comments_list():
    """Комментарии за последние COMMENT_TTL_MINUTES минут для матча. Параметры: home, away, date?"""
    try:
        if SessionLocal is None:
            return jsonify({'items': []})
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        date_str = (request.args.get('date') or '').strip()
        if not home or not away:
            return jsonify({'items': []})
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=COMMENT_TTL_MINUTES)
        db: Session = get_db()
        try:
            # Берём максимум 100 последних, затем переворачиваем в хронологический порядок
            q = db.query(MatchComment).filter(
                MatchComment.home==home,
                MatchComment.away==away,
                MatchComment.date==(date_str or None),
                MatchComment.created_at >= cutoff
            ).order_by(MatchComment.created_at.desc()).limit(100)
            rows_desc = q.all()
            rows = list(reversed(rows_desc))
            # Избегаем N+1: батч-достаем имена пользователей
            user_ids = list({int(r.user_id) for r in rows})
            names_map = {}
            if user_ids:
                for u in db.query(User).filter(User.user_id.in_(user_ids)).all():
                    try:
                        names_map[int(u.user_id)] = u.display_name or 'User'
                    except Exception:
                        pass
            items = []
            for r in rows:
                uid = int(r.user_id)
                items.append({
                    'user_id': uid,
                    'name': names_map.get(uid, 'User'),
                    'content': r.content,
                    'created_at': r.created_at.isoformat()
                })
            # ETag и Last-Modified
            last_ts = rows[-1].created_at if rows else None
            # Версия как md5 по (last_ts + count)
            version_seed = f"{last_ts.isoformat() if last_ts else ''}:{len(rows)}"
            etag = hashlib.md5(version_seed.encode('utf-8')).hexdigest()
            inm = request.headers.get('If-None-Match')
            ims = request.headers.get('If-Modified-Since')
            # Сравнение If-None-Match
            if inm and inm == etag:
                resp = app.response_class(status=304)
                resp.headers['ETag'] = etag
                if last_ts:
                    resp.headers['Last-Modified'] = last_ts.strftime('%a, %d %b %Y %H:%M:%S GMT')
                resp.headers['Cache-Control'] = 'no-cache'
                return resp
            # Сравнение If-Modified-Since
            if ims and last_ts:
                try:
                    # Разбор RFC1123
                    from email.utils import parsedate_to_datetime
                    ims_dt = parsedate_to_datetime(ims)
                    # Приводим к aware UTC
                    if ims_dt.tzinfo is None:
                        ims_dt = ims_dt.replace(tzinfo=timezone.utc)
                    if last_ts <= ims_dt:
                        resp = app.response_class(status=304)
                        resp.headers['ETag'] = etag
                        resp.headers['Last-Modified'] = last_ts.strftime('%a, %d %b %Y %H:%M:%S GMT')
                        resp.headers['Cache-Control'] = 'no-cache'
                        return resp
                except Exception:
                    pass
            resp = jsonify({'items': items, 'version': etag})
            resp.headers['ETag'] = etag
            if last_ts:
                resp.headers['Last-Modified'] = last_ts.strftime('%a, %d %b %Y %H:%M:%S GMT')
            resp.headers['Cache-Control'] = 'no-cache'
            return resp
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"comments/list error: {e}")
        return jsonify({'items': []})

@app.route('/api/match/comments/add', methods=['POST'])
def api_match_comments_add():
    """Добавляет комментарий (rate limit: 1 комментарий в 5 минут на пользователя/матч/дату)."""
    try:
        # Global anti-spam limiter: не чаще 3 комментариев за 60 секунд на пользователя
        limited = _rate_limit('comments_add', limit=3, window_sec=60, allow_pseudo=False)
        if limited is not None:
            return limited
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData',''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = int(parsed['user'].get('id'))
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        date_str = (request.form.get('date') or '').strip()
        content = (request.form.get('content') or '').strip()
        if not home or not away or not content:
            return jsonify({'error': 'Пустой комментарий'}), 400
        if len(content) > 280:
            return jsonify({'error': 'Слишком длинный комментарий'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            # rate limit: ищем последний комментарий этого пользователя под этим матчем
            window_start = datetime.now(timezone.utc) - timedelta(minutes=COMMENT_RATE_MINUTES)
            recent = db.query(MatchComment).filter(
                MatchComment.user_id==user_id,
                MatchComment.home==home,
                MatchComment.away==away,
                MatchComment.date==(date_str or None),
                MatchComment.created_at >= window_start
            ).order_by(MatchComment.created_at.desc()).first()
            if recent:
                return jsonify({'error': f'Можно комментировать раз в {COMMENT_RATE_MINUTES} минут'}), 429
            row = MatchComment(home=home, away=away, date=(date_str or None), user_id=user_id, content=content)
            db.add(row)
            # счетчик достижений
            cc = db.get(CommentCounter, user_id)
            if not cc:
                cc = CommentCounter(user_id=user_id, comments_total=0, updated_at=datetime.now(timezone.utc))
                db.add(cc)
            cc.comments_total = int(cc.comments_total or 0) + 1
            cc.updated_at = datetime.now(timezone.utc)
            db.commit()
            return jsonify({'status':'ok', 'created_at': row.created_at.isoformat(), 'comments_total': int(cc.comments_total or 0)})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"comments/add error: {e}")
        return jsonify({'error': 'Не удалось сохранить комментарий'}), 500

@app.route('/admin')
@app.route('/admin/')
@require_admin()          # теперь сам декоратор умеет принимать Telegram или cookie
@rate_limit(max_requests=10, time_window=300)
def admin_dashboard():
    """Админ панель управления (cookie+Telegram)."""
    return render_template('admin_dashboard.html')

@app.route('/admin/login', methods=['GET','POST'])
def admin_login_page():
    if request.method == 'GET':
        # Простой HTML без внешних зависимостей
        return ('<!doctype html><html><head><meta charset="utf-8"><title>Admin Login</title>'
                '<style>body{font-family:system-ui;background:#0f1720;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}'
                '.box{background:#111c28;padding:24px;border-radius:12px;min-width:320px;border:1px solid #243446}'
                'input{width:100%;padding:10px;margin:8px 0;border:1px solid #33475a;background:#182635;color:#fff;border-radius:6px}'
                'button{width:100%;padding:10px;background:#2563eb;color:#fff;border:0;border-radius:6px;font-weight:600;cursor:pointer}'
                'button:hover{background:#1d4ed8}'
                '.msg{margin-top:8px;font-size:12px;opacity:.85}'
                'a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}'
                '</style></head><body><form class="box" method="POST" autocomplete="off">'
                '<h2 style="margin:0 0 12px">Admin Login</h2>'
                '<input type="text" name="user" placeholder="Admin ID (Telegram)" required>'
                '<input type="password" name="password" placeholder="Admin Password" required>'
                '<button type="submit">Войти</button>'
                '<div class="msg">После входа откроется <a href="/admin">/admin</a>. <br>Используйте Telegram WebApp для автоматического входа.</div>'
                '</form></body></html>')
    # POST
    user = (request.form.get('user') or '').strip()
    password = (request.form.get('password') or '').strip()
    admin_id = os.environ.get('ADMIN_USER_ID','')
    admin_pass = os.environ.get('ADMIN_PASSWORD','')
    if not admin_id or not admin_pass:
        return 'Admin not configured', 500
    if user != admin_id or password != admin_pass:
        return 'Invalid credentials', 401
    # Выдать cookie (HMAC(admin_pass, admin_id))
    token = hmac.new(admin_pass.encode('utf-8'), admin_id.encode('utf-8'), hashlib.sha256).hexdigest()
    resp = flask.make_response(flask.redirect('/admin'))
    resp.set_cookie('admin_auth', token, httponly=True, secure=False, samesite='Lax', max_age=3600*6)
    return resp

@app.route('/admin/logout')
def admin_logout():
    resp = flask.make_response(flask.redirect('/admin/login'))
    # сбрасываем cookie
    resp.delete_cookie('admin_auth')
    return resp

# ---- Админ: сезонный rollover (дублируем здесь, т.к. blueprint admin не зарегистрирован) ----
def _admin_cookie_or_telegram_ok():
    """True если запрос от админа: либо валидный Telegram initData, либо cookie admin_auth."""
    admin_id = os.environ.get('ADMIN_USER_ID','')
    if not admin_id:
        return False
    # Telegram initData
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData','') or request.args.get('initData',''))
        if parsed and parsed.get('user') and str(parsed['user'].get('id')) == admin_id:
            return True
    except Exception:
        pass
    # Cookie fallback
    try:
        cookie_token = request.cookies.get('admin_auth')
        admin_pass = os.environ.get('ADMIN_PASSWORD','')
        if cookie_token and admin_pass:
            expected = hmac.new(admin_pass.encode('utf-8'), admin_id.encode('utf-8'), hashlib.sha256).hexdigest()
            if hmac.compare_digest(cookie_token, expected):
                return True
    except Exception:
        pass
    return False

@app.route('/api/admin/season/rollover', methods=['POST'])
def api_admin_season_rollover_inline():
    """Endpoint сезонного rollover (cookie или Telegram)."""
    if not _admin_cookie_or_telegram_ok():
        return jsonify({'error': 'Недействительные данные'}), 401
    try:
        # Расширенная схема
        from database.database_models import db_manager as adv_db_manager, Tournament
        adv_db_manager._ensure_initialized()
    except Exception as e:
        return jsonify({'error': f'advanced schema unavailable: {e}'}), 500
    dry_run = request.args.get('dry') in ('1','true','yes')
    soft_mode = request.args.get('soft') in ('1','true','yes')
    deep_mode = (not soft_mode) and (request.args.get('deep') in ('1','true','yes'))  # deep только в full-reset
    adv_sess = adv_db_manager.get_session()
    from sqlalchemy import text as _sql_text
    import json as _json, hashlib as _hashlib
    try:
        active = (adv_sess.query(Tournament)
                  .filter(Tournament.status=='active')
                  .order_by(Tournament.start_date.desc().nullslast(), Tournament.created_at.desc())
                  .first())
        def _compute_next(season_str: str|None):
            import re, datetime as _dt
            if season_str:
                m = re.match(r'^(\d{2})[-/](\d{2})$', season_str.strip())
                if m:
                    a=int(m.group(1)); b=int(m.group(2))
                    return f"{(a+1)%100:02d}-{(b+1)%100:02d}"
            now=_dt.date.today()
            if now.month>=7:
                a=now.year%100; b=(now.year+1)%100
            else:
                a=(now.year-1)%100; b=now.year%100
            return f"{a:02d}-{b:02d}"
        new_season = _compute_next(active.season if active else None)
        # rate-limit (10 мин) если не dry
        # Попытка создать таблицу season_rollovers заранее (чтобы SELECT не падал)
        try:
            adv_sess.execute(_sql_text("""
                CREATE TABLE IF NOT EXISTS season_rollovers (
                    id SERIAL PRIMARY KEY,
                    prev_tournament_id INT NULL,
                    prev_season TEXT NULL,
                    new_tournament_id INT NOT NULL,
                    new_season TEXT NOT NULL,
                    soft_mode BOOLEAN NOT NULL DEFAULT FALSE,
                    legacy_cleanup_done BOOLEAN NOT NULL DEFAULT FALSE,
                    pre_hash TEXT NULL,
                    post_hash TEXT NULL,
                    pre_meta TEXT NULL,
                    post_meta TEXT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )"""))
            adv_sess.commit()
        except Exception:
            try: adv_sess.rollback()
            except Exception: pass
        if not dry_run:
            try:
                last_row = adv_sess.execute(_sql_text("SELECT created_at FROM season_rollovers ORDER BY created_at DESC LIMIT 1")).fetchone()
                if last_row:
                    from datetime import datetime as _dtm, timezone as _tz
                    delta = (_dtm.now(_tz.utc) - last_row[0]).total_seconds()
                    if delta < 600:
                        return jsonify({'error':'rate_limited','retry_after_seconds': int(600-delta)}), 429
            except Exception as _rl_err:
                # Обязательно откатываем сессию — иначе дальнейшие запросы 'InFailedSqlTransaction'
                try: adv_sess.rollback()
                except Exception: pass
                app.logger.warning(f"season rollover rate-limit check failed (rollback applied): {_rl_err}")
        def _collect_summary():
            summary={}
            try:
                t_total = adv_sess.execute(_sql_text('SELECT COUNT(*) FROM tournaments')).scalar() or 0
                t_active = adv_sess.execute(_sql_text("SELECT COUNT(*) FROM tournaments WHERE status='active'" )).scalar() or 0
                last_season_row = adv_sess.execute(_sql_text('SELECT season FROM tournaments ORDER BY created_at DESC LIMIT 1')).fetchone()
                summary['tournaments_total']=t_total
                summary['tournaments_active']=t_active
                summary['last_season']= last_season_row[0] if last_season_row else None
                try:
                    m_total = adv_sess.execute(_sql_text('SELECT COUNT(*) FROM matches')).scalar() or 0
                    summary['matches_total']=m_total
                except Exception as _me:
                    summary['matches_total_error']=str(_me)
                ps_rows = adv_sess.execute(_sql_text('SELECT COUNT(*) FROM player_statistics')).scalar() or 0
                summary['player_statistics_rows']=ps_rows
            except Exception as _e:
                summary['error_tournaments']=str(_e)
            legacy_counts={}
            legacy_db_local = get_db()
            try:
                for tbl in ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags']:
                    try:
                        cnt = legacy_db_local.execute(_sql_text(f'SELECT COUNT(*) FROM {tbl}')).scalar() or 0
                        legacy_counts[tbl]=cnt
                    except Exception as _tbl_e:
                        legacy_counts[tbl]=f'err:{_tbl_e}'
            finally:
                try: legacy_db_local.close()
                except Exception: pass
            summary['legacy']=legacy_counts
            try:
                summary['_hash'] = _hashlib.sha256(_json.dumps(summary, sort_keys=True).encode()).hexdigest()
            except Exception:
                summary['_hash']=None
            return summary
        pre_summary=_collect_summary()
        if dry_run:
            return jsonify({
                'ok':True,
                'dry_run':True,
                'would_complete': active.season if active else None,
                'would_create': new_season,
                'soft_mode': soft_mode,
                'deep_mode': deep_mode,
                'legacy_cleanup': [] if soft_mode else ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags'],
                'advanced_cleanup': [] if (soft_mode or not deep_mode or not active) else ['matches','match_events','team_compositions','player_statistics'],
                'pre_hash': pre_summary.get('_hash'),
                'pre_summary': pre_summary
            })
        prev_id = active.id if active else None
        prev_season = active.season if active else None
        from datetime import date as _date
        if active:
            active.status='completed'; active.end_date=_date.today()
        new_tournament = Tournament(name=f"Лига Обнинска {new_season}",season=new_season,status='active',start_date=_date.today(),description=f"Сезон {new_season}")
        adv_sess.add(new_tournament)
        adv_sess.flush()
        # ensure audit table
        try:
            adv_sess.execute(_sql_text("""
                CREATE TABLE IF NOT EXISTS season_rollovers (
                    id SERIAL PRIMARY KEY,
                    prev_tournament_id INT NULL,
                    prev_season TEXT NULL,
                    new_tournament_id INT NOT NULL,
                    new_season TEXT NOT NULL,
                    soft_mode BOOLEAN NOT NULL DEFAULT FALSE,
                    legacy_cleanup_done BOOLEAN NOT NULL DEFAULT FALSE,
                    pre_hash TEXT NULL,
                    post_hash TEXT NULL,
                    pre_meta TEXT NULL,
                    post_meta TEXT NULL,
                    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )"""))
            for col in ['pre_hash TEXT','post_hash TEXT','pre_meta TEXT','post_meta TEXT']:
                try: adv_sess.execute(_sql_text(f'ALTER TABLE season_rollovers ADD COLUMN IF NOT EXISTS {col}'))
                except Exception: pass
        except Exception as _crt_err:
            app.logger.warning(f'season_rollovers create/alter failed: {_crt_err}')
        legacy_cleanup_done=False
        advanced_cleanup_done=False
        schedule_imported=0
        schedule_errors=[]
        if not soft_mode:
            legacy_db = get_db()
            try:
                for tbl in ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags']:
                    try: legacy_db.execute(_sql_text(f'DELETE FROM {tbl}'))
                    except Exception as tbl_err: app.logger.warning(f'Failed to clear {tbl}: {tbl_err}')
                legacy_db.commit(); legacy_cleanup_done=True
            finally:
                try: legacy_db.close()
                except Exception: pass
        # Deep advanced cleanup (старые матчи расширенной схемы + статистика) только если deep_mode
        if deep_mode and active and not dry_run:
            try:
                # Удаляем зависимые сущности явно (на случай отсутствия CASCADE в БД)
                adv_sess.execute(_sql_text('DELETE FROM match_events WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=:tid)'), {'tid': active.id})
                adv_sess.execute(_sql_text('DELETE FROM team_compositions WHERE match_id IN (SELECT id FROM matches WHERE tournament_id=:tid)'), {'tid': active.id})
                adv_sess.execute(_sql_text('DELETE FROM player_statistics WHERE tournament_id=:tid'), {'tid': active.id})
                adv_sess.execute(_sql_text('DELETE FROM matches WHERE tournament_id=:tid'), {'tid': active.id})
                advanced_cleanup_done=True
            except Exception as _adv_del_err:
                app.logger.warning(f'advanced deep cleanup failed: {_adv_del_err}')
        # Импорт расписания (первые 300 строк) для нового турнира если deep_mode + очистка колонок B,D (счета) до 300 строки
        if deep_mode and not dry_run:
            try:
                import json as _jsonmod, os as _os, datetime as _dt
                import gspread
                from google.oauth2.service_account import Credentials as _Creds
                creds_json = _os.environ.get('GOOGLE_SHEETS_CREDS_JSON','')
                sheet_url = _os.environ.get('GOOGLE_SHEET_URL','')
                if creds_json and sheet_url:
                    try:
                        creds_data = _jsonmod.loads(creds_json)
                        scope=['https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/drive']
                        creds=_Creds.from_service_account_info(creds_data, scopes=scope)
                        client=gspread.authorize(creds)
                        sh=client.open_by_url(sheet_url)
                        target_ws=None
                        for ws in sh.worksheets():
                            ttl=ws.title.lower()
                            if 'расписание' in ttl or 'schedule' in ttl:
                                target_ws=ws; break
                        if target_ws:
                            # Очистка колонок B и D (до 300 строки) — предполагаем что там счета/разделитель
                            try:
                                # gspread batch_clear требует A1 диапазоны
                                target_ws.batch_clear(["B2:B300","D2:D300"])
                            except Exception as _clr_err:
                                schedule_errors.append(f'clear_fail:{_clr_err}'[:120])
                            values = target_ws.get_all_values()[:301]  # включая header (0..300)
                            # Assume header row present -> parse rows after header
                            header = values[0] if values else []
                            # Heuristics: columns: [Дата, Дома, Гости, Время, Место ...]
                            for row in values[1:]:
                                if not row or len(row) < 3:
                                    continue
                                date_str = (row[0] or '').strip()
                                home_team = (row[1] or '').strip()
                                away_team = (row[2] or '').strip()
                                time_str = (row[3] or '').strip() if len(row) > 3 else ''
                                venue = (row[4] or '').strip() if len(row) > 4 else ''
                                if not (date_str and home_team and away_team):
                                    continue
                                # parse date/time
                                match_dt=None
                                for fmt in ("%d.%m.%Y %H:%M","%d.%m.%Y","%Y-%m-%d %H:%M","%Y-%m-%d"):
                                    try:
                                        if time_str and '%H:%M' in fmt:
                                            match_dt=_dt.datetime.strptime(f"{date_str} {time_str}", fmt)
                                        else:
                                            match_dt=_dt.datetime.strptime(date_str, fmt)
                                        break
                                    except ValueError:
                                        continue
                                if not match_dt:
                                    schedule_errors.append(f'bad_date:{date_str}')
                                    continue
                                # ensure teams
                                from database.database_models import Team, Match as AdvMatch
                                home = adv_sess.query(Team).filter(Team.name==home_team).first()
                                if not home:
                                    home=Team(name=home_team,is_active=True)
                                    adv_sess.add(home); adv_sess.flush()
                                away = adv_sess.query(Team).filter(Team.name==away_team).first()
                                if not away:
                                    away=Team(name=away_team,is_active=True)
                                    adv_sess.add(away); adv_sess.flush()
                                exists = adv_sess.query(AdvMatch).filter(AdvMatch.tournament_id==new_tournament.id,AdvMatch.home_team_id==home.id,AdvMatch.away_team_id==away.id,AdvMatch.match_date==match_dt).first()
                                if exists:
                                    continue
                                adv_sess.add(AdvMatch(tournament_id=new_tournament.id,home_team_id=home.id,away_team_id=away.id,match_date=match_dt,venue=venue,status='scheduled'))
                                schedule_imported+=1
                        else:
                            schedule_errors.append('worksheet_not_found')
                    except Exception as _sched_err:
                        schedule_errors.append(str(_sched_err)[:200])
                else:
                    schedule_errors.append('creds_or_url_missing')
            except Exception as _outer_sched_err:
                schedule_errors.append(f'outer:{_outer_sched_err}')
        audit_id=None
        try:
            res = adv_sess.execute(_sql_text("""
                INSERT INTO season_rollovers (prev_tournament_id, prev_season, new_tournament_id, new_season, soft_mode, legacy_cleanup_done, pre_hash, pre_meta)
                VALUES (:pid,:ps,:nid,:ns,:soft,:lcd,:ph,:pm) RETURNING id
            """), {'pid': prev_id,'ps': prev_season,'nid': new_tournament.id,'ns': new_season,'soft': soft_mode,'lcd': legacy_cleanup_done,'ph': pre_summary.get('_hash'),'pm': _json.dumps(pre_summary, ensure_ascii=False)})
            row = res.fetchone(); audit_id = row and row[0]
        except Exception as _ins_err:
            app.logger.warning(f'season_rollovers audit insert failed: {_ins_err}')
        post_summary=_collect_summary()
        try:
            if audit_id is not None:
                adv_sess.execute(_sql_text('UPDATE season_rollovers SET post_hash=:h, post_meta=:pm WHERE id=:id'), {'h': post_summary.get('_hash'),'pm': _json.dumps(post_summary, ensure_ascii=False),'id': audit_id})
        except Exception as _upd_err:
            app.logger.warning(f'season_rollovers audit post update failed: {_upd_err}')
        adv_sess.commit()
        # инвалидация кэшей
        try:
            from optimizations.multilevel_cache import get_cache as _gc
            cache=_gc();
            for key in ('league_table','stats_table','results','schedule','tours','betting-tours'):
                try: cache.invalidate(key)
                except Exception: pass
        except Exception as _c_err:
            app.logger.warning(f'cache invalidate failed season rollover: {_c_err}')
        # Фоновый прогрев кэшей (best-effort) чтобы UI не увидел пустоту после инвалидции
        try:
            from threading import Thread
            def _warm():
                try:
                    with app.app_context():
                        # Поддерживаемые refresh endpoints если существуют
                        import requests, os as _os
                        base = _os.environ.get('SELF_BASE_URL') or ''  # можно задать для продакшена
                        # Локально может не работать без полного URL — поэтому fallback пропускаем
                        endpoints = [
                            '/api/league-table','/api/stats-table','/api/schedule','/api/results','/api/betting/tours'
                        ]
                        for ep in endpoints:
                            try:
                                if base:
                                    requests.get(base+ep, timeout=3)
                            except Exception:
                                pass
                except Exception as _werr:
                    app.logger.warning(f'cache warm failed: {_werr}')
            Thread(target=_warm, daemon=True).start()
        except Exception as _tw:  # не критично
            app.logger.warning(f'failed to dispatch warm thread: {_tw}')
        return jsonify({
            'ok':True,
            'previous_season': prev_season,
            'new_season': new_season,
            'tournament_id': new_tournament.id,
            'soft_mode': soft_mode,
            'deep_mode': deep_mode,
            'legacy_cleanup_done': (not soft_mode) and legacy_cleanup_done,
            'advanced_cleanup_done': advanced_cleanup_done,
            'schedule_imported_matches': schedule_imported,
            'schedule_errors': schedule_errors,
            'pre_hash': pre_summary.get('_hash'),
            'post_hash': post_summary.get('_hash'),
            'cache_warm_dispatched': True
        })
    except Exception as e:
        app.logger.error(f'Season rollover error (inline): {e}')
        return jsonify({'error':'season rollover failed'}), 500
    finally:
        try: adv_sess.close()
        except Exception: pass

@app.route('/test-themes')
def test_themes():
    """Тестирование цветовых схем"""
    return render_template('theme_test.html')

@app.route('/admin/init-database', methods=['POST'])
@require_admin()
@rate_limit(max_requests=5, time_window=300)  # Строгое ограничение для опасных операций
@validate_input(action={'type':'string','required':True,'min_length':1})
def admin_init_database():
    """Админский роут для инициализации БД через веб-интерфейс"""
    try:
        # Простая авторизация через заголовок
        auth_header = request.headers.get('Authorization', '')
        admin_password = os.environ.get('ADMIN_PASSWORD', 'admin123')
        
        if not auth_header.startswith('Basic '):
            return jsonify({'error': 'Authorization required'}), 401
            
        import base64
        try:
            credentials = base64.b64decode(auth_header[6:]).decode('utf-8')
            username, password = credentials.split(':', 1)
        except:
            return jsonify({'error': 'Invalid authorization format'}), 401
            
        if username != 'admin' or password != admin_password:
            return jsonify({'error': 'Invalid credentials'}), 401
            
        # Импорт и запуск инициализации
        from scripts.init_database import main as init_main
        result = init_main()
        
        return jsonify({
            'status': 'success' if result == 0 else 'error',
            'message': 'Database initialized successfully' if result == 0 else 'Database initialization failed',
            'result_code': result
        })
        
    except Exception as e:
        import traceback
        tb = traceback.format_exc(limit=5)
        app.logger.error(f"Database initialization error: {e}\n{tb}")
        return jsonify({
            'status': 'error', 
            'message': str(e)
        }), 500

@app.route('/admin/init-database-form')
def admin_init_database_form():
    """Форма для инициализации БД"""
    return '''
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Liga Obninska - Database Initialization</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .container { background: #f5f5f5; padding: 30px; border-radius: 10px; }
            h2 { color: #1976d2; margin-bottom: 20px; }
            .form-group { margin-bottom: 15px; }
            label { display: block; margin-bottom: 5px; font-weight: bold; }
            input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
            button { background: #1976d2; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
            button:hover { background: #1565c0; }
            #result { margin-top: 20px; padding: 15px; border-radius: 5px; white-space: pre-wrap; }
            .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
            .info { background: #d1ecf1; color: #0c5460; border: 1px solid #bee5eb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>🏆 Liga Obninska - Database Initialization</h2>
            <p>Инициализация базы данных PostgreSQL. Выполните только один раз при первом деплое.</p>
            
            <div class="form-group">
                <label for="username">Admin Username:</label>
                <input type="text" id="username" value="admin" required>
            </div>
            
            <div class="form-group">
                <label for="password">Admin Password:</label>
                <input type="password" id="password" placeholder="Введите пароль" required>
            </div>
            
            <button onclick="initDatabase()">🚀 Initialize Database</button>
            
            <div id="result"></div>
        </div>
        
        <script>
        function initDatabase() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const resultDiv = document.getElementById('result');
            
            if (!password) {
                alert('Введите пароль!');
                return;
            }
            
            resultDiv.innerHTML = '<div class="info">⏳ Инициализация базы данных...</div>';
            
            fetch('/admin/init-database', {
                method: 'POST',
                headers: {
                    'Authorization': 'Basic ' + btoa(username + ':' + password)
                }
            })
            .then(response => response.json())
            .then(data => {
                const className = data.status === 'success' ? 'success' : 'error';
                resultDiv.innerHTML = `<div class="${className}">
                    <strong>Статус:</strong> ${data.status}
                    <br><strong>Сообщение:</strong> ${data.message}
                    ${data.result_code !== undefined ? '<br><strong>Код:</strong> ' + data.result_code : ''}
                </div>`;
                
                if (data.status === 'success') {
                    setTimeout(() => {
                        resultDiv.innerHTML += '<div class="info">✅ Теперь можете перейти к <a href="/admin">админ панели</a></div>';
                    }, 2000);
                }
            })
            .catch(error => {
                resultDiv.innerHTML = `<div class="error">
                    <strong>Ошибка:</strong> ${error.message || error}
                </div>`;
            });
        }
        </script>
    </body>
    </html>
    '''

@app.route('/api/admin/users-stats', methods=['POST'])
def api_admin_users_stats():
    """Статистика пользователей (только админ):
    - Всего пользователей
    - Онлайн за 5/15 минут
    - Активные уникальные за 1/7/30 дней (updated_at)
    - Новые пользователи за 30 дней (created_at)
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'total_users': 0, 'online_5m': 0, 'online_15m': 0, 'active_1d': 0, 'active_7d': 0, 'active_30d': 0, 'new_30d': 0})
        db: Session = get_db()
        try:
            total = db.query(func.count(User.user_id)).scalar() or 0
            now = datetime.now(timezone.utc)
            dt5 = now - timedelta(minutes=5)
            dt15 = now - timedelta(minutes=15)
            online5 = db.query(func.count(User.user_id)).filter(User.updated_at >= dt5).scalar() or 0
            online15 = db.query(func.count(User.user_id)).filter(User.updated_at >= dt15).scalar() or 0
            d1 = now - timedelta(days=1)
            d7 = now - timedelta(days=7)
            d30 = now - timedelta(days=30)
            active1 = db.query(func.count(func.distinct(User.user_id))).filter(User.updated_at >= d1).scalar() or 0
            active7 = db.query(func.count(func.distinct(User.user_id))).filter(User.updated_at >= d7).scalar() or 0
            active30 = db.query(func.count(func.distinct(User.user_id))).filter(User.updated_at >= d30).scalar() or 0
            new30 = db.query(func.count(User.user_id)).filter(User.created_at >= d30).scalar() or 0
            return jsonify({
                'total_users': int(total),
                'online_5m': int(online5), 'online_15m': int(online15),
                'active_1d': int(active1), 'active_7d': int(active7), 'active_30d': int(active30),
                'new_30d': int(new30),
                'ts': now.isoformat()
            })
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка admin users stats: {e}")
        return jsonify({'error': 'Не удалось получить статистику'}), 500

# ---------------- Version bump to force client cache refresh ----------------
def _get_app_version(db: Session) -> int:
    try:
        snap = _snapshot_get(db, 'app-version')
        if snap and isinstance(snap.get('payload'), dict):
            v = int(snap['payload'].get('ver') or 0)
            return max(0, v)
    except Exception:
        pass
    return 0

def _set_app_version(db: Session, ver: int):
    _snapshot_set(db, 'app-version', {'ver': int(ver), 'updated_at': datetime.now(timezone.utc).isoformat()})

@app.route('/api/version', methods=['GET'])
def api_version_get():
    try:
        if SessionLocal is None:
            return jsonify({'ver': 0, 'ts': datetime.now(timezone.utc).isoformat()})
        db: Session = get_db()
        try:
            ver = _get_app_version(db)
            return jsonify({'ver': int(ver), 'ts': datetime.now(timezone.utc).isoformat()})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"version get error: {e}")
        return jsonify({'ver': 0})

@app.route('/api/admin/bump-version', methods=['POST'])
def api_admin_bump_version():
    """Инкремент глобальной версии ассетов (кэш-бастинг). Только админ по initData."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            cur = _get_app_version(db)
            newv = cur + 1
            _set_app_version(db, newv)
            return jsonify({'status': 'ok', 'ver': int(newv)})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"bump-version error: {e}")
        return jsonify({'error': 'Не удалось обновить версию'}), 500

@app.route('/api/admin/bulk-lineups', methods=['POST'])
def api_admin_bulk_lineups():
    """Массовый импорт составов для матча"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Неверные данные'}), 400
            
        match_id = data.get('match_id')
        home_lineup = data.get('home_lineup', '').strip()
        away_lineup = data.get('away_lineup', '').strip()
        mode = data.get('mode', 'replace')
        
        if not match_id:
            return jsonify({'error': 'Не указан ID матча'}), 400
            
        if not home_lineup and not away_lineup:
            return jsonify({'error': 'Не указан ни один состав'}), 400
        
        def parse_lineup(text):
            """Парсинг состава из текста"""
            players = []
            lines = [line.strip() for line in text.split('\n') if line.strip()]
            for i, line in enumerate(lines):
                # Формат: "номер имя фамилия" или "номер имя фамилия (C)" для капитана
                parts = line.split()
                if len(parts) < 2:
                    continue
                    
                try:
                    number = int(parts[0])
                except ValueError:
                    continue
                    
                name = ' '.join(parts[1:])
                is_captain = '(C)' in name or name.endswith('*')
                name = name.replace('(C)', '').replace('*', '').strip()
                is_starter = i < 11  # Первые 11 - стартовый состав
                
                players.append({
                    'number': number,
                    'name': name,
                    'is_captain': is_captain,
                    'is_starter': is_starter
                })
            return players
        
        result_message = []
        
        if home_lineup:
            home_players = parse_lineup(home_lineup)
            result_message.append(f"Домашние: {len(home_players)} игроков")
            
        if away_lineup:
            away_players = parse_lineup(away_lineup)
            result_message.append(f"Гости: {len(away_players)} игроков")
        
        # В реальной реализации здесь была бы запись в БД
        # Для демонстрации просто возвращаем успех
        return jsonify({
            'status': 'success',
            'message': ', '.join(result_message),
            'mode': mode
        })
        
    except Exception as e:
        app.logger.error(f"bulk-lineups error: {e}")
        return jsonify({'error': 'Ошибка при импорте составов'}), 500

############################
# Новости API (перезаписано)
############################

def _get_news_session():
    """Возвращает SQLAlchemy session для модели News.
    1) Пробуем взять advanced db_manager (если новая архитектура активна)
    2) Иначе fallback на legacy get_db()
    """
    try:
        from database.database_models import db_manager as _adv_db  # type: ignore
        return _adv_db.get_session()
    except Exception:
        return get_db()


@app.route('/api/admin/news', methods=['GET'])
def api_admin_news_list():
    """Список новостей (админ)."""
    try:
        if News is None:
            return jsonify({'error': 'Модель новостей недоступна'}), 500
        parsed = parse_and_verify_telegram_init_data(request.args.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'Доступ запрещен'}), 403
        if not SessionLocal:
            return jsonify({'error': 'База данных недоступна'}), 500

        db = _get_news_session()
        try:
            rows = db.query(News).order_by(News.created_at.desc()).all()
            return jsonify({'news': [
                {
                    'id': r.id,
                    'title': r.title,
                    'content': r.content,
                    'author_id': r.author_id,
                    'created_at': r.created_at.isoformat() if r.created_at else None,
                    'updated_at': r.updated_at.isoformat() if r.updated_at else None
                } for r in rows
            ]})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"news list error: {e}")
        return jsonify({'error': 'Ошибка при получении новостей'}), 500


@app.route('/api/admin/news', methods=['POST'])
def api_admin_news_create():
    """Создать новость (админ)."""
    try:
        if News is None:
            return jsonify({'error': 'Модель новостей недоступна'}), 500
        data = request.get_json() or {}
        parsed = parse_and_verify_telegram_init_data(data.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'Доступ запрещен'}), 403

        title = (data.get('title') or '').strip()
        content = (data.get('content') or '').strip()
        if not title or not content:
            return jsonify({'error': 'Заголовок и содержание обязательны'}), 400
        if not SessionLocal:
            return jsonify({'error': 'База данных недоступна'}), 500

        db = _get_news_session()
        try:
            news = News(title=title, content=content, author_id=int(user_id))
            db.add(news)
            db.commit()

            # Инвалидация + прогрев
            try:
                from optimizations.multilevel_cache import get_cache
                cache = get_cache()
                cache.invalidate_pattern('cache:news')
                try:
                    latest = db.query(News).order_by(News.created_at.desc()).limit(5).all()
                    warm_payload = [
                        {
                            'id': r.id,
                            'title': r.title,
                            'content': r.content,
                            'created_at': r.created_at.isoformat() if r.created_at else None
                        } for r in latest
                    ]
                    cache.set('news', warm_payload, 'limit:5:offset:0')
                    
                    # Публикуем обновление новостей через автоподписки
                    try:
                        if 'subscription_manager' in app.config:
                            sub_manager = app.config['subscription_manager']
                            sub_manager.publish(
                                SubscriptionType.NEWS,
                                {
                                    'items': warm_payload,
                                    'updated_at': datetime.now(timezone.utc).isoformat(),
                                    'action': 'created'
                                }
                            )
                    except Exception as pub_e:
                        app.logger.warning(f"Failed to publish news update: {pub_e}")
                except Exception:
                    pass
            except Exception as _e:
                app.logger.warning(f"news cache invalidate (create) failed: {_e}")

            return jsonify({'status': 'success', 'id': news.id, 'title': news.title, 'content': news.content})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"news create error: {e}")
        return jsonify({'error': 'Ошибка при создании новости'}), 500


@app.route('/api/admin/news/<int:news_id>', methods=['PUT'])
def api_admin_news_update(news_id):
    """Обновить новость (админ)."""
    try:
        if News is None:
            return jsonify({'error': 'Модель новостей недоступна'}), 500
        data = request.get_json() or {}
        parsed = parse_and_verify_telegram_init_data(data.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'Доступ запрещен'}), 403
        if not SessionLocal:
            return jsonify({'error': 'База данных недоступна'}), 500

        db = _get_news_session()
        try:
            news = db.query(News).filter(News.id == news_id).first()
            if not news:
                return jsonify({'error': 'Новость не найдена'}), 404

            title = (data.get('title') or '').strip()
            content = (data.get('content') or '').strip()
            if title:
                news.title = title
            if content:
                news.content = content
            news.updated_at = datetime.now(timezone.utc)
            db.commit()

            try:
                from optimizations.multilevel_cache import get_cache
                cache = get_cache()
                cache.invalidate_pattern('cache:news')
                try:
                    latest = db.query(News).order_by(News.created_at.desc()).limit(5).all()
                    warm_payload = [
                        {
                            'id': r.id,
                            'title': r.title,
                            'content': r.content,
                            'created_at': r.created_at.isoformat() if r.created_at else None
                        } for r in latest
                    ]
                    cache.set('news', warm_payload, 'limit:5:offset:0')
                except Exception:
                    pass
            except Exception as _e:
                app.logger.warning(f"news cache invalidate (update) failed: {_e}")

            return jsonify({'status': 'success', 'id': news.id, 'title': news.title, 'content': news.content})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"news update error: {e}")
        return jsonify({'error': 'Ошибка при обновлении новости'}), 500


@app.route('/api/admin/news/<int:news_id>', methods=['DELETE'])
def api_admin_news_delete(news_id):
    """Удалить новость (админ)."""
    try:
        if News is None:
            return jsonify({'error': 'Модель новостей недоступна'}), 500
        parsed = parse_and_verify_telegram_init_data(request.args.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'Доступ запрещен'}), 403
        if not SessionLocal:
            return jsonify({'error': 'База данных недоступна'}), 500

        db = _get_news_session()
        try:
            news = db.query(News).filter(News.id == news_id).first()
            if not news:
                return jsonify({'error': 'Новость не найдена'}), 404
            db.delete(news)
            db.commit()

            try:
                from optimizations.multilevel_cache import get_cache
                cache = get_cache()
                cache.invalidate_pattern('cache:news')
                try:
                    latest = db.query(News).order_by(News.created_at.desc()).limit(5).all()
                    warm_payload = [
                        {
                            'id': r.id,
                            'title': r.title,
                            'content': r.content,
                            'created_at': r.created_at.isoformat() if r.created_at else None
                        } for r in latest
                    ]
                    cache.set('news', warm_payload, 'limit:5:offset:0')
                except Exception:
                    pass
            except Exception as _e:
                app.logger.warning(f"news cache invalidate (delete) failed: {_e}")

            return jsonify({'status': 'success'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"news delete error: {e}")
        return jsonify({'error': 'Ошибка при удалении новости'}), 500


@app.route('/api/news', methods=['GET'])
def api_news_public():
    """Публичный список новостей (кэш + ETag)."""
    try:
        if News is None:
            return jsonify({'news': []})
        if not SessionLocal:
            return jsonify({'error': 'База данных недоступна'}), 500
        from optimizations.multilevel_cache import get_cache
        cache = get_cache()
        limit = min(int(request.args.get('limit', 5)), 50)
        offset = max(int(request.args.get('offset', 0)), 0)

        def _load():
            db = _get_news_session()
            try:
                q = db.query(News).order_by(News.created_at.desc())
                if offset:
                    q = q.offset(offset)
                q = q.limit(limit)
                rows = q.all()
                return [
                    {
                        'id': r.id,
                        'title': r.title,
                        'content': r.content,
                        'created_at': r.created_at.isoformat() if r.created_at else None
                    } for r in rows
                ]
            finally:
                db.close()

        news_list = cache.get('news', identifier=f"limit:{limit}:offset:{offset}", loader_func=_load) or []
        try:
            import hashlib as _hl, json as _json
            _core = _json.dumps(news_list, ensure_ascii=False, sort_keys=True).encode('utf-8')
            etag = _hl.md5(_core).hexdigest()
            inm = request.headers.get('If-None-Match')
            if inm and inm == etag:
                resp = app.response_class(status=304)
                resp.headers['ETag'] = etag
                resp.headers['Cache-Control'] = 'public, max-age=120, stale-while-revalidate=60'
                return resp
            resp = jsonify({'news': news_list, 'version': etag})
            resp.headers['ETag'] = etag
            resp.headers['Cache-Control'] = 'public, max-age=120, stale-while-revalidate=60'
            return resp
        except Exception:
            return jsonify({'news': news_list})
    except Exception as e:
        app.logger.error(f"public news error: {e}")
        return jsonify({'error': 'Ошибка при получении новостей'}), 500

@app.route('/api/admin/subscriptions/stats', methods=['GET'])
def api_admin_subscription_stats():
    """Статистика системы автоподписок (только для админа)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.args.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
            
        if 'subscription_manager' in app.config:
            sub_manager = app.config['subscription_manager']
            stats = sub_manager.get_stats()
            
            # Добавляем информацию о WebSocket подключениях
            if 'websocket_manager' in app.config:
                ws_manager = app.config['websocket_manager']
                stats['websocket_connections'] = ws_manager.get_connected_count()
            
            return jsonify(stats)
        else:
            return jsonify({'error': 'Subscription manager not available'}), 503
            
    except Exception as e:
        app.logger.error(f"subscription stats error: {e}")
        return jsonify({'error': 'Ошибка при получении статистики'}), 500

@app.route('/api/stats-table', methods=['GET'])
def api_stats_table():
    """Возвращает таблицу статистики из снапшота БД; при отсутствии — bootstrap из Sheets. ETag/304 поддерживаются."""
    try:
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                snap = _snapshot_get(db, 'stats-table')
                if snap and snap.get('payload'):
                    payload = snap['payload']
                    _core = {'range': payload.get('range'), 'values': payload.get('values')}
                    _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                    inm = request.headers.get('If-None-Match')
                    if inm and inm == _etag:
                        resp = app.response_class(status=304)
                        resp.headers['ETag'] = _etag
                        resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
                        return resp
                    resp = jsonify({**payload, 'version': _etag})
                    resp.headers['ETag'] = _etag
                    resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
                    return resp
                # Если снапшота нет – сформируем таблицу из реальных игроков БД
                # Структура: A: Имя, B: Матчи, C: Голы, D: Пасы, E: Желтые, F: Красные, G: Очки
                try:
                    from database.database_models import PlayerStatistics, Player, MatchEvent
                except Exception:
                    PlayerStatistics = Player = MatchEvent = None
                    
                temp_values = []
                header = ['Игрок', 'Матчи', 'Голы', 'Пасы', 'ЖК', 'КК', 'Очки']
                
                if Player and MatchEvent:
                    try:
                        # Получаем статистику игроков из событий матчей
                        from sqlalchemy import func, desc
                        
                        # Подзапрос для подсчета голов
                        goals_subq = db.query(
                            MatchEvent.player_id,
                            func.count(MatchEvent.id).label('goals')
                        ).filter(MatchEvent.event_type == 'goal').group_by(MatchEvent.player_id).subquery()
                        
                        # Подзапрос для подсчета передач
                        assists_subq = db.query(
                            MatchEvent.assisted_by_player_id.label('player_id'),
                            func.count(MatchEvent.id).label('assists')
                        ).filter(
                            MatchEvent.event_type == 'goal',
                            MatchEvent.assisted_by_player_id.isnot(None)
                        ).group_by(MatchEvent.assisted_by_player_id).subquery()
                        
                        # Подзапрос для желтых карточек
                        yellow_subq = db.query(
                            MatchEvent.player_id,
                            func.count(MatchEvent.id).label('yellows')
                        ).filter(MatchEvent.event_type == 'yellow_card').group_by(MatchEvent.player_id).subquery()
                        
                        # Подзапрос для красных карточек
                        red_subq = db.query(
                            MatchEvent.player_id,
                            func.count(MatchEvent.id).label('reds')
                        ).filter(MatchEvent.event_type == 'red_card').group_by(MatchEvent.player_id).subquery()
                        
                        # Основной запрос с джойнами
                        stats_query = db.query(
                            Player.first_name,
                            Player.last_name,
                            func.coalesce(goals_subq.c.goals, 0).label('goals'),
                            func.coalesce(assists_subq.c.assists, 0).label('assists'),
                            func.coalesce(yellow_subq.c.yellows, 0).label('yellows'),
                            func.coalesce(red_subq.c.reds, 0).label('reds')
                        ).outerjoin(goals_subq, Player.id == goals_subq.c.player_id
                        ).outerjoin(assists_subq, Player.id == assists_subq.c.player_id
                        ).outerjoin(yellow_subq, Player.id == yellow_subq.c.player_id
                        ).outerjoin(red_subq, Player.id == red_subq.c.player_id
                        ).order_by(
                            desc(func.coalesce(goals_subq.c.goals, 0) + func.coalesce(assists_subq.c.assists, 0)),  # по голам+передачам
                            desc(func.coalesce(goals_subq.c.goals, 0))  # затем по голам
                        ).limit(10)
                        
                        results = stats_query.all()
                        
                        for row in results:
                            name = (row.first_name or '') + ((' ' + row.last_name) if row.last_name else '')
                            goals = int(row.goals or 0)
                            assists = int(row.assists or 0)
                            yellows = int(row.yellows or 0)
                            reds = int(row.reds or 0)
                            points = goals + assists
                            matches = 0  # пока не считаем матчи, можно добавить позже
                            
                            temp_values.append([name, matches, goals, assists, yellows, reds, points])
                            
                        # Если игроков меньше 10, добавляем игроков без событий
                        if len(temp_values) < 10:
                            remaining_players = db.query(Player).filter(
                                ~Player.id.in_([r[0] for r in results] if results else [])
                            ).limit(10 - len(temp_values)).all()
                            
                            for p in remaining_players:
                                name = (p.first_name or '') + ((' ' + p.last_name) if p.last_name else '')
                                temp_values.append([name, 0, 0, 0, 0, 0, 0])
                                
                    except Exception as e:
                        app.logger.warning(f"Stats query error: {e}")
                        pass
                        
                # Если все еще нет данных, случайные игроки из Player таблицы
                if not temp_values and Player:
                    try:
                        players = db.query(Player).limit(10).all()
                        for p in players:
                            name = (p.first_name or '') + ((' ' + p.last_name) if p.last_name else '')
                            temp_values.append([name, 0, 0, 0, 0, 0, 0])
                    except Exception:
                        pass
                        
                if not temp_values:
                    # Заглушки, если нет игроков
                    temp_values = [[f'Игрок {i}', 0, 0, 0, 0, 0, 0] for i in range(1, 11)]
                payload = {
                    'range': 'A1:G11',
                    'values': [header] + temp_values,
                    'updated_at': datetime.now(timezone.utc).isoformat()
                }
                _snapshot_set(db, 'stats-table', payload)
                _core = {'range': 'A1:G11', 'values': payload.get('values')}
                _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
                resp = jsonify({**payload, 'version': _etag})
                resp.headers['ETag'] = _etag
                resp.headers['Cache-Control'] = 'public, max-age=600, stale-while-revalidate=300'
                return resp
            finally:
                db.close()

        payload = _build_stats_payload_from_sheet()
        _core = {'range': 'A1:G11', 'values': payload.get('values')}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        if SessionLocal is not None:
            db = get_db()
            try:
                _snapshot_set(db, 'stats-table', payload)
            finally:
                db.close()

        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'public, max-age=1800, stale-while-revalidate=600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы статистики: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить статистику'}), 500

@app.route('/api/specials/set', methods=['POST'])
def api_specials_set():
    """Админ-эндпоинт для фиксации факта пенальти/красной карточки в матче.
    Поля: initData, home, away, [penalty_yes=0|1], [redcard_yes=0|1]
    Требуется совпадение user_id с ADMIN_USER_ID.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        val_pen = request.form.get('penalty_yes')
        val_red = request.form.get('redcard_yes')
        def to_int01(v):
            if v is None or v == '':
                return None
            return 1 if str(v).strip() in ('1','true','yes','on') else 0
        p_yes = to_int01(val_pen)
        r_yes = to_int01(val_red)
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchSpecials).filter(MatchSpecials.home==home, MatchSpecials.away==away).first()
            when = datetime.now(timezone.utc)
            if not row:
                row = MatchSpecials(home=home, away=away)
                db.add(row)
            if p_yes is not None:
                row.penalty_yes = p_yes
            if r_yes is not None:
                row.redcard_yes = r_yes
            row.updated_at = when
            db.commit()
            return jsonify({'status': 'ok', 'home': home, 'away': away, 'penalty_yes': row.penalty_yes, 'redcard_yes': row.redcard_yes, 'updated_at': when.isoformat()})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка specials/set: {e}")
        return jsonify({'error': 'Не удалось сохранить данные'}), 500

@app.route('/api/specials/get', methods=['GET'])
def api_specials_get():
    """Получить текущее состояние спецсобытий для матча (penalty/redcard). Параметры: home, away"""
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchSpecials).filter(MatchSpecials.home==home, MatchSpecials.away==away).first()
            return jsonify({
                'home': home,
                'away': away,
                'penalty_yes': (None if not row else row.penalty_yes),
                'redcard_yes': (None if not row else row.redcard_yes)
            })
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка specials/get: {e}")
        return jsonify({'error': 'Не удалось получить данные'}), 500

# Точечный расчёт спецрынков по одному матчу и одному рынку
@app.route('/api/specials/settle', methods=['POST'])
def api_specials_settle():
    """Админ: рассчитать ставки по спецрынку (penalty|redcard) для конкретного матча.
    Поля: initData, home, away, market ('penalty'|'redcard').
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        market = (request.form.get('market') or '').strip().lower()
        if not home or not away or market not in ('penalty','redcard'):
            return jsonify({'error': 'home/away/market обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500

        db: Session = get_db()
        try:
            now = datetime.now()
            # Получим открытые ставки по матчу и рынку
            bets = db.query(Bet).filter(
                Bet.status == 'open',
                Bet.home == home,
                Bet.away == away,
                Bet.market == market
            ).all()
            changed = 0
            won_cnt = 0
            lost_cnt = 0
            for b in bets:
                # Аналог логики из _settle_open_bets для спецрынков
                res = _get_special_result(home, away, market)
                if res is None:
                    finished = False
                    if b.match_datetime:
                        try:
                            end_dt = b.match_datetime + timedelta(minutes=BET_MATCH_DURATION_MINUTES)
                        except Exception:
                            end_dt = b.match_datetime
                        if end_dt <= now:
                            finished = True
                    if not finished:
                        r = _get_match_result(home, away)
                        if r is not None:
                            finished = True
                        else:
                            tg = _get_match_total_goals(home, away)
                            if tg is not None:
                                finished = True
                    if not finished:
                        # матч ещё не завершён и события не зафиксированы — пропустим
                        continue
                    res = False

                won = ((res is True) and b.selection == 'yes') or ((res is False) and b.selection == 'no')
                if won:
                    try:
                        odd = float(b.odds or '2.0')
                    except Exception:
                        odd = 2.0
                    payout = int(round(b.stake * odd))
                    b.status = 'won'
                    b.payout = payout
                    u = db.get(User, b.user_id)
                    if u:
                        u.credits = int(u.credits or 0) + payout
                        u.updated_at = datetime.now(timezone.utc)
                    won_cnt += 1
                else:
                    b.status = 'lost'
                    b.payout = 0
                    lost_cnt += 1
                b.updated_at = datetime.now(timezone.utc)
                changed += 1
            if changed:
                db.commit()
            return jsonify({'status':'ok', 'changed': changed, 'won': won_cnt, 'lost': lost_cnt})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка specials/settle: {e}")
        return jsonify({'error': 'Не удалось выполнить расчёт'}), 500

# Полный расчёт матча (все рынки): вызывается админом во время матча (ничего не изменит, если данные не готовы)
# и после 2 часов от начала матча должен закрыть все открытые ставки по этому матчу.
@app.route('/api/match/settle', methods=['POST'])
def api_match_settle():
    """Админ: рассчитать все открытые ставки по матчу (1x2, totals, specials). Спецрынки не пересчитываются,
    если были ранее закрыты отдельной кнопкой. Требует initData админа. Поля: initData, home, away."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500

        db: Session = get_db()
        try:
            now = datetime.now()
            # Принудительно записываем результат в снапшот results после settle
            ms = db.query(MatchScore).filter(MatchScore.home==home, MatchScore.away==away).first()
            if ms and (ms.score_home is not None) and (ms.score_away is not None):
                # Читаем снапшот
                snap = _snapshot_get(db, 'results') if SessionLocal is not None else None
                payload = (snap and snap.get('payload')) or {'results': [], 'updated_at': datetime.now(timezone.utc).isoformat()}
                results = payload.get('results') or []
                
                # Ищем существующий результат
                found_idx = None
                for i, r in enumerate(results):
                    if r.get('home') == home and r.get('away') == away:
                        found_idx = i
                        break
                
                # Обновляем или добавляем
                result_entry = {
                    'home': home, 
                    'away': away, 
                    'score_home': int(ms.score_home), 
                    'score_away': int(ms.score_away)
                }
                if found_idx is not None:
                    results[found_idx] = result_entry
                else:
                    results.append(result_entry)
                
                payload['results'] = results
                payload['updated_at'] = datetime.now(timezone.utc).isoformat()
                _snapshot_set(db, 'results', payload)
                
                # Также записываем в Google Sheets
                try:
                    mirror_match_score_to_schedule(home, away, int(ms.score_home), int(ms.score_away))
                except Exception:
                    pass
            # Автоматически зафиксируем спецрынки как 'Нет', если админ их не установил
            try:
                spec_row = db.query(MatchSpecials).filter(MatchSpecials.home==home, MatchSpecials.away==away).first()
                auto_fixed = False
                if not spec_row:
                    spec_row = MatchSpecials(home=home, away=away)
                    db.add(spec_row)
                    # оба None => выставим 0 (нет события)
                    spec_row.penalty_yes = 0
                    spec_row.redcard_yes = 0
                    auto_fixed = True
                else:
                    # Если отдельный расчёт не производился (поля None) — устанавливаем 0
                    if spec_row.penalty_yes is None:
                        spec_row.penalty_yes = 0
                        auto_fixed = True
                    if spec_row.redcard_yes is None:
                        spec_row.redcard_yes = 0
                        auto_fixed = True
                if auto_fixed:
                    spec_row.updated_at = datetime.now(timezone.utc)
                    db.flush()
            except Exception as _spec_auto_err:
                try: app.logger.warning(f"auto specials fix failed: {_spec_auto_err}")
                except Exception: pass

            # Подсчёт total_bets до расчёта (все ставки по матчу)
            total_bets_cnt = db.query(func.count(Bet.id)).filter(Bet.home==home, Bet.away==away).scalar() or 0
            open_before_cnt = db.query(func.count(Bet.id)).filter(Bet.home==home, Bet.away==away, Bet.status=='open').scalar() or 0
            open_bets = db.query(Bet).filter(Bet.status=='open', Bet.home==home, Bet.away==away).all()
            changed = 0
            won_cnt = 0
            lost_cnt = 0
            for b in open_bets:
                # Блокируем ранний расчёт до старта
                if b.match_datetime and b.match_datetime > now:
                    continue
                res_known = False
                won = False
                if b.market == '1x2':
                    res = _get_match_result(b.home, b.away)
                    if res is None:
                        continue
                    res_known = True
                    won = (res == b.selection)
                elif b.market == 'totals':
                    sel_raw = (b.selection or '').strip()
                    side=None; line=None
                    if '_' in sel_raw:  # старый формат over_3.5
                        parts = sel_raw.split('_',1)
                        if len(parts)==2:
                            side = parts[0];
                            try: line=float(parts[1])
                            except Exception: line=None
                    else:  # новый формат O35 / U45 / U55
                        if len(sel_raw) in (3,4) and sel_raw[0] in ('O','U') and sel_raw[1:].isdigit():
                            side = 'over' if sel_raw[0]=='O' else 'under'
                            mp={'35':'3.5','45':'4.5','55':'5.5'}; ln=mp.get(sel_raw[1:], sel_raw[1:])
                            try: line=float(ln)
                            except Exception: line=None
                    if side not in ('over','under') or line is None:
                        try:
                            app.logger.warning(f"Totals bet {b.id}: invalid selection '{sel_raw}' - side={side}, line={line}")
                        except: pass
                        continue
                    total = _get_match_total_goals(b.home, b.away)
                    if total is None:
                        try:
                            app.logger.warning(f"Totals bet {b.id}: no total goals found for {b.home} vs {b.away}")
                        except: pass
                        continue
                    res_known = True
                    won = (total > line) if side == 'over' else (total < line)
                    try:
                        app.logger.info(f"Totals bet {b.id}: {sel_raw} vs total {total} -> {'WON' if won else 'LOST'}")
                    except: pass
                elif b.market in ('penalty','redcard'):
                    # Спецрынки: если админ уже зафиксировал и рассчитал раньше — их ставки уже не open
                    res = _get_special_result(b.home, b.away, b.market)
                    if res is None:
                        # По кнопке "Матч завершён" — финализируем как "Нет" (событие не было зафиксировано)
                        res = False
                    res_known = True
                    won = ((res is True) and b.selection == 'yes') or ((res is False) and b.selection == 'no')
                else:
                    continue

                if not res_known:
                    continue
                if won:
                    try:
                        odd = float(b.odds or '2.0')
                    except Exception:
                        odd = 2.0
                    payout = int(round(b.stake * odd))
                    b.status = 'won'
                    b.payout = payout
                    u = db.get(User, b.user_id)
                    if u:
                        u.credits = int(u.credits or 0) + payout
                        u.updated_at = datetime.now(timezone.utc)
                    won_cnt += 1
                else:
                    b.status = 'lost'
                    b.payout = 0
                    lost_cnt += 1
                b.updated_at = datetime.now(timezone.utc)
                changed += 1
            if changed:
                db.commit()
            # После фиксации ставок попробуем записать счёт в Google Sheets (best-effort)
            try:
                ms = db.query(MatchScore).filter(MatchScore.home==home, MatchScore.away==away).first()
                if ms and (ms.score_home is not None) and (ms.score_away is not None):
                    mirror_match_score_to_schedule(home, away, int(ms.score_home), int(ms.score_away))
            except Exception:
                pass
            # --- Агрегация статистики игроков ---
            try:
                # 1. Получаем составы из MatchLineupPlayer (для игр)
                lineup_rows = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).all()
                # 2. Получаем события (goal/assist/yellow/red)
                event_rows = db.query(MatchPlayerEvent).filter(MatchPlayerEvent.home==home, MatchPlayerEvent.away==away).all()
                # 3. Обновляем games для всех игроков из составов обеих команд (старт + запасные считаются как сыгравшие, по требованиям)
                from collections import defaultdict
                team_players_games = defaultdict(set)  # team -> set(player)
                for r in lineup_rows:
                    team_players_games[r.team].add(r.player.strip())
                def upsert_player(team, player):
                    pl = db.query(TeamPlayerStats).filter(TeamPlayerStats.team==team, TeamPlayerStats.player==player).first()
                    if not pl:
                        pl = TeamPlayerStats(team=team, player=player)
                        db.add(pl)
                    return pl
                for team_side, players_set in team_players_games.items():
                    for p in players_set:
                        if not p:
                            continue
                        entry = upsert_player(team_side, p)
                        entry.games = (entry.games or 0) + 1  # инкрементируем; защита от повторного вызова ниже
                        entry.updated_at = datetime.now(timezone.utc)
                # 4. Применяем события. Чтобы избежать двойного подсчёта при повторном settle, проверим state.
                state = db.query(MatchStatsAggregationState).filter(MatchStatsAggregationState.home==home, MatchStatsAggregationState.away==away).first()
                if not state:
                    state = MatchStatsAggregationState(home=home, away=away, lineup_counted=1, events_applied=0)
                    db.add(state)
                    db.flush()
                else:
                    # Если lineup уже считался ранее — откатим games инкремент чтобы не удваивать
                    if state.lineup_counted == 1:
                        # Мы уже когда-то добавляли games. Поэтому теперь откатим предыдущее добавление и пересчитаем games корректно.
                        # Для простоты: пересчитаем games заново — установим games = games (без +1) (т.к. удвоения).
                        # NOTE: Для предотвращения двукратного увеличения можно пропустить инкремент, если уже counted.
                        for team_side, players_set in team_players_games.items():
                            for p in players_set:
                                pl = db.query(TeamPlayerStats).filter(TeamPlayerStats.team==team_side, TeamPlayerStats.player==p).first()
                                if pl and pl.games>0:
                                    pl.games -= 1  # откат предыдущего добавления
                        # Не инкрементируем второй раз
                    else:
                        state.lineup_counted = 1
                # После нормализации: гарантированно games +=1 один раз
                if state and state.lineup_counted == 0:
                    for team_side, players_set in team_players_games.items():
                        for p in players_set:
                            pl = db.query(TeamPlayerStats).filter(TeamPlayerStats.team==team_side, TeamPlayerStats.player==p).first()
                            if pl:
                                pl.games = (pl.games or 0) + 1
                # Обновляем события если ещё не применены
                if state.events_applied == 0:
                    for ev in event_rows:
                        player = (ev.player or '').strip();
                        if not player: continue
                        team_side = ev.team or 'home'
                        pl = upsert_player(team_side, player)
                        # Если у игрока ещё 0 игр (и не добавлялся по составу) — считаем, что сыграл
                        if not pl.games:
                            pl.games = 1
                        if ev.type == 'goal': pl.goals = (pl.goals or 0) + 1
                        elif ev.type == 'assist': pl.assists = (pl.assists or 0) + 1
                        elif ev.type == 'yellow': pl.yellows = (pl.yellows or 0) + 1
                        elif ev.type == 'red': pl.reds = (pl.reds or 0) + 1
                        pl.updated_at = datetime.now(timezone.utc)
                    state.events_applied = 1
                    state.updated_at = datetime.now(timezone.utc)
                db.commit()
                # 5. Перестраиваем глобальный кэш бомбардиров (по всем командам)
                try:
                    all_rows = db.query(TeamPlayerStats).all()
                    scorers = []
                    for r in all_rows:
                        total = (r.goals or 0) + (r.assists or 0)
                        scorers.append({
                            'player': r.player,
                            'team': r.team,
                            'games': r.games or 0,
                            'goals': r.goals or 0,
                            'assists': r.assists or 0,
                            'yellows': r.yells if hasattr(r,'yells') else (r.yellows or 0),
                            'reds': r.reds or 0,
                            'total_points': total
                        })
                    scorers.sort(key=lambda x: (-x['total_points'], x['games'], -x['goals']))
                    for i,s in enumerate(scorers, start=1):
                        s['rank'] = i
                    # Сохраняем в простой глобальный кэш
                    global SCORERS_CACHE
                    SCORERS_CACHE = { 'ts': time.time(), 'items': scorers }
                except Exception as scorers_err:
                    app.logger.warning(f"Failed to cache scorers: {scorers_err}")
                # --- Обновим snapshot stats-table из TeamPlayerStats (чтобы фронтенд видел игры) ---
                try:
                    header = ['Игрок', 'Матчи', 'Голы', 'Пасы', 'ЖК', 'КК', 'Очки']
                    rows = db.query(TeamPlayerStats).all()
                    # Сортируем по очкам (goals+assists), затем по голам
                    rows_sorted = sorted(rows, key=lambda r: (-( (r.goals or 0) + (r.assists or 0) ), -(r.goals or 0) ))
                    vals = []
                    for r in rows_sorted[:10]:
                        name = (r.player or '')
                        matches = int(r.games or 0)
                        goals = int(r.goals or 0)
                        assists = int(r.assists or 0)
                        yellows = int(r.yellows or 0)
                        reds = int(r.reds or 0)
                        points = goals + assists
                        vals.append([name, matches, goals, assists, yellows, reds, points])
                    # Дополняем до 10 строк, если нужно
                    if len(vals) < 10:
                        for i in range(len(vals)+1, 11):
                            vals.append([f'Игрок {i}', 0, 0, 0, 0, 0, 0])
                    stats_payload = {
                        'range': 'A1:G11',
                        'values': [header] + vals,
                        'updated_at': datetime.now(timezone.utc).isoformat()
                    }
                    try:
                        _snapshot_set(db, 'stats-table', stats_payload)
                    except Exception:
                        pass
                    try:
                        if cache_manager:
                            cache_manager.invalidate('stats_table')
                    except Exception:
                        pass
                    try:
                        if websocket_manager:
                            websocket_manager.notify_data_change('stats_table', stats_payload)
                    except Exception:
                        pass
                except Exception:
                    pass
            except Exception as agg_err:  # noqa: F841
                try: 
                    app.logger.error(f"player stats aggregation failed: {agg_err}")
                except Exception as log_err:
                    print(f"Failed to log aggregation error: {log_err}, original error: {agg_err}")

            # --- Инкрементируем столбец И (сыгранные матчи) в snapshot league-table (best-effort) ---
            # Допущение структуры: колонки = [#, Team, Games(И), Wins, Draws, Losses, Goals, Points]
            # Чтобы избежать двойного подсчёта при повторном settle, используем payload.counted_matches (список ключей)
            try:
                if SessionLocal is not None:
                    snap_lt = _snapshot_get(db, 'league-table')
                    payload_lt = snap_lt.get('payload') if snap_lt else None
                    if payload_lt and isinstance(payload_lt.get('values'), list):
                        counted = set(payload_lt.get('counted_matches') or [])
                        mkey = f"{home.lower().strip()}__{away.lower().strip()}"
                        if mkey not in counted:
                            changed_games = False
                            vals = payload_lt['values']
                            # Проходим по строкам, ищем home/away по второй колонке (index 1)
                            for row in vals:
                                try:
                                    team_name = (row[1] if len(row) > 1 else '').strip().lower()
                                except Exception:
                                    team_name = ''
                                if team_name in (home.lower().strip(), away.lower().strip()):
                                    # Колонка игр индекс 2
                                    while len(row) < 3:
                                        row.append('')
                                    try:
                                        games = int(str(row[2]).strip() or '0')
                                    except Exception:
                                        games = 0
                                    row[2] = str(games + 1)
                                    changed_games = True
                            if changed_games:
                                counted.add(mkey)
                                payload_lt['counted_matches'] = list(counted)
                                payload_lt['updated_at'] = datetime.now(timezone.utc).isoformat()
                                # Persist snapshot
                                _snapshot_set(db, 'league-table', payload_lt)
            except Exception as inc_err:  # noqa: F841
                try: app.logger.warning(f"league-table games increment failed: {inc_err}")
                except Exception: pass
            
            # --- Обновляем снапшот расписания чтобы удалить завершённые матчи ---
            try:
                schedule_payload = _build_schedule_payload_from_sheet()
                _snapshot_set(db, 'schedule', schedule_payload)
                try:
                    app.logger.info(f"Schedule snapshot updated after match settle: {home} vs {away}")
                except: pass
            except Exception as schedule_err:
                try: app.logger.warning(f"schedule snapshot update failed: {schedule_err}")
                except Exception: pass
            
            return jsonify({'status':'ok', 'changed': changed, 'won': won_cnt, 'lost': lost_cnt, 'total_bets': total_bets_cnt, 'open_before': open_before_cnt})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка match/settle: {e}")
        return jsonify({'error': 'Не удалось выполнить расчёт матча'}), 500

# ----------- SCORERS (GLOBAL) API -----------
@app.route('/api/scorers', methods=['GET'])
def api_scorers():
    """Таблица бомбардиров по агрегированной статистике (TeamPlayerStats).
    Параметры: limit? (int)
    Источник: кэш после settle; если кэш устарел (>10 мин), достраивается on-demand.
    Сортировка: (гол+пас desc, игры asc, голы desc).
    """
    try:
        global SCORERS_CACHE
        limit_param = request.args.get('limit')
        try:
            limit = int(limit_param) if limit_param else None
        except Exception:
            limit = None
        max_age = 600  # 10 минут
        age = time.time() - (SCORERS_CACHE.get('ts') or 0)
        if age > max_age:
            # перестраиваем из БД, если есть
            if SessionLocal is not None:
                db = get_db()
                try:
                    rows = db.query(TeamPlayerStats).all()
                    scorers = []
                    for r in rows:
                        total = (r.goals or 0) + (r.assists or 0)
                        scorers.append({
                            'player': r.player,
                            'team': r.team,
                            'games': r.games or 0,
                            'goals': r.goals or 0,
                            'assists': r.assists or 0,
                            'yellows': r.yells if hasattr(r,'yells') else (r.yellows or 0),
                            'reds': r.reds or 0,
                            'total_points': total
                        })
                    scorers.sort(key=lambda x: (-x['total_points'], x['games'], -x['goals']))
                    for i,s in enumerate(scorers, start=1):
                        s['rank'] = i
                    SCORERS_CACHE = { 'ts': time.time(), 'items': scorers }
                finally:
                    db.close()
        items = list(SCORERS_CACHE.get('items') or [])
        if limit:
            items = items[:limit]
        return jsonify({'items': items, 'updated_at': SCORERS_CACHE.get('ts')})
    except Exception as e:
        app.logger.error(f"Ошибка scorers api: {e}")
        return jsonify({'error': 'internal'}), 500

# ----------- MATCH STATS API -----------
@app.route('/api/match/stats/get', methods=['GET'])
def api_match_stats_get():
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchStats).filter(MatchStats.home==home, MatchStats.away==away).first()
            # fallback: если нет записи, сконструируем карточки из событий
            payload = {}
            if row:
                payload = {
                    'shots_total': [row.shots_total_home, row.shots_total_away],
                    'shots_on': [row.shots_on_home, row.shots_on_away],
                    'corners': [row.corners_home, row.corners_away],
                    'yellows': [row.yells_home if hasattr(row,'yells_home') else row.yellows_home, row.yellows_away],
                    'reds': [row.reds_home, row.reds_away],
                    'updated_at': (row.updated_at.isoformat() if row.updated_at else None)
                }
            else:
                # derive from player events for cards only
                ev = db.query(MatchPlayerEvent).filter(MatchPlayerEvent.home==home, MatchPlayerEvent.away==away).all()
                yh = len([e for e in ev if e.team=='home' and e.type=='yellow'])
                ya = len([e for e in ev if e.team=='away' and e.type=='yellow'])
                rh = len([e for e in ev if e.team=='home' and e.type=='red'])
                ra = len([e for e in ev if e.team=='away' and e.type=='red'])
                payload = { 'yellows': [yh, ya], 'reds': [rh, ra], 'updated_at': None }
            return jsonify(payload)
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка match/stats/get: {e}")
        return jsonify({'error': 'Не удалось получить статистику'}), 500

@app.route('/api/match/stats/set', methods=['POST'])
def api_match_stats_set():
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        vals = {}
        def as_int(v):
            try:
                return int(v)
            except Exception:
                return None
        map_fields = {
            'shots_total_home': 'shots_total_home','shots_total_away': 'shots_total_away',
            'shots_on_home': 'shots_on_home','shots_on_away': 'shots_on_away',
            'corners_home': 'corners_home','corners_away': 'corners_away',
            'yellows_home': 'yellows_home','yellows_away': 'yellows_away',
            'reds_home': 'reds_home','reds_away': 'reds_away',
        }
        for k in map_fields.keys():
            if k in request.form:
                vals[k] = as_int(request.form.get(k))
        if not vals:
            return jsonify({'error': 'Нет полей для обновления'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchStats).filter(MatchStats.home==home, MatchStats.away==away).first()
            if not row:
                row = MatchStats(home=home, away=away)
                db.add(row)
            for k,v in vals.items():
                setattr(row, k, v)
            row.updated_at = datetime.now(timezone.utc)
            db.commit()
            return jsonify({'status':'ok'})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка match/stats/set: {e}")
        return jsonify({'error': 'Не удалось сохранить статистику'}), 500

# ----------- LINEUPS API -----------
@app.route('/api/lineup/add', methods=['POST'])
def api_lineup_add():
    """Добавить игрока в состав: поля initData, home, away, team(home|away), player, jersey_number?, position? (starting_eleven|substitute), is_captain? (0/1)"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        team = (request.form.get('team') or 'home').strip().lower()
        player = (request.form.get('player') or '').strip()
        jersey = request.form.get('jersey_number')
        position = (request.form.get('position') or 'starting_eleven').strip().lower()
        is_captain = 1 if (request.form.get('is_captain') in ('1','true','yes','on')) else 0
        try:
            jersey_number = int(jersey) if jersey not in (None, '') else None
        except Exception:
            jersey_number = None
        if team not in ('home','away'):
            team = 'home'
        if position not in ('starting_eleven','substitute'):
            position = 'starting_eleven'
        if not home or not away or not player:
            return jsonify({'error': 'Некорректные данные'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            # Проверим дубликат по (home, away, team, player)
            exists = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away, MatchLineupPlayer.team==team, MatchLineupPlayer.player==player).first()
            if exists:
                # Обновим номер/позицию/капитана
                changed = False
                if jersey_number is not None and exists.jersey_number != jersey_number:
                    exists.jersey_number = jersey_number; changed = True
                if exists.position != position:
                    exists.position = position; changed = True
                if exists.is_captain != is_captain:
                    exists.is_captain = is_captain; changed = True
                if changed:
                    db.commit()
                return jsonify({'status': 'ok', 'id': int(exists.id), 'updated': bool(changed)})
            row = MatchLineupPlayer(home=home, away=away, team=team, player=player, jersey_number=jersey_number, position=position, is_captain=is_captain)
            db.add(row)
            db.commit()
            return jsonify({'status': 'ok', 'id': int(row.id), 'created': True})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка lineup/add: {e}")
        return jsonify({'error': 'Не удалось сохранить состав'}), 500

@app.route('/api/lineup/remove', methods=['POST'])
def api_lineup_remove():
    """Удалить игрока из состава: initData, home, away, team, player"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        team = (request.form.get('team') or 'home').strip().lower()
        player = (request.form.get('player') or '').strip()
        if team not in ('home','away'):
            team = 'home'
        if not home or not away or not player:
            return jsonify({'error': 'Некорректные данные'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            row = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away, MatchLineupPlayer.team==team, MatchLineupPlayer.player==player).first()
            if not row:
                return jsonify({'status': 'ok', 'removed': 0})
            db.delete(row)
            db.commit()
            return jsonify({'status': 'ok', 'removed': 1})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка lineup/remove: {e}")
        return jsonify({'error': 'Не удалось удалить игрока из состава'}), 500

@app.route('/api/lineup/list', methods=['GET'])
def api_lineup_list():
    """Получить составы: параметры home, away. Ответ: {'home': {'starting_eleven':[], 'substitutes':[]}, 'away': {...}}"""
    try:
        home = (request.args.get('home') or '').strip()
        away = (request.args.get('away') or '').strip()
        if not home or not away:
            return jsonify({'home': {'starting_eleven': [], 'substitutes': []}, 'away': {'starting_eleven': [], 'substitutes': []}})
        if SessionLocal is None:
            return jsonify({'home': {'starting_eleven': [], 'substitutes': []}, 'away': {'starting_eleven': [], 'substitutes': []}})
        db: Session = get_db()
        try:
            rows = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away).order_by(MatchLineupPlayer.team.asc(), MatchLineupPlayer.position.desc(), MatchLineupPlayer.jersey_number.asc().nulls_last()).all()
            out = {
                'home': {'starting_eleven': [], 'substitutes': []},
                'away': {'starting_eleven': [], 'substitutes': []}
            }
            for r in rows:
                side = 'home' if (r.team or 'home') == 'home' else 'away'
                bucket = 'starting_eleven' if r.position == 'starting_eleven' else 'substitutes'
                out[side][bucket].append({
                    'player': r.player,
                    'jersey_number': r.jersey_number,
                    'position': r.position,
                    'is_captain': bool(r.is_captain)
                })
            return jsonify(out)
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка lineup/list: {e}")
        return jsonify({'error': 'Не удалось получить составы'}), 500

@app.route('/api/lineup/bulk_set', methods=['POST'])
def api_lineup_bulk_set():
    """Массовая загрузка составов.
    Поля:
      initData, home, away
      roster_home (многострочный) опц.
      roster_away (многострочный) опц.
      mode=replace|append (default replace)
      first11_policy=first11_starting (по умолчанию первые 11 строк -> основа)
    Формат строки: "10 Иванов Иван (C)" либо "7. Петров" либо "#8 Сидоров". Номер опционален.
    Капитан помечается (C) или * в конце.
    """
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = str(parsed['user'].get('id'))
        admin_id = os.environ.get('ADMIN_USER_ID', '')
        if not admin_id or user_id != admin_id:
            return jsonify({'error': 'forbidden'}), 403
        home = (request.form.get('home') or '').strip()
        away = (request.form.get('away') or '').strip()
        roster_home_raw = request.form.get('roster_home') or ''
        roster_away_raw = request.form.get('roster_away') or ''
        mode = (request.form.get('mode') or 'replace').strip().lower()
        if not home or not away:
            return jsonify({'error': 'home/away обязательны'}), 400
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        def parse_lines(raw: str):
            out = []
            for line in raw.splitlines():
                ln = line.strip()
                if not ln:
                    continue
                jersey_number = None
                is_captain = 0
                # Капитан маркеры
                if ln.lower().endswith('(c)') or ln.endswith('*'):
                    is_captain = 1
                    ln = ln.rstrip('*').rstrip()
                    if ln.lower().endswith('(c)'):
                        ln = ln[:-3].rstrip()
                # Извлечение номера в начале
                import re as _re
                m = _re.match(r'^(?:#)?(\d{1,2})[\).\- ]+(.*)$', ln)
                if m:
                    try:
                        jersey_number = int(m.group(1))
                    except Exception:
                        jersey_number = None
                    name_part = m.group(2).strip()
                else:
                    # Альтернативно номер слитно перед пробелом
                    m2 = _re.match(r'^(\d{1,2})\s+(.*)$', ln)
                    if m2:
                        try:
                            jersey_number = int(m2.group(1))
                        except Exception:
                            jersey_number = None
                        name_part = m2.group(2).strip()
                    else:
                        name_part = ln
                # Очистка повторных пробелов
                name_part = ' '.join([p for p in name_part.split() if p])
                if not name_part:
                    continue
                out.append({'player': name_part, 'jersey_number': jersey_number, 'is_captain': is_captain})
            return out
        home_items = parse_lines(roster_home_raw)
        away_items = parse_lines(roster_away_raw)
        # Ограничение
        if len(home_items) > 40 or len(away_items) > 40:
            return jsonify({'error': 'Слишком много строк'}), 400
        db: Session = get_db()
        added = {'home': 0, 'away': 0}
        replaced = {'home': 0, 'away': 0}
        try:
            for side, items in (('home', home_items), ('away', away_items)):
                if not items:
                    continue
                # replace: удаляем старые строки этой стороны
                if mode == 'replace':
                    q = db.query(MatchLineupPlayer).filter(MatchLineupPlayer.home==home, MatchLineupPlayer.away==away, MatchLineupPlayer.team==side)
                    replaced[side] = q.count()
                    q.delete()
                # Создаём
                for idx, it in enumerate(items):
                    position = 'starting_eleven' if idx < 11 else 'substitute'
                    row = MatchLineupPlayer(home=home, away=away, team=side, player=it['player'], jersey_number=it['jersey_number'], position=position, is_captain=1 if it['is_captain'] else 0)
                    db.add(row)
                    added[side] += 1
            db.commit()
            return jsonify({'status': 'ok', 'added': added, 'replaced': replaced, 'mode': mode})
        finally:
            db.close()
    except Exception as e:
        app.logger.error(f"Ошибка lineup/bulk_set: {e}")
        return jsonify({'error': 'Не удалось выполнить массовый импорт'}), 500

# ===== WEBSOCKET ОБРАБОТЧИКИ ДЛЯ СИСТЕМЫ АВТОПОДПИСОК =====
try:
    if 'socketio' in globals() and socketio is not None:
        from flask_socketio import request as socketio_request
        
        @socketio.on('connect')
        def handle_connect():
            """Обработчик подключения к WebSocket"""
            try:
                # Получаем данные пользователя из сессии Flask
                user_id = flask.session.get('user_id')
                if not user_id:
                    # Пытаемся извлечь из Telegram WebApp данных
                    initData = socketio_request.args.get('initData', '')
                    if initData:
                        # Простая валидация Telegram данных (базовая)
                        try:
                            import urllib.parse
                            parsed = urllib.parse.parse_qs(initData)
                            if 'user' in parsed:
                                user_data = json.loads(parsed['user'][0])
                                user_id = user_data.get('id')
                        except:
                            pass
                
                if user_id:
                    # Подключаем к менеджеру подписок
                    if 'subscription_manager' in app.config:
                        sub_manager = app.config['subscription_manager']
                        sub_manager.on_connect(socketio_request.sid, {'user_id': str(user_id)})
                    
                    print(f"[WebSocket] User {user_id} connected")
                else:
                    print("[WebSocket] Anonymous user connected")
                    
            except Exception as e:
                print(f"[WebSocket] Connect error: {e}")

        @socketio.on('disconnect')
        def handle_disconnect():
            """Обработчик отключения от WebSocket"""
            try:
                if 'subscription_manager' in app.config:
                    sub_manager = app.config['subscription_manager']
                    sub_manager.on_disconnect(socketio_request.sid)
                print(f"[WebSocket] Client {socketio_request.sid} disconnected")
            except Exception as e:
                print(f"[WebSocket] Disconnect error: {e}")

        @socketio.on('subscribe')
        def handle_subscribe(data):
            """Обработчик подписки на обновления"""
            try:
                sub_type = data.get('type')
                object_id = data.get('object_id')
                
                if not sub_type:
                    return {'error': 'Missing subscription type'}
                
                if 'subscription_manager' in app.config:
                    sub_manager = app.config['subscription_manager']
                    try:
                        subscription_type = SubscriptionType(sub_type)
                        result = sub_manager.subscribe(socketio_request.sid, subscription_type, object_id)
                        return {'success': result}
                    except ValueError:
                        return {'error': f'Invalid subscription type: {sub_type}'}
                else:
                    return {'error': 'Subscription manager not available'}
                    
            except Exception as e:
                print(f"[WebSocket] Subscribe error: {e}")
                return {'error': 'Subscription failed'}

        @socketio.on('unsubscribe')
        def handle_unsubscribe(data):
            """Обработчик отписки от обновлений"""
            try:
                sub_type = data.get('type')
                object_id = data.get('object_id')
                
                if not sub_type:
                    return {'error': 'Missing subscription type'}
                
                if 'subscription_manager' in app.config:
                    sub_manager = app.config['subscription_manager']
                    try:
                        subscription_type = SubscriptionType(sub_type)
                        result = sub_manager.unsubscribe(socketio_request.sid, subscription_type, object_id)
                        return {'success': result}
                    except ValueError:
                        return {'error': f'Invalid subscription type: {sub_type}'}
                else:
                    return {'error': 'Subscription manager not available'}
                    
            except Exception as e:
                print(f"[WebSocket] Unsubscribe error: {e}")
                return {'error': 'Unsubscribe failed'}

        print("[INFO] WebSocket subscription handlers registered")
        
except Exception as e:
    print(f"[WARN] Failed to register WebSocket handlers: {e}")

if __name__ == '__main__':
    # Локальный standalone запуск (в прод Gunicorn вызывает wsgi:app)
    try:
        start_background_sync()
    except Exception as _e:
        print(f"[WARN] Background sync not started: {_e}")
    # Self-ping только если явно включен (для локальных тестов)
    if os.environ.get('ENABLE_SELF_PING','1') == '1':
        try:
            import threading, requests
            def self_ping_loop():
                url_env = os.environ.get('RENDER_URL') or ''
                base = url_env.rstrip('/') if url_env else None
                while True:
                    try:
                        target = (base + '/ping') if base else None
                        if target:
                            requests.get(target, timeout=5)
                        else:
                            requests.get('http://127.0.0.1:' + str(int(os.environ.get('PORT', 5000))) + '/ping', timeout=3)
                    except Exception:
                        pass
                    finally:
                        time.sleep(300)
            threading.Thread(target=self_ping_loop, daemon=True).start()
        except Exception as _e:
            print(f"[WARN] Self-ping thread not started: {_e}")
    port = int(os.environ.get('PORT', 5000))
    debug_mode = os.environ.get('FLASK_DEBUG', '').lower() in ('1', 'true', 'yes')
    # Если есть socketio объект – используем его, иначе стандартный Flask
    _socketio = globals().get('socketio')
    if _socketio is not None:
        try:
            _socketio.run(app, host='0.0.0.0', port=port, debug=debug_mode)
        except Exception as _e:
            print(f"[WARN] socketio.run failed, fallback to app.run: {_e}")
            app.run(host='0.0.0.0', port=port, debug=debug_mode)
    else:
        app.run(host='0.0.0.0', port=port, debug=debug_mode)
