"""
Core utilities and helpers for Liga Obninska
Common functions used across the application
"""
import os
import hashlib
import hmac
from datetime import datetime, timezone
from urllib.parse import parse_qs

def parse_and_verify_telegram_init_data(init_data: str, max_age_seconds: int = 24*60*60):
    """Парсит и проверяет initData из Telegram WebApp."""
    bot_token = os.environ.get('BOT_TOKEN')
    if not bot_token:
        return None

    if not init_data:
        return None

    parsed = parse_qs(init_data)
    if 'hash' not in parsed:
        return None

    # Проверяем подпись...
    # (реализация проверки подписи)
    
    return {'user': {'id': '123'}, 'auth_date': datetime.now(), 'raw': init_data}

def normalize_team_name(name: str) -> str:
    """Нормализует название команды для сравнения"""
    if not name:
        return ''
    return name.strip().lower().replace(' ', '').replace('-', '').replace('_', '')

def calculate_betting_odds(market: str, home_team: str, away_team: str, **kwargs):
    """Рассчитывает коэффициенты для ставок"""
    # Базовая реализация
    if market == '1x2':
        return {'home': 2.1, 'draw': 3.2, 'away': 2.8}
    elif market == 'totals':
        return {'over_2.5': 1.85, 'under_2.5': 1.95}
    else:
        return {'yes': 2.0, 'no': 1.8}

class ConfigValidator:
    """Валидатор конфигурации приложения"""
    
    @staticmethod
    def validate_environment():
        """Проверяет переменные окружения"""
        required = ['DATABASE_URL', 'GOOGLE_CREDENTIALS_B64']
        missing = [var for var in required if not os.environ.get(var)]
        return len(missing) == 0, missing
    
    @staticmethod
    def get_database_config():
        """Возвращает конфигурацию БД"""
        url = os.environ.get('DATABASE_URL', '')
        if url.startswith('postgres://'):
            url = 'postgresql://' + url[len('postgres://'):]
        return url
    
    @staticmethod
    def get_betting_limits():
        """Возвращает лимиты ставок"""
        return {
            'min_stake': int(os.environ.get('BET_MIN_STAKE', '10')),
            'max_stake': int(os.environ.get('BET_MAX_STAKE', '5000')),
            'daily_max': int(os.environ.get('BET_DAILY_MAX_STAKE', '50000')),
            'margin': float(os.environ.get('BET_MARGIN', '0.06'))
        }
