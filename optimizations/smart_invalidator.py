"""
Система smart cache invalidation для мгновенного обновления данных при изменениях админа
Минимизирует задержку между изменениями и их отображением пользователям
"""
from typing import List, Dict, Set, Optional
from dataclasses import dataclass
from datetime import datetime, timezone
import threading
import json

@dataclass
class InvalidationRule:
    """Правило инвалидации кэша"""
    trigger_type: str  # 'match_score', 'match_status', 'league_table', etc.
    affected_caches: List[str]  # Список типов кэша для инвалидации
    identifier_pattern: Optional[str] = None  # Паттерн для identifier (например, "{home}_{away}")
    broadcast_update: bool = True  # Отправлять ли WebSocket уведомление

class SmartCacheInvalidator:
    REDIS_CHANNEL = 'app:invalidation'

    def __init__(self, cache_manager, websocket_manager=None):
        self.cache_manager = cache_manager
        self.websocket_manager = websocket_manager
        self.lock = threading.Lock()
        self.redis_client = None
        self.subscriber_thread = None
        self.task_manager = None

        # Правила инвалидации для разных типов изменений
        self.invalidation_rules = {
            'match_score_update': InvalidationRule(
                trigger_type='match_score_update',
                affected_caches=['match_details', 'betting_odds', 'results', 'league_table'],
                identifier_pattern='{home}_{away}',
                broadcast_update=True
            ),
            'match_status_change': InvalidationRule(
                trigger_type='match_status_change', 
                affected_caches=['match_details', 'schedule', 'betting_odds'],
                identifier_pattern='{home}_{away}',
                broadcast_update=True
            ),
            'league_table_update': InvalidationRule(
                trigger_type='league_table_update',
                affected_caches=['league_table', 'stats_table'],
                broadcast_update=True
            ),
            'schedule_update': InvalidationRule(
                trigger_type='schedule_update',
                affected_caches=['schedule', 'betting_odds', 'match_details'],
                broadcast_update=True
            ),
            'vote_aggregates_update': InvalidationRule(
                trigger_type='vote_aggregates_update',
                affected_caches=['match_details', 'betting_odds', 'match_votes'],
                identifier_pattern='{home}_{away}',
                broadcast_update=True
            ),
            'user_credits_change': InvalidationRule(
                trigger_type='user_credits_change',
                affected_caches=['user_profile', 'leaderboards'],
                identifier_pattern='{user_id}',
                broadcast_update=False  # Персональные данные не всем
            ),
            'betting_result': InvalidationRule(
                trigger_type='betting_result',
                affected_caches=['user_profile', 'leaderboards', 'achievements', 'match_details'],
                broadcast_update=True
            )
        }

        # Попробуем инициализировать Redis клиент (best-effort)
        try:
            import os
            import redis as _redis
            redis_url = os.environ.get('REDIS_URL')
            if redis_url:
                self.redis_client = _redis.from_url(redis_url)
        except Exception:
            self.redis_client = None

        # Попробуем получить менеджер фоновых задач, если он доступен
        try:
            from optimizations.background_tasks import get_task_manager
            self.task_manager = get_task_manager()
        except Exception:
            self.task_manager = None

        # Запустим background подписчик на Redis, чтобы получать invalidation от других инстансов
        if self.redis_client:
            try:
                self.subscriber_thread = threading.Thread(target=self._redis_subscribe_loop, daemon=True)
                self.subscriber_thread.start()
            except Exception:
                self.subscriber_thread = None

    def invalidate_for_change(self, change_type: str, context: Dict = None) -> bool:
        """
        Инвалидирует кэш при изменении данных
        
        Args:
            change_type: Тип изменения (ключ из invalidation_rules)
            context: Контекст изменения (home, away, user_id, etc.)
        """
        if change_type not in self.invalidation_rules:
            return False
            
        rule = self.invalidation_rules[change_type]
        context = context or {}
        
        try:
            with self.lock:
                # Инвалидируем все затронутые типы кэша
                for cache_type in rule.affected_caches:
                    if rule.identifier_pattern and context:
                        # Используем паттерн для создания identifier
                        identifier = rule.identifier_pattern.format(**context)
                        try:
                            self.cache_manager.invalidate(cache_type, identifier)
                        except Exception:
                            pass
                        
                        # Также инвалидируем общий кэш этого типа
                        try:
                            self.cache_manager.invalidate(cache_type)
                        except Exception:
                            pass
                    else:
                        # Инвалидируем весь тип кэша
                        try:
                            self.cache_manager.invalidate(cache_type)
                        except Exception:
                            pass

                # Отправляем WebSocket уведомление (неблокирующе)
                if rule.broadcast_update and self.websocket_manager:
                    payload = {'change_type': change_type, 'context': context or {}, 'timestamp': datetime.now(timezone.utc).isoformat()}
                    try:
                        if self.task_manager:
                            # submit in background
                            self.task_manager.submit_task(f'ws_notify_{change_type}', self._send_update_notification, change_type, context or {}, payload, priority=1)
                        else:
                            threading.Thread(target=self._send_update_notification, args=(change_type, context or {}, payload), daemon=True).start()
                    except Exception:
                        # fallback to direct call
                        try:
                            self._send_update_notification(change_type, context or {}, payload)
                        except Exception:
                            pass

                # Опубликовать сообщение в Redis channel чтобы другие инстансы тоже инвалиировали и эмитнули
                try:
                    if self.redis_client:
                        msg = json.dumps({'change_type': change_type, 'context': context or {}, 'timestamp': datetime.now(timezone.utc).isoformat()})
                        try:
                            self.redis_client.publish(self.REDIS_CHANNEL, msg)
                        except Exception as e:
                            print(f"Redis publish failed: {e}")
                except Exception:
                    pass

                return True

        except Exception as e:
            print(f"Cache invalidation error for {change_type}: {e}")
            return False

    def _send_update_notification(self, change_type: str, context: Dict, payload: Dict = None):
        """Отправляет WebSocket уведомление об изменении"""
        try:
            notification_data = payload or {'change_type': change_type, 'context': context, 'timestamp': datetime.now(timezone.utc).isoformat()}

            # Специальная обработка для разных типов изменений
            if change_type == 'match_score_update':
                data = {
                    'score_home': context.get('score_home'),
                    'score_away': context.get('score_away'),
                    'updated_at': notification_data.get('timestamp')
                }
                self.websocket_manager.notify_match_live_update(context.get('home', ''), context.get('away', ''), data)
            elif change_type in ['league_table_update', 'schedule_update']:
                self.websocket_manager.notify_data_change(change_type.replace('_update', ''), notification_data)
            else:
                self.websocket_manager.notify_data_change('general_update', notification_data)

        except Exception as e:
            print(f"WebSocket notification error: {e}")

    def _redis_subscribe_loop(self):
        try:
            pubsub = self.redis_client.pubsub(ignore_subscribe_messages=True)
            pubsub.subscribe(self.REDIS_CHANNEL)
            for message in pubsub.listen():
                try:
                    if not message or message.get('type') != 'message':
                        continue
                    data = message.get('data')
                    if isinstance(data, bytes):
                        data = data.decode('utf-8')
                    payload = json.loads(data)
                    change_type = payload.get('change_type')
                    context = payload.get('context') or {}
                    # локальная инвалидация и отправка уведомления (не публикуем обратно)
                    try:
                        with self.lock:
                            rule = self.invalidation_rules.get(change_type)
                            if rule:
                                for cache_type in rule.affected_caches:
                                    try:
                                        if rule.identifier_pattern and context:
                                            identifier = rule.identifier_pattern.format(**context)
                                            self.cache_manager.invalidate(cache_type, identifier)
                                            self.cache_manager.invalidate(cache_type)
                                        else:
                                            self.cache_manager.invalidate(cache_type)
                                    except Exception:
                                        pass
                            if rule and rule.broadcast_update and self.websocket_manager:
                                try:
                                    # отправляем уведомление локально
                                    self._send_update_notification(change_type, context, payload)
                                except Exception:
                                    pass
                    except Exception:
                        pass
                except Exception:
                    continue
        except Exception as e:
            print(f"Redis subscribe loop failed: {e}")

    def register_custom_rule(self, change_type: str, rule: InvalidationRule):
        """Регистрирует кастомное правило инвалидации"""
        with self.lock:
            self.invalidation_rules[change_type] = rule

    def get_affected_caches(self, change_type: str) -> List[str]:
        """Возвращает список затронутых кэшей для типа изменения"""
        rule = self.invalidation_rules.get(change_type)
        return rule.affected_caches if rule else []

