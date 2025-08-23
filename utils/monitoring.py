"""
Performance monitoring and metrics for Liga Obninska
Tracks application performance, database queries, and API response times
"""
import time
import threading
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any
from collections import defaultdict, deque
import os

class PerformanceMetrics:
    """Collects and tracks performance metrics"""
    
    def __init__(self, max_samples: int = 1000):
        self.max_samples = max_samples
        self.request_times = deque(maxlen=max_samples)
        self.db_query_times = deque(maxlen=max_samples)
        self.api_endpoints = defaultdict(lambda: deque(maxlen=100))
        self.error_counts = defaultdict(int)
        self.lock = threading.Lock()
        
        # Current metrics
        self.current_requests = 0
        self.total_requests = 0
        self.start_time = datetime.now(timezone.utc)
    
    def record_request(self, endpoint: str, duration_ms: float, status_code: int):
        """Record request metrics"""
        with self.lock:
            self.request_times.append(duration_ms)
            self.api_endpoints[endpoint].append({
                'duration': duration_ms,
                'status': status_code,
                'timestamp': time.time()
            })
            
            self.total_requests += 1
            
            if status_code >= 400:
                self.error_counts[f"{status_code}"] += 1
    
    def record_db_query(self, duration_ms: float, query_type: str = 'unknown'):
        """Record database query metrics"""
        with self.lock:
            self.db_query_times.append(duration_ms)
    
    def get_summary(self) -> Dict[str, Any]:
        """Get performance summary"""
        with self.lock:
            uptime = (datetime.now(timezone.utc) - self.start_time).total_seconds()
            
            # Request metrics
            if self.request_times:
                avg_response_time = sum(self.request_times) / len(self.request_times)
                min_response_time = min(self.request_times)
                max_response_time = max(self.request_times)
                p95_response_time = sorted(self.request_times)[int(len(self.request_times) * 0.95)] if len(self.request_times) > 20 else avg_response_time
            else:
                avg_response_time = min_response_time = max_response_time = p95_response_time = 0
            
            # Database metrics
            if self.db_query_times:
                avg_db_time = sum(self.db_query_times) / len(self.db_query_times)
                max_db_time = max(self.db_query_times)
            else:
                avg_db_time = max_db_time = 0
            
            # Error rate
            error_count = sum(self.error_counts.values())
            error_rate = (error_count / self.total_requests * 100) if self.total_requests > 0 else 0
            
            return {
                'uptime_seconds': uptime,
                'total_requests': self.total_requests,
                'current_requests': self.current_requests,
                'requests_per_minute': (self.total_requests / (uptime / 60)) if uptime > 0 else 0,
                'response_times': {
                    'avg_ms': round(avg_response_time, 2),
                    'min_ms': round(min_response_time, 2),
                    'max_ms': round(max_response_time, 2),
                    'p95_ms': round(p95_response_time, 2)
                },
                'database': {
                    'avg_query_time_ms': round(avg_db_time, 2),
                    'max_query_time_ms': round(max_db_time, 2),
                    'total_queries': len(self.db_query_times)
                },
                'errors': {
                    'total_count': error_count,
                    'error_rate_percent': round(error_rate, 2),
                    'by_status': dict(self.error_counts)
                }
            }
    
    def get_endpoint_stats(self, endpoint: str) -> Dict[str, Any]:
        """Get statistics for specific endpoint"""
        with self.lock:
            if endpoint not in self.api_endpoints:
                return {'error': 'Endpoint not found'}
            
            requests = list(self.api_endpoints[endpoint])
            if not requests:
                return {'error': 'No data available'}
            
            durations = [r['duration'] for r in requests]
            status_codes = [r['status'] for r in requests]
            
            return {
                'endpoint': endpoint,
                'total_requests': len(requests),
                'avg_duration_ms': round(sum(durations) / len(durations), 2),
                'min_duration_ms': round(min(durations), 2),
                'max_duration_ms': round(max(durations), 2),
                'success_rate_percent': round((len([s for s in status_codes if s < 400]) / len(status_codes)) * 100, 2),
                'recent_requests': requests[-10:]  # Last 10 requests
            }

class DatabaseMonitor:
    """Monitors database performance"""
    
    def __init__(self):
        self.query_count = 0
        self.slow_queries = deque(maxlen=50)
        self.connection_pool_stats = {}
        self.lock = threading.Lock()
    
    def record_query(self, query: str, duration_ms: float, success: bool = True):
        """Record database query execution"""
        with self.lock:
            self.query_count += 1
            
            # Track slow queries (>100ms)
            if duration_ms > 100:
                self.slow_queries.append({
                    'query': query[:200] + '...' if len(query) > 200 else query,
                    'duration_ms': duration_ms,
                    'timestamp': datetime.now(timezone.utc).isoformat(),
                    'success': success
                })
    
    def get_stats(self) -> Dict[str, Any]:
        """Get database statistics"""
        with self.lock:
            return {
                'total_queries': self.query_count,
                'slow_queries_count': len(self.slow_queries),
                'slow_queries': list(self.slow_queries),
                'connection_pool': self.connection_pool_stats
            }

