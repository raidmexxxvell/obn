# app.py
import os
import json
import time
from datetime import datetime, timedelta, timezone
from flask import Flask, render_template, request, jsonify
import gspread
from oauth2client.service_account import ServiceAccountCredentials

app = Flask(__name__)

# Настройка Google Sheets
def get_google_client():
    """Создает клиент для работы с Google Sheets API"""
    scope = ['https://spreadsheets.google.com/feeds', 'https://www.googleapis.com/auth/drive']
    creds_data = json.loads(os.environ.get('GOOGLE_SHEETS_CREDENTIALS', '{}'))
    
    if not creds_data:
        raise ValueError("Отсутствуют данные сервисного аккаунта в переменных окружения")
    
    credentials = ServiceAccountCredentials.from_json_keyfile_dict(creds_data, scope)
    return gspread.authorize(credentials)

def get_user_sheet():
    """Получает лист пользователей из Google Sheets"""
    client = get_google_client()
    sheet = client.open_by_key(os.environ['SHEET_ID'])
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
        user_data['first_name'],
        user_data.get('username', ''),
        '1000',  # credits
        '0',     # xp
        '1',     # level
        '1',     # consecutive_days
        '',      # last_checkin_date
        '0',     # badge_tier
        '',      # badge_unlocked_at
        datetime.now(timezone.utc).isoformat(),
        datetime.now(timezone.utc).isoformat()
    ]
    sheet.append_row(new_row)
    return new_row

def parse_user_data(row):
    """Преобразует строку таблицы в объект пользователя"""
    return {
        'user_id': int(row[0]),
        'display_name': row[1],
        'tg_username': row[2],
        'credits': int(row[3]),
        'xp': int(row[4]),
        'level': int(row[5]),
        'consecutive_days': int(row[6]),
        'last_checkin_date': row[7],
        'badge_tier': int(row[8]),
        'created_at': row[9],
        'updated_at': row[10]
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
        user_data = request.json.get('user')
        if not user_data:
            return jsonify({'error': 'Данные пользователя не переданы'}), 400

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

@app.route('/api/checkin', methods=['POST'])
def daily_checkin():
    """Обрабатывает ежедневный чекин"""
    try:
        user_id = request.json.get('user_id')
        if not user_id:
            return jsonify({'error': 'user_id обязателен'}), 400

        row_num = find_user_row(user_id)
        if not row_num:
            return jsonify({'error': 'Пользователь не найден'}), 404

        sheet = get_user_sheet()
        row = sheet.row_values(row_num)
        user = parse_user_data(row)

        # Проверка даты чекина
        today = datetime.now(timezone.utc).date()
        last_checkin = datetime.fromisoformat(user['last_checkin_date']).date() if user['last_checkin_date'] else None

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
        sheet.update(f'H{row_num}', today.isoformat())
        sheet.update(f'G{row_num}', str(new_consecutive))
        sheet.update(f'E{row_num}', str(new_xp))
        sheet.update(f'D{row_num}', str(new_credits))
        sheet.update(f'F{row_num}', str(new_level))
        sheet.update(f'K{row_num}', datetime.now(timezone.utc).isoformat())

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

@app.route('/health')
def health():
    """Healthcheck для Render.com"""
    return jsonify(status="healthy"), 200

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)