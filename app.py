# app.py
import os
import logging
import threading
import time
import json
import traceback
from datetime import datetime, timezone, timedelta
from functools import wraps
from google.auth.transport.requests import Request

from flask import Flask, request, render_template, jsonify, session, redirect, url_for
import telebot
from telebot import types
from sqlalchemy import create_engine, text as sql_text
import random
import requests

def check_time_sync():
    """Проверяет синхронизацию времени с Google"""
    try:
        # Получаем текущее время с сервера Google
        response = requests.head('https://www.google.com', timeout=5)
        google_time_str = response.headers['Date']
        google_time = datetime.strptime(google_time_str, '%a, %d %b %Y %H:%M:%S GMT')
        google_time = google_time.replace(tzinfo=timezone.utc)
        
        # Текущее время на сервере
        server_time = datetime.now(timezone.utc)
        
        # Разница во времени в секундах
        time_diff = abs((google_time - server_time).total_seconds())
        
        logger.info(f"Time sync check: Google time = {google_time}, Server time = {server_time}, Difference = {time_diff} seconds")
        
        if time_diff > 300:  # 5 минут
            logger.error(f"CRITICAL: Time difference with Google is {time_diff} seconds (more than 300 seconds)!")
            return False
        return True
    except Exception as e:
        logger.warning(f"Could not check time sync: {e}")
        return True  # Не блокируем работу при ошибке проверки

# Optional: gspread for Google Sheets integration
try:
    import gspread
    from google.oauth2 import service_account
    GS_ENABLED = True
    logger = logging.getLogger(__name__)
    logger.info("gspread и google.oauth2 успешно импортированы")
except ImportError as e:
    logger = logging.getLogger(__name__)
    logger.warning("gspread не установлен: %s", e)
    GS_ENABLED = False

# --- Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

# --- Environment / Config ---
TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
if not TOKEN:
    raise RuntimeError("TELEGRAM_BOT_TOKEN required")

OWNER_ID = int(os.getenv("OWNER_TELEGRAM_ID", "0")) or None
if not OWNER_ID:
    raise RuntimeError("OWNER_TELEGRAM_ID required")

RENDER_URL = os.getenv("RENDER_URL", "https://football-league-app.onrender.com").rstrip('/')
WEBHOOK_URL = f"{RENDER_URL}/{TOKEN}"
MINIAPP_URL = f"{RENDER_URL}/miniapp"

DATABASE_URL = os.getenv("DATABASE_URL")  # Postgres URL
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

# Google Sheets
GS_CREDS_JSON = os.getenv("GS_CREDS_JSON")  # JSON string of service account creds
GS_SHEET_ID = os.getenv("GS_SHEET_ID")      # spreadsheet id

# Promo codes mapping by milestone level
PROMOCODES_BY_LEVEL = {
    10: "PROMO10",
    25: "PROMO25",
    50: "PROMO50",
    100: "PROMO100"
}

# --- DB init ---
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is required (Postgres).")

engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)

# Проверяем синхронизацию времени
if not check_time_sync():
    logger.warning("Time is not synchronized with Google. This may cause JWT signature errors.")
    
