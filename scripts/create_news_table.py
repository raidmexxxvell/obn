#!/usr/bin/env python3
"""
Скрипт для создания таблицы news в базе данных
"""

import sys
import os

# Добавляем родительскую директорию в path
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def create_news_table():
    """Создает таблицу news если она не существует"""
    # Импорт после добавления в path
    from database.database_models import db_manager, News, Base
    from sqlalchemy import text
    
    if not db_manager or not db_manager.SessionLocal:
        print('❌ База данных недоступна. Убедитесь, что DATABASE_URL настроен.')
        return False
        
    try:
        db = db_manager.get_session()
        
        # Создаем все таблицы, определенные в Base
        print('🔄 Создание таблиц...')
        Base.metadata.create_all(bind=db.bind)
        print('✅ Таблицы созданы/обновлены успешно')
        
        # Проверяем, есть ли новости
        news_count = db.query(News).count()
        
        if news_count == 0:
            # Добавляем тестовую новость
            test_news = News(
                title='Добро пожаловать в админ панель!',
                content='Это первая новость в системе управления лигой. Здесь вы можете публиковать объявления, результаты матчей и другую информацию для участников лиги.',
                author_id=1
            )
            db.add(test_news)
            db.commit()
            print('✅ Добавлена тестовая новость')
        else:
            print(f'ℹ️ В базе уже есть {news_count} новостей')
                
        db.close()
        return True
        
    except Exception as e:
        print(f'❌ Ошибка при создании таблицы: {e}')
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    create_news_table()
