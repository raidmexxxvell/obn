"""
Система автоподписок для оптимизированной доставки обновлений в реальном времени
- Селективная публикация по категориям и объектам
- Снижение нагрузки за счёт точечной доставки
- Совместимость с существующим WebSocketManager
- Полная обратная совместимость
"""
import logging
from typing import Dict, Set, List, Optional, Any
from enum import Enum
from flask_socketio import emit, join_room, leave_room
from datetime import datetime

logger = logging.getLogger(__name__)

class SubscriptionType(Enum):
    """Типы подписок для автоматического обновления"""
    MATCH_SCORE = 'match_score'          # Обновление счета матча
    MATCH_LINEUP = 'match_lineup'        # Составы на матч
    MATCH_EVENTS = 'match_events'        # События матча (голы, карточки)
    LEAGUE_TABLE = 'league_table'        # Турнирная таблица
    NEWS = 'news'                        # Новости
    BETTING_ODDS = 'betting_odds'        # Коэффициенты ставок
    USER_NOTIFICATIONS = 'user_notif'    # Персональные уведомления
    ADMIN_CHANGES = 'admin_changes'      # Изменения в админке
    STATS_TABLE = 'stats_table'          # Таблица статистики
    USER_CREDITS = 'user_credits'        # Баланс пользователя