def init_db():
    with engine.connect() as conn:
        # users table
        conn.execute(sql_text('''
    CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username TEXT,
        display_name TEXT,
        level INTEGER DEFAULT 1,
        xp INTEGER DEFAULT 0,
        coins INTEGER DEFAULT 0,
        badges TEXT DEFAULT '',
        referrer BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banned_until TIMESTAMP
    )
''').execution_options(autocommit=True))
        
        # Проверяем и добавляем недостающие колонки
        existing_columns = [row[0] for row in conn.execute(sql_text("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users'
        """))]
        
        # Добавляем колонку streak если её нет
        if 'streak' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE users ADD COLUMN streak INTEGER DEFAULT 0"))
            logger.info("Added 'streak' column to users table")
        
        # Добавляем колонку last_streak_date если её нет
        if 'last_streak_date' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE users ADD COLUMN last_streak_date DATE"))
            logger.info("Added 'last_streak_date' column to users table")
        
        # Добавляем новые колонки, если их нет
        if 'full_name' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE users ADD COLUMN full_name TEXT"))
            logger.info("Added 'full_name' column to users table")
        
        if 'birth_date' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE users ADD COLUMN birth_date DATE"))
            logger.info("Added 'birth_date' column to users table")
        
        if 'favorite_club' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE users ADD COLUMN favorite_club TEXT"))
            logger.info("Added 'favorite_club' column to users table")
        
        # matches
        conn.execute(sql_text('''
            CREATE TABLE IF NOT EXISTS matches (
                id SERIAL PRIMARY KEY,
                round INTEGER,
                team1 TEXT,
                team2 TEXT,
                score1 INTEGER DEFAULT 0,
                score2 INTEGER DEFAULT 0,
                datetime TIMESTAMP,
                status TEXT DEFAULT 'scheduled',
                stream_url TEXT,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                odds_team1 INTEGER DEFAULT 35,
                odds_team2 INTEGER DEFAULT 65,
                odds_draw INTEGER DEFAULT 0
            )
        '''))
        
        # Проверяем и добавляем недостающие колонки в таблицу matches
        existing_columns = [row[0] for row in conn.execute(sql_text("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'matches'
        """))]
        
        if 'odds_team1' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE matches ADD COLUMN odds_team1 INTEGER DEFAULT 35"))
            logger.info("Added 'odds_team1' column to matches table")
        
        if 'odds_team2' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE matches ADD COLUMN odds_team2 INTEGER DEFAULT 65"))
            logger.info("Added 'odds_team2' column to matches table")
        
        if 'odds_draw' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE matches ADD COLUMN odds_draw INTEGER DEFAULT 0"))
            logger.info("Added 'odds_draw' column to matches table")
        
        # products table
        conn.execute(sql_text('''
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                name TEXT,
                price INTEGER,
                image TEXT,
                description TEXT,
                stock INTEGER DEFAULT 100
            )
        '''))
        
        # Проверяем и добавляем недостающие колонки в таблицу products
        existing_columns = [row[0] for row in conn.execute(sql_text("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'products'
        """))]
        
        if 'stock' not in existing_columns:
            conn.execute(sql_text("ALTER TABLE products ADD COLUMN stock INTEGER DEFAULT 100"))
            logger.info("Added 'stock' column to products table")
        
        # cart table
        conn.execute(sql_text('''
            CREATE TABLE IF NOT EXISTS cart (
                id SERIAL PRIMARY KEY,
                user_id BIGINT,
                product_id INTEGER,
                quantity INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        '''))
        
        # achievements table
        conn.execute(sql_text('''
            CREATE TABLE IF NOT EXISTS achievements (
                id SERIAL PRIMARY KEY,
                user_id BIGINT,
                achievement_id TEXT,
                achieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        '''))
        
        # referrals table
        conn.execute(sql_text('''
            CREATE TABLE IF NOT EXISTS referrals (
                id SERIAL PRIMARY KEY,
                referrer_id BIGINT,
                referee_id BIGINT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        '''))
    
    logger.info("DB initialized")

init_db()

# --- gspread (Google Sheets) setup ---
gs_client = None
sheet = None
if GS_ENABLED and GS_CREDS_JSON and GS_SHEET_ID:
    try:
        # Добавляем подробное логирование для диагностики
        logger.info("Attempting to connect to Google Sheets...")
        logger.info("GS_CREDS_JSON length: %d", len(GS_CREDS_JSON) if GS_CREDS_JSON else 0)
        logger.info("GS_SHEET_ID: %s", GS_SHEET_ID)
        
        # Проверяем корректность JSON
        try:
            creds_dict = json.loads(GS_CREDS_JSON)
            logger.info("Successfully parsed GS_CREDS_JSON")
        except json.JSONDecodeError as e:
            logger.error("GS_CREDS_JSON is not valid JSON: %s", e)
            raise
        
        # Проверяем необходимые поля в JSON
        required_fields = ['client_email', 'private_key', 'token_uri']
        missing_fields = [field for field in required_fields if field not in creds_dict]
        if missing_fields:
            logger.error("Missing required fields in GS_CREDS_JSON: %s", missing_fields)
            raise ValueError(f"Missing required fields: {missing_fields}")
        
        # Используем современный метод авторизации
        from google.oauth2 import service_account
        
        # Обновленные scope для современного API
        SCOPES = [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive'
        ]
        
        # Создаем учетные данные
        credentials = service_account.Credentials.from_service_account_info(
            creds_dict, scopes=SCOPES)
        
        # Авторизуемся через gspread
        gs_client = gspread.authorize(credentials)
        logger.info("Successfully authorized with Google Sheets API")
        
        # Пытаемся открыть таблицу
        try:
            sheet = gs_client.open_by_key(GS_SHEET_ID)
            logger.info("Successfully connected to Google Sheets with title: %s", sheet.title)
        except gspread.exceptions.APIError as e:
            error_details = e.response.json()
            if 'error' in error_details and 'message' in error_details['error']:
                error_message = error_details['error']['message']
                if 'has no permission' in error_message or 'Forbidden' in error_message:
                    logger.error("ACCESS ERROR: Service account does not have access to the spreadsheet. "
                                "Please share the spreadsheet with: %s", 
                                creds_dict.get('client_email', 'UNKNOWN_EMAIL'))
            raise
    except Exception as e:
        logger.exception("Google Sheets connection failed with detailed error:")
        gs_client = None
        sheet = None
else:
    status = {
        "GS_ENABLED": GS_ENABLED,
        "GS_CREDS_JSON": bool(GS_CREDS_JSON),
        "GS_SHEET_ID": bool(GS_SHEET_ID)
    }
    logger.warning("Google Sheets is not configured. Status: %s", status)
    gs_client = None
    sheet = None

# --- Flask and TeleBot ---
app = Flask(__name__, static_folder='static', template_folder='templates')
app.secret_key = os.getenv("FLASK_SECRET", "supersecret")

bot = telebot.TeleBot(TOKEN)
# remove webhook then set
try:
    bot.remove_webhook()
    bot.set_webhook(url=WEBHOOK_URL)
    logger.info("Webhook set to %s", WEBHOOK_URL)
except Exception as e:
    logger.warning("Failed to set webhook: %s", e)

# --- Anti-spam protection ---
user_last_request = {}

def anti_spam(wait_time=2):
    """Decorator to prevent spamming (wait_time in seconds)"""
    def decorator(func):
        @wraps(func)
        def wrapped(*args, **kwargs):
            user_id = request.json.get('user_id') if request.json else request.args.get('user_id')
            if user_id:
                user_id = int(user_id)
                current_time = time.time()
                last_time = user_last_request.get(user_id, 0)
                
                if current_time - last_time < wait_time:
                    return jsonify({"error": "Too many requests. Please wait."}), 429
                
                user_last_request[user_id] = current_time
            return func(*args, **kwargs)
        return wrapped
    return decorator

# --- Auto-ping to keep bot awake ---
def keep_alive():
    while True:
        try:
            requests.get(RENDER_URL)
            logger.info("Keep-alive ping sent to %s", RENDER_URL)
        except Exception as e:
            logger.error("Keep-alive error: %s", e)
        time.sleep(300)  # every 5 minutes

# Start keep-alive thread
keep_alive_thread = threading.Thread(target=keep_alive, daemon=True)
keep_alive_thread.start()

# --- Miniapp routes ---
@app.route('/')
def index():
    return redirect(url_for('miniapp'))

@app.route('/miniapp')
def miniapp():
    # Получаем user_id из сессии
    user_id = session.get('user_id', 0)
    # Передаем user_id в шаблон
    return render_template('miniapp_index.html', 
                          miniapp_url=MINIAPP_URL, 
                          owner_id=OWNER_ID,
                          user_id=user_id)

@app.route('/miniapp/init', methods=['POST'])
def miniapp_init():
    """Initialize user session"""
    data = request.json or {}
    user_id = int(data.get('user_id', 0))
    username = data.get('username') or ""
    display_name = data.get('display_name') or ""
    
    if not user_id:
        return jsonify({"success": False, "error": "invalid_user"}), 400
    
    session['user_id'] = user_id
    user = ensure_user_exists(user_id, username, display_name)
    
    # Update active session
    with engine.begin() as conn:
        conn.execute(sql_text("DELETE FROM active_sessions WHERE user_id = :id"), {"id": user_id})
        conn.execute(sql_text("INSERT INTO active_sessions (user_id, page) VALUES (:id, :page) ON CONFLICT (user_id) DO UPDATE SET last_active=NOW(), page=:page"),
                     {"id": user_id, "page": "home"})
    
    # Check daily streak
    check_daily_streak(user_id)
    
    return jsonify({
        "success": True,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "level": user.level,
            "xp": user.xp,
            "coins": user.coins,
            "streak": user.streak,
            "badges": (user.badges or "").split(",") if user.badges else []
        }
    })

@app.route('/miniapp/home')
def miniapp_home():
    user_id = session.get('user_id', 0)
    if not user_id:
        # Добавляем небольшую задержку для синхронизации сессии
        time.sleep(0.5)
        user_id = session.get('user_id', 0)
        if not user_id:
            logger.warning("User not authorized in /miniapp/home after retry")
            return "Not authorized", 403
    
    rounds = []
    for r in range(1, 4):
        matches = get_matches(r)
        rounds.append({"number": r, "matches": matches})
    
    return render_template('home.html', rounds=rounds, user_id=user_id, owner_id=OWNER_ID)

@app.route('/miniapp/standings')
def miniapp_standings():
    if not gs_client or not sheet:
        return "Google Sheets не настроен", 500
    
    try:
        ws = sheet.worksheet("ТАБЛИЦА")
        data = ws.get_all_values()
        return render_template('standings.html', table=data)
    except Exception as e:
        logger.error(f"Ошибка чтения Google Sheets: {e}")
        return "Ошибка чтения данных", 500

@app.route('/miniapp/nlo')
def miniapp_nlo():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    rounds = []
    for r in range(1, 4):
        matches = get_matches(r)
        rounds.append({"number": r, "matches": matches})
    
    return render_template('nlo.html', rounds=rounds, user_id=user_id, owner_id=OWNER_ID)

@app.route('/miniapp/nlo/streams')
def miniapp_nlo_streams():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauthorized"}), 403
    
    matches = get_live_matches()
    return render_template('nlo_streams.html', matches=matches, user_id=user_id)

@app.route('/miniapp/predictions')
def miniapp_predictions():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    matches = get_upcoming_matches()
    return render_template('predictions.html', matches=matches, user_id=user_id)

@app.route('/miniapp/profile')
def miniapp_profile():
    user_id = session.get('user_id', 0)
    if not user_id:
        logger.warning("Попытка доступа к профилю без user_id в сессии")
        return "Not authorized", 403
    
    logger.info(f"Запрос профиля для user_id={user_id}")
    
    try:
        user = get_user(user_id)
        if not user:
            logger.warning(f"Пользователь с user_id={user_id} не найден")
            return "User not found", 404
        
        stats = get_user_stats(user_id)
        achievements = get_user_achievements(user_id)
        
        # Формируем реферальную ссылку
        referral_link = f"{MINIAPP_URL}?ref={user_id}"
        
        logger.info(f"Профиль для user_id={user_id} успешно загружен")
        return render_template('profile.html', 
                              user=user, 
                              stats=stats, 
                              achievements=achievements,
                              user_id=user_id,
                              referral_link=referral_link)
    except Exception as e:
        logger.error(f"Ошибка при загрузке профиля для user_id={user_id}: {str(e)}", exc_info=True)
        return "Internal server error", 500
        
@app.route('/miniapp/profile/edit', methods=['GET'])
def miniapp_profile_edit():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    user = get_user(user_id)
    
    # Получаем список команд из Google Sheets
    clubs = []
    if gs_client and sheet:
        try:
            ws = sheet.worksheet("ТАБЛИЦА")
            # Получаем названия команд из столбца B, строки 2-10
            for i in range(2, 11):
                club = ws.cell(i, 2).value  # Столбец B - индекс 2
                if club:
                    clubs.append(club)
        except Exception as e:
            logger.error(f"Error getting clubs from Google Sheets: {e}")
    
    return render_template('profile_edit.html', 
                          user=user, 
                          clubs=clubs,
                          user_id=user_id)

@app.route('/miniapp/profile/save', methods=['POST'])
def miniapp_profile_save():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauthorized"}), 403
    
    data = request.json
    full_name = data.get('full_name', '')
    birth_date = data.get('birth_date', '')
    favorite_club = data.get('favorite_club', '')
    
    try:
        with engine.begin() as conn:
            # Преобразуем дату в правильный формат
            birth_date_formatted = None
            if birth_date:
                try:
                    # Пытаемся преобразовать дату в формат YYYY-MM-DD
                    birth_date_obj = datetime.strptime(birth_date, "%Y-%m-%d")
                    birth_date_formatted = birth_date_obj.strftime("%Y-%m-%d")
                except ValueError:
                    pass
            
            # Обновляем профиль
            conn.execute(sql_text("""
                UPDATE users 
                SET full_name = :full_name, 
                    birth_date = :birth_date, 
                    favorite_club = :favorite_club
                WHERE id = :user_id
            """), {
                "full_name": full_name,
                "birth_date": birth_date_formatted,
                "favorite_club": favorite_club,
                "user_id": user_id
            })
        
        return jsonify({"success": True})
    except Exception as e:
        logger.error(f"Error saving profile: {e}")
        return jsonify({"error": "server_error"}), 500

@app.route('/miniapp/profile_api')
def miniapp_profile_api():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    user = get_user(user_id)
    stats = get_user_stats(user_id)
    achievements = get_user_achievements(user_id)
    
    if not user:
        return jsonify({"error": "notfound"}), 404
    
    return jsonify({
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "level": user.level,
        "xp": user.xp,
        "coins": user.coins,
        "streak": user.streak,
        "badges": (user.badges or "").split(",") if user.badges else [],
        "stats": stats,
        "achievements": achievements
    })
    
@app.route('/miniapp/achievements')
def miniapp_achievements():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauthorized"}), 403
    
    achievements = get_user_achievements(user_id)
    return jsonify([{
        "id": a.achievement_id,
        "name": a.name,
        "description": a.description,
        "tier": a.tier,
        "achieved_at": format_datetime(a.achieved_at)
    } for a in achievements])

@app.route('/miniapp/shop')
def miniapp_shop():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    products = get_products()
    user = get_user(user_id)
    
    return render_template('shop.html', products=products, user=user, user_id=user_id)

@app.route('/miniapp/cart')
def miniapp_cart():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    cart_items = get_cart_items(user_id)
    total = sum(item.price * item.quantity for item in cart_items)
    user = get_user(user_id)
    
    return render_template('cart.html', cart_items=cart_items, total=total, user=user, user_id=user_id)

@app.route('/miniapp/admin')
def miniapp_admin():
    user_id = session.get('user_id', 0)
    logger.info(f"Попытка доступа к админ-панели: user_id={user_id}, OWNER_ID={OWNER_ID}")
    
    if user_id != OWNER_ID:
        logger.warning(f"Доступ запрещен: user_id={user_id} не совпадает с OWNER_ID={OWNER_ID}")
        return "Доступ запрещён", 403
    
    stats = current_online_counts()
    orders = get_pending_orders()
    bets = get_recent_bets()
    
    return render_template('admin.html', 
                          stats=stats, 
                          orders=orders, 
                          bets=bets,
                          user_id=user_id)
    
    stats = current_online_counts()
    orders = get_pending_orders()
    bets = get_recent_bets()
    
    return render_template('admin.html', 
                          stats=stats, 
                          orders=orders, 
                          bets=bets,
                          user_id=user_id)

@app.route('/miniapp/admin/update_data', methods=['POST'])
def admin_update_data():
    user_id = session.get('user_id', 0)
    if user_id != OWNER_ID:
        return jsonify({"success": False, "error": "access denied"}), 403
    
    try:
        sync_all_data_to_sheets()
        return jsonify({"success": True})
    except Exception as e:
        logger.error("Error syncing data to sheets: %s", e)
        return jsonify({"success": False, "error": str(e)}), 500

# --- API routes ---
@app.route('/miniapp/daily_check', methods=['POST'])
def daily_check():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    streak, coins = get_daily_streak_bonus(user_id)
    return jsonify({
        "success": True,
        "streak": streak,
        "coins": coins,
        "message": f"Вы получили {coins} кредитов за {streak}-дневный стрик!"
    })

@app.route('/miniapp/place_bet', methods=['POST'])
@anti_spam()
def place_bet():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    data = request.json
    match_id = data.get('match_id')
    bet_type = data.get('bet_type')
    amount = data.get('amount')
    prediction = data.get('prediction', "")
    
    if not match_id or not bet_type or not amount:
        return jsonify({"error": "invalid data"}), 400
    
    # Проверка, что матч еще не начался
    match = get_match(match_id)
    if not match or match.status != 'scheduled':
        return jsonify({"error": "match not available"}), 400
    
    # Проверка, что пользователь имеет достаточно средств
    user = get_user(user_id)
    if user.coins < amount:
        return jsonify({"error": "insufficient funds"}), 400
    
    # Проверка минимальной ставки
    if amount < 10:
        return jsonify({"error": "minimum bet is 10"}), 400
    
    # Запись ставки
    with engine.begin() as conn:
        conn.execute(sql_text("""
            INSERT INTO bets (user_id, match_id, type, amount, prediction)
            VALUES (:user_id, :match_id, :bet_type, :amount, :prediction)
        """), {
            "user_id": user_id,
            "match_id": match_id,
            "bet_type": bet_type,
            "amount": amount,
            "prediction": prediction
        })
        # Списание средств
        conn.execute(sql_text("""
            UPDATE users SET coins = coins - :amount WHERE id = :user_id
        """), {
            "amount": amount,
            "user_id": user_id
        })
    
    # Проверка достижений
    check_achievement(user_id, "bet_placed")
    
    return jsonify({
        "success": True,
        "new_balance": user.coins - amount
    })

@app.route('/miniapp/add_to_cart', methods=['POST'])
@anti_spam()
def add_to_cart():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    data = request.json
    product_id = data.get('product_id')
    quantity = data.get('quantity', 1)
    
    if not product_id:
        return jsonify({"error": "invalid product"}), 400
    
    product = get_product(product_id)
    if not product:
        return jsonify({"error": "product not found"}), 404
    
    with engine.begin() as conn:
        # Проверка наличия товара
        if product.stock < quantity:
            return jsonify({"error": "not enough stock"}), 400
        
        # Добавление в корзину
        conn.execute(sql_text("""
            INSERT INTO cart (user_id, product_id, quantity)
            VALUES (:user_id, :product_id, :quantity)
            ON CONFLICT (user_id, product_id) 
            DO UPDATE SET quantity = cart.quantity + EXCLUDED.quantity
        """), {
            "user_id": user_id,
            "product_id": product_id,
            "quantity": quantity
        })
    
    return jsonify({"success": True})

@app.route('/miniapp/remove_from_cart', methods=['POST'])
@anti_spam()
def remove_from_cart():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    data = request.json
    product_id = data.get('product_id')
    quantity = data.get('quantity', 1)
    
    if not product_id:
        return jsonify({"error": "invalid product"}), 400
    
    with engine.begin() as conn:
        cart_item = conn.execute(sql_text("""
            SELECT * FROM cart WHERE user_id = :user_id AND product_id = :product_id
        """), {
            "user_id": user_id,
            "product_id": product_id
        }).fetchone()
        
        if not cart_item:
            return jsonify({"error": "item not in cart"}), 404
        
        if quantity >= cart_item.quantity:
            # Удаление товара из корзины
            conn.execute(sql_text("""
                DELETE FROM cart WHERE user_id = :user_id AND product_id = :product_id
            """), {
                "user_id": user_id,
                "product_id": product_id
            })
        else:
            # Уменьшение количества
            conn.execute(sql_text("""
                UPDATE cart SET quantity = quantity - :quantity 
                WHERE user_id = :user_id AND product_id = :product_id
            """), {
                "quantity": quantity,
                "user_id": user_id,
                "product_id": product_id
            })
    
    return jsonify({"success": True})

@app.route('/miniapp/checkout', methods=['POST'])
@anti_spam()
def checkout():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauth"}), 403
    
    cart_items = get_cart_items(user_id)
    if not cart_items:
        return jsonify({"error": "cart empty"}), 400
    
    total = sum(item.price * item.quantity for item in cart_items)
    user = get_user(user_id)
    
    if user.coins < total:
        return jsonify({"error": "insufficient funds"}), 400
    
    # Создание заказа
    with engine.begin() as conn:
        # Списание средств
        conn.execute(sql_text("""
            UPDATE users SET coins = coins - :total WHERE id = :user_id
        """), {
            "total": total,
            "user_id": user_id
        })
        
        # Создание заказа
        for item in cart_items:
            conn.execute(sql_text("""
                INSERT INTO orders (user_id, item, price)
                VALUES (:user_id, :item, :price)
            """), {
                "user_id": user_id,
                "item": item.name,
                "price": item.price * item.quantity
            })
        
        # Очистка корзины
        conn.execute(sql_text("""
            DELETE FROM cart WHERE user_id = :user_id
        """), {
            "user_id": user_id
        })
    
    # Синхронизация с Google Sheets
    try:
        sync_orders_to_sheets()
    except Exception as e:
        logger.error("Error syncing orders to sheets: %s", e)
    
    # Уведомление администратора
    try:
        bot.send_message(OWNER_ID, f"Новый заказ от пользователя {user_id} на сумму {total} кредитов")
    except Exception as e:
        logger.error("Error sending order notification: %s", e)
    
    return jsonify({
        "success": True,
        "new_balance": user.coins - total
    })

@app.route('/miniapp/admin/update_order_status', methods=['POST'])
def update_order_status():
    user_id = session.get('user_id', 0)
    if user_id != OWNER_ID:
        return jsonify({"success": False, "error": "access denied"}), 403
    
    data = request.json
    order_id = data.get('order_id')
    status = data.get('status')
    
    if not order_id or not status:
        return jsonify({"error": "invalid data"}), 400
    
    with engine.begin() as conn:
        conn.execute(sql_text("""
            UPDATE orders SET status = :status WHERE id = :order_id
        """), {
            "status": status,
            "order_id": order_id
        })
    
    return jsonify({"success": True})

@app.route('/miniapp/admin/update_odds', methods=['POST'])
def update_odds():
    user_id = session.get('user_id', 0)
    if user_id != OWNER_ID:
        return jsonify({"success": False, "error": "access denied"}), 403
    
    data = request.json
    match_id = data.get('match_id')
    odds_team1 = data.get('odds_team1')
    odds_team2 = data.get('odds_team2')
    odds_draw = data.get('odds_draw')
    
    if not match_id or odds_team1 is None or odds_team2 is None or odds_draw is None:
        return jsonify({"error": "invalid data"}), 400
    
    with engine.begin() as conn:
        conn.execute(sql_text("""
            UPDATE matches 
            SET odds_team1 = :odds_team1, 
                odds_team2 = :odds_team2, 
                odds_draw = :odds_draw 
            WHERE id = :match_id
        """), {
            "odds_team1": odds_team1,
            "odds_team2": odds_team2,
            "odds_draw": odds_draw,
            "match_id": match_id
        })
    
    return jsonify({"success": True})

@app.route('/miniapp/admin/set_match_result', methods=['POST'])
def set_match_result():
    user_id = session.get('user_id', 0)
    if user_id != OWNER_ID:
        return jsonify({"success": False, "error": "access denied"}), 403
    
    data = request.json
    match_id = data.get('match_id')
    score1 = data.get('score1')
    score2 = data.get('score2')
    
    if not match_id or score1 is None or score2 is None:
        return jsonify({"error": "invalid data"}), 400
    
    # Обновление счета матча
    update_match_score(match_id, score1, score2)
    
    # Закрытие ставок и расчет выигрышей
    process_bets_for_match(match_id, score1, score2)
    
    return jsonify({"success": True})

# --- Telegram bot handlers ---
@bot.message_handler(commands=['start'])
def handle_start(message):
    user = message.from_user
    user_id = message.chat.id
    ensure_user_exists(user_id, user.username, f"{user.first_name} {user.last_name or ''}")
    
    # Просто отправляем приветственное сообщение
    bot.send_message(user_id, "Добро пожаловать в Лигу! Нажмите кнопку 'Open' рядом со скрепкой.")

@bot.message_handler(func=lambda m: m.text == "🔗 Пригласить друга")
def referral(message):
    user = message.from_user
    user_id = message.chat.id
    ref_link = f"{MINIAPP_URL}?ref={user_id}"
    bot.send_message(user_id, f"Поделитесь ссылкой с другом: {ref_link}\nЕсли друг зарегистрируется через неё — вы получите бонусы!")

# Webhook processing
@app.route(f"/{TOKEN}", methods=['POST'])
def telegram_webhook():
    json_str = request.get_data().decode("UTF-8")
    update = telebot.types.Update.de_json(json_str)
    bot.process_new_updates([update])
    return "", 200

# --- Helpers ---
def ensure_user_exists(user_id, username=None, display_name=None, referrer=None):
    with engine.begin() as conn:
        r = conn.execute(sql_text("SELECT * FROM users WHERE id = :id").bindparams(id=user_id)).fetchone()
        if not r:
            # Первый вход - даем 500 кредитов
            conn.execute(sql_text(
                "INSERT INTO users (id, username, display_name, coins, streak, last_streak_date) VALUES (:id, :username, :display_name, 500, 0, NULL)"
            ), {
                "id": user_id, 
                "username": username or "", 
                "display_name": display_name or ""
            })
            # Проверка реферала
            if referrer and referrer != user_id:
                conn.execute(sql_text("""
                    INSERT INTO referrals (referrer_id, referee_id) 
                    VALUES (:referrer_id, :referee_id)
                """), {
                    "referrer_id": referrer,
                    "referee_id": user_id
                })
                # Начисление реферального бонуса
                conn.execute(sql_text("""
                    UPDATE users SET coins = coins + 100 WHERE id = :referrer_id
                """), {
                    "referrer_id": referrer
                })
                # Проверка достижения для реферера
                check_achievement(referrer, "referral")
        else:
            # Обновление данных пользователя
            conn.execute(sql_text("""
                UPDATE users 
                SET username = :username, 
                    display_name = :display_name,
                    last_active = NOW()
                WHERE id = :id
            """), {
                "id": user_id,
                "username": username or "",
                "display_name": display_name or ""
            })
    
    return get_user(user_id)

def get_user(user_id):
    with engine.connect() as conn:
        row = conn.execute(sql_text("SELECT * FROM users WHERE id = :id").bindparams(id=user_id)).fetchone()
        if row:
            logger.debug(f"Найден пользователь: id={row.id}, username={row.username}")
        else:
            logger.warning(f"Пользователь с id={user_id} не найден в базе данных")
    return row

def check_daily_streak(user_id):
    """Проверяет и обновляет ежедневный стрик пользователя"""
    with engine.begin() as conn:
        user = conn.execute(sql_text("SELECT streak, last_streak_date FROM users WHERE id = :id"), {"id": user_id}).fetchone()
        
        today = datetime.now(timezone.utc).date()
        
        # Если пользователь уже заходил сегодня
        if user.last_streak_date == today:
            return
        
        # Если это первый вход после перерыва
        if user.last_streak_date is None or (today - user.last_streak_date).days > 1:
            streak = 1
        else:
            streak = min(user.streak + 1, 7)
        
        # Обновление данных
        conn.execute(sql_text("""
            UPDATE users 
            SET streak = :streak, 
                last_streak_date = :today 
            WHERE id = :id
        """), {
            "streak": streak,
            "today": today,
            "id": user_id
        })
    
    return streak

def get_daily_streak_bonus(user_id):
    """Возвращает бонус за ежедневный стрик"""
    user = get_user(user_id)
    streak = user.streak
    
    # Бонусы за стрик
    bonuses = {1: 10, 2: 20, 3: 30, 4: 40, 5: 50, 6: 60, 7: 500}
    bonus = bonuses.get(streak, 10)
    
    # Начисление бонуса
    with engine.begin() as conn:
        conn.execute(sql_text("""
            UPDATE users 
            SET coins = coins + :bonus 
            WHERE id = :id
        """), {
            "bonus": bonus,
            "id": user_id
        })
    
    return streak, bonus

def user_level_for_xp(xp):
    """Рассчитывает уровень пользователя на основе XP"""
    # Прогрессивная система уровней
    level = min(100, xp // 100 + 1)
    next_xp = (level) * 100
    return level, next_xp

def add_xp(user_id, xp_amount, reason=""):
    """Добавляет XP пользователю и обновляет уровень"""
    with engine.begin() as conn:
        row = conn.execute(sql_text("SELECT xp, level FROM users WHERE id = :id"), {"id": user_id}).fetchone()
        if not row:
            return
        
        new_xp = (row.xp or 0) + xp_amount
        level, next_xp = user_level_for_xp(new_xp)
        
        # Обновление данных
        conn.execute(sql_text("""
            UPDATE users 
            SET xp = :xp, 
                level = :level 
            WHERE id = :id
        """), {
            "xp": new_xp,
            "level": level,
            "id": user_id
        })
        
        # Проверка достижений
        if level >= 10:
            check_achievement(user_id, "level_10")
        if level >= 25:
            check_achievement(user_id, "level_25")
        if level >= 50:
            check_achievement(user_id, "level_50")
        if level >= 100:
            check_achievement(user_id, "level_100")
        
        return level

def check_achievement(user_id, trigger):
    """Проверяет и выдает достижения"""
    # Список достижений
    achievements = {
        "level_10": {"name": "Начинающий", "description": "Достиг 10 уровня", "tier": "bronze"},
        "level_25": {"name": "Опытный", "description": "Достиг 25 уровня", "tier": "silver"},
        "level_50": {"name": "Профессионал", "description": "Достиг 50 уровня", "tier": "gold"},
        "level_100": {"name": "Легенда", "description": "Достиг 100 уровня", "tier": "gold"},
        "bet_100": {"name": "Смелый прогнозист", "description": "Сделал 100 ставок", "tier": "bronze"},
        "bet_500": {"name": "Ветеран", "description": "Сделал 500 ставок", "tier": "silver"},
        "bet_3000": {"name": "Гуру ставок", "description": "Сделал 3000 ставок", "tier": "gold"},
        "referral_5": {"name": "Рекрутер", "description": "Пригласил 5 друзей", "tier": "bronze"},
        "referral_20": {"name": "Популярный", "description": "Пригласил 20 друзей", "tier": "silver"},
        "referral_100": {"name": "Влиятельный", "description": "Пригласил 100 друзей", "tier": "gold"},
        "win_10": {"name": "Удачливый", "description": "Выиграл 10 ставок подряд", "tier": "bronze"},
        "win_30": {"name": "Везунчик", "description": "Выиграл 30 ставок подряд", "tier": "silver"},
        "win_50": {"name": "Фаворит фортуны", "description": "Выиграл 50 ставок подряд", "tier": "gold"},
        "comment_50": {"name": "Активный", "description": "Оставил 50 комментариев", "tier": "bronze"},
        "comment_200": {"name": "Комментатор", "description": "Оставил 200 комментариев", "tier": "silver"},
        "comment_500": {"name": "Эксперт", "description": "Оставил 500 комментариев", "tier": "gold"},
        "daily_7": {"name": "Последовательный", "description": "7 дней подряд заходил в приложение", "tier": "bronze"},
        "daily_30": {"name": "Преданный", "description": "30 дней подряд заходил в приложение", "tier": "silver"},
        "daily_100": {"name": "Настоящий фанат", "description": "100 дней подряд заходил в приложение", "tier": "gold"},
        "bet_placed": {"name": "Новичок", "description": "Сделал первую ставку", "tier": "bronze"},
    }
    
    # Проверка, получено ли уже достижение
    with engine.begin() as conn:
        existing = conn.execute(sql_text("""
            SELECT 1 FROM achievements 
            WHERE user_id = :user_id AND achievement_id = :trigger
        """), {
            "user_id": user_id,
            "trigger": trigger
        }).fetchone()
        
        if existing:
            return
        
        # Проверка условий для некоторых достижений
        if trigger == "bet_100":
            bet_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM bets WHERE user_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if bet_count < 100:
                return
        elif trigger == "bet_500":
            bet_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM bets WHERE user_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if bet_count < 500:
                return
        elif trigger == "bet_3000":
            bet_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM bets WHERE user_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if bet_count < 3000:
                return
        elif trigger == "referral_5":
            ref_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM referrals WHERE referrer_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if ref_count < 5:
                return
        elif trigger == "referral_20":
            ref_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM referrals WHERE referrer_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if ref_count < 20:
                return
        elif trigger == "referral_100":
            ref_count = conn.execute(sql_text("""
                SELECT COUNT(*) FROM referrals WHERE referrer_id = :user_id
            """), {
                "user_id": user_id
            }).scalar()
            if ref_count < 100:
                return
        
        # Выдача достижения
        if trigger in achievements:
            conn.execute(sql_text("""
                INSERT INTO achievements (user_id, achievement_id)
                VALUES (:user_id, :achievement_id)
            """), {
                "user_id": user_id,
                "achievement_id": trigger
            })
            
            # Начисление бонуса за достижение
            if trigger in ["level_10", "level_25", "level_50", "level_100"]:
                bonus = 50 * int(trigger.split("_")[1])
                conn.execute(sql_text("""
                    UPDATE users SET coins = coins + :bonus WHERE id = :user_id
                """), {
                    "bonus": bonus,
                    "user_id": user_id
                })

def get_user_achievements(user_id):
    """Возвращает достижения пользователя"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT a.achievement_id, a.achieved_at,
                   CASE a.achievement_id
                       WHEN 'level_10' THEN 'Начинающий'
                       WHEN 'level_25' THEN 'Опытный'
                       WHEN 'level_50' THEN 'Профессионал'
                       WHEN 'level_100' THEN 'Легенда'
                       WHEN 'bet_100' THEN 'Смелый прогнозист'
                       WHEN 'bet_500' THEN 'Ветеран'
                       WHEN 'bet_3000' THEN 'Гуру ставок'
                       WHEN 'referral_5' THEN 'Рекрутер'
                       WHEN 'referral_20' THEN 'Популярный'
                       WHEN 'referral_100' THEN 'Влиятельный'
                       WHEN 'win_10' THEN 'Удачливый'
                       WHEN 'win_30' THEN 'Везунчик'
                       WHEN 'win_100' THEN 'Победитель'
                       WHEN 'daily_7' THEN 'Последовательный'
                       WHEN 'daily_30' THEN 'Преданный'
                       WHEN 'daily_100' THEN 'Настоящий фанат'
                       ELSE a.achievement_id
                   END as name,
                   CASE a.achievement_id
                       WHEN 'level_10' THEN 'Достиг 10 уровня'
                       WHEN 'level_25' THEN 'Достиг 25 уровня'
                       WHEN 'level_50' THEN 'Достиг 50 уровня'
                       WHEN 'level_100' THEN 'Достиг 100 уровня'
                       WHEN 'bet_100' THEN 'Сделал 100 ставок'
                       WHEN 'bet_500' THEN 'Сделал 500 ставок'
                       WHEN 'bet_3000' THEN 'Сделал 3000 ставок'
                       WHEN 'referral_5' THEN 'Пригласил 5 друзей'
                       WHEN 'referral_20' THEN 'Пригласил 20 друзей'
                       WHEN 'referral_100' THEN 'Пригласил 100 друзей'
                       WHEN 'win_10' THEN 'Выиграл 10 ставок'
                       WHEN 'win_30' THEN 'Выиграл 30 ставок'
                       WHEN 'win_100' THEN 'Выиграл 100 ставок'
                       WHEN 'daily_7' THEN '7 дней подряд заходил в приложение'
                       WHEN 'daily_30' THEN '30 дней подряд заходил в приложение'
                       WHEN 'daily_100' THEN '100 дней подряд заходил в приложение'
                       ELSE 'Неизвестное достижение'
                   END as description,
                   CASE
                       WHEN a.achievement_id LIKE 'level_%' THEN 'gold'
                       WHEN a.achievement_id LIKE 'bet_%' THEN 'silver'
                       WHEN a.achievement_id LIKE 'referral_%' THEN 'bronze'
                       WHEN a.achievement_id LIKE 'win_%' THEN 'silver'
                       WHEN a.achievement_id LIKE 'daily_%' THEN 'bronze'
                       ELSE 'bronze'
                   END as tier
            FROM achievements a
            WHERE a.user_id = :user_id
            ORDER BY a.achieved_at DESC
        """), {"user_id": user_id}).fetchall()
    
    return [{
        "achievement_id": r.achievement_id,
        "name": r.name,
        "description": r.description,
        "tier": r.tier,
        "achieved_at": format_datetime(r.achieved_at)
    } for r in rows]

def current_online_counts():
    """Возвращает статистику онлайн-пользователей"""
    with engine.connect() as conn:
        total = conn.execute(sql_text("SELECT COUNT(*) FROM users")).scalar()
        online = conn.execute(sql_text("SELECT COUNT(*) FROM active_sessions WHERE last_active > NOW() - INTERVAL '5 minutes'")).scalar()
        today = conn.execute(sql_text("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '1 day'")).scalar()
        week = conn.execute(sql_text("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days'")).scalar()
    return {"total": total, "online": online, "today": today, "week": week}

def get_user_stats(user_id):
    """Возвращает статистику пользователя по ставкам"""
    with engine.connect() as conn:
        # Проверяем наличие колонки status
        has_status_column = conn.execute(sql_text("""
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'bets' AND column_name = 'status'
        """)).scalar()
        
        # Общая статистика
        total_bets = conn.execute(sql_text("""
            SELECT COUNT(*) FROM bets WHERE user_id = :user_id
        """), {
            "user_id": user_id
        }).scalar()
        
        won_bets = 0
        lost_bets = 0
        
        if has_status_column:
            won_bets = conn.execute(sql_text("""
                SELECT COUNT(*) FROM bets 
                WHERE user_id = :user_id AND status = 'won'
            """), {
                "user_id": user_id
            }).scalar()
            
            lost_bets = conn.execute(sql_text("""
                SELECT COUNT(*) FROM bets 
                WHERE user_id = :user_id AND status = 'lost'
            """), {
                "user_id": user_id
            }).scalar()
        else:
            # Для совместимости со старыми данными без колонки status
            # Предполагаем, что все ставки активны
            won_bets = 0
            lost_bets = 0
        
        # Средний коэффициент
        try:
            # Проверяем, есть ли колонки odds_team1, odds_team2, odds_draw в таблице matches
            has_odds_columns = conn.execute(sql_text("""
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'matches' 
                AND column_name IN ('odds_team1', 'odds_team2', 'odds_draw')
            """)).fetchall()
            
            if has_odds_columns:
                avg_odds = conn.execute(sql_text("""
                    SELECT AVG(odds) FROM (
                        SELECT 
                            CASE 
                                WHEN b.type = 'team1' THEN m.odds_team1 / 100.0
                                WHEN b.type = 'team2' THEN m.odds_team2 / 100.0
                                WHEN b.type = 'draw' THEN m.odds_draw / 100.0
                                ELSE 1.0
                            END as odds
                        FROM bets b
                        LEFT JOIN matches m ON b.match_id = m.id
                        WHERE b.user_id = :user_id
                    ) as odds_table
                """), {
                    "user_id": user_id
                }).scalar() or 1.0
            else:
                avg_odds = 1.0
        except Exception as e:
            logger.error(f"Error calculating average odds: {e}", exc_info=True)
            avg_odds = 1.0
        
        # Топ-10 пользователей
        try:
            # Проверяем, есть ли колонка status в таблице bets
            has_status_column_in_bets = conn.execute(sql_text("""
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'bets' AND column_name = 'status'
            """)).scalar()
            
            # Проверяем, есть ли колонки odds в таблице matches
            has_odds_columns = conn.execute(sql_text("""
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'matches' 
                AND column_name IN ('odds_team1', 'odds_team2', 'odds_draw')
            """)).fetchall()
            
            if has_status_column_in_bets and has_odds_columns:
                top_users = conn.execute(sql_text("""
                    SELECT u.id, u.display_name, COUNT(b.id) as bet_count,
                           SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(b.id), 0) as win_percent,
                           AVG(
                               CASE 
                                   WHEN b.type = 'team1' THEN m.odds_team1 / 100.0
                                   WHEN b.type = 'team2' THEN m.odds_team2 / 100.0
                                   WHEN b.type = 'draw' THEN m.odds_draw / 100.0
                                   ELSE 1.0
                               END
                           ) as avg_odds
                    FROM users u
                    LEFT JOIN bets b ON u.id = b.user_id
                    LEFT JOIN matches m ON b.match_id = m.id
                    GROUP BY u.id
                    HAVING COUNT(b.id) > 0
                    ORDER BY bet_count DESC, win_percent DESC, avg_odds DESC
                    LIMIT 10
                """)).fetchall()
            else:
                # Более простой запрос без использования статуса и коэффициентов
                top_users = conn.execute(sql_text("""
                    SELECT u.id, u.display_name, COUNT(b.id) as bet_count,
                           0 as win_percent,
                           1.0 as avg_odds
                    FROM users u
                    LEFT JOIN bets b ON u.id = b.user_id
                    GROUP BY u.id
                    HAVING COUNT(b.id) > 0
                    ORDER BY bet_count DESC
                    LIMIT 10
                """)).fetchall()
        except Exception as e:
            logger.error(f"Error getting top users: {e}", exc_info=True)
            top_users = []
    
    return {
        "total_bets": total_bets,
        "won_bets": won_bets,
        "lost_bets": lost_bets,
        "win_percent": round(won_bets / total_bets * 100, 1) if total_bets > 0 else 0,
        "avg_odds": round(avg_odds, 2),
        "top_users": [{
            "id": u.id,
            "display_name": u.display_name,
            "bet_count": u.bet_count,
            "win_percent": round(u.win_percent, 1) if u.win_percent else 0,
            "avg_odds": round(u.avg_odds, 2) if u.avg_odds else 1.0
        } for u in top_users]
    }

def get_products():
    """Возвращает список товаров"""
    with engine.connect() as conn:
        # Проверяем, существуют ли необходимые колонки
        existing_columns = [row[0] for row in conn.execute(sql_text("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'products'
        """))]
        
        # Если таблица пуста, добавляем тестовые товары
        products = conn.execute(sql_text("SELECT * FROM products")).fetchall()
        if not products:
            # Создаем тестовые товары
            test_products = [
                ("Официальная футболка", 3500, "product1.png", "Официальная футболка Лиги", 100),
                ("Кепка", 2000, "product2.png", "Стильная кепка с логотипом", 50),
                ("Кружка", 1500, "product3.png", "Керамическая кружка", 75),
                ("Брелок", 500, "product4.png", "Металлический брелок", 200)
            ]
            
            for product in test_products:
                conn.execute(sql_text("""
                    INSERT INTO products (name, price, image, description, stock)
                    VALUES (%(name)s, %(price)s, %(image)s, %(description)s, %(stock)s)
                """), {
                    "name": product[0],
                    "price": product[1],
                    "image": product[2],
                    "description": product[3],
                    "stock": product[4]
                })
            
            products = conn.execute(sql_text("SELECT * FROM products")).fetchall()
            logger.info(f"Added {len(test_products)} test products to database")
        
        return [{
            "id": p.id,
            "name": p.name,
            "price": p.price,
            "image": p.image,
            "description": p.description,
            "stock": p.stock
        } for p in products]

