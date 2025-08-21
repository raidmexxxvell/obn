"""
WebSocket manager для real-time уведомлений при изменениях админа
Снижает нагрузку на сервер, устраняя необходимость в polling
"""
import json
import threading
from typing import Dict, Set
from flask_socketio import SocketIO, emit, join_room, leave_room
import logging

logger = logging.getLogger(__name__)

class WebSocketManager:
    def __init__(self, socketio: SocketIO):
        self.socketio = socketio
        self.connected_users: Dict[str, Set[str]] = {}  # user_id -> {session_ids}
        self.lock = threading.Lock()

    def add_connection(self, user_id: str, session_id: str):
        """Добавляет соединение пользователя"""
        with self.lock:
            if user_id not in self.connected_users:
                self.connected_users[user_id] = set()
            self.connected_users[user_id].add(session_id)
            
    def remove_connection(self, user_id: str, session_id: str):
        """Удаляет соединение пользователя"""
        with self.lock:
            if user_id in self.connected_users:
                self.connected_users[user_id].discard(session_id)
                if not self.connected_users[user_id]:
                    del self.connected_users[user_id]

    def notify_data_change(self, data_type: str, data: dict = None):
        """
        Уведомляет всех подключенных пользователей об изменении данных
        data_type: 'league_table', 'schedule', 'match_score', 'match_status', etc.
        """
        if not self.socketio:
            return
            
        message = {
            'type': 'data_update',
            'data_type': data_type,
            'timestamp': json.dumps(data.get('updated_at', ''), default=str) if data else None,
            'data': data
        }
        
        try:
            # Отправляем всем подключенным пользователям (совместимый синтаксис)
            self.socketio.emit('data_changed', message, namespace='/')
            logger.info(f"Sent {data_type} update to all connected users")
        except Exception as e:
            logger.warning(f"Failed to send WebSocket notification for {data_type}: {e}")

    def notify_match_live_update(self, home: str, away: str, update_data: dict):
        """Специальные уведомления для live-матчей"""
        if not self.socketio:
            return
            
        try:
            room = f"match_{home}_{away}"
            message = {
                'type': 'match_live_update',
                'home': home,
                'away': away,
                'data': update_data
            }
            self.socketio.emit('live_update', message, room=room, namespace='/')
        except Exception as e:
            logger.warning(f"Failed to send live match update: {e}")

    def get_connected_count(self) -> int:
        """Возвращает количество подключенных пользователей"""
        with self.lock:
            return len(self.connected_users)
