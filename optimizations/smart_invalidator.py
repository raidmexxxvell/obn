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
    def __init__(self, cache_manager, websocket_manager=None):
        self.cache_manager = cache_manager
        self.websocket_manager = websocket_manager
        self.lock = threading.Lock()
        
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
                        self.cache_manager.invalidate(cache_type, identifier)
                        
                        # Также инвалидируем общий кэш этого типа
                        self.cache_manager.invalidate(cache_type)
                    else:
                        # Инвалидируем весь тип кэша
                        self.cache_manager.invalidate(cache_type)

                # Отправляем WebSocket уведомление
                if rule.broadcast_update and self.websocket_manager:
                    self._send_update_notification(change_type, context)
                    
                return True
                
        except Exception as e:
            print(f"Cache invalidation error for {change_type}: {e}")
            return False

    def _send_update_notification(self, change_type: str, context: Dict):
        """Отправляет WebSocket уведомление об изменении"""
        try:
            notification_data = {
                'change_type': change_type,
                'context': context,
                'timestamp': datetime.now(timezone.utc).isoformat()
            }
            
            # Специальная обработка для разных типов изменений
            if change_type == 'match_score_update':
                self.websocket_manager.notify_match_live_update(
                    context.get('home', ''),
                    context.get('away', ''),
                    {
                        'score_home': context.get('score_home'),
                        'score_away': context.get('score_away'),
                        'updated_at': notification_data['timestamp']
                    }
                )
            elif change_type in ['league_table_update', 'schedule_update']:
                self.websocket_manager.notify_data_change(
                    change_type.replace('_update', ''),
                    notification_data
                )
            else:
                self.websocket_manager.notify_data_change(
                    'general_update',
                    notification_data
                )
                
        except Exception as e:
            print(f"WebSocket notification error: {e}")

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
