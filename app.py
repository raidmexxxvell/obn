"""Flask backend for Liga Obninska app with betting, Google Sheets and SQLAlchemy."""
import os
import json
import time
import hashlib
import hmac
from datetime import datetime, date, timezone
from urllib.parse import parse_qs

from flask import Flask, request, jsonify, render_template

import gspread
from google.oauth2.service_account import Credentials

from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime, Date
)
from sqlalchemy.orm import sessionmaker, declarative_base, Session

# Flask app
app = Flask(__name__, static_folder='static', template_folder='templates')

# Database
import re

def _normalize_db_url(url: str) -> str:
    if not url:
        return url
    # Render/Heroku style postgres:// -> postgresql://
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    # If driver not specified, force psycopg (psycopg3)
    if url.startswith('postgresql://') and '+psycopg' not in url and '+psycopg2' not in url:
        url = 'postgresql+psycopg://' + url[len('postgresql://'):]
    return url

DATABASE_URL_RAW = os.environ.get('DATABASE_URL', '').strip()
DATABASE_URL = _normalize_db_url(DATABASE_URL_RAW)
engine = create_engine(DATABASE_URL) if DATABASE_URL else None
SessionLocal = sessionmaker(bind=engine) if engine else None
Base = declarative_base()

# Caches and TTLs
LEAGUE_TABLE_CACHE = {'data': None, 'ts': 0}
LEAGUE_TABLE_TTL = 60 * 60

SCHEDULE_CACHE = {'data': None, 'ts': 0}
SCHEDULE_TTL = 15 * 60

STATS_TABLE_CACHE = {'data': None, 'ts': 0}
STATS_TABLE_TTL = 60 * 60

MATCH_DETAILS_CACHE = {}
MATCH_DETAILS_TTL = 60 * 60

# Betting config
BET_MIN_STAKE = int(os.environ.get('BET_MIN_STAKE', '10'))
BET_MAX_STAKE = int(os.environ.get('BET_MAX_STAKE', '10000'))
BET_DAILY_MAX_STAKE = int(os.environ.get('BET_DAILY_MAX_STAKE', '50000'))
BET_MARGIN = float(os.environ.get('BET_MARGIN', '0.06'))  # 6% маржа по умолчанию
_LAST_SETTLE_TS = 0


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