def get_product(product_id):
    """Возвращает товар по ID"""
    with engine.connect() as conn:
        row = conn.execute(sql_text("SELECT * FROM products WHERE id = :id"), {"id": product_id}).fetchone()
    return row

def get_cart_items(user_id):
    """Возвращает товары в корзине пользователя"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT c.id, c.quantity, p.id as product_id, p.name, p.price, p.image
            FROM cart c
            JOIN products p ON c.product_id = p.id
            WHERE c.user_id = :user_id
        """), {
            "user_id": user_id
        }).fetchall()
    
    return [{
        "id": r.id,
        "quantity": r.quantity,
        "product_id": r.product_id,
        "name": r.name,
        "price": r.price,
        "image": r.image,
        "total": r.price * r.quantity
    } for r in rows]

def get_pending_orders():
    """Возвращает незавершенные заказы"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT o.*, u.display_name 
            FROM orders o
            JOIN users u ON o.user_id = u.id
            WHERE o.status = 'pending'
            ORDER BY o.created_at DESC
        """)).fetchall()
    
    return [{
        "id": r.id,
        "user_id": r.user_id,
        "display_name": r.display_name,
        "item": r.item,
        "price": r.price,
        "status": r.status,
        "created_at": str(r.created_at)
    } for r in rows]