class SubscriptionManager:
    """Менеджер автоподписок для оптимизированного распространения обновлений"""
    
    def __init__(self, socketio, existing_websocket_manager=None):
        self.socketio = socketio
        self.websocket_manager = existing_websocket_manager  # Совместимость
        self.user_sessions = {}  # sid -> user_id
        self.user_subscriptions = {}  # user_id -> {subscription_type -> {object_ids}}
        self.object_subscribers = {}  # subscription_type -> {object_id -> {user_ids}}
        self.stats = {
            'total_subscriptions': 0,
            'active_users': 0,
            'broadcast_sent': 0,
            'targeted_sent': 0
        }
    
    def generate_room_name(self, subscription_type: SubscriptionType, object_id: str = None) -> str:
        """Генерирует имя комнаты для подписки"""
        if object_id:
            return f"sub_{subscription_type.value}_{object_id}"
        return f"sub_{subscription_type.value}"
    
    def on_connect(self, sid, user_data):
        """Обработчик подключения пользователя"""
        user_id = user_data.get('user_id')
        if not user_id:
            return
            
        self.user_sessions[sid] = user_id
        if user_id not in self.user_subscriptions:
            self.user_subscriptions[user_id] = {}
            
        self.stats['active_users'] = len(set(self.user_sessions.values()))
        logger.debug(f"User {user_id} connected with sid {sid}")
        
        # Совместимость с существующим WebSocketManager
        if self.websocket_manager:
            self.websocket_manager.add_connection(user_id, sid)
    
    def on_disconnect(self, sid):
        """Обработчик отключения пользователя"""
        user_id = self.user_sessions.pop(sid, None)
        if not user_id:
            return
            
        # Очистка подписок при отключении
        self._cleanup_user_subscriptions(user_id, sid)
        self.stats['active_users'] = len(set(self.user_sessions.values()))
        logger.debug(f"User {user_id} disconnected")
        
        # Совместимость с существующим WebSocketManager
        if self.websocket_manager:
            self.websocket_manager.remove_connection(user_id, sid)
    
    def subscribe(self, sid, subscription_type: SubscriptionType, object_id: str = None):
        """Подписаться на обновления"""
        user_id = self.user_sessions.get(sid)
        if not user_id:
            logger.warning(f"Unknown session {sid} attempted to subscribe")
            return False
            
        # Добавляем подписку в структуры данных
        if subscription_type.value not in self.user_subscriptions.setdefault(user_id, {}):
            self.user_subscriptions[user_id][subscription_type.value] = set()
        
        if object_id:
            self.user_subscriptions[user_id][subscription_type.value].add(object_id)
            
            # Обновляем реверсивный индекс для быстрой публикации
            if subscription_type.value not in self.object_subscribers:
                self.object_subscribers[subscription_type.value] = {}
            if object_id not in self.object_subscribers[subscription_type.value]:
                self.object_subscribers[subscription_type.value][object_id] = set()
            self.object_subscribers[subscription_type.value][object_id].add(user_id)
        
        # Добавляем пользователя в комнату
        room_name = self.generate_room_name(subscription_type, object_id)
        join_room(room_name, sid=sid)
        
        self.stats['total_subscriptions'] += 1
        logger.debug(f"User {user_id} subscribed to {subscription_type.value}" + 
                    (f":{object_id}" if object_id else ""))
        return True
    
    def unsubscribe(self, sid, subscription_type: SubscriptionType, object_id: str = None):
        """Отписаться от обновлений"""
        user_id = self.user_sessions.get(sid)
        if not user_id:
            return False
            
        room_name = self.generate_room_name(subscription_type, object_id)
        leave_room(room_name, sid=sid)
        
        # Удаляем подписку из структур данных
        if user_id in self.user_subscriptions and subscription_type.value in self.user_subscriptions[user_id]:
            if object_id:
                if object_id in self.user_subscriptions[user_id][subscription_type.value]:
                    self.user_subscriptions[user_id][subscription_type.value].remove(object_id)
                    
                    # Обновляем реверсивный индекс
                    if (subscription_type.value in self.object_subscribers and 
                        object_id in self.object_subscribers[subscription_type.value] and
                        user_id in self.object_subscribers[subscription_type.value][object_id]):
                        self.object_subscribers[subscription_type.value][object_id].remove(user_id)
                        
                        # Если больше нет подписчиков, удаляем запись
                        if not self.object_subscribers[subscription_type.value][object_id]:
                            del self.object_subscribers[subscription_type.value][object_id]
            else:
                # Отписываемся от всех объектов данного типа
                if subscription_type.value in self.user_subscriptions[user_id]:
                    del self.user_subscriptions[user_id][subscription_type.value]
        
        self.stats['total_subscriptions'] = max(0, self.stats['total_subscriptions'] - 1)
        logger.debug(f"User {user_id} unsubscribed from {subscription_type.value}" + 
                    (f":{object_id}" if object_id else ""))
        return True
    
    def _cleanup_user_subscriptions(self, user_id, sid):
        """Очистка всех подписок пользователя при отключении"""
        if user_id not in self.user_subscriptions:
            return
            
        # Удаляем пользователя из всех реверсивных индексов
        for sub_type, objects in self.user_subscriptions[user_id].items():
            if sub_type in self.object_subscribers:
                for obj_id in objects:
                    if obj_id in self.object_subscribers[sub_type]:
                        if user_id in self.object_subscribers[sub_type][obj_id]:
                            self.object_subscribers[sub_type][obj_id].remove(user_id)
                        
                        # Удаляем пустые множества
                        if not self.object_subscribers[sub_type][obj_id]:
                            del self.object_subscribers[sub_type][obj_id]
        
        # Удаляем все подписки пользователя если больше нет сессий
        remaining_sessions = [s for s, u in self.user_sessions.items() if u == user_id]
        if not remaining_sessions:
            if user_id in self.user_subscriptions:
                del self.user_subscriptions[user_id]
    
    def publish(self, subscription_type: SubscriptionType, data: dict, object_id: str = None):
        """Публикация обновления по подписке"""
        room_name = self.generate_room_name(subscription_type, object_id)
        
        # Добавляем метаданные в сообщение
        message = {
            'type': subscription_type.value,
            'object_id': object_id,
            'data': data,
            'timestamp': datetime.now().isoformat()
        }
        
        # Отправляем в комнату через новый формат
        try:
            self.socketio.emit('subscription_update', message, room=room_name)
            
            if object_id:
                self.stats['targeted_sent'] += 1
            else:
                self.stats['broadcast_sent'] += 1
                
            logger.debug(f"Published update for {subscription_type.value}" + 
                        (f":{object_id}" if object_id else "") + 
                        f" to room {room_name}")
        except Exception as e:
            logger.error(f"Failed to publish update: {e}")
        
        return True
    
    def publish_legacy(self, data_type: str, data: dict = None):
        """Обратная совместимость с существующим WebSocketManager"""
        try:
            # Мапинг legacy типов на новые
            legacy_mapping = {
                'league_table': SubscriptionType.LEAGUE_TABLE,
                'schedule': SubscriptionType.MATCH_EVENTS,
                'match_score': SubscriptionType.MATCH_SCORE,
                'match_status': SubscriptionType.MATCH_EVENTS,
                'news': SubscriptionType.NEWS,
                'stats_table': SubscriptionType.STATS_TABLE
            }
            
            if data_type in legacy_mapping:
                self.publish(legacy_mapping[data_type], data or {})
            
            # Также отправляем в старом формате для совместимости
            if self.websocket_manager:
                self.websocket_manager.notify_data_change(data_type, data)
        except Exception as e:
            logger.error(f"Failed to publish legacy update: {e}")
    
    def _count_subscribers(self, subscription_type: SubscriptionType, object_id: str = None) -> int:
        """Подсчёт количества подписчиков на объект"""
        count = 0
        if object_id and subscription_type.value in self.object_subscribers:
            count = len(self.object_subscribers[subscription_type.value].get(object_id, set()))
        return count

    def get_stats(self):
        """Получение статистики подписок"""
        active_subs_by_type = {}
        for sub_type in SubscriptionType:
            if sub_type.value in self.object_subscribers:
                active_subs_by_type[sub_type.value] = len(self.object_subscribers[sub_type.value])
            else:
                active_subs_by_type[sub_type.value] = 0
        
        self.stats['subscription_breakdown'] = active_subs_by_type
        return self.stats

# Singleton instance
_subscription_manager = None

def init_subscription_manager(socketio, existing_websocket_manager=None):
    """Инициализация синглтона менеджера подписок"""
    global _subscription_manager
    if _subscription_manager is None:
        _subscription_manager = SubscriptionManager(socketio, existing_websocket_manager)
    return _subscription_manager

def get_subscription_manager():
    """Получение синглтона менеджера подписок"""
    global _subscription_manager
    if _subscription_manager is None:
        raise RuntimeError("SubscriptionManager not initialized. Call init_subscription_manager first.")
    return _subscription_manager