@app.route('/api/betting/place', methods=['POST'])
def api_betting_place():
    """Размещает ставку. Маркеты: 
    - 1X2: selection in ['home','draw','away']
    - totals: selection in ['over','under'], требуется поле line (например 3.5)
    Поля: initData, tour, home, away, market, selection, stake, [line]
    """
    parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
    if not parsed or not parsed.get('user'):
        return jsonify({'error': 'Недействительные данные'}), 401
    user_id = int(parsed['user'].get('id'))
    if SessionLocal is None:
        return jsonify({'error': 'БД недоступна'}), 500
    market = (request.form.get('market') or '1x2').strip().lower()
    sel = (request.form.get('selection') or '').strip().lower()
    if market not in ('1x2','totals'):
        return jsonify({'error': 'Неверный рынок'}), 400
    if market == '1x2':
        if sel not in ('home','draw','away'):
            return jsonify({'error': 'Неверная ставка'}), 400
    else:
        if sel not in ('over','under'):
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
    if match_dt and match_dt <= datetime.now():
        return jsonify({'error': 'Ставки на начавшийся матч недоступны'}), 400

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
            odds_map = _compute_match_odds(home, away)
            k = odds_map.get(sel) or 2.00
            selection_to_store = sel
            market_to_store = '1x2'
        else:
            # totals требует line
            try:
                line = float((request.form.get('line') or '').replace(',', '.'))
            except Exception:
                line = None
            if line not in (3.5, 4.5, 5.5):
                return jsonify({'error': 'Неверная линия тотала'}), 400
            odds_map = _compute_totals_odds(home, away, line)
            k = odds_map.get(sel) or 2.00
            selection_to_store = f"{sel}_{line}"
            market_to_store = 'totals'
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
                'selection': bet.selection,
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
    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, index=True, nullable=False)
    tour = Column(Integer, nullable=True)
    home = Column(Text, nullable=False)
    away = Column(Text, nullable=False)
    match_datetime = Column(DateTime(timezone=False), nullable=True)
    market = Column(String(16), default='1x2')
    selection = Column(String(8), nullable=False)  # 'home' | 'draw' | 'away'
    odds = Column(String(16), default='')         # храним как строку для простоты (например, '2.20')
    stake = Column(Integer, nullable=False)
    payout = Column(Integer, default=0)
    status = Column(String(16), default='open')   # open | won | lost | void
    placed_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

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
        ws = doc.add_worksheet(title="achievements", rows=1000, cols=10)
        # user_id | credits_tier | credits_unlocked_at | level_tier | level_unlocked_at | streak_tier | streak_unlocked_at | invited_tier | invited_unlocked_at
        ws.update('A1:I1', [[
            'user_id', 'credits_tier', 'credits_unlocked_at', 'level_tier', 'level_unlocked_at', 'streak_tier', 'streak_unlocked_at', 'invited_tier', 'invited_unlocked_at'
        ]])
    # Убедимся, что колонки для invited присутствуют
    try:
        headers = ws.row_values(1)
        if len(headers) < 9:
            headers = list(headers) + [''] * (9 - len(headers))
            headers[0:9] = headers[0:9]
            if len(headers) >= 7:
                if len(headers) < 9:
                    headers += ['invited_tier', 'invited_unlocked_at']
            ws.update('A1:I1', [headers[:9]])
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
    """Возвращает словарь {нормализованное_имя_команды: позиция} из листа 'ТАБЛИЦА'.
    Позиция начинается с 1 для первой команды ниже шапки.
    """
    try:
        ws = get_table_sheet()
        values = ws.get('A1:H10') or []
        # строка 0 — заголовки; строки 1.. — данные
        ranks = {}
        def norm(s: str) -> str:
            s = (s or '').strip().lower().replace('\u00A0',' ').replace('ё','е')
            return ''.join(ch for ch in s if ch.isalnum())
        for i in range(1, len(values)):
            row = values[i]
            if not row or len(row) < 2:
                continue
            name = (row[1] or '').strip()
            if not name:
                continue
            ranks[norm(name)] = len(ranks) + 1
        return ranks
    except Exception as e:
        app.logger.warning(f"Не удалось загрузить ранги лиги: {e}")
        return {}

def _compute_match_odds(home: str, away: str) -> dict:
    """Возвращает коэффициенты 1X2 по простейшей модели: преимущество хозяев + разница позиций.
    Формат: {'home': 2.15, 'draw': 3.10, 'away': 2.75}.
    """
    def clamp(x, a, b):
        return max(a, min(b, x))
    def to_norm(s: str) -> str:
        s = (s or '').strip().lower().replace('\u00A0',' ').replace('ё','е')
        return ''.join(ch for ch in s if ch.isalnum())
    ranks = _load_league_ranks()
    r_home = ranks.get(to_norm(home))
    r_away = ranks.get(to_norm(away))
    # базовые вероятности
    p_home = 0.45
    p_draw = 0.26
    p_away = 0.29
    # если есть позиции — скорректируем
    if r_home and r_away:
        delta = r_away - r_home  # >0 если хозяева выше в таблице
        p_home += clamp(delta * 0.02, -0.15, 0.15)
        p_draw = clamp(0.26 - abs(delta) * 0.01, 0.16, 0.30)
        # нормализуем
        p_home = clamp(p_home, 0.10, 0.80)
        p_away = max(0.05, 1.0 - p_home - p_draw)
    else:
        # нет данных — оставляем базовые
        pass
    # применяем маржу и считаем кэфы
    overround = 1.0 + BET_MARGIN
    # распределим маржу пропорционально вероятностям
    denom = p_home + p_draw + p_away
    ph = p_home / denom; px = p_draw / denom; pa = p_away / denom
    ph *= overround; px *= overround; pa *= overround
    def to_odds(p):
        try:
            o = 1.0 / p
            return round(max(1.10, o), 2)
        except Exception:
            return 1.10
    return { 'home': to_odds(ph), 'draw': to_odds(px), 'away': to_odds(pa) }