def get_recent_bets():
    """Возвращает недавние ставки"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT b.*, m.team1, m.team2, u.display_name
            FROM bets b
            JOIN matches m ON b.match_id = m.id
            JOIN users u ON b.user_id = u.id
            ORDER BY b.created_at DESC
            LIMIT 20
        """)).fetchall()
    
    return [{
        "id": r.id,
        "user_id": r.user_id,
        "display_name": r.display_name,
        "match_id": r.match_id,
        "team1": r.team1,
        "team2": r.team2,
        "type": r.type,
        "amount": r.amount,
        "prediction": r.prediction,
        "status": r.status,
        "created_at": str(r.created_at)
    } for r in rows]

def get_matches(round_number=None):
    """Возвращает матчи из Google Sheets"""
    matches = get_matches_from_sheets()
    
    if round_number:
        return [m for m in matches if m["round"] == round_number]
    return matches

def get_upcoming_matches():
    """Возвращает предстоящие матчи из Google Sheets"""
    matches = get_matches_from_sheets()
    now = datetime.now(timezone.utc)
    upcoming = [m for m in matches if m["datetime"] > now]
    return upcoming[:10]  # Возвращаем первые 10 матчей

def get_live_matches():
    """Возвращает текущие матчи из Google Sheets"""
    matches = get_matches_from_sheets()
    now = datetime.now(timezone.utc)
    # Для демонстрации считаем, что матч "живой", если он начался в течение последнего часа
    live_matches = [m for m in matches if m["datetime"] <= now <= m["datetime"] + timedelta(hours=2)]
    return live_matches

