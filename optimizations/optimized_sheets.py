"""
Оптимизированная система работы с Google Sheets
- Batch операции для минимизации запросов
- Intelligent delta sync (только измененные данные)
- Rate limiting и backoff strategies
- Connection pooling и retry logic
"""
import time
import json
import hashlib
import threading
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime, timezone
from dataclasses import dataclass, asdict
import gspread
from google.oauth2.service_account import Credentials
import queue
import logging

logger = logging.getLogger(__name__)

@dataclass
class SheetOperation:
    """Операция с Google Sheets"""
    operation_type: str  # 'read', 'write', 'batch_write'
    sheet_name: str
    range_name: str
    data: Optional[Any] = None
    priority: int = 1  # Чем меньше, тем выше приоритет
    callback: Optional[callable] = None
    created_at: float = None
    
    def __post_init__(self):
        if self.created_at is None:
            self.created_at = time.time()

class OptimizedSheetsManager:
    def __init__(self, credentials_data: Dict, sheet_id: str, max_qps: float = 10.0):
        self.credentials_data = credentials_data
        self.sheet_id = sheet_id
        self.max_qps = max_qps  # Максимум запросов в секунду
        
        # Rate limiting
        self.last_request_time = 0
        self.request_interval = 1.0 / max_qps
        self.rate_limit_lock = threading.Lock()
        
        # Connection management
        self._client = None
        self._doc = None
        self._worksheets_cache = {}
        self.connection_lock = threading.Lock()
        
        # Operation queue для batch processing
        self.operation_queue = queue.PriorityQueue()
        self.batch_processor_thread = None
        self.batch_size = 50
        self.batch_timeout = 5.0  # секунд
        
        # Delta sync для эффективного обновления
        self.data_checksums = {}  # sheet_name:range -> checksum
        self.checksum_lock = threading.Lock()
        
        # Metrics
        self.metrics = {
            'requests_total': 0,
            'requests_successful': 0,
            'requests_failed': 0,
            'rate_limit_hits': 0,
            'batch_operations': 0,
            'delta_sync_skips': 0,
            'last_error': '',
            'connection_resets': 0
        }
        self.metrics_lock = threading.Lock()
        
        self._start_batch_processor()

    def _get_client(self):
        """Получает или создает клиент Google Sheets с переподключением"""
        with self.connection_lock:
            try:
                if self._client is None:
                    scopes = [
                        'https://www.googleapis.com/auth/spreadsheets',
                        'https://www.googleapis.com/auth/drive'
                    ]
                    credentials = Credentials.from_service_account_info(
                        self.credentials_data, scopes=scopes
                    )
                    self._client = gspread.authorize(credentials)
                    self._doc = None  # Сбрасываем кэш документа
                    self._worksheets_cache.clear()
                    
                    with self.metrics_lock:
                        self.metrics['connection_resets'] += 1
                        
                return self._client
            except Exception as e:
                logger.error(f"Failed to create Google Sheets client: {e}")
                self._client = None
                raise

    def _get_worksheet(self, sheet_name: str):
        """Получает worksheet с кэшированием"""
        if sheet_name in self._worksheets_cache:
            return self._worksheets_cache[sheet_name]
            
        try:
            if self._doc is None:
                client = self._get_client()
                self._doc = client.open_by_key(self.sheet_id)
                
            worksheet = self._doc.worksheet(sheet_name)
            self._worksheets_cache[sheet_name] = worksheet
            return worksheet
        except Exception as e:
            logger.error(f"Failed to get worksheet {sheet_name}: {e}")
            # Сбрасываем кэш при ошибке
            self._doc = None
            self._worksheets_cache.clear()
            raise

    def _rate_limit_wait(self):
        """Применяет rate limiting"""
        with self.rate_limit_lock:
            current_time = time.time()
            time_since_last = current_time - self.last_request_time
            
            if time_since_last < self.request_interval:
                sleep_time = self.request_interval - time_since_last
                time.sleep(sleep_time)
                
            self.last_request_time = time.time()

    def _calculate_checksum(self, data: Any) -> str:
        """Вычисляет чексумму для данных"""
        try:
            serialized = json.dumps(data, sort_keys=True, ensure_ascii=False)
            return hashlib.sha256(serialized.encode()).hexdigest()[:16]
        except Exception:
            return str(hash(str(data)))[:16]

    def _should_skip_update(self, sheet_name: str, range_name: str, data: Any) -> bool:
        """Проверяет, нужно ли обновлять данные (delta sync)"""
        key = f"{sheet_name}:{range_name}"
        new_checksum = self._calculate_checksum(data)
        
        with self.checksum_lock:
            old_checksum = self.data_checksums.get(key)
            if old_checksum == new_checksum:
                with self.metrics_lock:
                    self.metrics['delta_sync_skips'] += 1
                return True
            else:
                self.data_checksums[key] = new_checksum
                return False

    def read_range(self, sheet_name: str, range_name: str, use_cache: bool = True) -> Optional[List[List]]:
        """Читает диапазон из Google Sheets"""
        try:
            self._rate_limit_wait()
            
            worksheet = self._get_worksheet(sheet_name)
            values = worksheet.get(range_name)
            
            with self.metrics_lock:
                self.metrics['requests_total'] += 1
                self.metrics['requests_successful'] += 1
                
            # Обновляем чексумму для delta sync
            if use_cache:
                key = f"{sheet_name}:{range_name}"
                checksum = self._calculate_checksum(values)
                with self.checksum_lock:
                    self.data_checksums[key] = checksum
                    
            return values
            
        except Exception as e:
            logger.error(f"Failed to read {sheet_name}:{range_name}: {e}")
            with self.metrics_lock:
                self.metrics['requests_failed'] += 1
                self.metrics['last_error'] = str(e)
                
            # Проверяем на rate limit
            if 'RESOURCE_EXHAUSTED' in str(e) or '429' in str(e):
                with self.metrics_lock:
                    self.metrics['rate_limit_hits'] += 1
                # Экспоненциальная задержка
                time.sleep(min(60, 2 ** self.metrics['rate_limit_hits']))
                
            return None

    def write_range(self, sheet_name: str, range_name: str, values: List[List], 
                   use_delta: bool = True, priority: int = 1) -> bool:
        """Записывает данные в Google Sheets (через очередь для batch processing)"""
        
        # Delta sync - пропускаем, если данные не изменились
        if use_delta and self._should_skip_update(sheet_name, range_name, values):
            return True
            
        operation = SheetOperation(
            operation_type='write',
            sheet_name=sheet_name,
            range_name=range_name,
            data=values,
            priority=priority
        )
        
        self.operation_queue.put((priority, time.time(), operation))
        return True

    def batch_write(self, operations: List[Tuple[str, str, List[List]]], priority: int = 2) -> bool:
        """Пакетная запись для нескольких диапазонов"""
        operation = SheetOperation(
            operation_type='batch_write',
            sheet_name='',  # Не используется для batch
            range_name='',
            data=operations,
            priority=priority
        )
        
        self.operation_queue.put((priority, time.time(), operation))
        return True

    def _execute_write_operation(self, operation: SheetOperation) -> bool:
        """Выполняет операцию записи"""
        try:
            self._rate_limit_wait()
            
            if operation.operation_type == 'write':
                worksheet = self._get_worksheet(operation.sheet_name)
                worksheet.update(operation.range_name, operation.data)
                
            elif operation.operation_type == 'batch_write':
                # Группируем операции по worksheet для batch API
                worksheets_data = {}
                for sheet_name, range_name, values in operation.data:
                    if sheet_name not in worksheets_data:
                        worksheets_data[sheet_name] = []
                    worksheets_data[sheet_name].append((range_name, values))
                
                # Выполняем batch update для каждого worksheet
                for sheet_name, ranges_data in worksheets_data.items():
                    worksheet = self._get_worksheet(sheet_name)
                    if len(ranges_data) == 1:
                        range_name, values = ranges_data[0]
                        worksheet.update(range_name, values)
                    else:
                        # Используем batch_update для множественных диапазонов
                        updates = []
                        for range_name, values in ranges_data:
                            updates.append({
                                'range': range_name,
                                'values': values
                            })
                        worksheet.batch_update(updates)
                        
                with self.metrics_lock:
                    self.metrics['batch_operations'] += 1
            
            with self.metrics_lock:
                self.metrics['requests_total'] += 1
                self.metrics['requests_successful'] += 1
                
            return True
            
        except Exception as e:
            logger.error(f"Failed to execute write operation: {e}")
            with self.metrics_lock:
                self.metrics['requests_failed'] += 1
                self.metrics['last_error'] = str(e)
                
            if 'RESOURCE_EXHAUSTED' in str(e) or '429' in str(e):
                with self.metrics_lock:
                    self.metrics['rate_limit_hits'] += 1
                time.sleep(min(60, 2 ** self.metrics['rate_limit_hits']))
                
            return False

    def _start_batch_processor(self):
        """Запускает фоновый процессор для batch операций"""
        def processor():
            batch = []
            last_batch_time = time.time()
            
            while True:
                try:
                    # Ожидаем операции с таймаутом
                    try:
                        priority, timestamp, operation = self.operation_queue.get(timeout=1.0)
                        batch.append(operation)
                    except queue.Empty:
                        operation = None
                    
                    current_time = time.time()
                    should_process = (
                        len(batch) >= self.batch_size or
                        (batch and current_time - last_batch_time >= self.batch_timeout)
                    )
                    
                    if should_process and batch:
                        # Группируем операции по типу для оптимизации
                        write_ops = []
                        batch_write_ops = []
                        
                        for op in batch:
                            if op.operation_type == 'write':
                                write_ops.append((op.sheet_name, op.range_name, op.data))
                            elif op.operation_type == 'batch_write':
                                batch_write_ops.extend(op.data)
                        
                        # Выполняем операции
                        if write_ops:
                            batch_op = SheetOperation(
                                operation_type='batch_write',
                                sheet_name='',
                                range_name='',
                                data=write_ops
                            )
                            self._execute_write_operation(batch_op)
                            
                        for batch_data in batch_write_ops:
                            batch_op = SheetOperation(
                                operation_type='batch_write',
                                sheet_name='',
                                range_name='',
                                data=[batch_data]
                            )
                            self._execute_write_operation(batch_op)
                        
                        batch.clear()
                        last_batch_time = current_time
                        
                except Exception as e:
                    logger.error(f"Batch processor error: {e}")
                    batch.clear()
                    
        self.batch_processor_thread = threading.Thread(target=processor, daemon=True)
        self.batch_processor_thread.start()

    def get_metrics(self) -> Dict:
        """Возвращает метрики производительности"""
        with self.metrics_lock:
            return dict(self.metrics)

    def reset_connection(self):
        """Сбрасывает соединение с Google Sheets"""
        with self.connection_lock:
            self._client = None
            self._doc = None
            self._worksheets_cache.clear()

    def cleanup(self):
        """Очищает ресурсы"""
        self.reset_connection()
        with self.checksum_lock:
            self.data_checksums.clear()

# Singleton manager
_sheets_manager = None

def get_sheets_manager() -> OptimizedSheetsManager:
    """Возвращает singleton instance менеджера"""
    global _sheets_manager
    if _sheets_manager is None:
        import os
        
        credentials_raw = os.environ.get('GOOGLE_SHEETS_CREDENTIALS', '')
        sheet_id = os.environ.get('SHEET_ID', '')
        
        if not credentials_raw or not sheet_id:
            raise ValueError("Google Sheets credentials or sheet ID not configured")
            
        credentials_data = json.loads(credentials_raw)
        max_qps = float(os.environ.get('SHEETS_MAX_QPS', '8.0'))  # Консервативный лимит
        
        _sheets_manager = OptimizedSheetsManager(credentials_data, sheet_id, max_qps)
        
    return _sheets_manager
