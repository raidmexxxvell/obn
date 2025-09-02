"""
Decorators for Liga Obninska
Security, performance, and utility decorators
"""
import functools
import time
import os
import hmac, hashlib
from datetime import datetime, timezone
from flask import request, jsonify, g
from typing import Callable, Any, Dict, Optional

from utils.security import telegram_security, rate_limiter, input_validator

# --- Backward compatibility adapters ---
# В старом коде могли использовать @validate_input(['field1','field2']).
# Текущая реализация ожидает именованные валидаторы. Добавим тонкий слой,
# позволяющий списковый вызов: @validate_input(['a','b']) будет трактоваться
# как просто проверка присутствия (required string) этих полей.

def _compat_validate_input_arg(arg):
    if isinstance(arg, (list, tuple)):
        spec = {}
        for name in arg:
            # Простейшая проверка на обязательное строковое поле
            spec[name] = {'type': 'string', 'required': True, 'min_length': 1}
        return spec
    return arg

def require_telegram_auth(max_age_seconds: int = 86400):
    """Decorator to require valid Telegram authentication"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            # Unified extraction of initData from multiple possible sources
            init_data = None
            try:
                if request.method in ('POST','PUT','PATCH'):
                    # form first
                    init_data = request.form.get('initData') or request.form.get('init_data')
                if init_data is None and request.is_json:
                    try:
                        js = request.get_json(silent=True) or {}
                        init_data = js.get('initData') or js.get('init_data')
                    except Exception:
                        pass
                if init_data is None:
                    init_data = request.args.get('initData') or request.args.get('init_data')
                if init_data is None:
                    # Custom header
                    init_data = request.headers.get('X-Telegram-Init-Data')
                if init_data is None and request.data:
                    # Raw fallback (e.g. text/plain body like initData=...)
                    try:
                        from urllib.parse import parse_qs
                        raw_map = parse_qs(request.data.decode('utf-8'), keep_blank_values=True)
                        init_data = raw_map.get('initData', [None])[0] or raw_map.get('init_data', [None])[0]
                    except Exception:
                        pass
            except Exception:
                init_data = None
            init_data = init_data or ''
            
            if not init_data:
                return jsonify({'error': 'Authentication required'}), 401
            
            # Get bot token
            bot_token = os.environ.get('BOT_TOKEN')
            if not bot_token:
                # In development mode, allow without token
                if os.environ.get('FLASK_ENV') == 'development':
                    g.user = {'id': '123', 'first_name': 'Dev', 'username': 'dev_user'}
                    g.auth_data = {'user': g.user, 'auth_date': str(int(time.time()))}
                    return f(*args, **kwargs)
                return jsonify({'error': 'Service configuration error'}), 500
            
            # Verify initData
            is_valid, auth_data = telegram_security.verify_init_data(init_data, bot_token, max_age_seconds)
            
            if not is_valid or not auth_data:
                return jsonify({'error': 'Invalid authentication'}), 401
            
            # Store auth data in g for use in the route
            g.user = auth_data.get('user', {})
            g.auth_data = auth_data
            
            return f(*args, **kwargs)
        
        return decorated_function
    return decorator

def require_admin():
    """Decorator to require admin privileges"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            admin_id_env = os.environ.get('ADMIN_USER_ID', '')
            # 1. Telegram (g.user уже установлен require_telegram_auth)
            if hasattr(g, 'user') and g.user:
                user_id = str(g.user.get('id', ''))
                if admin_id_env and user_id == admin_id_env:
                    return f(*args, **kwargs)
            # 2. Cookie fallback (парольная авторизация вне Telegram)
            try:
                cookie_token = request.cookies.get('admin_auth')
                admin_pass = os.environ.get('ADMIN_PASSWORD', '')
                if cookie_token and admin_pass and admin_id_env:
                    expected = hmac.new(admin_pass.encode('utf-8'), admin_id_env.encode('utf-8'), hashlib.sha256).hexdigest()
                    if hmac.compare_digest(cookie_token, expected):
                        # Синтетический g.user для совместимости
                        g.user = {'id': admin_id_env, 'first_name': 'Admin', 'username': 'admin'}
                        return f(*args, **kwargs)
            except Exception:
                pass
            # 3. Нет доступа
            if not admin_id_env:
                return jsonify({'error': 'Admin not configured'}), 500
            return jsonify({'error': 'Authentication required'}), 401
        return decorated_function
    return decorator