def get_match(match_id):
    """Возвращает матч по ID"""
    with engine.connect() as conn:
        row = conn.execute(sql_text("""
            SELECT * FROM matches 
            WHERE id = :id
        """), {"id": match_id}).fetchone()
    return row

def get_team_form(team):
    """Возвращает форму команды (заглушка)"""
    return "-/-/-/-/-"

def get_team_players(team):
    """Возвращает состав команды (заглушка)"""
    return []

def update_match_score(match_id, s1, s2):
    """Обновляет счет матча"""
    with engine.begin() as conn:
        conn.execute(sql_text("""
            UPDATE matches 
            SET score1 = :s1, 
                score2 = :s2, 
                last_updated = NOW(), 
                status = 'finished' 
            WHERE id = :id
        """), {
            "s1": s1,
            "s2": s2,
            "id": match_id
        })
    return True

def calculate_odds(match):
    """Рассчитывает коэффициенты с учетом маржи 5%"""
    total = match.odds_team1 + match.odds_team2 + match.odds_draw
    if total == 0:
        return {
            'team1': 2.0,
            'team2': 2.0,
            'draw': 2.0
        }
    
    # Убедимся, что все коэффициенты положительные
    odds_team1 = max(match.odds_team1, 1)
    odds_team2 = max(match.odds_team2, 1)
    odds_draw = max(match.odds_draw, 1)
    
    # Рассчитываем вероятности
    prob_team1 = odds_team1 / 100.0
    prob_team2 = odds_team2 / 100.0
    prob_draw = odds_draw / 100.0
    total_prob = prob_team1 + prob_team2 + prob_draw
    
    # Нормализуем вероятности
    norm_team1 = prob_team1 / total_prob
    norm_team2 = prob_team2 / total_prob
    norm_draw = prob_draw / total_prob
    
    # Рассчитываем коэффициенты с маржей
    k_factor = 1.05  # Маржа 5%
    return {
        'team1': round(1 / norm_team1 * k_factor, 2),
        'team2': round(1 / norm_team2 * k_factor, 2),
        'draw': round(1 / norm_draw * k_factor, 2) if norm_draw > 0 else 0
    }

