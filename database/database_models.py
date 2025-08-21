"""
Database models and operations for Liga Obninska
Using PostgreSQL database schema
"""

from sqlalchemy import create_engine, Column, Integer, String, DateTime, Boolean, Text, Date, BigInteger, ForeignKey, UniqueConstraint, CheckConstraint, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.sql import func
from datetime import datetime
import os

Base = declarative_base()

class Tournament(Base):
    __tablename__ = 'tournaments'
    
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    season = Column(String(100), nullable=False)
    status = Column(String(50), default='active')  # active, completed, paused
    start_date = Column(Date)
    end_date = Column(Date)
    description = Column(Text)
    created_at = Column(DateTime, default=func.current_timestamp())
    updated_at = Column(DateTime, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    # Relationships
    matches = relationship("Match", back_populates="tournament")
    player_statistics = relationship("PlayerStatistics", back_populates="tournament")

class Team(Base):
    __tablename__ = 'teams'
    
    id = Column(Integer, primary_key=True)
    name = Column(String(255), nullable=False)
    logo_url = Column(String(500))
    description = Column(Text)
    founded_year = Column(Integer)
    city = Column(String(100))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.current_timestamp())
    updated_at = Column(DateTime, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    # Relationships
    home_matches = relationship("Match", foreign_keys="Match.home_team_id", back_populates="home_team")
    away_matches = relationship("Match", foreign_keys="Match.away_team_id", back_populates="away_team")
    team_compositions = relationship("TeamComposition", back_populates="team")
    match_events = relationship("MatchEvent", back_populates="team")

class Player(Base):
    __tablename__ = 'players'
    
    id = Column(Integer, primary_key=True)
    telegram_id = Column(BigInteger, unique=True)
    first_name = Column(String(100), nullable=False)
    last_name = Column(String(100))
    username = Column(String(100))
    position = Column(String(50))  # goalkeeper, defender, midfielder, forward
    birth_date = Column(Date)
    phone = Column(String(20))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=func.current_timestamp())
    updated_at = Column(DateTime, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    # Relationships
    team_compositions = relationship("TeamComposition", back_populates="player")
    match_events = relationship("MatchEvent", back_populates="player")
    player_statistics = relationship("PlayerStatistics", back_populates="player")
    assisted_events = relationship("MatchEvent", foreign_keys="MatchEvent.assisted_by_player_id")

class Match(Base):
    __tablename__ = 'matches'
    
    id = Column(Integer, primary_key=True)
    tournament_id = Column(Integer, ForeignKey('tournaments.id', ondelete='CASCADE'))
    home_team_id = Column(Integer, ForeignKey('teams.id', ondelete='SET NULL'))
    away_team_id = Column(Integer, ForeignKey('teams.id', ondelete='SET NULL'))
    match_date = Column(DateTime, nullable=False)
    venue = Column(String(255))
    home_score = Column(Integer, default=0)
    away_score = Column(Integer, default=0)
    status = Column(String(50), default='scheduled')  # scheduled, live, finished, cancelled, postponed
    referee = Column(String(100))
    duration_minutes = Column(Integer, default=90)
    weather_conditions = Column(String(100))
    attendance = Column(Integer)
    notes = Column(Text)
    created_at = Column(DateTime, default=func.current_timestamp())
    updated_at = Column(DateTime, default=func.current_timestamp(), onupdate=func.current_timestamp())
    
    # Relationships
    tournament = relationship("Tournament", back_populates="matches")
    home_team = relationship("Team", foreign_keys=[home_team_id], back_populates="home_matches")
    away_team = relationship("Team", foreign_keys=[away_team_id], back_populates="away_matches")
    team_compositions = relationship("TeamComposition", back_populates="match")
    match_events = relationship("MatchEvent", back_populates="match")

class TeamComposition(Base):
    __tablename__ = 'team_compositions'
    
    id = Column(Integer, primary_key=True)
    match_id = Column(Integer, ForeignKey('matches.id', ondelete='CASCADE'))
    team_id = Column(Integer, ForeignKey('teams.id', ondelete='CASCADE'))
    player_id = Column(Integer, ForeignKey('players.id', ondelete='CASCADE'))
    position = Column(String(50))  # starting_eleven, substitute, bench
    jersey_number = Column(Integer)
    is_captain = Column(Boolean, default=False)
    substituted_in_minute = Column(Integer)  # когда игрок вышел на замену
    substituted_out_minute = Column(Integer)  # когда игрок был заменен
    yellow_cards = Column(Integer, default=0)
    red_cards = Column(Integer, default=0)
    created_at = Column(DateTime, default=func.current_timestamp())
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('match_id', 'player_id', name='unique_player_per_match'),
        UniqueConstraint('match_id', 'team_id', 'jersey_number', name='unique_jersey_per_team_match'),
    )
    
    # Relationships
    match = relationship("Match", back_populates="team_compositions")
    team = relationship("Team", back_populates="team_compositions")
    player = relationship("Player", back_populates="team_compositions")

