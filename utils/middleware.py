"""
Middleware for Liga Obninska
Security, monitoring, and performance middleware
"""
import time
from flask import request, g, jsonify
from functools import wraps
from utils.security import sql_prevention, rate_limiter
from utils.monitoring import performance_metrics, db_monitor

class SecurityMiddleware:
    """Security middleware for Flask application"""
    
    def __init__(self, app=None):
        self.app = app
        if app is not None:
            self.init_app(app)
    
    def init_app(self, app):
        """Initialize middleware with Flask app"""
        app.before_request(self.before_request)
        app.after_request(self.after_request)
        app.teardown_appcontext(self.teardown)
    
    def before_request(self):
        """Execute before each request"""
        # Record start time for performance monitoring
        g.start_time = time.time()
        
        # Basic security checks
        self._check_sql_injection()
        self._check_content_type()
        self._add_security_headers()
    
    def after_request(self, response):
        """Execute after each request"""
        # Record performance metrics
        if hasattr(g, 'start_time'):
            duration_ms = (time.time() - g.start_time) * 1000
            performance_metrics.record_request(
                endpoint=request.endpoint or request.path,
                duration_ms=duration_ms,
                status_code=response.status_code
            )
        
        # Add security headers
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['X-XSS-Protection'] = '1; mode=block'
        response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        
        # CORS headers for Telegram WebApp
        if request.headers.get('Origin'):
            response.headers['Access-Control-Allow-Origin'] = 'https://web.telegram.org'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        
        return response
    
    def teardown(self, exception):
        """Execute during teardown"""
        # Log any exceptions
        if exception:
            print(f"Request exception: {exception}")
    
    def _check_sql_injection(self):
        """Check for SQL injection attempts"""
        for key, value in request.values.items():
            # initData может содержать множество символов (%, =) по спецификации Telegram
            if key in ('initData', 'init_data'):
                continue
            if isinstance(value, str) and not sql_prevention.is_safe_string(value):
                print(f"Potential SQL injection attempt: {key}={value[:100]}")
                # In production, you might want to block the request
                # return jsonify({'error': 'Invalid input detected'}), 400
    
    def _check_content_type(self):
        """Validate content type for POST requests"""
        if request.method == 'POST':
            content_type = request.content_type
            if content_type and not content_type.startswith(('application/json', 'application/x-www-form-urlencoded', 'multipart/form-data')):
                print(f"Suspicious content type: {content_type}")
    
    def _add_security_headers(self):
        """Add security headers to response"""
        # Store in g to be added in after_request
        g.security_headers = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block'
        }

class PerformanceMiddleware:
    """Performance monitoring middleware"""
    
    def __init__(self, app=None, slow_request_threshold=1000):
        self.app = app
        self.slow_request_threshold = slow_request_threshold  # ms
        if app is not None:
            self.init_app(app)
    
    def init_app(self, app):
        """Initialize middleware with Flask app"""
        app.before_request(self.before_request)
        app.after_request(self.after_request)
    
    def before_request(self):
        """Record request start time"""
        g.perf_start_time = time.time()
        
        # Increment current request counter
        performance_metrics.current_requests += 1
    
    def after_request(self, response):
        """Record request performance"""
        if hasattr(g, 'perf_start_time'):
            duration_ms = (time.time() - g.perf_start_time) * 1000
            
            # Log slow requests
            if duration_ms > self.slow_request_threshold:
                print(f"SLOW REQUEST: {request.method} {request.path} took {duration_ms:.2f}ms")
            
            # Decrement current request counter
            performance_metrics.current_requests = max(0, performance_metrics.current_requests - 1)
        
        return response

class DatabaseMiddleware:
    """Database monitoring middleware"""
    
    def __init__(self, app=None):
        self.app = app
        if app is not None:
            self.init_app(app)
    
    def init_app(self, app):
        """Initialize middleware with Flask app"""
        # Hook into SQLAlchemy events if available
        try:
            from sqlalchemy import event
            from sqlalchemy.engine import Engine
            
            @event.listens_for(Engine, "before_cursor_execute")
            def receive_before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
                context._query_start_time = time.time()
            
            @event.listens_for(Engine, "after_cursor_execute")
            def receive_after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
                if hasattr(context, '_query_start_time'):
                    duration_ms = (time.time() - context._query_start_time) * 1000
                    db_monitor.record_query(
                        query=statement[:200] + '...' if len(statement) > 200 else statement,
                        duration_ms=duration_ms,
                        success=True
                    )
                    
                    # Record in performance metrics
                    performance_metrics.record_db_query(duration_ms)
        
        except ImportError:
            print("SQLAlchemy not available for database monitoring")

class ErrorHandlingMiddleware:
    """Error handling middleware"""
    
    def __init__(self, app=None):
        self.app = app
        if app is not None:
            self.init_app(app)
    
    def init_app(self, app):
        """Initialize middleware with Flask app"""
        app.errorhandler(400)(self.handle_bad_request)
        app.errorhandler(401)(self.handle_unauthorized)
        app.errorhandler(403)(self.handle_forbidden)
        app.errorhandler(404)(self.handle_not_found)
        app.errorhandler(429)(self.handle_rate_limit)
        app.errorhandler(500)(self.handle_internal_error)
    
    def handle_bad_request(self, error):
        """Handle 400 errors"""
        return jsonify({
            'error': 'Bad Request',
            'message': 'Invalid request format or parameters'
        }), 400
    
    def handle_unauthorized(self, error):
        """Handle 401 errors"""
        return jsonify({
            'error': 'Unauthorized',
            'message': 'Authentication required'
        }), 401
    
    def handle_forbidden(self, error):
        """Handle 403 errors"""
        return jsonify({
            'error': 'Forbidden',
            'message': 'Insufficient permissions'
        }), 403
    
    def handle_not_found(self, error):
        """Handle 404 errors"""
        return jsonify({
            'error': 'Not Found',
            'message': 'Resource not found'
        }), 404
    
    def handle_rate_limit(self, error):
        """Handle 429 errors"""
        return jsonify({
            'error': 'Rate Limit Exceeded',
            'message': 'Too many requests, please try again later'
        }), 429
    
    def handle_internal_error(self, error):
        """Handle 500 errors"""
        # Log the error
        print(f"Internal server error: {error}")
        
        return jsonify({
            'error': 'Internal Server Error',
            'message': 'An unexpected error occurred'
        }), 500

def init_middleware(app):
    """Initialize all middleware with Flask app"""
    SecurityMiddleware(app)
    PerformanceMiddleware(app)
    DatabaseMiddleware(app)
    ErrorHandlingMiddleware(app)
    
    return app