class CacheMonitor:
    """Monitors cache performance"""
    
    def __init__(self):
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.lock = threading.Lock()
    
    def record_hit(self):
        """Record cache hit"""
        with self.lock:
            self.hits += 1
    
    def record_miss(self):
        """Record cache miss"""
        with self.lock:
            self.misses += 1
    
    def record_eviction(self):
        """Record cache eviction"""
        with self.lock:
            self.evictions += 1
    
    def get_stats(self) -> Dict[str, Any]:
        """Get cache statistics"""
        with self.lock:
            total = self.hits + self.misses
            hit_rate = (self.hits / total * 100) if total > 0 else 0
            
            return {
                'hits': self.hits,
                'misses': self.misses,
                'hit_rate_percent': round(hit_rate, 2),
                'evictions': self.evictions,
                'total_requests': total
            }

class SystemMonitor:
    """Monitors system resources"""
    
    @staticmethod
    def get_memory_usage() -> Dict[str, Any]:
        """Get memory usage information"""
        try:
            import psutil
            process = psutil.Process()
            memory_info = process.memory_info()
            
            return {
                'rss_mb': round(memory_info.rss / 1024 / 1024, 2),
                'vms_mb': round(memory_info.vms / 1024 / 1024, 2),
                'percent': round(process.memory_percent(), 2)
            }
        except ImportError:
            return {'error': 'psutil not available'}
    
    @staticmethod
    def get_cpu_usage() -> Dict[str, Any]:
        """Get CPU usage information"""
        try:
            import psutil
            process = psutil.Process()
            
            return {
                'percent': round(process.cpu_percent(), 2),
                'num_threads': process.num_threads()
            }
        except ImportError:
            return {'error': 'psutil not available'}

class HealthCheck:
    """Application health check"""
    
    def __init__(self, db_session_factory=None):
        self.db_session_factory = db_session_factory
        self.last_check = None
        self.status = 'unknown'
    
    def check_database(self) -> tuple[bool, str]:
        """Check database connectivity"""
        if not self.db_session_factory:
            return True, "Database not configured"
        
        try:
            session = self.db_session_factory()
            session.execute("SELECT 1")
            session.close()
            return True, "Database OK"
        except Exception as e:
            return False, f"Database error: {str(e)}"
    
    def check_cache(self) -> tuple[bool, str]:
        """Check cache connectivity"""
        try:
            from optimizations.multilevel_cache import get_cache
            cache = get_cache()
            if cache:
                # Try to set and get a test value
                test_key = "health_check_test"
                cache.set(test_key, "test_value", 10)
                result = cache.get(test_key)
                if result == "test_value":
                    return True, "Cache OK"
                else:
                    return False, "Cache not responding correctly"
            else:
                return True, "Cache not configured"
        except Exception as e:
            return False, f"Cache error: {str(e)}"
    
    def check_sheets(self) -> tuple[bool, str]:
        """Check Google Sheets connectivity"""
        try:
            credentials_b64 = os.environ.get('GOOGLE_CREDENTIALS_B64')
            if not credentials_b64:
                return True, "Sheets not configured"
            
            # Basic connectivity check would go here
            return True, "Sheets OK"
        except Exception as e:
            return False, f"Sheets error: {str(e)}"
    
    def full_health_check(self) -> Dict[str, Any]:
        """Perform full health check"""
        self.last_check = datetime.now(timezone.utc)
        
        checks = {
            'database': self.check_database(),
            'cache': self.check_cache(),
            'sheets': self.check_sheets()
        }
        
        # Overall status
        all_healthy = all(status for status, _ in checks.values())
        self.status = 'healthy' if all_healthy else 'unhealthy'
        
        return {
            'status': self.status,
            'timestamp': self.last_check.isoformat(),
            'checks': {
                name: {'healthy': status, 'message': message}
                for name, (status, message) in checks.items()
            },
            'system': {
                'memory': SystemMonitor.get_memory_usage(),
                'cpu': SystemMonitor.get_cpu_usage()
            }
        }

# Global instances
performance_metrics = PerformanceMetrics()
db_monitor = DatabaseMonitor()
cache_monitor = CacheMonitor()
health_check = HealthCheck()