class MatchEvent(Base):
    __tablename__ = 'match_events'
    
    id = Column(Integer, primary_key=True)
    match_id = Column(Integer, ForeignKey('matches.id', ondelete='CASCADE'))
    player_id = Column(Integer, ForeignKey('players.id', ondelete='CASCADE'))
    team_id = Column(Integer, ForeignKey('teams.id', ondelete='CASCADE'))
    event_type = Column(String(50), nullable=False)  # goal, assist, yellow_card, red_card, substitution_in, substitution_out
    minute = Column(Integer, nullable=False)
    additional_time = Column(Integer, default=0)  # добавленное время
    description = Column(Text)
    assisted_by_player_id = Column(Integer, ForeignKey('players.id', ondelete='SET NULL'))  # кто сделал передачу на гол
    created_at = Column(DateTime, default=func.current_timestamp())
    
    # Constraints
    __table_args__ = (
        CheckConstraint('minute >= 0 AND minute <= 120', name='check_minute_range'),
        CheckConstraint('additional_time >= 0 AND additional_time <= 15', name='check_additional_time_range'),
    )
    
    # Relationships
    match = relationship("Match", back_populates="match_events")
    player = relationship("Player", foreign_keys=[player_id], back_populates="match_events")
    team = relationship("Team", back_populates="match_events")
    assisted_by = relationship("Player", foreign_keys=[assisted_by_player_id], back_populates="assisted_events")

class PlayerStatistics(Base):
    __tablename__ = 'player_statistics'
    
    id = Column(Integer, primary_key=True)
    player_id = Column(Integer, ForeignKey('players.id', ondelete='CASCADE'))
    tournament_id = Column(Integer, ForeignKey('tournaments.id', ondelete='CASCADE'))
    
    # Основная статистика
    matches_played = Column(Integer, default=0)
    goals_scored = Column(Integer, default=0)
    assists = Column(Integer, default=0)
    yellow_cards = Column(Integer, default=0)
    red_cards = Column(Integer, default=0)
    
    # Время обновления
    last_updated = Column(DateTime, default=func.current_timestamp())
    
    # Constraints
    __table_args__ = (
        UniqueConstraint('player_id', 'tournament_id', name='unique_player_tournament_stats'),
    )
    
    # Relationships
    player = relationship("Player", back_populates="player_statistics")
    tournament = relationship("Tournament", back_populates="player_statistics")
    
    @property
    def total_points(self):
        """Общие очки (голы + передачи)"""
        return (self.goals_scored or 0) + (self.assists or 0)

# Database connection and session management
class DatabaseManager:
    def __init__(self, database_url=None):
        self.database_url = database_url or os.getenv('DATABASE_URL')
        self.engine = None
        self.SessionLocal = None
        self._initialized = False
    
    def _ensure_initialized(self):
        """Ленивая инициализация - подключение только при первом использовании"""
        if self._initialized:
            return
            
        if not self.database_url:
            raise ValueError("DATABASE_URL not configured")
            
        try:
            self.engine = create_engine(self.database_url, 
                                       pool_size=10, 
                                       max_overflow=20, 
                                       pool_pre_ping=True)
            self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)
            self._initialized = True
        except Exception as e:
            raise RuntimeError(f"Failed to initialize database: {e}")
    
    def create_tables(self):
        """Создание всех таблиц"""
        self._ensure_initialized()
        Base.metadata.create_all(bind=self.engine)
    
    def drop_tables(self):
        """Удаление всех таблиц"""
        self._ensure_initialized()
        Base.metadata.drop_all(bind=self.engine)
    
    def get_session(self):
        """Получение сессии БД"""
        self._ensure_initialized()
        return self.SessionLocal()
    
    def execute_sql_file(self, file_path):
        """Выполнение SQL файла"""
        self._ensure_initialized()
        with open(file_path, 'r', encoding='utf-8') as file:
            sql_content = file.read()
        
        with self.engine.connect() as connection:
            # Разбиваем на отдельные команды
            commands = sql_content.split(';')
            for command in commands:
                command = command.strip()
                if command:
                    connection.execute(text(command))
            connection.commit()