def rate_limit(max_requests: int = 60, time_window: int = 60, per: str = 'ip'):
    """Decorator for rate limiting"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            # Determine identifier
            if per == 'ip':
                identifier = request.remote_addr or 'unknown'
            elif per == 'user':
                identifier = getattr(g, 'user', {}).get('id', request.remote_addr or 'unknown')
            else:
                identifier = request.remote_addr or 'unknown'
            
            # Check rate limit
            if not rate_limiter.is_allowed(f"{f.__name__}:{identifier}", max_requests, time_window):
                return jsonify({'error': 'Rate limit exceeded'}), 429
            
            return f(*args, **kwargs)
        
        return decorated_function
    return decorator

def validate_input(*args, **validators):
    """Decorator for input validation.

    Использование:
      @validate_input(field={'type':'team_name', 'required':True}, stake='int')
    Либо (устаревшее):
      @validate_input(['field1','field2'])
    """
    # Поддержка старого варианта: первым позиционным аргументом список полей
    legacy_spec = {}
    if args:
        if len(args) == 1:
            legacy_spec = _compat_validate_input_arg(args[0]) or {}
        else:
            raise TypeError('validate_input legacy form принимает максимум один позиционный аргумент')
    # Объединяем legacy и именованные
    full_spec = { **legacy_spec, **validators }

    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*f_args, **f_kwargs):
            errors = []
            # Собираем данные
            if request.method == 'POST':
                data = request.form.to_dict()
                try:
                    if request.json:
                        data.update(request.json)
                except Exception:
                    pass
            else:
                data = request.args.to_dict()

            for field_name, validator_config in full_spec.items():
                value = data.get(field_name)
                if isinstance(validator_config, dict):
                    vtype = validator_config.get('type')
                    required = validator_config.get('required', False)
                    min_length = validator_config.get('min_length')
                    max_length = validator_config.get('max_length')
                else:
                    vtype = validator_config
                    required = False
                    min_length = None
                    max_length = None

                if required and (value is None or value == ''):
                    errors.append(f"{field_name} is required")
                    continue
                if value is None:
                    continue

                if vtype == 'team_name':
                    ok, res = input_validator.validate_team_name(value)
                    if not ok:
                        errors.append(f"{field_name}: {res}")
                elif vtype == 'score':
                    ok, res = input_validator.validate_score(value)
                    if not ok:
                        errors.append(f"{field_name}: {res}")
                elif vtype == 'int':
                    try:
                        int(value)
                    except (ValueError, TypeError):
                        errors.append(f"{field_name} must be an integer")
                elif vtype == 'string':
                    if not isinstance(value, str):
                        errors.append(f"{field_name} must be a string")
                    elif min_length and len(value) < min_length:
                        errors.append(f"{field_name} too short (min {min_length})")
                    elif max_length and len(value) > max_length:
                        errors.append(f"{field_name} too long (max {max_length})")

            if errors:
                return jsonify({'error': 'Validation failed', 'details': errors}), 400
            return f(*f_args, **f_kwargs)
        return decorated_function
    return decorator

def cache_response(timeout: int = 300, key_func: Optional[Callable] = None):
    """Decorator for caching responses"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            # Generate cache key
            if key_func:
                cache_key = key_func(*args, **kwargs)
            else:
                cache_key = f"{f.__name__}:{request.path}:{request.query_string.decode()}"
            
            # Try to get from cache (if cache system is available)
            try:
                from optimizations.multilevel_cache import get_cache
                cache = get_cache()
                if cache:
                    cached_result = cache.get(cache_key)
                    if cached_result is not None:
                        return cached_result
            except ImportError:
                pass
            
            # Execute function
            result = f(*args, **kwargs)
            
            # Store in cache
            try:
                if cache:
                    cache.set(cache_key, result, timeout)
            except:
                pass  # Fail silently if cache is not available
            
            return result
        
        return decorated_function
    return decorator

def log_performance(threshold_ms: int = 1000):
    """Decorator to log slow requests"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            start_time = time.time()
            
            try:
                result = f(*args, **kwargs)
                return result
            finally:
                duration = (time.time() - start_time) * 1000
                
                if duration > threshold_ms:
                    print(f"SLOW REQUEST: {f.__name__} took {duration:.2f}ms")
        
        return decorated_function
    return decorator

def handle_errors(default_response: Dict[str, Any] = None):
    """Decorator for consistent error handling"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            try:
                return f(*args, **kwargs)
            except ValueError as e:
                return jsonify({'error': 'Invalid input', 'details': str(e)}), 400
            except KeyError as e:
                return jsonify({'error': 'Missing required field', 'field': str(e)}), 400
            except Exception as e:
                # Log the error
                print(f"ERROR in {f.__name__}: {str(e)}")
                
                # Return default response or generic error
                if default_response:
                    return jsonify(default_response), 500
                else:
                    return jsonify({'error': 'Internal server error'}), 500
        
        return decorated_function
    return decorator

def require_database():
    """Decorator to ensure database is available"""
    def decorator(f: Callable) -> Callable:
        @functools.wraps(f)
        def decorated_function(*args, **kwargs):
            # Check if database is configured
            database_url = os.environ.get('DATABASE_URL')
            if not database_url:
                return jsonify({'error': 'Database not configured'}), 503
            
            return f(*args, **kwargs)
        
        return decorated_function
    return decorator
