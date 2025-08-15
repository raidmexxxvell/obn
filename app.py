# app.py
import os
import json
import time
import hmac
import hashlib
from datetime import datetime, timedelta, timezone, date
from flask import Flask, render_template, request, jsonify
from urllib.parse import parse_qs
import gspread
from google.oauth2.service_account import Credentials
from sqlalchemy import create_engine, Column, Integer, String, Date, DateTime, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base, sessionmaker, Session

app = Flask(__name__)

# Простой кеш для таблицы лиги (обновление раз в час)
LEAGUE_TABLE_CACHE = {
    'ts': 0,       # unix timestamp последнего обновления
    'data': None   # кэшированные данные таблицы
}
LEAGUE_TABLE_TTL = 60 * 60  # 1 час

# Кеш для таблицы статистики (A1:G11)
STATS_TABLE_CACHE = {
    'ts': 0,
    'data': None
}
STATS_TABLE_TTL = 60 * 60  # 1 час

# ---------------- PostgreSQL / SQLAlchemy -----------------
DATABASE_URL = os.environ.get('DATABASE_URL') or os.environ.get('DATABASE_URL_RENDER')
if not DATABASE_URL:
    # позволяем локально запускаться без БД, но в лог
    print('[WARN] DATABASE_URL не задан. БД не будет использована.')

def _normalize_db_url(url: str) -> str:
    if not url:
        return ''
    # Используем драйвер psycopg (v3), совместимый с Python 3.13
    # Render часто даёт postgres:// — SQLAlchemy предпочитает postgresql+psycopg://
    if url.startswith('postgres://'):
        url = 'postgresql+psycopg://' + url[len('postgres://'):]
    elif url.startswith('postgresql://') and '+psycopg' not in url and '+pg8000' not in url:
        url = 'postgresql+psycopg://' + url[len('postgresql://'):]
    # Требуем sslmode=require если не указан
    if 'sslmode=' not in url:
        sep = '&' if '?' in url else '?'
        url = f"{url}{sep}sslmode=require"
    return url

engine = None
SessionLocal = None
Base = declarative_base()

if DATABASE_URL:
    engine = create_engine(_normalize_db_url(DATABASE_URL), pool_pre_ping=True)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

class User(Base):
    __tablename__ = 'users'
    user_id = Column(Integer, primary_key=True, index=True)
    display_name = Column(String(255))
    tg_username = Column(String(255))
    credits = Column(Integer, default=1000)
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
    c1 = Column(Text)
    c2 = Column(Text)
    c3 = Column(Text)
    c4 = Column(Text)
    c5 = Column(Text)
    c6 = Column(Text)
    c7 = Column(Text)
    c8 = Column(Text)
    updated_at = Column(DateTime(timezone=True))

class StatsTableRow(Base):
    __tablename__ = 'stats_table'
    row_index = Column(Integer, primary_key=True)
    c1 = Column(Text)
    c2 = Column(Text)
    c3 = Column(Text)
    c4 = Column(Text)
    c5 = Column(Text)
    c6 = Column(Text)
    c7 = Column(Text)
    updated_at = Column(DateTime(timezone=True))

class Referral(Base):
    __tablename__ = 'referrals'
    # user_id совпадает с Telegram user_id и с users.user_id
    user_id = Column(Integer, primary_key=True)
    referral_code = Column(String(32), unique=True, index=True, nullable=False)
    referrer_id = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

if engine is not None:
    try:
        Base.metadata.create_all(engine)
        print('[INFO] DB tables ensured')
    except Exception as e:
        print(f'[ERROR] DB init failed: {e}')

def get_db() -> Session:
    if SessionLocal is None:
        raise RuntimeError('База данных не сконфигурирована (DATABASE_URL не задан).')
    return SessionLocal()

def _generate_ref_code(uid: int) -> str:
    """Детерминированно генерирует короткий реф-код по user_id и BOT_TOKEN в качестве соли."""
    salt = os.environ.get('BOT_TOKEN', 's')
    digest = hashlib.sha256(f"{uid}:{salt}".encode()).hexdigest()
    return digest[:8]

