"""
Monitoring API routes for Liga Obninska
Health checks, metrics, and system status endpoints
"""
from flask import Blueprint, jsonify, request
from utils.monitoring import performance_metrics, db_monitor, cache_monitor, health_check
from utils.decorators import require_admin, rate_limit
from datetime import datetime, timezone
import os

monitoring_bp = Blueprint('monitoring', __name__, url_prefix='/api/monitoring')

@monitoring_bp.route('/health', methods=['GET'])
@rate_limit(max_requests=30, time_window=60)
def health_status():
    """Basic health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'version': os.environ.get('APP_VERSION', 'unknown')
    })

@monitoring_bp.route('/health/detailed', methods=['GET'])
@rate_limit(max_requests=10, time_window=60)
def detailed_health():
    """Detailed health check with all components"""
    health_data = health_check.full_health_check()
    
    # Determine HTTP status based on health
    status_code = 200 if health_data['status'] == 'healthy' else 503
    
    return jsonify(health_data), status_code

@monitoring_bp.route('/metrics', methods=['GET'])
@require_admin()
@rate_limit(max_requests=20, time_window=60)
def performance_summary():
    """Get performance metrics summary"""
    return jsonify({
        'performance': performance_metrics.get_summary(),
        'database': db_monitor.get_stats(),
        'cache': cache_monitor.get_stats()
    })

@monitoring_bp.route('/metrics/endpoints', methods=['GET'])
@require_admin()
@rate_limit(max_requests=10, time_window=60)
def endpoint_metrics():
    """Get metrics for all endpoints"""
    endpoint_name = request.args.get('endpoint')
    
    if endpoint_name:
        return jsonify(performance_metrics.get_endpoint_stats(endpoint_name))
    
    # Return summary for all endpoints
    with performance_metrics.lock:
        endpoints = list(performance_metrics.api_endpoints.keys())
    
    return jsonify({
        'endpoints': endpoints,
        'total_endpoints': len(endpoints)
    })

@monitoring_bp.route('/metrics/slow-queries', methods=['GET'])
@require_admin()
@rate_limit(max_requests=10, time_window=60)
def slow_queries():
    """Get slow database queries"""
    return jsonify({
        'slow_queries': list(db_monitor.slow_queries),
        'threshold_ms': 100
    })

@monitoring_bp.route('/status', methods=['GET'])
def system_status():
    """Public system status endpoint"""
    try:
        # Basic checks without sensitive information
        database_ok = True
        try:
            # Check if database environment is configured
            if not os.environ.get('DATABASE_URL'):
                database_ok = False
        except:
            database_ok = False
        
        cache_ok = True
        try:
            from optimizations.multilevel_cache import get_cache
            cache = get_cache()
            if not cache:
                cache_ok = False
        except:
            cache_ok = False
        
        overall_status = 'operational' if database_ok and cache_ok else 'degraded'
        
        return jsonify({
            'status': overall_status,
            'services': {
                'database': 'operational' if database_ok else 'unavailable',
                'cache': 'operational' if cache_ok else 'unavailable',
                'api': 'operational'
            },
            'timestamp': datetime.now(timezone.utc).isoformat()
        })
    
    except Exception as e:
        return jsonify({
            'status': 'error',
            'message': 'Unable to determine system status',
            'timestamp': datetime.now(timezone.utc).isoformat()
        }), 500

@monitoring_bp.route('/ping', methods=['GET'])
def ping():
    """Simple ping endpoint for load balancers"""
    return jsonify({
        'pong': True,
        'timestamp': datetime.now(timezone.utc).isoformat()
    })

# Register error handlers for monitoring blueprint
@monitoring_bp.errorhandler(429)
def rate_limit_error(error):
    """Handle rate limit errors"""
    return jsonify({
        'error': 'Rate limit exceeded',
        'message': 'Too many monitoring requests'
    }), 429

def init_monitoring_routes(app):
    """Initialize monitoring routes with Flask app"""
    app.register_blueprint(monitoring_bp)
    return monitoring_bp