def _compute_totals_odds(home: str, away: str, line: float) -> dict:
    """Грубая модель коэффициентов для тоталов (Over/Under) заданной линии.
    Базируется на среднем ожидаемом количестве голов mu с поправкой на разницу сил команд.
    Применяет маржу BET_MARGIN аналогично 1X2. Возвращает {'over': k, 'under': k}.
    """
    try:
        base_mu = float(os.environ.get('BET_BASE_TOTAL', '4.2'))
    except Exception:
        base_mu = 4.2

    def to_norm(s: str) -> str:
        s = (s or '').strip().lower().replace('\u00A0',' ').replace('ё','е')
        return ''.join(ch for ch in s if ch.isalnum())
    ranks = _load_league_ranks()
    r_home = ranks.get(to_norm(home))
    r_away = ranks.get(to_norm(away))
    adj = 1.0
    if r_home and r_away:
        delta = abs(r_home - r_away)
        adj += min(0.25, delta * 0.02)
    mu = max(1.2, base_mu * adj)

    import math
    try:
        l = float(line)
    except Exception:
        l = 3.5
    kappa = 1.15
    x = mu - l
    p_over = 1.0 / (1.0 + math.exp(-kappa * x))
    p_over = max(0.05, min(0.95, p_over))
    p_under = max(0.05, 1.0 - p_over)

    overround = 1.0 + BET_MARGIN
    denom = p_over + p_under
    po = (p_over / denom) * overround
    pu = (p_under / denom) * overround

    def to_odds(p):
        try:
            o = 1.0 / p
            return round(max(1.10, o), 2)
        except Exception:
            return 1.10
    return { 'over': to_odds(po), 'under': to_odds(pu) }

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
        ws.update('A1:F1', [[
            'user_id', 'referral_code', 'referrer_id', 'invited_count', 'created_at', 'updated_at'
        ]])
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
            ws.append_row([
                str(user_id), referral_code or '', str(referrer_id or ''), str(invited_count or 0), created_at, updated_at
            ])
        except Exception as e:
            app.logger.warning(f"Не удалось добавить referral в лист: {e}")
    else:
        row = cell.row
        try:
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

def get_user_achievements_row(user_id):
    """Читает или инициализирует строку достижений пользователя."""
    ws = get_achievements_sheet()
    try:
        cell = ws.find(str(user_id), in_column=1)
        if cell:
            row_vals = ws.row_values(cell.row)
            # Гарантируем длину
            row_vals = list(row_vals) + [''] * (9 - len(row_vals))
            return cell.row, {
                'credits_tier': int(row_vals[1] or 0),
                'credits_unlocked_at': row_vals[2] or '',
                'level_tier': int(row_vals[3] or 0),
                'level_unlocked_at': row_vals[4] or '',
                'streak_tier': int(row_vals[5] or 0),
                'streak_unlocked_at': row_vals[6] or '',
                'invited_tier': int(row_vals[7] or 0),
                'invited_unlocked_at': row_vals[8] or ''
            }
    except gspread.exceptions.APIError as e:
        app.logger.error(f"Ошибка API при чтении достижений: {e}")
    # Создаём новую строку (включая invited_tier/unlocked_at)
    ws.append_row([str(user_id), '0', '', '0', '', '0', '', '0', ''])
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
        'invited_unlocked_at': ''
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
    return render_template('index.html', admin_user_id=os.environ.get('ADMIN_USER_ID', ''))

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
        invited_thresholds = [(150, 3), (50, 2), (10, 1)]

        # Вычисляем текущие тиры
        streak_tier = compute_tier(user['consecutive_days'], streak_thresholds)
        credits_tier = compute_tier(user['credits'], credits_thresholds)
        level_tier = compute_tier(user['level'], level_thresholds)
        # Считаем приглашённых
        invited_count = 0
        if SessionLocal is not None:
            db: Session = get_db()
            try:
                invited_count = db.query(Referral).filter(Referral.referrer_id == int(user_id)).count()
            finally:
                db.close()
        invited_tier = compute_tier(invited_count, invited_thresholds)

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
        if invited_tier > ach.get('invited_tier', 0):
            updates.append({'range': f'H{ach_row}', 'values': [[str(invited_tier)]]})
            updates.append({'range': f'I{ach_row}', 'values': [[now_iso]]})
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

        # Приглашённые: 10/50/150
        if invited_tier:
            achievements.append({ 'group': 'invited', 'tier': invited_tier, 'name': {1:'Рекрутер',2:'Посол',3:'Легенда'}[invited_tier], 'value': invited_count, 'target': {1:10,2:50,3:150}[invited_tier], 'icon': {1:'bronze',2:'silver',3:'gold'}[invited_tier], 'unlocked': True })
        else:
            achievements.append({ 'group': 'invited', 'tier': 1, 'name': 'Рекрутер', 'value': invited_count, 'target': 10, 'icon': 'bronze', 'unlocked': False })
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
        # ETag для условного запроса
        _core = {'range': 'A1:H10', 'values': normalized}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        inm = request.headers.get('If-None-Match')
        if inm and inm == _etag and LEAGUE_TABLE_CACHE['data']:
            resp = app.response_class(status=304)
            resp.headers['ETag'] = _etag
            resp.headers['Cache-Control'] = 'private, max-age=1800'
            return resp

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
        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'private, max-age=1800'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы лиги: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить таблицу'}), 500

