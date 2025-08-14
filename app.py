# app.py
import os
import json
import time
import hmac
import hashlib
from datetime import datetime, timedelta, timezone
from flask import Flask, render_template, request, jsonify
from urllib.parse import parse_qs
import gspread
from google.oauth2.service_account import Credentials

app = Flask(__name__)

# Простой кеш для таблицы лиги (обновление раз в час)
LEAGUE_TABLE_CACHE = {
    'ts': 0,       # unix timestamp последнего обновления
    'data': None   # кэшированные данные таблицы
}
LEAGUE_TABLE_TTL = 60 * 60  # 1 час

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

def initialize_new_user(user_data):
    """Инициализирует нового пользователя"""
    sheet = get_user_sheet()
    new_row = [
        user_data['id'],
        user_data.get('first_name', 'User'),
        user_data.get('username', ''),
        '1000',  # credits
        '0',     # xp
        '1',     # level
        '1',     # consecutive_days
        '',      # last_checkin_date
        '0',     # badge_tier
        '',      # badge_unlocked_at (J)
        datetime.now(timezone.utc).isoformat(),  # created_at (K)
        datetime.now(timezone.utc).isoformat()   # updated_at (L)
    ]
    sheet.append_row(new_row)
    return new_row

def _to_int(val, default=0):
    try:
        return int(val)
    except Exception:
        return default

def parse_user_data(row):
    """Преобразует строку таблицы в объект пользователя"""
    # Гарантируем длину массива значений
    row = list(row) + [''] * (12 - len(row))
    return {
        'user_id': _to_int(row[0]),                # A
        'display_name': row[1],                    # B
        'tg_username': row[2],                     # C
        'credits': _to_int(row[3]),                # D
        'xp': _to_int(row[4]),                     # E
        'level': _to_int(row[5], 1),               # F
        'consecutive_days': _to_int(row[6]),       # G
        'last_checkin_date': row[7],               # H
        'badge_tier': _to_int(row[8]),             # I
        # row[9] = J (badge_unlocked_at) — сейчас в ответ не включаем
        'created_at': row[10],                     # K
        'updated_at': row[11]                      # L
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

        row_num = find_user_row(user_data['id'])
        sheet = get_user_sheet()

        if not row_num:
            new_user = initialize_new_user(user_data)
            user = parse_user_data(new_user)
        else:
            row = sheet.row_values(row_num)
            user = parse_user_data(row)

        return jsonify(user)

    except Exception as e:
        app.logger.error(f"Ошибка получения пользователя: {str(e)}")
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
        
        row_num = find_user_row(user_id)
        if not row_num:
            return jsonify({'error': 'Пользователь не найден'}), 404
        
        sheet = get_user_sheet()
        # Обновляем имя (B) и updated_at (L)
        sheet.batch_update([
            {'range': f'B{row_num}', 'values': [[new_name]]},
            {'range': f'L{row_num}', 'values': [[datetime.now(timezone.utc).isoformat()]]}
        ])
        
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

        row_num = find_user_row(user_id)
        if not row_num:
            return jsonify({'error': 'Пользователь не найден'}), 404

        sheet = get_user_sheet()
        row = sheet.row_values(row_num)
        user = parse_user_data(row)

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
        new_xp = user['xp'] + xp_reward
        new_credits = user['credits'] + credits_reward

        # Расчет уровня
        new_level = user['level']
        while new_xp >= new_level * 100:
            new_xp -= new_level * 100
            new_level += 1

        # Обновление строки
        # Групповое обновление ячеек одним запросом
        sheet.batch_update([
            {'range': f'H{row_num}', 'values': [[today.isoformat()]]},       # last_checkin_date
            {'range': f'G{row_num}', 'values': [[str(new_consecutive)]]},    # consecutive_days
            {'range': f'E{row_num}', 'values': [[str(new_xp)]]},             # xp
            {'range': f'D{row_num}', 'values': [[str(new_credits)]]},        # credits
            {'range': f'F{row_num}', 'values': [[str(new_level)]]},          # level
            {'range': f'L{row_num}', 'values': [[datetime.now(timezone.utc).isoformat()]]}  # updated_at
        ])

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

        row_num = find_user_row(user_id)
        if not row_num:
            return jsonify({'error': 'Пользователь не найден'}), 404

        sheet = get_user_sheet()
        row = sheet.row_values(row_num)
        user = parse_user_data(row)
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
        return jsonify(payload)
    except Exception as e:
        app.logger.error(f"Ошибка загрузки таблицы лиги: {str(e)}")
        return jsonify({'error': 'Не удалось загрузить таблицу'}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
