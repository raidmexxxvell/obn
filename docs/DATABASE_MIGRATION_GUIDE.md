# Liga Obninska - Новая система БД

## Обзор изменений

Система полностью переработана для использования PostgreSQL вместо Google Sheets для операционных данных. Google Sheets теперь используется только для импорта расписания матчей.

## Архитектура новой системы

### База данных (PostgreSQL)
- **tournaments** - турниры/сезоны
- **teams** - команды с логотипами
- **players** - игроки с Telegram ID
- **matches** - матчи с счетом и статусом
- **team_compositions** - составы команд на матчи
- **match_events** - события матчей (голы, передачи, карточки)
- **player_statistics** - автоматически обновляемая статистика

### API endpoints
- `GET /api/tournaments` - список турниров
- `GET /api/teams` - список команд
- `GET /api/players` - список игроков
- `GET /api/matches` - список матчей с фильтрацией
- `POST /api/match/{id}/score` - обновление счета (админ)
- `POST /api/match/{id}/event` - добавление события (админ)
- `GET /api/match/{id}/events` - события матча
- `GET /api/tournament/{id}/rankings` - рейтинг игроков
- `GET /api/match/{id}/composition/{team_id}` - состав команды

### Админ панель
- URL: `/admin`
- Управление счетом матчей в реальном времени
- Добавление событий матча (голы, передачи, карточки)
- Создание новых игроков
- Пересчет статистики

## Установка и настройка

### 1. Переменные окружения

Добавьте в ваш `.env` файл:

```bash
# Database (PostgreSQL from render.com)
DATABASE_URL=postgresql://username:password@hostname:port/database

# Инициализация таблиц БД (только при первом запуске)
INIT_DATABASE_TABLES=1

# Google Sheets (только для импорта расписания)
GOOGLE_SHEETS_CREDS_JSON={"type":"service_account",...}
GOOGLE_SHEET_URL=https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID
```

### 2. Установка зависимостей

```bash
pip install -r requirements.txt
```

### 3. Инициализация базы данных

```bash
# Создание таблиц и импорт расписания из Google Sheets
python init_database.py
```

### 4. Запуск приложения

```bash
python app.py
```

## Использование

### Администратор

1. Откройте `/admin` для управления матчами
2. Выберите матч из списка
3. Обновляйте счет в реальном времени
4. Добавляйте события матча:
   - ⚽ Голы (автоматически обновляет счет)
   - 🅰️ Передачи (с указанием автора передачи)
   - 🟨 Желтые карточки
   - 🟥 Красные карточки

### Статистика игроков

Статистика обновляется автоматически при добавлении событий:
- **Сортировка**: голы + передачи → меньше матчей → больше голов
- **Автоматический расчет**: ранги, общие очки
- **Real-time обновления**: через WebSocket

### Составы команд

- Добавление игроков в состав через админ панель
- Указание позиций: основной состав, запасные, скамейка
- Номера игроков, капитаны

## Структура файлов

```
├── database_schema.sql          # SQL схема PostgreSQL
├── database_models.py           # SQLAlchemy модели
├── database_api.py             # API endpoints для БД
├── init_database.py            # Скрипт инициализации
├── static/js/database-client.js # JavaScript клиент
├── static/css/database-ui.css   # Стили для UI
├── templates/admin_dashboard.html # Админ панель
└── app.py                      # Основное приложение (обновлено)
```

## Миграция данных

### Что мигрируется из Google Sheets:
- ✅ Расписание матчей (дата, время, команды, место)

### Что НЕ мигрируется (создается пустым):
- ❌ Статистика игроков (будет заполняться из событий матчей)
- ❌ Составы команд (добавляются через админ панель)
- ❌ События матчей (добавляются через админ панель)

## Real-time обновления

Система поддерживает WebSocket для мгновенных обновлений:
- Изменения счета матчей
- Новые события матчей  
- Обновления статистики
- Уведомления в админ панели

## Производительность

### Кэширование
- Многоуровневый кэш (память + Redis + БД)
- TTL для разных типов данных
- Умная инвалидация при изменениях

### База данных
- Индексы для быстрых запросов
- Connection pooling
- Автоматические триггеры для статистики

### API
- Пагинация для больших списков
- Фильтрация и сортировка
- Gzip сжатие ответов

## Отладка

### Логи приложения
```bash
# Проверка подключения к БД
[INFO] New database system initialized
[INFO] Database API registered successfully

# Ошибки подключения
[ERROR] Failed to register database API: ...
```

### Проверка таблиц БД
```sql
-- Подключитесь к PostgreSQL и выполните:
\dt  -- список таблиц
SELECT * FROM tournaments;
SELECT * FROM teams;
SELECT * FROM matches LIMIT 5;
```

### Тестирование API
```bash
# Получить список команд
curl http://localhost:5000/api/teams

# Получить матчи
curl http://localhost:5000/api/matches

# Получить рейтинг (замените 1 на ID турнира)
curl http://localhost:5000/api/tournament/1/rankings
```

## Развертывание на Render.com

1. **Настройте PostgreSQL**:
   - Создайте PostgreSQL database на Render
   - Скопируйте DATABASE_URL

2. **Переменные окружения**:
   ```
   DATABASE_URL=postgresql://...
   INIT_DATABASE_TABLES=1
   GOOGLE_SHEETS_CREDS_JSON=...
   GOOGLE_SHEET_URL=...
   ```

3. **Deploy команды**:
   ```bash
   # Build
   pip install -r requirements.txt
   
   # Start (добавьте в render.yaml)
   python init_database.py && python app.py
   ```

## Поддержка и обслуживание

### Регулярные задачи
- Пересчет статистики: `/api/statistics/refresh` (POST)
- Очистка старых кэшей: автоматически
- Бэкап БД: через Render dashboard

### Мониторинг
- Админ панель: `/admin`
- Статистика пользователей: существующие endpoints
- Логи: через Render dashboard

## Troubleshooting

### База данных не подключается
1. Проверьте DATABASE_URL
2. Убедитесь что PostgreSQL запущен на Render
3. Проверьте сетевые настройки

### Админ панель не работает
1. Убедитесь что пользователь имеет админские права
2. Проверьте JavaScript консоль браузера
3. Проверьте API endpoints в Network tab

### Статистика не обновляется
1. Вызовите `/api/statistics/refresh`
2. Проверьте triggers в БД
3. Добавьте события матчей заново

### Google Sheets не импортируется
1. Проверьте GOOGLE_SHEETS_CREDS_JSON
2. Проверьте права доступа к таблице
3. Убедитесь в правильности формата данных

---

**Готово!** Новая система БД полностью заменяет Google Sheets для операционных данных, оставляя только импорт расписания матчей. Все остальное управляется через PostgreSQL и админ панель.