@app.route('/api/schedule', methods=['GET'])
def api_schedule():
    """Возвращает ближайшие 3 тура из листа 'РАСПИСАНИЕ ИГР'.
    Ожидается структура блоками: строка с 'N Тур', затем 3-5 строк матчей: A(home), E(away), F(дата dd.mm.yy), G(время HH:MM).
    """
    try:
        now = int(time.time())
        if SCHEDULE_CACHE['data'] and (now - SCHEDULE_CACHE['ts'] < SCHEDULE_TTL):
            return jsonify(SCHEDULE_CACHE['data'])

        ws = get_schedule_sheet()
        rows = ws.get_all_values() or []

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

        for r in rows:
            a = (r[0] if len(r) > 0 else '').strip()
            # заголовок вида "1 Тур" (число + слово Тур)
            header_num = None
            if a:
                parts = a.replace('\u00A0', ' ').strip().split()
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].lower().startswith('тур'):
                    header_num = int(parts[0])
            if header_num is not None:
                if current_tour is not None and current_matches:
                    # закрываем предыдущий: вычислим старт тура как минимальная дата/время
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
                # начинаем новый блок тура
                current_tour = header_num
                current_title = a
                current_matches = []
                continue

            # строки матчей внутри текущего тура
            if current_tour is not None:
                home = (r[0] if len(r) > 0 else '').strip()
                # Счёт: B (дом), D (гости)
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

        # закрыть последний тур
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

        # ближайшие 3 тура: есть хотя бы один матч с датой >= сегодня
        today = datetime.now().date()
        def tour_is_upcoming(t):
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

        upcoming = [t for t in tours if tour_is_upcoming(t)]
        def tour_sort_key(t):
            try:
                return (datetime.fromisoformat(t.get('start_at') or '2100-01-01T00:00:00'), t.get('tour') or 10**9)
            except Exception:
                return (datetime(2100,1,1), t.get('tour') or 10**9)
        upcoming.sort(key=tour_sort_key)
        upcoming = upcoming[:3]

        payload = { 'updated_at': datetime.now(timezone.utc).isoformat(), 'tours': upcoming }
        _core = {'tours': upcoming}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        inm = request.headers.get('If-None-Match')
        if inm and inm == _etag and SCHEDULE_CACHE['data']:
            resp = app.response_class(status=304)
            resp.headers['ETag'] = _etag
            resp.headers['Cache-Control'] = 'private, max-age=900'
            return resp

        SCHEDULE_CACHE['data'] = payload
        SCHEDULE_CACHE['ts'] = int(time.time())
        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'private, max-age=900'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки расписания: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить расписание'}), 500