# Database operations
class DatabaseOperations:
    def __init__(self, db_manager):
        self.db_manager = db_manager
    
    def get_player_rankings(self, tournament_id, limit=None):
        """
        Получение рейтинга игроков с правильной сортировкой:
        1. По сумме голов + передач (убывание)
        2. По количеству сыгранных матчей (возрастание)
        3. По количеству голов (убывание)
        """
        with self.db_manager.get_session() as session:
            query = session.query(
                PlayerStatistics,
                Player.first_name,
                Player.last_name,
                Player.username
            ).join(Player).filter(
                PlayerStatistics.tournament_id == tournament_id,
                PlayerStatistics.matches_played > 0
            ).order_by(
                (PlayerStatistics.goals_scored + PlayerStatistics.assists).desc(),
                PlayerStatistics.matches_played.asc(),
                PlayerStatistics.goals_scored.desc()
            )
            
            if limit:
                query = query.limit(limit)
            
            results = query.all()
            
            # Добавляем ранг
            rankings = []
            for rank, (stats, first_name, last_name, username) in enumerate(results, 1):
                rankings.append({
                    'rank': rank,
                    'player_id': stats.player_id,
                    'first_name': first_name,
                    'last_name': last_name,
                    'username': username,
                    'matches_played': stats.matches_played,
                    'goals_scored': stats.goals_scored,
                    'assists': stats.assists,
                    'total_points': stats.total_points,
                    'yellow_cards': stats.yellow_cards,
                    'red_cards': stats.red_cards
                })
            
            return rankings
    
    def add_match_event(self, match_id, player_id, team_id, event_type, minute, 
                       additional_time=0, description=None, assisted_by_player_id=None):
        """Добавление события матча"""
        with self.db_manager.get_session() as session:
            event = MatchEvent(
                match_id=match_id,
                player_id=player_id,
                team_id=team_id,
                event_type=event_type,
                minute=minute,
                additional_time=additional_time,
                description=description,
                assisted_by_player_id=assisted_by_player_id
            )
            session.add(event)
            session.commit()
            return event.id
    
    def get_match_events(self, match_id):
        """Получение всех событий матча"""
        with self.db_manager.get_session() as session:
            events = session.query(MatchEvent).filter(
                MatchEvent.match_id == match_id
            ).order_by(MatchEvent.minute, MatchEvent.additional_time).all()
            return events
    
    def update_match_score(self, match_id, home_score, away_score):
        """Обновление счета матча"""
        with self.db_manager.get_session() as session:
            match = session.query(Match).filter(Match.id == match_id).first()
            if match:
                match.home_score = home_score
                match.away_score = away_score
                match.updated_at = func.current_timestamp()
                session.commit()
                return True
            return False
    
    def get_team_composition(self, match_id, team_id):
        """Получение состава команды на матч"""
        with self.db_manager.get_session() as session:
            composition = session.query(
                TeamComposition, Player.first_name, Player.last_name
            ).join(Player).filter(
                TeamComposition.match_id == match_id,
                TeamComposition.team_id == team_id
            ).order_by(
                TeamComposition.position.desc(),  # starting_eleven первые
                TeamComposition.jersey_number
            ).all()
            return composition
    
    def add_player_to_composition(self, match_id, team_id, player_id, position, jersey_number, is_captain=False):
        """Добавление игрока в состав"""
        with self.db_manager.get_session() as session:
            composition = TeamComposition(
                match_id=match_id,
                team_id=team_id,
                player_id=player_id,
                position=position,
                jersey_number=jersey_number,
                is_captain=is_captain
            )
            session.add(composition)
            session.commit()
            return composition.id

# Initialize database manager
db_manager = DatabaseManager()
db_ops = DatabaseOperations(db_manager)

# Export for use in main app
__all__ = [
    'Tournament', 'Team', 'Player', 'Match', 'TeamComposition', 'MatchEvent', 'PlayerStatistics',
    'DatabaseManager', 'DatabaseOperations', 'db_manager', 'db_ops', 'Base'
]
