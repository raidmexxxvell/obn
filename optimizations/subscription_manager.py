"""SubscriptionManager (Фаза 2 — Шаг 1)
Скелет селективной системы подписок (feature-flag ENABLE_SUBSCRIPTIONS)
На данном этапе: только структуры + базовые методы без hash-skip / debounce.
Не интегрирован в существующий websocket_manager, не меняет поведение приложения.
"""
from __future__ import annotations
from typing import Dict, Set, Optional, Any, Iterable
from dataclasses import dataclass, field
from enum import Enum
import time

class SubscriptionType(str, Enum):
    MATCH_SCORE = "match_score"
    MATCH_LINEUP = "match_lineup"
    LEAGUE_TABLE = "league_table"
    NEWS = "news"
    BETTING_ODDS = "betting_odds"
    USER_NOTIFICATIONS = "user_notifications"
    USER_CREDITS = "user_credits"

@dataclass
class SubscriptionStats:
    total_subscriptions: int = 0
    active_users: int = 0
    broadcast_sent: int = 0  # для будущей метрики
    targeted_sent: int = 0   # для будущей метрики
    started_at: float = field(default_factory=time.time)

class SubscriptionManager:
    """In-memory менеджер подписок (без внешних зависимостей).
    Интеграционные вызовы socketio будут добавлены на следующих шагах.
    """
    def __init__(self, socketio: Optional[Any] = None) -> None:
        self.user_sessions: Dict[str, str] = {}          # sid -> user_id
        self.user_subscriptions: Dict[str, Dict[str, Set[str]]] = {}  # user_id -> {type -> set(object_id)}
        self.object_subscribers: Dict[str, Dict[str, Set[str]]] = {}  # type -> {object_id -> {user_id}}
        self.stats = SubscriptionStats()
        self.socketio = socketio  # ссылка на Flask-SocketIO для эмита событий

    # --- Lifecycle ---
    def on_connect(self, sid: str, user_id: Optional[str]) -> None:
        if not user_id:
            return
        self.user_sessions[sid] = user_id
        self.user_subscriptions.setdefault(user_id, {})
        self.stats.active_users = len(self.user_subscriptions)

    def on_disconnect(self, sid: str) -> None:
        user_id = self.user_sessions.pop(sid, None)
        if not user_id:
            return
        self._cleanup_user(user_id)
        self.stats.active_users = len(self.user_subscriptions)

    # --- Core ---
    def subscribe(self, sid: str, sub_type: SubscriptionType, object_id: Optional[str] = None) -> bool:
        user_id = self.user_sessions.get(sid)
        if not user_id:
            return False
        user_map = self.user_subscriptions.setdefault(user_id, {})
        bucket = user_map.setdefault(sub_type.value, set())
        if object_id:
            if object_id in bucket:
                return True
            bucket.add(object_id)
            type_map = self.object_subscribers.setdefault(sub_type.value, {})
            type_map.setdefault(object_id, set()).add(user_id)
        self.stats.total_subscriptions += 1
        return True

    def unsubscribe(self, sid: str, sub_type: SubscriptionType, object_id: Optional[str] = None) -> bool:
        user_id = self.user_sessions.get(sid)
        if not user_id:
            return False
        if user_id not in self.user_subscriptions:
            return False
        type_bucket = self.user_subscriptions[user_id].get(sub_type.value)
        if not type_bucket:
            return False
        if object_id:
            if object_id in type_bucket:
                type_bucket.remove(object_id)
                subs = self.object_subscribers.get(sub_type.value, {})
                if object_id in subs and user_id in subs[object_id]:
                    subs[object_id].remove(user_id)
                    if not subs[object_id]:
                        subs.pop(object_id, None)
        else:
            # remove all objects of this type
            for oid in list(type_bucket):
                self.unsubscribe(sid, sub_type, oid)
            self.user_subscriptions[user_id].pop(sub_type.value, None)
        self.stats.total_subscriptions = max(0, self.stats.total_subscriptions - 1)
        return True

    # Публикация (Шаг 5 частичная реализация): отправка targeted или broadcast событий
    def publish(self, sub_type: SubscriptionType, data: Dict[str, Any], object_id: Optional[str] = None) -> bool:
        try:
            # Если сокета нет – считаем успешным (чтобы не ломать логику)
            if not self.socketio:
                return True

            delivered = 0
            # Targeted рассылка если object_id указан и у нас есть подписчики на этот объект
            if object_id is not None:
                uids: Iterable[str] = self.object_subscribers.get(sub_type.value, {}).get(object_id, set())
                if uids:
                    # Получаем sid по user_id (1:1 предположение на данном этапе)
                    for sid, uid in list(self.user_sessions.items()):
                        if uid in uids:
                            self.socketio.emit('subscription_update', {
                                'type': sub_type.value,
                                'object_id': object_id,
                                'data': data,
                                'ts': int(time.time())
                            }, room=sid)
                            delivered += 1
                    self.stats.targeted_sent += delivered
                # fallback: если нет подписчиков (пока ранний этап) — делаем broadcast, чтобы UX не страдал
                if delivered == 0:
                    for sid in list(self.user_sessions.keys()):
                        self.socketio.emit('subscription_update', {
                            'type': sub_type.value,
                            'object_id': object_id,
                            'data': data,
                            'ts': int(time.time())
                        }, room=sid)
                    self.stats.broadcast_sent += 1
            else:
                # Broadcast (например league_table) – всем активным сессиям
                for sid in list(self.user_sessions.keys()):
                    self.socketio.emit('subscription_update', {
                        'type': sub_type.value,
                        'object_id': None,
                        'data': data,
                        'ts': int(time.time())
                    }, room=sid)
                    delivered += 1
                self.stats.broadcast_sent += 1
            return True
        except Exception:
            return False

    def get_stats(self) -> Dict[str, Any]:
        return {
            "total_subscriptions": self.stats.total_subscriptions,
            "active_users": self.stats.active_users,
            "broadcast_sent": self.stats.broadcast_sent,
            "targeted_sent": self.stats.targeted_sent,
            "uptime_sec": int(time.time() - self.stats.started_at),
        }

    # --- Internal ---
    def _cleanup_user(self, user_id: str) -> None:
        if user_id not in self.user_subscriptions:
            return
        for t, oids in self.user_subscriptions[user_id].items():
            tmap = self.object_subscribers.get(t, {})
            for oid in list(oids):
                if oid in tmap and user_id in tmap[oid]:
                    tmap[oid].remove(user_id)
                    if not tmap[oid]:
                        tmap.pop(oid, None)
        self.user_subscriptions.pop(user_id, None)

# Singleton helpers
_subscription_manager: Optional[SubscriptionManager] = None

def get_subscription_manager(socketio: Optional[Any] = None) -> SubscriptionManager:
    global _subscription_manager
    if _subscription_manager is None:
        _subscription_manager = SubscriptionManager(socketio=socketio)
    else:
        # обновляем ссылку на socketio если передана (горячее обновление)
        if socketio is not None and _subscription_manager.socketio is None:
            _subscription_manager.socketio = socketio
    return _subscription_manager