def _load_all_tours_from_sheet():
    """Читает лист расписания и возвращает список всех туров с матчами.
    Формат тура: { tour:int, title:str, start_at:iso, matches:[{home,away,date,time,datetime,score_home,score_away}] }
    """
    ws = get_schedule_sheet()
    rows = ws.get_all_values() or []

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
    """Возвращает туры для ставок: начиная с текущего дня и ещё два следующих тура.
    Для матчей в прошлом блокируем ставки (поле lock: true)."""
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

        all_tours = _load_all_tours_from_sheet()
        today = datetime.now().date()

        def is_relevant(t):
            # тур релевантен, если есть матч с датой >= сегодня
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
        tours = tours[:1]  # только ближайший тур

        # отметим для каждого матча, можно ли ставить (до начала)
        now = datetime.now()
        for t in tours:
            for m in t.get('matches', []):
                try:
                    lock = False
                    if m.get('datetime'):
                        lock = datetime.fromisoformat(m['datetime']) <= now
                    elif m.get('date'):
                        # если нет времени — считаем до конца дня
                        d = datetime.fromisoformat(m['date']).date()
                        lock = datetime.combine(d, datetime.max.time()) <= now
                    m['lock'] = bool(lock)
                    # посчитаем коэффициенты для отображения
                    m['odds'] = _compute_match_odds(m.get('home',''), m.get('away',''))
                    # дополнительные рынки: тоталы (3.5/4.5/5.5)
                    totals = []
                    for ln in (3.5, 4.5, 5.5):
                        totals.append({'line': ln, 'odds': _compute_totals_odds(m.get('home',''), m.get('away',''), ln)})
                    m['markets'] = {
                        'totals': totals,
                        'specials': {
                            'penalty': { 'available': False },
                            'redcard': { 'available': False }
                        }
                    }
                except Exception:
                    m['lock'] = True

        return jsonify({ 'tours': tours, 'updated_at': datetime.now(timezone.utc).isoformat() })
    except Exception as e:
        app.logger.error(f"Ошибка betting tours: {e}")
        return jsonify({'error': 'Не удалось загрузить туры для ставок'}), 500

 

