"""
Система тестирования безопасности для Liga Obninska
Содержит функции для проверки работы всех компонентов безопасности
"""

from flask import Blueprint, request, jsonify, current_app
from datetime import datetime
import traceback

# Blueprint для тестирования безопасности
security_test_bp = Blueprint('security_test', __name__)

@security_test_bp.route('/api/security/test/rate-limit', methods=['POST'])
def test_rate_limit():
    """Тестирует работу системы ограничения запросов"""
    try:
        if not current_app.config.get('rate_limiter'):
            return jsonify({'error': 'Rate limiter not initialized'}), 500
        
        user_id = request.form.get('user_id', 'test_user')
        endpoint = 'test_endpoint'
        
        rate_limiter = current_app.config['rate_limiter']
        is_limited = rate_limiter.is_rate_limited(user_id, endpoint, max_requests=5, time_window=60)
        
        return jsonify({
            'rate_limited': is_limited,
            'timestamp': datetime.now().isoformat(),
            'user_id': user_id,
            'endpoint': endpoint
        })
    except Exception as e:
        return jsonify({
            'error': f'Rate limit test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/input-validation', methods=['POST'])
def test_input_validation():
    """Тестирует систему валидации входных данных"""
    try:
        if not current_app.config.get('input_validator'):
            return jsonify({'error': 'Input validator not initialized'}), 500
        
        test_input = request.form.get('test_input', '<script>alert("xss")</script>')
        validator = current_app.config['input_validator']
        
        # Тестируем различные виды валидации
        results = {
            'original_input': test_input,
            'sanitized_html': validator.sanitize_html(test_input),
            'is_safe_sql': validator.is_safe_sql(test_input),
            'cleaned_json': validator.clean_json_input({'test': test_input}),
            'timestamp': datetime.now().isoformat()
        }
        
        return jsonify(results)
    except Exception as e:
        return jsonify({
            'error': f'Input validation test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/telegram-auth', methods=['POST'])
def test_telegram_auth():
    """Тестирует валидацию Telegram WebApp данных"""
    try:
        if not current_app.config.get('telegram_security'):
            return jsonify({'error': 'Telegram security not initialized'}), 500
        
        init_data = request.form.get('initData', '')
        telegram_security = current_app.config['telegram_security']
        
        is_valid = telegram_security.validate_webapp_data(init_data)
        user_data = telegram_security.extract_user_data(init_data) if is_valid else None
        
        return jsonify({
            'init_data_valid': is_valid,
            'user_data': user_data,
            'timestamp': datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            'error': f'Telegram auth test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/sql-injection', methods=['POST'])
def test_sql_injection():
    """Тестирует защиту от SQL-инъекций"""
    try:
        if not current_app.config.get('input_validator'):
            return jsonify({'error': 'Input validator not initialized'}), 500
        
        test_queries = [
            "SELECT * FROM users",
            "'; DROP TABLE users; --",
            "1' OR '1'='1",
            "UNION SELECT * FROM passwords",
            "normal_value_123"
        ]
        
        validator = current_app.config['input_validator']
        results = []
        
        for query in test_queries:
            is_safe = validator.is_safe_sql(query)
            results.append({
                'query': query,
                'is_safe': is_safe,
                'risk_level': 'LOW' if is_safe else 'HIGH'
            })
        
        return jsonify({
            'test_results': results,
            'timestamp': datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            'error': f'SQL injection test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/performance', methods=['GET'])
def test_performance_monitoring():
    """Тестирует систему мониторинга производительности"""
    try:
        if not current_app.config.get('performance_metrics'):
            return jsonify({'error': 'Performance metrics not initialized'}), 500
        
        performance_metrics = current_app.config['performance_metrics']
        
        # Получаем текущие метрики
        current_metrics = performance_metrics.get_metrics()
        
        return jsonify({
            'metrics': current_metrics,
            'timestamp': datetime.now().isoformat(),
            'status': 'Performance monitoring active'
        })
    except Exception as e:
        return jsonify({
            'error': f'Performance test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/health', methods=['GET'])
def test_health_check():
    """Тестирует систему проверки здоровья приложения"""
    try:
        if not current_app.config.get('health_check'):
            return jsonify({'error': 'Health check not initialized'}), 500
        
        health_check = current_app.config['health_check']
        health_status = health_check.get_health_status()
        
        return jsonify({
            'health_status': health_status,
            'timestamp': datetime.now().isoformat()
        })
    except Exception as e:
        return jsonify({
            'error': f'Health check test failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500

@security_test_bp.route('/api/security/test/all', methods=['GET'])
def test_all_security_systems():
    """Запускает все тесты безопасности"""
    try:
        results = {
            'timestamp': datetime.now().isoformat(),
            'phase_3_status': 'TESTING',
            'tests': {}
        }
        
        # Проверяем доступность всех компонентов
        components = {
            'input_validator': current_app.config.get('input_validator'),
            'telegram_security': current_app.config.get('telegram_security'),
            'rate_limiter': current_app.config.get('rate_limiter'),
            'performance_metrics': current_app.config.get('performance_metrics'),
            'health_check': current_app.config.get('health_check')
        }
        
        for component_name, component in components.items():
            if component:
                results['tests'][component_name] = 'AVAILABLE'
            else:
                results['tests'][component_name] = 'NOT_AVAILABLE'
        
        # Общий статус
        all_available = all(comp is not None for comp in components.values())
        results['overall_status'] = 'ALL_SYSTEMS_OPERATIONAL' if all_available else 'SOME_SYSTEMS_UNAVAILABLE'
        results['security_level'] = 'HIGH' if all_available else 'MEDIUM'
        
        return jsonify(results)
    except Exception as e:
        return jsonify({
            'error': f'Security systems test failed: {str(e)}',
            'traceback': traceback.format_exc(),
            'timestamp': datetime.now().isoformat()
        }), 500
