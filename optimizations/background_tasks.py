"""
Система асинхронных фоновых задач с приоритизацией
Выносит тяжелые операции из основного потока запросов
"""
import threading
import queue
import time
import logging
from typing import Callable, Any, Dict, Optional, List
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import IntEnum
import json
import traceback

logger = logging.getLogger(__name__)

class TaskPriority(IntEnum):
    """Приоритеты задач (чем меньше число, тем выше приоритет)"""
    CRITICAL = 1      # Критичные задачи (обновление счета матча)
    HIGH = 2          # Высокий приоритет (синхронизация таблицы лиги)
    NORMAL = 3        # Обычный приоритет (обновление статистики)
    LOW = 4           # Низкий приоритет (предварительные вычисления)
    BACKGROUND = 5    # Фоновые задачи (очистка, архивирование)

@dataclass
class BackgroundTask:
    """Фоновая задача"""
    task_id: str
    priority: TaskPriority
    func: Callable
    args: tuple = field(default_factory=tuple)
    kwargs: dict = field(default_factory=dict)
    retry_count: int = 0
    max_retries: int = 3
    retry_delay: float = 1.0
    timeout: Optional[float] = None
    callback: Optional[Callable] = None
    created_at: float = field(default_factory=time.time)
    scheduled_at: Optional[float] = None  # Для отложенных задач
    
    def __lt__(self, other):
        """Сравнение для priority queue"""
        if self.priority != other.priority:
            return self.priority < other.priority
        return self.created_at < other.created_at