def process_bets_for_match(match_id, score1, score2):
    """Обработка ставок после завершения матча"""
    with engine.begin() as conn:
        # Получаем информацию о матче
        match = conn.execute(sql_text("SELECT * FROM matches WHERE id = :match_id"), {"match_id": match_id}).fetchone()
        if not match:
            return
        
        # Определяем результат матча
        result = "draw"
        if score1 > score2:
            result = "team1"
        elif score2 > score1:
            result = "team2"
        
        # Получаем все ставки на матч
        bets = conn.execute(sql_text("""
            SELECT * FROM bets WHERE match_id = :match_id AND status = 'active'
        """), {"match_id": match_id}).fetchall()
        
        # Рассчитываем коэффициенты
        odds = calculate_odds(match)
        
        # Обрабатываем каждую ставку
        for bet in bets:
            payout = 0
            status = "lost"
            
            # Если ставка на победу команды
            if bet.type in ['team1', 'team2', 'draw']:
                if bet.type == result:
                    status = "won"
                    payout = bet.amount * odds[result]
            
            # Если ставка на точное количество голов
            elif bet.type == 'total_goals' and bet.prediction:
                try:
                    predicted_goals = int(bet.prediction)
                    actual_goals = score1 + score2
                    if predicted_goals == actual_goals:
                        status = "won"
                        payout = bet.amount * 3.0  # Фиксированный коэффициент для этой ставки
                except:
                    pass
            
            # Если ставка на пенальти
            elif bet.type == 'penalty' and bet.prediction:
                # Здесь должна быть логика определения пенальти
                # Для примера, предположим, что если разница в 1 гол, то пенальти
                if abs(score1 - score2) == 1:
                    expected = "yes" if bet.prediction.lower() == "yes" else "no"
                    # В реальности здесь должна быть проверка на пенальти из данных матча
                    actual = "yes"  # Временное решение
                    if expected == actual:
                        status = "won"
                        payout = bet.amount * 2.0
                else:
                    status = "lost"
            
            # Если ставка на удаление
            elif bet.type == 'red_card' and bet.prediction:
                # Здесь должна быть логика определения удаления
                # Для примера, предположим, что если разница в 2 гола, то удаление
                if abs(score1 - score2) >= 2:
                    expected = "yes" if bet.prediction.lower() == "yes" else "no"
                    # В реальности здесь должна быть проверка на удаление из данных матча
                    actual = "yes"  # Временное решение
                    if expected == actual:
                        status = "won"
                        payout = bet.amount * 2.0
                else:
                    status = "lost"
            
            # Обновление ставки
            conn.execute(sql_text("""
                UPDATE bets 
                SET status = :status, 
                    payout = :payout 
                WHERE id = :bet_id
            """), {
                "status": status,
                "payout": payout,
                "bet_id": bet.id
            })
            
            # Если ставка выиграла, начисляем выигрыш
            if status == "won" and payout > 0:
                conn.execute(sql_text("""
                    UPDATE users 
                    SET coins = coins + :payout 
                    WHERE id = :user_id
                """), {
                    "payout": payout,
                    "user_id": bet.user_id
                })
                # Проверка достижений
                check_achievement(bet.user_id, "win_streak")

# --- Notifications & subscriptions ---
def subscribe_to_match(user_id, match_id):
    """Подписка на уведомления матча"""
    with engine.begin() as conn:
        exists = conn.execute(sql_text("""
            SELECT 1 FROM match_subscriptions 
            WHERE user_id = :uid AND match_id = :mid
        """), {
            "uid": user_id,
            "mid": match_id
        }).fetchone()
        
        if not exists:
            conn.execute(sql_text("""
                INSERT INTO match_subscriptions (user_id, match_id)
                VALUES (:uid, :mid)
            """), {
                "uid": user_id,
                "mid": match_id
            })
    return True

def unsubscribe_from_match(user_id, match_id):
    """Отписка от уведомлений матча"""
    with engine.begin() as conn:
        conn.execute(sql_text("""
            DELETE FROM match_subscriptions 
            WHERE user_id = :uid AND match_id = :mid
        """), {
            "uid": user_id,
            "mid": match_id
        })
    return True