# Decorator для автоматической инвалидации кэша
def invalidate_cache_on_change(change_type: str, context_extractor=None):
    """
    Декоратор для автоматической инвалидации кэша при изменении данных
    
    Args:
        change_type: Тип изменения
        context_extractor: Функция для извлечения контекста из аргументов функции
    """
    def decorator(func):
        def wrapper(*args, **kwargs):
            # Выполняем основную функцию
            result = func(*args, **kwargs)
            
            try:
                # Извлекаем контекст для инвалидации
                context = {}
                if context_extractor:
                    context = context_extractor(*args, **kwargs)
                elif hasattr(func, '__self__') and hasattr(func.__self__, 'invalidator'):
                    # Если это метод класса с invalidator
                    func.__self__.invalidator.invalidate_for_change(change_type, context)
                    
            except Exception as e:
                print(f"Cache invalidation decorator error: {e}")
                
            return result
        return wrapper
    return decorator

# Utility функции для извлечения контекста
def extract_match_context(*args, **kwargs) -> Dict:
    """Извлекает контекст матча из аргументов"""
    context = {}
    
    # Пробуем найти home/away в kwargs
    context['home'] = kwargs.get('home', '')
    context['away'] = kwargs.get('away', '')
    
    # Или в args (в зависимости от сигнатуры функции)
    if not context['home'] and len(args) >= 2:
        context['home'] = str(args[0])
        context['away'] = str(args[1])
        
    return context

def extract_user_context(*args, **kwargs) -> Dict:
    """Извлекает контекст пользователя из аргументов"""
    context = {}
    context['user_id'] = kwargs.get('user_id', '') or (str(args[0]) if args else '')
    return context