# Настройка Google Sheets
def get_google_client():
    """Создает клиент для работы с Google Sheets API"""
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
    return gspread.authorize(credentials)

def get_user_sheet():
    """Получает лист пользователей из Google Sheets"""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    sheet = client.open_by_key(sheet_id)
    return sheet.worksheet("users")

def get_achievements_sheet():
    """Возвращает лист достижений, создаёт при отсутствии."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = client.open_by_key(sheet_id)
    try:
        ws = doc.worksheet("achievements")
    except gspread.exceptions.WorksheetNotFound:
        ws = doc.add_worksheet(title="achievements", rows=1000, cols=8)
        # user_id | credits_tier | credits_unlocked_at | level_tier | level_unlocked_at | streak_tier | streak_unlocked_at
        ws.update('A1:G1', [[
            'user_id', 'credits_tier', 'credits_unlocked_at', 'level_tier', 'level_unlocked_at', 'streak_tier', 'streak_unlocked_at'
        ]])
    return ws

def get_table_sheet():
    """Возвращает лист таблицы лиги 'ТАБЛИЦА'."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = client.open_by_key(sheet_id)
    return doc.worksheet("ТАБЛИЦА")

def get_stats_sheet():
    """Возвращает лист статистики 'СТАТИСТИКА'."""
    client = get_google_client()
    sheet_id = os.environ.get('SHEET_ID')
    if not sheet_id:
        raise ValueError("SHEET_ID не установлен в переменных окружения")
    doc = client.open_by_key(sheet_id)
    return doc.worksheet("СТАТИСТИКА")

def get_user_achievements_row(user_id):
    """Читает или инициализирует строку достижений пользователя."""
    ws = get_achievements_sheet()
    try:
        cell = ws.find(str(user_id), in_column=1)
        if cell:
            row_vals = ws.row_values(cell.row)
            # Гарантируем длину
            row_vals = list(row_vals) + [''] * (7 - len(row_vals))
            return cell.row, {
                'credits_tier': int(row_vals[1] or 0),
                'credits_unlocked_at': row_vals[2] or '',
                'level_tier': int(row_vals[3] or 0),
                'level_unlocked_at': row_vals[4] or '',
                'streak_tier': int(row_vals[5] or 0),
                'streak_unlocked_at': row_vals[6] or ''
            }
    except gspread.exceptions.APIError as e:
        app.logger.error(f"Ошибка API при чтении достижений: {e}")
    # Создаём новую строку
    ws.append_row([str(user_id), '0', '', '0', '', '0', ''])
    # Найдём только что добавленную (последняя строка)
    last_row = len(ws.get_all_values())
    return last_row, {
        'credits_tier': 0,
        'credits_unlocked_at': '',
        'level_tier': 0,
        'level_unlocked_at': '',
        'streak_tier': 0,
        'streak_unlocked_at': ''
    }

