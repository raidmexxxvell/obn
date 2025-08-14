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
        
        # Определяем текущий уровень достижений
        achievements = []
        
        # Золото (120 дней)
        if user['consecutive_days'] >= 120:
            achievements.append({
                'tier': 3,
                'name': 'Золото',
                'days': 120,
                'icon': 'gold',
                'unlocked': True
            })
        # Серебро (30 дней)
        elif user['consecutive_days'] >= 30:
            achievements.append({
                'tier': 2,
                'name': 'Серебро',
                'days': 30,
                'icon': 'silver',
                'unlocked': True
            })
        # Бронза (7 дней)
        elif user['consecutive_days'] >= 7:
            achievements.append({
                'tier': 1,
                'name': 'Бронза',
                'days': 7,
                'icon': 'bronze',
                'unlocked': True
            })
        # Если нет достижений, добавляем заглушку
        else:
            achievements.append({
                'tier': 1,
                'name': 'Бронза',
                'days': 7,
                'icon': 'bronze',
                'unlocked': False
            })
        

        return jsonify({'achievements': achievements})

    except Exception as e:
        app.logger.error(f"Ошибка получения достижений: {str(e)}")
        return jsonify({'error': 'Внутренняя ошибка сервера'}), 500

@app.route('/health')
def health():
    """Healthcheck для Render.com"""
    return jsonify(status="healthy"), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