@app.route('/api/betting/my-bets', methods=['POST'])
def api_betting_my_bets():
    """Список ставок пользователя (последние 50)."""
    try:
        parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
        if not parsed or not parsed.get('user'):
            return jsonify({'error': 'Недействительные данные'}), 401
        user_id = int(parsed['user'].get('id'))
        if SessionLocal is None:
            return jsonify({'error': 'БД недоступна'}), 500
        db: Session = get_db()
        try:
            rows = db.query(Bet).filter(Bet.user_id == user_id).order_by(Bet.placed_at.desc()).limit(50).all()
            data = []
            for b in rows:
                data.append({
                    'id': b.id,
                    'tour': b.tour,
                    'home': b.home,
                    'away': b.away,
                    'datetime': (b.match_datetime.isoformat() if b.match_datetime else ''),
                    'market': b.market,
                    'selection': b.selection,
                    'odds': b.odds,
                    'stake': b.stake,
                    'status': b.status,
                    'payout': b.payout,
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
    """Ищет матч в расписании и возвращает ('home'|'draw'|'away') если есть счёт, иначе None."""
    tours = _load_all_tours_from_sheet()
    for t in tours:
        for m in t.get('matches', []):
            if (m.get('home') == home and m.get('away') == away):
                res = _winner_from_scores(m.get('score_home',''), m.get('score_away',''))
                return res
    return None

def _get_match_total_goals(home: str, away: str):
    tours = _load_all_tours_from_sheet()
    for t in tours:
        for m in t.get('matches', []):
            if (m.get('home') == home and m.get('away') == away):
                h = _parse_score(m.get('score_home',''))
                a = _parse_score(m.get('score_away',''))
                if h is None or a is None:
                    return None
                return h + a
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
                # selection вид: 'over_3.5' или 'under_4.5'
                parts = (b.selection or '').split('_', 1)
                if len(parts) != 2:
                    continue
                side, line_str = parts[0], parts[1]
                try:
                    line = float(line_str)
                except Exception:
                    continue
                total = _get_match_total_goals(b.home, b.away)
                if total is None:
                    continue
                won = (total > line) if side == 'over' else (total < line)
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
    """Возвращает все прошедшие матчи из листа 'РАСПИСАНИЕ ИГР'.
    Использует колонки: A(home), B(score_home), D(score_away), E(away), F(date dd.mm.yy), G(time HH:MM).
    """
    try:
        ws = get_schedule_sheet()
        rows = ws.get_all_values() or []

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
            # Заголовок тура: "N Тур"
            header_num = None
            if a:
                parts = a.replace('\u00A0', ' ').strip().split()
                if len(parts) >= 2 and parts[0].isdigit() and parts[1].lower().startswith('тур'):
                    header_num = int(parts[0])
            if header_num is not None:
                current_tour = header_num
                continue

            # строки матчей
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

                # матч считается прошедшим, если дата/время <= сейчас
                now = datetime.now()
                is_past = False
                try:
                    if dt:
                        is_past = dt <= now
                    elif d:
                        is_past = d <= now.date()
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

        # сортируем прошедшие матчи по дате/времени убыв.
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
        _core = {'results': results[:200]}  # усечённое ядро для ETag, чтобы не дуло слишком длинным
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        inm = request.headers.get('If-None-Match')
        # простой in-memory кеш по etag можно добавить при необходимости; пока полагаемся на клиентский ETag
        if inm and inm == _etag:
            resp = app.response_class(status=304)
            resp.headers['ETag'] = _etag
            resp.headers['Cache-Control'] = 'private, max-age=900'
            return resp

        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'private, max-age=900'
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
            s = (s or '').lower().strip()
            s = s.replace('\u00A0', ' ').replace('ё', 'е')
            s = s.replace('фк', '', 1).strip() if s.startswith('фк') else s  # убираем префикс ФК
            return ''.join(ch for ch in s if ch.isalnum())

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
        headers = ws.row_values(1) or []
        # карта нормализованных заголовков -> индекс (1-based)
        idx_map = {}
        for i, h in enumerate(headers, start=1):
            key = norm(h)
            if key:
                idx_map[key] = i

        def extract(team_name: str):
            key = norm(team_name)
            col_idx = idx_map.get(key)
            # если не нашли — попробуем без лишних слов (например, второе слово и т.п.)
            if col_idx is None:
                # простая эвристика: оставим только буквенно-цифровые, без пробелов уже сделано
                # попробуем найти подстрочной похожестью среди ключей
                for k, i in idx_map.items():
                    if key in k or k in key:
                        col_idx = i
                        break
            if col_idx is None:
                return {'team': team_name, 'players': []}
            col_vals = ws.col_values(col_idx)
            # убираем заголовок
            players = [v.strip() for v in col_vals[1:] if v and v.strip()]
            return {'team': headers[col_idx-1] or team_name, 'players': players}

        home_data = extract(home)
        away_data = extract(away)

        # Версионируем содержимое через хеш, чтобы поддержать ETag/кэш
        import hashlib, json as _json
        payload_core = {
            'teams': {'home': home_data['team'], 'away': away_data['team']},
            'rosters': {'home': home_data['players'], 'away': away_data['players']}
        }
        etag = hashlib.md5(_json.dumps(payload_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        # Сохраняем в кеш
        MATCH_DETAILS_CACHE[cache_key] = { 'ts': now_ts, 'etag': etag, 'payload': payload_core }
        resp = jsonify({ **payload_core, 'version': etag })
        resp.headers['ETag'] = etag
        resp.headers['Cache-Control'] = 'private, max-age=3600'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка получения составов: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить составы'}), 500

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

        # форс-обновление: игнорируем кеш
        ws = get_table_sheet()
        values = ws.get('A1:H10') or []
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
        LEAGUE_TABLE_CACHE['ts'] = int(time.time())
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
            finally:
                db.close()
        return jsonify({'status': 'ok', 'updated_at': payload['updated_at']})
    except Exception as e:
        app.logger.error(f"Ошибка принудительного обновления лиги: {str(e)}")
        return jsonify({'error': 'Не удалось обновить таблицу'}), 500

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
        # ETag и условный ответ
        _core = {'range': 'A1:G11', 'values': normalized}
        _etag = hashlib.md5(json.dumps(_core, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
        inm = request.headers.get('If-None-Match')
        if inm and inm == _etag and STATS_TABLE_CACHE['data']:
            resp = app.response_class(status=304)
            resp.headers['ETag'] = _etag
            resp.headers['Cache-Control'] = 'private, max-age=1800'
            return resp

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

        resp = jsonify({**payload, 'version': _etag})
        resp.headers['ETag'] = _etag
        resp.headers['Cache-Control'] = 'private, max-age=1800'
        return resp
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы статистики: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить статистику'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