class BackgroundTaskManager:
    """Менеджер фоновых задач"""
    
    def __init__(self, num_workers: int = 3, queue_maxsize: int = 1000):
        self.num_workers = num_workers
        self.task_queue = queue.PriorityQueue(maxsize=queue_maxsize)
        self.delayed_queue = queue.Queue()
        self.workers = []
        self.running = False
        self.stats = {
            'tasks_completed': 0,
            'tasks_failed': 0,
            'tasks_retried': 0,
            'queue_size': 0,
            'workers_busy': 0,
            'last_error': '',
            'start_time': None
        }
        self.stats_lock = threading.Lock()
        self.active_tasks = {}  # task_id -> worker_info
        self.task_history = []  # Последние 100 задач для анализа
        self.shutdown_event = threading.Event()
        
        # Callbacks для мониторинга
        self.on_task_complete = None
        self.on_task_error = None

    def start(self):
        """Запускает менеджер задач"""
        if self.running:
            return
            
        self.running = True
        self.shutdown_event.clear()
        
        with self.stats_lock:
            self.stats['start_time'] = time.time()
        
        # Запускаем worker threads
        for i in range(self.num_workers):
            worker = threading.Thread(
                target=self._worker_loop,
                name=f"TaskWorker-{i}",
                daemon=True
            )
            worker.start()
            self.workers.append(worker)
        
        # Запускаем scheduler для отложенных задач
        scheduler = threading.Thread(
            target=self._scheduler_loop,
            name="TaskScheduler",
            daemon=True
        )
        scheduler.start()
        
        logger.info(f"Background task manager started with {self.num_workers} workers")

    def stop(self, timeout: float = 30.0):
        """Останавливает менеджер задач"""
        if not self.running:
            return
            
        logger.info("Stopping background task manager...")
        self.running = False
        self.shutdown_event.set()
        
        # Ждем завершения всех worker threads
        for worker in self.workers:
            worker.join(timeout=timeout)
        
        logger.info("Background task manager stopped")

    def submit_task(self, task_id: str, func: Callable, *args, 
                   priority: TaskPriority = TaskPriority.NORMAL,
                   max_retries: int = 3, timeout: Optional[float] = None,
                   delay: float = 0.0, callback: Optional[Callable] = None,
                   **kwargs) -> bool:
        """
        Добавляет задачу в очередь
        
        Args:
            task_id: Уникальный идентификатор задачи
            func: Функция для выполнения
            priority: Приоритет задачи
            max_retries: Максимальное количество повторов
            timeout: Таймаут выполнения
            delay: Задержка перед выполнением (секунды)
            callback: Функция обратного вызова
        """
        try:
            task = BackgroundTask(
                task_id=task_id,
                priority=priority,
                func=func,
                args=args,
                kwargs=kwargs,
                max_retries=max_retries,
                timeout=timeout,
                callback=callback,
                scheduled_at=time.time() + delay if delay > 0 else None
            )
            
            if delay > 0:
                # Отложенная задача
                self.delayed_queue.put(task)
            else:
                # Немедленное выполнение
                self.task_queue.put((task.priority, task.created_at, task))
                
            with self.stats_lock:
                self.stats['queue_size'] = self.task_queue.qsize()
                
            return True
            
        except queue.Full:
            logger.warning(f"Task queue is full, dropping task {task_id}")
            return False
        except Exception as e:
            logger.error(f"Failed to submit task {task_id}: {e}")
            return False

    def submit_critical_task(self, task_id: str, func: Callable, *args, **kwargs) -> bool:
        """Быстрый доступ для критичных задач"""
        return self.submit_task(task_id, func, *args, priority=TaskPriority.CRITICAL, **kwargs)

    def submit_background_task(self, task_id: str, func: Callable, *args, **kwargs) -> bool:
        """Быстрый доступ для фоновых задач"""
        return self.submit_task(task_id, func, *args, priority=TaskPriority.BACKGROUND, **kwargs)

    def _worker_loop(self):
        """Основной цикл worker thread"""
        worker_name = threading.current_thread().name
        
        while self.running:
            try:
                # Получаем задачу с таймаутом
                try:
                    priority, created_at, task = self.task_queue.get(timeout=1.0)
                except queue.Empty:
                    continue
                
                # Отмечаем worker как занятый
                with self.stats_lock:
                    self.stats['workers_busy'] += 1
                    self.active_tasks[task.task_id] = {
                        'worker': worker_name,
                        'started_at': time.time(),
                        'task': task
                    }
                
                try:
                    self._execute_task(task)
                finally:
                    # Освобождаем worker
                    with self.stats_lock:
                        self.stats['workers_busy'] -= 1
                        self.active_tasks.pop(task.task_id, None)
                        self.stats['queue_size'] = self.task_queue.qsize()
                    
                    self.task_queue.task_done()
                    
            except Exception as e:
                logger.error(f"Worker {worker_name} error: {e}")

    def _scheduler_loop(self):
        """Цикл планировщика для отложенных задач"""
        while self.running:
            try:
                # Проверяем отложенные задачи
                current_time = time.time()
                ready_tasks = []
                remaining_tasks = []
                
                # Выбираем готовые задачи
                while not self.delayed_queue.empty():
                    try:
                        task = self.delayed_queue.get_nowait()
                        if task.scheduled_at and task.scheduled_at <= current_time:
                            ready_tasks.append(task)
                        else:
                            remaining_tasks.append(task)
                    except queue.Empty:
                        break
                
                # Возвращаем неготовые задачи в очередь
                for task in remaining_tasks:
                    self.delayed_queue.put(task)
                
                # Добавляем готовые задачи в основную очередь
                for task in ready_tasks:
                    try:
                        self.task_queue.put((task.priority, task.created_at, task))
                    except queue.Full:
                        logger.warning(f"Main queue full, dropping delayed task {task.task_id}")
                
                time.sleep(0.5)  # Проверяем каждые 0.5 секунд
                
            except Exception as e:
                logger.error(f"Scheduler error: {e}")

    def _execute_task(self, task: BackgroundTask):
        """Выполняет задачу"""
        start_time = time.time()
        error = None
        
        try:
            # Устанавливаем таймаут, если указан
            if task.timeout:
                import signal
                
                def timeout_handler(signum, frame):
                    raise TimeoutError(f"Task {task.task_id} timed out after {task.timeout}s")
                
                signal.signal(signal.SIGALRM, timeout_handler)
                signal.alarm(int(task.timeout))
            
            # Выполняем задачу
            result = task.func(*task.args, **task.kwargs)
            
            # Отключаем таймаут
            if task.timeout:
                signal.alarm(0)
            
            # Вызываем callback при успехе
            if task.callback:
                try:
                    task.callback(task.task_id, result, None)
                except Exception as e:
                    logger.warning(f"Task callback error for {task.task_id}: {e}")
            
            # Обновляем статистику
            with self.stats_lock:
                self.stats['tasks_completed'] += 1
            
            # Добавляем в историю
            self._add_to_history(task, 'completed', time.time() - start_time)
            
            if self.on_task_complete:
                self.on_task_complete(task, result)
                
            logger.debug(f"Task {task.task_id} completed in {time.time() - start_time:.2f}s")
            
        except Exception as e:
            error = e
            
            # Отключаем таймаут при ошибке
            if task.timeout:
                try:
                    import signal
                    signal.alarm(0)
                except:
                    pass
            
            # Логируем ошибку
            logger.error(f"Task {task.task_id} failed: {e}\n{traceback.format_exc()}")
            
            # Обновляем статистику
            with self.stats_lock:
                self.stats['tasks_failed'] += 1
                self.stats['last_error'] = str(e)
            
            # Пробуем повторить задачу
            if task.retry_count < task.max_retries:
                task.retry_count += 1
                retry_delay = task.retry_delay * (2 ** (task.retry_count - 1))  # Экспоненциальная задержка
                
                logger.info(f"Retrying task {task.task_id} in {retry_delay}s (attempt {task.retry_count}/{task.max_retries})")
                
                # Добавляем в очередь с задержкой
                task.scheduled_at = time.time() + retry_delay
                self.delayed_queue.put(task)
                
                with self.stats_lock:
                    self.stats['tasks_retried'] += 1
            else:
                # Исчерпали попытки, вызываем callback с ошибкой
                if task.callback:
                    try:
                        task.callback(task.task_id, None, error)
                    except Exception as e:
                        logger.warning(f"Task error callback failed for {task.task_id}: {e}")
                
                # Добавляем в историю
                self._add_to_history(task, 'failed', time.time() - start_time, error)
                
                if self.on_task_error:
                    self.on_task_error(task, error)

    def _add_to_history(self, task: BackgroundTask, status: str, duration: float, error: Exception = None):
        """Добавляет запись в историю выполнения"""
        record = {
            'task_id': task.task_id,
            'priority': task.priority.name,
            'status': status,
            'duration': duration,
            'completed_at': time.time(),
            'retry_count': task.retry_count,
            'error': str(error) if error else None
        }
        
        self.task_history.append(record)
        
        # Ограничиваем размер истории
        if len(self.task_history) > 100:
            self.task_history.pop(0)

    def get_stats(self) -> Dict:
        """Возвращает статистику менеджера"""
        with self.stats_lock:
            stats = dict(self.stats)
            stats['queue_size'] = self.task_queue.qsize()
            stats['delayed_queue_size'] = self.delayed_queue.qsize()
            stats['active_tasks_count'] = len(self.active_tasks)
            stats['running'] = self.running
            
            if stats['start_time']:
                stats['uptime'] = time.time() - stats['start_time']
            
        return stats

    def get_active_tasks(self) -> Dict:
        """Возвращает список активных задач"""
        with self.stats_lock:
            return dict(self.active_tasks)

    def get_task_history(self) -> List[Dict]:
        """Возвращает историю выполнения задач"""
        return list(self.task_history)

    def cancel_task(self, task_id: str) -> bool:
        """Отменяет задачу (если она еще не выполняется)"""
        # TODO: Реализовать отмену задач в очереди
        logger.warning(f"Task cancellation not implemented for {task_id}")
        return False

# Singleton instance
_task_manager = None

def get_task_manager() -> BackgroundTaskManager:
    """Возвращает singleton instance менеджера задач"""
    global _task_manager
    if _task_manager is None:
        import os
        num_workers = int(os.environ.get('BACKGROUND_WORKERS', '3'))
        queue_maxsize = int(os.environ.get('TASK_QUEUE_SIZE', '1000'))
        
        _task_manager = BackgroundTaskManager(num_workers, queue_maxsize)
        _task_manager.start()
        
    return _task_manager

# Utility decorators
def background_task(priority: TaskPriority = TaskPriority.NORMAL, max_retries: int = 3):
    """Декоратор для автоматического выполнения функции в фоне"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            task_manager = get_task_manager()
            task_id = f"{func.__name__}_{int(time.time() * 1000)}"
            return task_manager.submit_task(task_id, func, *args, priority=priority, max_retries=max_retries, **kwargs)
        return wrapper
    return decorator