def is_subscribed_to_match(user_id, match_id):
    """Проверяет подписку на матч"""
    with engine.connect() as conn:
        r = conn.execute(sql_text("""
            SELECT 1 FROM match_subscriptions 
            WHERE user_id = :uid AND match_id = :mid
        """), {
            "uid": user_id,
            "mid": match_id
        }).fetchone()
    return bool(r)

def get_match_subscribers(match_id):
    """Возвращает подписчиков матча"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT user_id FROM match_subscriptions 
            WHERE match_id = :mid
        """), {
            "mid": match_id
        }).fetchall()
    return [r.user_id for r in rows]

def create_notification(user_id, match_id, event):
    """Создает уведомление"""
    with engine.begin() as conn:
        conn.execute(sql_text("""
            INSERT INTO notifications (user_id, match_id, event)
            VALUES (:uid, :mid, :ev)
        """), {
            "uid": user_id,
            "mid": match_id,
            "ev": event
        })
    return True

def get_unseen_notifications(user_id):
    """Возвращает непрочитанные уведомления"""
    with engine.connect() as conn:
        rows = conn.execute(sql_text("""
            SELECT n.id, m.team1, m.team2, m.score1, m.score2, n.event, n.created_at 
            FROM notifications n 
            JOIN matches m ON n.match_id = m.id 
            WHERE n.user_id = :uid AND n.seen = FALSE 
            ORDER BY n.created_at DESC
        """), {
            "uid": user_id
        }).fetchall()
    return rows

def mark_notification_seen(nid):
    """Отмечает уведомление как прочитанное"""
    with engine.begin() as conn:
        conn.execute(sql_text("""
            UPDATE notifications 
            SET seen = TRUE 
            WHERE id = :id
        """), {
            "id": nid
        })
    return True

def send_score_update_notifications(match_id, score1, score2):
    """Отправляет уведомления об изменении счета"""
    match = get_match(match_id)
    if not match:
        return
    
    subscribers = get_match_subscribers(match_id)
    message = f"⚽ Обновление: {match.team1} - {match.team2}\nСчет {score1}:{score2}"
    
    for uid in subscribers:
        try:
            # Если пользователь в приложении, создаем в-апп уведомление
            with engine.connect() as conn:
                sess = conn.execute(sql_text("""
                    SELECT page, last_active 
                    FROM active_sessions 
                    WHERE user_id = :id AND last_active > NOW() - INTERVAL '5 minutes'
                """), {
                    "id": uid
                }).fetchone()
            
            if sess:
                create_notification(uid, match_id, "Изменение счета")
            else:
                # Иначе отправляем в Telegram
                bot.send_message(uid, message)
        except Exception as e:
            logger.error("send notification err: %s", e)

# --- Google Sheets sync (periodic) ---
def sync_all_data_to_sheets():
    """Синхронизирует все данные с Google Sheets"""
    if not gs_client or not sheet:
        logger.warning("Google Sheets not configured; skipping sync")
        return
    
    # Синхронизация пользователей
    sync_users_to_sheets()
    
    # Синхронизация матчей
    sync_matches_to_sheets()
    
    # Синхронизация заказов
    sync_orders_to_sheets()
    
    logger.info("All data synced to Google Sheets")

def sync_users_to_sheets():
    """Синхронизирует пользователей с Google Sheets"""
    if not gs_client or not sheet:
        return
    
    try:
        # Лист для пользователей
        try:
            users_ws = sheet.worksheet("ПРОФИЛЬ")
        except Exception:
            users_ws = sheet.add_worksheet("ПРОФИЛЬ", rows=1000, cols=10)
        
        # Данные пользователей
        with engine.connect() as conn:
            rows = conn.execute(sql_text("""
                SELECT id, username, display_name, level, xp, coins, streak, created_at 
                FROM users 
                ORDER BY created_at DESC
            """)).fetchall()
        
        # Подготовка данных
        data = [["ID", "Username", "Имя", "Уровень", "XP", "Кредиты", "Стрик", "Дата регистрации"]]
        for r in rows:
            data.append([
                r.id,
                r.username,
                r.display_name,
                r.level,
                r.xp,
                r.coins,
                r.streak,
                str(r.created_at)
            ])
        
        # Обновление листа
        users_ws.clear()
        users_ws.update('A1', data)
        logger.info("Synced users to Google Sheets")
    except Exception as e:
        logger.error("Users sync err: %s", e)

def sync_matches_to_sheets():
    """Синхронизирует матчи с Google Sheets"""
    if not gs_client or not sheet:
        return
    
    try:
        # Лист для матчей
        try:
            matches_ws = sheet.worksheet("МАТЧИ")
        except Exception:
            matches_ws = sheet.add_worksheet("МАТЧИ", rows=500, cols=10)
        
        # Данные матчей
        with engine.connect() as conn:
            mrows = conn.execute(sql_text("""
                SELECT id, round, team1, team2, score1, score2, datetime, status 
                FROM matches 
                ORDER BY datetime
            """)).fetchall()
        
        # Подготовка данных
        mdata = [["ID", "Тур", "Команда 1", "Команда 2", "Голы 1", "Голы 2", "Дата", "Статус"]]
        for m in mrows:
            mdata.append([
                m.id,
                m.round,
                m.team1,
                m.team2,
                m.score1,
                m.score2,
                str(m.datetime),
                m.status
            ])
        
        # Обновление листа
        matches_ws.clear()
        matches_ws.update('A1', mdata)
        logger.info("Synced matches to Google Sheets")
    except Exception as e:
        logger.error("Matches sync err: %s", e)

def sync_orders_to_sheets():
    """Синхронизирует заказы с Google Sheets"""
    if not gs_client or not sheet:
        return
    
    try:
        # Лист для заказов
        try:
            orders_ws = sheet.worksheet("ЗАКАЗЫ")
        except Exception:
            orders_ws = sheet.add_worksheet("ЗАКАЗЫ", rows=500, cols=10)
        
        # Данные заказов
        with engine.connect() as conn:
            orows = conn.execute(sql_text("""
                SELECT o.id, u.display_name, o.item, o.price, o.status, o.created_at 
                FROM orders o
                JOIN users u ON o.user_id = u.id
                ORDER BY o.created_at DESC
            """)).fetchall()
        
        # Подготовка данных
        odata = [["ID", "Пользователь", "Товар", "Цена", "Статус", "Дата"]]
        for o in orows:
            odata.append([
                o.id,
                o.display_name,
                o.item,
                o.price,
                o.status,
                str(o.created_at)
            ])
        
        # Обновление листа
        orders_ws.clear()
        orders_ws.update('A1', odata)
        logger.info("Synced orders to Google Sheets")
    except Exception as e:
        logger.error("Orders sync err: %s", e)

# Кэш для матчей из Google Sheets
MATCHES_CACHE = {
    'data': None,
    'last_updated': None,
    'cache_ttl': timedelta(minutes=5)  # Время жизни кэша - 5 минут
}