def compute_tier(value: int, thresholds) -> int:
    """Возвращает tier по убывающим порогам. thresholds: [(threshold, tier), ...]"""
    for thr, tier in thresholds:
        if value >= thr:
            return tier
    return 0

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
            db_user.display_name or 'User',
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
            sheet.append_row(new_row)
        except Exception as e:
            app.logger.warning(f"Не удалось добавить пользователя в лист users: {e}")
    else:
        try:
            sheet.batch_update([
                {'range': f'B{row_num}', 'values': [[db_user.display_name or 'User']]},
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
        'display_name': db_user.display_name or 'User',
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
def parse_and_verify_telegram_init_data(init_data: str, max_age_seconds: int = 24*60*60):
    """Парсит и проверяет initData из Telegram WebApp.
    Возвращает dict с полями 'user', 'auth_date', 'raw' при успехе, иначе None.
    """
    bot_token = os.environ.get('BOT_TOKEN')
    if not bot_token:
        raise ValueError("BOT_TOKEN не установлен в переменных окружения")

    if not init_data:
        return None

    parsed = parse_qs(init_data)
    if 'hash' not in parsed:
        return None

    received_hash = parsed.pop('hash')[0]
    # Строка для подписи — все пары (key=value) кроме hash, отсортированные по ключу
    data_check_string = '\n'.join([f"{k}={v[0]}" for k, v in sorted(parsed.items())])

    # Секретный ключ = HMAC_SHA256("WebAppData", bot_token)
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
    return render_template('index.html')

@app.route('/api/user', methods=['POST'])
def get_user():
    """Получает данные пользователя из Telegram WebApp"""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_data = parsed['user']

        if SessionLocal is None:
            # Fallback без БД: старый путь через таблицу (на случай локальной разработки)
            row_num = find_user_row(user_data['id'])
            sheet = get_user_sheet()
            if not row_num:
                # инициализация в листе
                new_row = [
                    user_data['id'], user_data.get('first_name', 'User'), user_data.get('username', ''),
                    '1000','0','1','0','', '0','', datetime.now(timezone.utc).isoformat(), datetime.now(timezone.utc).isoformat()
                ]
                sheet.append_row(new_row)
                row = new_row
            else:
                row = sheet.row_values(row_num)
            # формируем ответ из строки
            row = list(row) + [''] * (12 - len(row))
            resp = {
                'user_id': _to_int(row[0]),
                'display_name': row[1],
                'tg_username': row[2],
                'credits': _to_int(row[3]),
                'xp': _to_int(row[4]),
                'level': _to_int(row[5], 1),
                'consecutive_days': _to_int(row[6]),
                'last_checkin_date': row[7],
                'badge_tier': _to_int(row[8]),
                'created_at': row[10],
                'updated_at': row[11]
            }
            return jsonify(resp)

    # Основной путь: через БД
        db: Session = get_db()
        try:
            db_user = db.get(User, int(user_data['id']))
            now = datetime.now(timezone.utc)
            if not db_user:
                # Попробуем взять стартовые данные из Google Sheets, если пользователь уже есть там
                seed = {
                    'display_name': user_data.get('first_name') or 'User',
                    'tg_username': user_data.get('username') or '',
                    'credits': 1000,
                    'xp': 0,
                    'level': 1,
                    'consecutive_days': 0,
                    'last_checkin_date': None,
                }
                try:
                    row_num = find_user_row(user_data['id'])
                    if row_num:
                        sheet = get_user_sheet()
                        row = sheet.row_values(row_num)
                        row = list(row) + [''] * (12 - len(row))
                        seed.update({
                            'display_name': row[1] or seed['display_name'],
                            'tg_username': row[2] or seed['tg_username'],
                            'credits': _to_int(row[3], seed['credits']),
                            'xp': _to_int(row[4], seed['xp']),
                            'level': _to_int(row[5], seed['level']),
                            'consecutive_days': _to_int(row[6], seed['consecutive_days']),
                            'last_checkin_date': (datetime.fromisoformat(row[7]).date() if row[7] else None)
                        })
                except Exception as e:
                    app.logger.warning(f"Seed from sheets failed: {e}")
                db_user = User(
                    user_id=int(user_data['id']),
                    display_name=seed['display_name'],
                    tg_username=seed['tg_username'],
                    credits=seed['credits'],
                    xp=seed['xp'],
                    level=seed['level'],
                    consecutive_days=seed['consecutive_days'],
                    last_checkin_date=seed['last_checkin_date'],
                    badge_tier=0,
                    created_at=now,
                    updated_at=now,
                )
                db.add(db_user)
                # Реферальная привязка на первичном входе
                start_param = None
                try:
                    raw = parsed.get('raw') or {}
                    if 'start_param' in raw:
                        start_param = raw['start_param'][0]
                except Exception:
                    start_param = None
                try:
                    # создаём запись в referrals с уникальным кодом
                    code = _generate_ref_code(int(user_data['id']))
                    referrer_id = None
                    if start_param and start_param != code:
                        # найдём пригласившего по коду
                        existing = db.query(Referral).filter(Referral.referral_code == start_param).first()
                        if existing and existing.user_id != int(user_data['id']):
                            referrer_id = existing.user_id
                    db_ref = Referral(user_id=int(user_data['id']), referral_code=code, referrer_id=referrer_id)
                    db.add(db_ref)
                except Exception as e:
                    app.logger.warning(f"Create referral row failed: {e}")
            else:
                # just update updated_at
                db_user.updated_at = now
                # Убедимся, что у пользователя есть запись в referrals
                try:
                    db_ref = db.get(Referral, int(user_data['id']))
                    if not db_ref:
                        code = _generate_ref_code(int(user_data['id']))
                        db.add(Referral(user_id=int(user_data['id']), referral_code=code))
                except Exception as e:
                    app.logger.warning(f"Ensure referral row failed: {e}")
            db.commit()
            db.refresh(db_user)
        finally:
            db.close()

        # Зеркалим в Google Sheets (best-effort)
        try:
            mirror_user_to_sheets(db_user)
        except Exception as e:
            app.logger.warning(f"Mirror user to sheets failed: {e}")

        return jsonify(serialize_user(db_user))

    except Exception as e:
        app.logger.error(f"Ошибка получения пользователя: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

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
            # посчитаем приглашённых
            invited_count = db.query(Referral).filter(Referral.referrer_id == user_id).count()
        finally:
            db.close()
        bot_username = os.environ.get('BOT_USERNAME', '')
        link = f"https://t.me/{bot_username}?start={ref.referral_code}" if bot_username else ref.referral_code
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
            }
        ]
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
            db_user = db.get(User, int(user_id))
            if not db_user:
                return jsonify({'error': 'Пользователь не найден'}), 404
            db_user.display_name = new_name
            db_user.updated_at = datetime.now(timezone.utc)
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
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = parsed['user'].get('id')

        # Получаем пользователя из БД либо (fallback) из листа
        if SessionLocal is None:
            row_num = find_user_row(user_id)
            if not row_num:
                return jsonify({'error': 'Пользователь не найден'}), 404
            sheet = get_user_sheet()
            row = sheet.row_values(row_num)
            row = list(row) + [''] * (12 - len(row))
            user = {
                'user_id': _to_int(row[0]),
                'display_name': row[1],
                'tg_username': row[2],
                'credits': _to_int(row[3]),
                'xp': _to_int(row[4]),
                'level': _to_int(row[5], 1),
                'consecutive_days': _to_int(row[6]),
                'last_checkin_date': row[7],
                'badge_tier': _to_int(row[8]),
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
        # Пороговые значения и названия
        streak_thresholds = [(120, 3), (30, 2), (7, 1)]
        credits_thresholds = [(500000, 3), (50000, 2), (10000, 1)]
        level_thresholds = [(100, 3), (50, 2), (25, 1)]

        # Вычисляем текущие тиры
        streak_tier = compute_tier(user['consecutive_days'], streak_thresholds)
        credits_tier = compute_tier(user['credits'], credits_thresholds)
        level_tier = compute_tier(user['level'], level_thresholds)

        # Обновляем прогресс в отдельной таблице (фиксируем время первого получения каждого тира)
        ach_row, ach = get_user_achievements_row(user_id)
        updates = []
        now_iso = datetime.now(timezone.utc).isoformat()
        if credits_tier > ach['credits_tier']:
            updates.append({'range': f'B{ach_row}', 'values': [[str(credits_tier)]]})
            updates.append({'range': f'C{ach_row}', 'values': [[now_iso]]})
        if level_tier > ach['level_tier']:
            updates.append({'range': f'D{ach_row}', 'values': [[str(level_tier)]]})
            updates.append({'range': f'E{ach_row}', 'values': [[now_iso]]})
        if streak_tier > ach['streak_tier']:
            updates.append({'range': f'F{ach_row}', 'values': [[str(streak_tier)]]})
            updates.append({'range': f'G{ach_row}', 'values': [[now_iso]]})
        if updates:
            get_achievements_sheet().batch_update(updates)

        # Собираем карточки достижений
        achievements = []

        # Серия дней (как было)
        if streak_tier:
            achievements.append({ 'group': 'streak', 'tier': streak_tier, 'name': {1:'Бронза',2:'Серебро',3:'Золото'}[streak_tier], 'value': user['consecutive_days'], 'target': {1:7,2:30,3:120}[streak_tier], 'icon': {1:'bronze',2:'silver',3:'gold'}[streak_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'streak', 'tier': 1, 'name': 'Бронза', 'value': user['consecutive_days'], 'target': 7, 'icon': 'bronze', 'unlocked': False })

        # Кредиты: 10k/50k/500k
        if credits_tier:
            achievements.append({ 'group': 'credits', 'tier': credits_tier, 'name': {1:'Бедолага',2:'Мажор',3:'Олигарх'}[credits_tier], 'value': user['credits'], 'target': {1:10000,2:50000,3:500000}[credits_tier], 'icon': {1:'bronze',2:'silver',3:'gold'}[credits_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'credits', 'tier': 1, 'name': 'Бедолага', 'value': user['credits'], 'target': 10000, 'icon': 'bronze', 'unlocked': False })

        # Уровень: 25/50/100
        if level_tier:
            achievements.append({ 'group': 'level', 'tier': level_tier, 'name': {1:'Новобранец',2:'Ветеран',3:'Легенда'}[level_tier], 'value': user['level'], 'target': {1:25,2:50,3:100}[level_tier], 'icon': {1:'bronze',2:'silver',3:'gold'}[level_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'level', 'tier': 1, 'name': 'Новобранец', 'value': user['level'], 'target': 25, 'icon': 'bronze', 'unlocked': False })

        return jsonify({'achievements': achievements})

    except Exception as e:
        app.logger.error(f"Ошибка получения достижений: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/health')
def health():
    """Healthcheck для Render.com"""
    return jsonify(status="healthy"), 200

@app.route('/api/league-table', methods=['GET'])
def api_league_table():
    """Возвращает таблицу лиги (A1:H10) с кешем на 1 час."""
    try:
        now = int(time.time())
        if LEAGUE_TABLE_CACHE['data'] and (now - LEAGUE_TABLE_CACHE['ts'] < LEAGUE_TABLE_TTL):
            return jsonify(LEAGUE_TABLE_CACHE['data'])

        ws = get_table_sheet()
        values = ws.get('A1:H10') or []
        # Гарантируем 10 строк и 8 столбцов (заполним пустыми строками/ячейками при необходимости)
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
        LEAGUE_TABLE_CACHE['data'] = payload
        LEAGUE_TABLE_CACHE['ts'] = now
        # Сохраняем в БД (если настроена)
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                for idx, r in enumerate(normalized, start=1):
                    row = db.get(LeagueTableRow, idx)
                    when = datetime.now(timezone.utc)
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
            except Exception as e:
                app.logger.warning(f"Не удалось сохранить лигу в БД: {e}")
            finally:
                db.close()
        return jsonify(payload)
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы лиги: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить таблицу'}), 500

@app.route('/api/stats-table', methods=['GET'])
def api_stats_table():
    """Возвращает таблицу статистики (A1:G11) с кешем на 1 час и сохраняет в БД."""
    try:
        now = int(time.time())
        if STATS_TABLE_CACHE['data'] and (now - STATS_TABLE_CACHE['ts'] < STATS_TABLE_TTL):
            return jsonify(STATS_TABLE_CACHE['data'])

        ws = get_stats_sheet()
        values = ws.get('A1:G11') or []
        # Гарантируем 11 строк и 7 столбцов
        normalized = []
        for i in range(11):
            row = values[i] if i < len(values) else []
            row = list(row) + [''] * (7 - len(row))
            normalized.append(row[:7])

        payload = {
            'range': 'A1:G11',
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'values': normalized
        }
        STATS_TABLE_CACHE['data'] = payload
        STATS_TABLE_CACHE['ts'] = now

        # Сохраняем в БД (если настроена)
        if SessionLocal is not None:
            db: Session = get_db()
            try:
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
                app.logger.warning(f"Не удалось сохранить статистику в БД: {e}")
            finally:
                db.close()

        return jsonify(payload)
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы статистики: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить статистику'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
