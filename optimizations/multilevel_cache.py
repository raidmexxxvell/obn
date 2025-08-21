"""
Многоуровневая система кэширования для снижения нагрузки на БД и Google Sheets
Уровень 1: In-memory кэш (самые частые запросы)
Уровень 2: Redis (средние данные) 
Уровень 3: Database snapshots (тяжелые данные)
"""
import json
import time
import hashlib
import threading
from typing import Any, Optional, Dict, Callable
from datetime import datetime, timezone, timedelta
import redis
import pickle

class MultiLevelCache:
    def __init__(self, redis_client: Optional[redis.Redis] = None):
        self.redis_client = redis_client
        self.memory_cache: Dict[str, Dict] = {}
        self.lock = threading.RLock()
        
        # TTL конфигурация по типам данных
        self.ttl_config = {
            # Очень частые запросы - держим в памяти
            'league_table': {'memory': 300, 'redis': 1800},  # 5 мин в памяти, 30 мин в Redis
            'schedule': {'memory': 300, 'redis': 1800},
            'user_profile': {'memory': 180, 'redis': 900},
            
            # Средние по частоте - преимущественно Redis
            'match_details': {'memory': 60, 'redis': 600},
            'betting_odds': {'memory': 60, 'redis': 300},
            'stats_table': {'memory': 120, 'redis': 900},
            
            # Редкие но тяжелые запросы - только Redis
            'leaderboards': {'memory': 0, 'redis': 3600},
            'achievements': {'memory': 0, 'redis': 1800},
            'results': {'memory': 60, 'redis': 3600},
        }

    def _make_key(self, cache_type: str, identifier: str = '') -> str:
        """Создает ключ для кэша"""
        if identifier:
            return f"cache:{cache_type}:{identifier}"
        return f"cache:{cache_type}"

    def get(self, cache_type: str, identifier: str = '', loader_func: Optional[Callable] = None) -> Optional[Any]:
        """
        Получает данные из многоуровневого кэша
        loader_func: функция для загрузки данных при отсутствии в кэше
        """
        key = self._make_key(cache_type, identifier)
        config = self.ttl_config.get(cache_type, {'memory': 300, 'redis': 1800})
        
        # Уровень 1: Memory cache
        if config['memory'] > 0:
            with self.lock:
                if key in self.memory_cache:
                    entry = self.memory_cache[key]
                    if time.time() - entry['timestamp'] < config['memory']:
                        return entry['data']
                    else:
                        del self.memory_cache[key]

        # Уровень 2: Redis cache
        if self.redis_client and config['redis'] > 0:
            try:
                cached = self.redis_client.get(key)
                if cached:
                    data = pickle.loads(cached)
                    # Обновляем memory cache для следующих запросов
                    if config['memory'] > 0:
                        with self.lock:
                            self.memory_cache[key] = {
                                'data': data,
                                'timestamp': time.time()
                            }
                    return data
            except Exception as e:
                print(f"Redis get error for {key}: {e}")

        # Уровень 3: Загружаем данные, если есть loader
        if loader_func:
            try:
                data = loader_func()
                if data is not None:
                    self.set(cache_type, data, identifier)
                return data
            except Exception as e:
                print(f"Loader function error for {key}: {e}")
                
        return None

    def set(self, cache_type: str, data: Any, identifier: str = '') -> bool:
        """Устанавливает данные во все уровни кэша"""
        key = self._make_key(cache_type, identifier)
        config = self.ttl_config.get(cache_type, {'memory': 300, 'redis': 1800})
        
        try:
            # Memory cache
            if config['memory'] > 0:
                with self.lock:
                    self.memory_cache[key] = {
                        'data': data,
                        'timestamp': time.time()
                    }

            # Redis cache
            if self.redis_client and config['redis'] > 0:
                try:
                    serialized = pickle.dumps(data)
                    self.redis_client.setex(key, config['redis'], serialized)
                except Exception as e:
                    print(f"Redis set error for {key}: {e}")
                    
            return True
        except Exception as e:
            print(f"Cache set error for {key}: {e}")
            return False

    def invalidate(self, cache_type: str, identifier: str = '') -> bool:
        """Инвалидирует данные во всех уровнях кэша"""
        key = self._make_key(cache_type, identifier)
        
        try:
            # Memory cache
            with self.lock:
                self.memory_cache.pop(key, None)

            # Redis cache
            if self.redis_client:
                try:
                    self.redis_client.delete(key)
                except Exception as e:
                    print(f"Redis delete error for {key}: {e}")
                    
            return True
        except Exception as e:
            print(f"Cache invalidate error for {key}: {e}")
            return False

    def invalidate_pattern(self, pattern: str) -> int:
        """Инвалидирует данные по паттерну (например, все данные матча)"""
        count = 0
        
        # Memory cache
        with self.lock:
            keys_to_delete = [k for k in self.memory_cache.keys() if pattern in k]
            for k in keys_to_delete:
                del self.memory_cache[k]
                count += 1

        # Redis cache
        if self.redis_client:
            try:
                keys = self.redis_client.keys(f"*{pattern}*")
                if keys:
                    self.redis_client.delete(*keys)
                    count += len(keys)
            except Exception as e:
                print(f"Redis pattern delete error for {pattern}: {e}")
                
        return count

    def get_stats(self) -> dict:
        """Возвращает статистику кэша"""
        with self.lock:
            memory_count = len(self.memory_cache)
            
        redis_count = 0
        if self.redis_client:
            try:
                redis_count = len(self.redis_client.keys("cache:*"))
            except Exception:
                pass
                
        return {
            'memory_entries': memory_count,
            'redis_entries': redis_count,
            'timestamp': datetime.now(timezone.utc).isoformat()
        }

    def cleanup_expired(self):
        """Очищает истекшие записи из memory cache"""
        with self.lock:
            current_time = time.time()
            expired_keys = []
            
            for key, entry in self.memory_cache.items():
                cache_type = key.split(':')[1] if ':' in key else 'default'
                ttl = self.ttl_config.get(cache_type, {'memory': 300})['memory']
                
                if current_time - entry['timestamp'] > ttl:
                    expired_keys.append(key)
                    
            for key in expired_keys:
                del self.memory_cache[key]
                
        return len(expired_keys)


# Singleton instance
_cache_instance = None

def get_cache() -> MultiLevelCache:
    """Возвращает singleton instance кэша"""
    global _cache_instance
    if _cache_instance is None:
        # Инициализация Redis клиента
        redis_client = None
        try:
            import os
            redis_url = os.environ.get('REDIS_URL')
            if redis_url:
                redis_client = redis.from_url(redis_url, decode_responses=False)
                # Проверяем соединение
                redis_client.ping()
            else:
                # Локальный Redis
                redis_client = redis.Redis(host='localhost', port=6379, db=0, decode_responses=False)
                redis_client.ping()
        except Exception as e:
            print(f"Redis connection failed, using memory-only cache: {e}")
            redis_client = None
            
        _cache_instance = MultiLevelCache(redis_client)
    return _cache_instance