def get_matches_from_sheets():
    """Получает матчи из Google Sheets со вкладки 'РАСПИСАНИЕ ИГР' с кэшированием"""
    global MATCHES_CACHE
    # Проверяем, не нужно ли обновить кэш
    now = datetime.now(timezone.utc)
    if MATCHES_CACHE['data'] is not None and MATCHES_CACHE['last_updated'] is not None:
        if now - MATCHES_CACHE['last_updated'] < MATCHES_CACHE['cache_ttl']:
            return MATCHES_CACHE['data']
    
    # Если кэш устарел или пуст, получаем данные из Google Sheets
    if not gs_client or not sheet:
        if MATCHES_CACHE['data'] is not None:
            logger.warning("Google Sheets not available, using cached data")
            return MATCHES_CACHE['data']  # Возвращаем старые данные, если нет доступа к Sheets
        logger.warning("Google Sheets not available and no cached data, generating test matches")
        return generate_test_matches()
    
    try:
        ws = sheet.worksheet("РАСПИСАНИЕ ИГР")
        # Остальной код...
    except Exception as e:
        logger.exception("Error getting matches from Google Sheets:")
        if MATCHES_CACHE['data'] is not None:
            logger.warning("Using cached data due to Google Sheets error")
            return MATCHES_CACHE['data']
        logger.warning("No cached data available, generating test matches")
        return generate_test_matches()
    
    try:
        ws = sheet.worksheet("РАСПИСАНИЕ ИГР")
        data = ws.get_all_values()
        
        # Пропускаем заголовки (первую строку)
        matches = []
        current_round = None
        round_number = 1
        
        for row in data[1:]:
            # Если в ячейке A1:E1 это название тура (например, "1 ТУР")
            if len(row) > 0 and "ТУР" in row[0].upper():
                current_round = row[0]
                round_number = int(row[0].split()[0]) if row[0].split()[0].isdigit() else round_number + 1
                continue
            
            # Пропускаем пустые строки
            if not row or not any(row):
                continue
            
            # Проверяем, что строка содержит достаточно данных
            if len(row) < 7:  # Должно быть как минимум 7 столбцов (A-G)
                continue
            
            # Извлекаем данные
            team1 = row[0].strip() if row[0] else ""
            # Обработка счета для команды 1 (столбец B)
            score1 = int(row[1]) if len(row) > 1 and row[1].isdigit() else 0
            # Обработка счета для команды 2 (столбец D)
            score2 = int(row[3]) if len(row) > 3 and row[3].isdigit() else 0
            team2 = row[4].strip() if len(row) > 4 and row[4] else ""
            date_str = row[5].strip() if len(row) > 5 and row[5] else ""
            time_str = row[6].strip() if len(row) > 6 and row[6] else ""
            
            # Пропускаем строки без команд или даты
            if not team1 or not team2 or not date_str:
                continue
            
            # Формируем дату и время
            try:
                # Пытаемся определить формат даты
                if '.' in date_str:
                    # Формат "дд.мм.гг" или "дд.мм.гггг"
                    parts = date_str.split('.')
                    if len(parts) == 3:
                        day = parts[0]
                        month = parts[1]
                        year = parts[2]
                        if len(year) == 2:
                            year = "20" + year
                elif '-' in date_str:
                    # Формат "гггг-мм-дд"
                    parts = date_str.split('-')
                    if len(parts) == 3:
                        year = parts[0]
                        month = parts[1]
                        day = parts[2]
                
                date_time_str = f"{year}-{month}-{day}"
                
                if time_str:
                    date_time_str += f" {time_str}"
                
                # Создаем объект datetime
                if time_str:
                    match_datetime = datetime.strptime(date_time_str, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
                else:
                    match_datetime = datetime.strptime(date_time_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except (ValueError, IndexError) as e:
                logger.error(f"Error parsing date '{date_str}': {e}")
                continue
            
            # Определяем статус матча с учетом временной зоны
            current_time = datetime.now(timezone.utc)
            status = "scheduled" if match_datetime > current_time else "finished"
            # Если матч завершен, но счет не 0-0, то статус "finished"
            if status == "finished" and (score1 > 0 or score2 > 0):
                status = "finished"
            
            # Добавляем матч
            matches.append({
                "id": len(matches) + 1,
                "round": round_number,
                "team1": team1,
                "team2": team2,
                "score1": score1,
                "score2": score2,
                "datetime": match_datetime,
                "status": status,
                "odds_team1": 35,
                "odds_team2": 65,
                "odds_draw": 0
            })
        
        # Сортируем матчи по дате
        matches.sort(key=lambda x: x["datetime"])
        
        # Обновляем кэш
        MATCHES_CACHE['data'] = matches
        MATCHES_CACHE['last_updated'] = now
        
        return matches
    except Exception as e:
        logger.error(f"Ошибка при получении матчей из Google Sheets: {e}", exc_info=True)
        if MATCHES_CACHE['data'] is not None:
            return MATCHES_CACHE['data']  # Возвращаем старые данные при ошибке
        return []
        
        

def sync_matches_to_db():
    """Синхронизирует матчи из Google Sheets с базой данных"""
    if not gs_client or not sheet:
        logger.warning("Google Sheets not configured; skipping match sync")
        return
    
    try:
        # Получаем матчи из Google Sheets
        matches = get_matches_from_sheets()
        
        # Синхронизируем с базой данных
        with engine.begin() as conn:
            # Проверяем существование колонок
            existing_columns = [row[0] for row in conn.execute(sql_text("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'matches'
            """))]
            
            # Очищаем существующие матчи
            conn.execute(sql_text("DELETE FROM matches"))
            
            # Добавляем новые матчи
            for match in matches:
                # Формируем параметры вставки
                params = {
                    "round": match["round"],
                    "team1": match["team1"],
                    "team2": match["team2"],
                    "score1": match["score1"],
                    "score2": match["score2"],
                    "datetime": match["datetime"],
                    "status": match["status"]
                }
                
                # Добавляем коэффициенты, если колонки существуют
                if 'odds_team1' in existing_columns:
                    params["odds_team1"] = match["odds_team1"]
                if 'odds_team2' in existing_columns:
                    params["odds_team2"] = match["odds_team2"]
                if 'odds_draw' in existing_columns:
                    params["odds_draw"] = match["odds_draw"]
                
                # Формируем SQL-запрос
                columns = ", ".join(params.keys())
                placeholders = ", ".join([f":{k}" for k in params.keys()])
                
                conn.execute(sql_text(f"""
                    INSERT INTO matches ({columns})
                    VALUES ({placeholders})
                """), params)
        
        logger.info(f"Synced {len(matches)} matches to database")
    except Exception as e:
        logger.error(f"Error syncing matches to database: {e}", exc_info=True)
        
def generate_test_matches():
    """Генерирует тестовые матчи, если Google Sheets недоступен"""
    logger.info("Generating test matches as fallback")
    now = datetime.now(timezone.utc)
    matches = []
    
    # Тур 1
    matches.append({
        "id": 1,
        "round": 1,
        "team1": "ФК Обнинск",
        "team2": "Дождь",
        "score1": 2,
        "score2": 1,
        "datetime": now + timedelta(days=1, hours=15),
        "status": "scheduled",
        "odds_team1": 35,
        "odds_team2": 65,
        "odds_draw": 0
    })
    
    matches.append({
        "id": 2,
        "round": 1,
        "team1": "Спартак",
        "team2": "Зенит",
        "score1": 0,
        "score2": 0,
        "datetime": now + timedelta(days=1, hours=17),
        "status": "scheduled",
        "odds_team1": 45,
        "odds_team2": 55,
        "odds_draw": 0
    })
    
    # Тур 2
    matches.append({
        "id": 3,
        "round": 2,
        "team1": "ФК Обнинск",
        "team2": "Зенит",
        "score1": 0,
        "score2": 0,
        "datetime": now + timedelta(days=8, hours=15),
        "status": "scheduled",
        "odds_team1": 40,
        "odds_team2": 60,
        "odds_draw": 0
    })
    
    matches.append({
        "id": 4,
        "round": 2,
        "team1": "Спартак",
        "team2": "Дождь",
        "score1": 0,
        "score2": 0,
        "datetime": now + timedelta(days=8, hours=17),
        "status": "scheduled",
        "odds_team1": 50,
        "odds_team2": 50,
        "odds_draw": 0
    })
    
    # Тур 3
    matches.append({
        "id": 5,
        "round": 3,
        "team1": "ФК Обнинск",
        "team2": "Спартак",
        "score1": 0,
        "score2": 0,
        "datetime": now + timedelta(days=15, hours=15),
        "status": "scheduled",
        "odds_team1": 45,
        "odds_team2": 55,
        "odds_draw": 0
    })
    
    matches.append({
        "id": 6,
        "round": 3,
        "team1": "Зенит",
        "team2": "Дождь",
        "score1": 0,
        "score2": 0,
        "datetime": now + timedelta(days=15, hours=17),
        "status": "scheduled",
        "odds_team1": 55,
        "odds_team2": 45,
        "odds_draw": 0
    })
    
    # Обновляем кэш
    MATCHES_CACHE['data'] = matches
    MATCHES_CACHE['last_updated'] = datetime.now(timezone.utc)
    
    return matches

# Синхронизируем матчи из Google Sheets с базой данных
try:
    sync_matches_to_db()
except Exception as e:
    logger.error(f"Error during initial match sync: {e}")

# Запускаем периодическую синхронизацию
def start_match_sync():
    while True:
        try:
            sync_matches_to_db()
        except Exception as e:
            logger.error(f"Error in periodic match sync: {e}")
        # Синхронизируем каждые 30 минут
        time.sleep(1800)

sync_thread = threading.Thread(target=start_match_sync, daemon=True)
sync_thread.start()

# Добавляем фильтр для форматирования даты в шаблонах
@app.template_filter('datetime')
def format_datetime(value, format='%d.%m.%Y %H:%M'):
    """Форматирует объект datetime"""
    if not value:
        return ""
    # Если значение уже строка, возвращаем как есть
    if isinstance(value, str):
        return value
    try:
        # Пытаемся преобразовать в datetime, если это строка
        if isinstance(value, str):
            value = datetime.fromisoformat(value)
        # Форматируем дату
        return value.strftime(format)
    except (TypeError, ValueError):
        return str(value)
        
# --- Static helpers for rendering templates ---
@app.context_processor
def inject_now():
    return {
        'now': datetime.now(timezone.utc),
        'OWNER_ID': OWNER_ID,
        'league_logo': 'images/league-logo.png'
    }

# Добавляем обработчики для несуществующих маршрутов
@app.route('/miniapp/matches')
def miniapp_matches():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    rounds = []
    for r in range(1, 4):
        matches = get_matches(r)
        rounds.append({"number": r, "matches": matches})
    
    return render_template('home.html', rounds=rounds, user_id=user_id, owner_id=OWNER_ID)

@app.route('/miniapp/notifications')
def miniapp_notifications():
    user_id = session.get('user_id', 0)
    if not user_id:
        return jsonify({"error": "unauthorized"}), 403
    
    notifications = get_unseen_notifications(user_id)
    return jsonify([{
        "id": n.id,
        "team1": n.team1,
        "team2": n.team2,
        "score1": n.score1,
        "score2": n.score2,
        "event": n.event,
        "created_at": str(n.created_at)
    } for n in notifications])
    
@app.route('/miniapp/match/<int:match_id>')
def match_detail(match_id):
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    match = get_match(match_id)
    if not match:
        return "Match not found", 404
    
    # Получаем информацию о команде
    team_form1 = get_team_form(match.team1)
    team_form2 = get_team_form(match.team2)
    players1 = get_team_players(match.team1)
    players2 = get_team_players(match.team2)
    
    # Проверяем подписку пользователя
    is_subscribed = is_subscribed_to_match(user_id, match_id)
    
    return render_template('match_detail.html', 
                          match=match,
                          team_form1=team_form1,
                          team_form2=team_form2,
                          players1=players1,
                          players2=players2,
                          is_subscribed=is_subscribed,
                          user_id=user_id,
                          owner_id=OWNER_ID)

@app.route('/miniapp/support')
def miniapp_support():
    user_id = session.get('user_id', 0)
    if not user_id:
        return "Not authorized", 403
    
    return render_template('support.html', user_id=user_id, owner_id=OWNER_ID)
    
# --- Run ---
if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)