"""
API endpoints for Liga Obninska database operations
Replaces Google Sheets functionality with PostgreSQL database
"""

from flask import Blueprint, request, jsonify, session
from flask import current_app
from .database_models import db_ops, db_manager, Tournament, Team, Player, Match, MatchEvent, TeamComposition, PlayerStatistics
from sqlalchemy import text
from datetime import datetime, timedelta
import logging

# Create blueprint for database API
db_api = Blueprint('db_api', __name__)

logger = logging.getLogger(__name__)

@db_api.route('/api/tournaments', methods=['GET'])
def get_tournaments():
    """Получить список турниров"""
    try:
        with db_manager.get_session() as session:
            tournaments = session.query(Tournament).filter(Tournament.status == 'active').all()
            result = []
            for tournament in tournaments:
                result.append({
                    'id': tournament.id,
                    'name': tournament.name,
                    'season': tournament.season,
                    'status': tournament.status,
                    'start_date': tournament.start_date.isoformat() if tournament.start_date else None,
                    'description': tournament.description
                })
            return jsonify({'tournaments': result})
    except Exception as e:
        logger.error(f"Error getting tournaments: {e}")
        return jsonify({'error': 'Ошибка получения турниров'}), 500

@db_api.route('/api/teams', methods=['GET'])
def get_teams():
    """Получить список команд"""
    try:
        with db_manager.get_session() as session:
            teams = session.query(Team).filter(Team.is_active == True).all()
            result = []
            for team in teams:
                result.append({
                    'id': team.id,
                    'name': team.name,
                    'logo_url': team.logo_url,
                    'description': team.description,
                    'city': team.city
                })
            return jsonify({'teams': result})
    except Exception as e:
        logger.error(f"Error getting teams: {e}")
        return jsonify({'error': 'Ошибка получения команд'}), 500

@db_api.route('/api/players', methods=['GET'])
def get_players():
    """Получить список игроков"""
    try:
        team_id = request.args.get('team_id', type=int)
        
        with db_manager.get_session() as session:
            query = session.query(Player).filter(Player.is_active == True)
            
            players = query.all()
            result = []
            for player in players:
                result.append({
                    'id': player.id,
                    'telegram_id': player.telegram_id,
                    'first_name': player.first_name,
                    'last_name': player.last_name,
                    'username': player.username,
                    'position': player.position,
                    'full_name': f"{player.first_name} {player.last_name or ''}".strip()
                })
            return jsonify({'players': result})
    except Exception as e:
        logger.error(f"Error getting players: {e}")
        return jsonify({'error': 'Ошибка получения игроков'}), 500

@db_api.route('/api/matches', methods=['GET'])
def get_matches():
    """Получить список матчей"""
    try:
        tournament_id = request.args.get('tournament_id', type=int)
        status = request.args.get('status')  # scheduled, live, finished
        
        with db_manager.get_session() as session:
            query = session.query(Match).join(Tournament).join(Team, Match.home_team_id == Team.id)
            
            if tournament_id:
                query = query.filter(Match.tournament_id == tournament_id)
            if status:
                query = query.filter(Match.status == status)
            
            matches = query.order_by(Match.match_date.desc()).all()
            result = []
            for match in matches:
                # Получаем названия команд
                home_team = session.query(Team).filter(Team.id == match.home_team_id).first()
                away_team = session.query(Team).filter(Team.id == match.away_team_id).first()
                
                result.append({
                    'id': match.id,
                    'tournament_id': match.tournament_id,
                    'home_team_id': match.home_team_id,
                    'away_team_id': match.away_team_id,
                    'home_team_name': home_team.name if home_team else '',
                    'away_team_name': away_team.name if away_team else '',
                    'home_team_logo': home_team.logo_url if home_team else '',
                    'away_team_logo': away_team.logo_url if away_team else '',
                    'match_date': match.match_date.isoformat(),
                    'venue': match.venue,
                    'home_score': match.home_score,
                    'away_score': match.away_score,
                    'status': match.status,
                    'referee': match.referee
                })
            return jsonify({'matches': result})
    except Exception as e:
        logger.error(f"Error getting matches: {e}")
        return jsonify({'error': 'Ошибка получения матчей'}), 500

@db_api.route('/api/match/<int:match_id>/score', methods=['POST'])
def update_match_score(match_id):
    """Обновить счет матча"""
    try:
        # Проверка админских прав
        if not session.get('is_admin'):
            return jsonify({'error': 'Нет прав доступа'}), 403
        
        data = request.get_json()
        home_score = data.get('home_score', 0)
        away_score = data.get('away_score', 0)
        
        if db_ops.update_match_score(match_id, home_score, away_score):
            
            # Отправить WebSocket уведомление (без прямого импорта)
            try:
                ws = current_app.config.get('websocket_manager')
                if ws:
                    ws.notify_data_change('match_score', {
                        'match_id': match_id,
                        'home_score': home_score,
                        'away_score': away_score,
                        'updated_at': datetime.now().isoformat()
                    })
            except Exception:
                pass
            
            return jsonify({'success': True, 'message': 'Счет обновлен'})
        else:
            return jsonify({'error': 'Матч не найден'}), 404
            
    except Exception as e:
        logger.error(f"Error updating match score: {e}")
        return jsonify({'error': 'Ошибка обновления счета'}), 500

@db_api.route('/api/match/<int:match_id>/event', methods=['POST'])
def add_match_event(match_id):
    """Добавить событие матча (гол, передача, карточка)"""
    try:
        # Проверка админских прав
        if not session.get('is_admin'):
            return jsonify({'error': 'Нет прав доступа'}), 403
        
        data = request.get_json()
        player_id = data.get('player_id')
        team_id = data.get('team_id')
        event_type = data.get('event_type')  # goal, assist, yellow_card, red_card
        minute = data.get('minute')
        additional_time = data.get('additional_time', 0)
        description = data.get('description')
        assisted_by_player_id = data.get('assisted_by_player_id')
        
        if not all([player_id, team_id, event_type, minute is not None]):
            return jsonify({'error': 'Не все обязательные поля заполнены'}), 400
        
        event_id = db_ops.add_match_event(
            match_id, player_id, team_id, event_type, minute,
            additional_time, description, assisted_by_player_id
        )
        
        # Если это гол, обновляем счет матча
        if event_type == 'goal':
            with db_manager.get_session() as session:
                match = session.query(Match).filter(Match.id == match_id).first()
                if match:
                    # Подсчитываем голы
                    home_goals = session.query(MatchEvent).filter(
                        MatchEvent.match_id == match_id,
                        MatchEvent.team_id == match.home_team_id,
                        MatchEvent.event_type == 'goal'
                    ).count()
                    
                    away_goals = session.query(MatchEvent).filter(
                        MatchEvent.match_id == match_id,
                        MatchEvent.team_id == match.away_team_id,
                        MatchEvent.event_type == 'goal'
                    ).count()
                    
                    match.home_score = home_goals
                    match.away_score = away_goals
                    session.commit()
        
        # Отправить WebSocket уведомление
        try:
            ws = current_app.config.get('websocket_manager')
            if ws:
                ws.notify_data_change('match_events', {
                    'event_id': event_id,
                    'event_type': event_type,
                    'player_id': player_id,
                    'team_id': team_id,
                    'minute': minute,
                    'description': description,
                    'updated_at': datetime.now().isoformat()
                })
        except Exception:
            pass
        
        return jsonify({'success': True, 'event_id': event_id})
        
    except Exception as e:
        logger.error(f"Error adding match event: {e}")
        return jsonify({'error': 'Ошибка добавления события'}), 500

@db_api.route('/api/match/<int:match_id>/events', methods=['GET'])
def get_match_events(match_id):
    """Получить события матча"""
    try:
        events = db_ops.get_match_events(match_id)
        result = []
        
        with db_manager.get_session() as session:
            for event in events:
                player = session.query(Player).filter(Player.id == event.player_id).first()
                team = session.query(Team).filter(Team.id == event.team_id).first()
                assisted_by = None
                if event.assisted_by_player_id:
                    assisted_by = session.query(Player).filter(Player.id == event.assisted_by_player_id).first()
                
                result.append({
                    'id': event.id,
                    'event_type': event.event_type,
                    'minute': event.minute,
                    'additional_time': event.additional_time,
                    'description': event.description,
                    'player_name': f"{player.first_name} {player.last_name or ''}".strip() if player else '',
                    'team_name': team.name if team else '',
                    'assisted_by_name': f"{assisted_by.first_name} {assisted_by.last_name or ''}".strip() if assisted_by else None
                })
        
        return jsonify({'events': result})
        
    except Exception as e:
        logger.error(f"Error getting match events: {e}")
        return jsonify({'error': 'Ошибка получения событий матча'}), 500

@db_api.route('/api/tournament/<int:tournament_id>/rankings', methods=['GET'])
def get_player_rankings(tournament_id):
    """Получить рейтинг игроков в турнире"""
    try:
        limit = request.args.get('limit', type=int)
        rankings = db_ops.get_player_rankings(tournament_id, limit)
        return jsonify({'rankings': rankings})
        
    except Exception as e:
        logger.error(f"Error getting player rankings: {e}")
        return jsonify({'error': 'Ошибка получения рейтинга'}), 500

@db_api.route('/api/match/<int:match_id>/composition/<int:team_id>', methods=['GET'])
def get_team_composition(match_id, team_id):
    """Получить состав команды на матч"""
    try:
        composition = db_ops.get_team_composition(match_id, team_id)
        result = []
        
        for comp, first_name, last_name in composition:
            result.append({
                'id': comp.id,
                'player_id': comp.player_id,
                'player_name': f"{first_name} {last_name or ''}".strip(),
                'position': comp.position,
                'jersey_number': comp.jersey_number,
                'is_captain': comp.is_captain,
                'substituted_in_minute': comp.substituted_in_minute,
                'substituted_out_minute': comp.substituted_out_minute,
                'yellow_cards': comp.yellow_cards,
                'red_cards': comp.red_cards
            })
        
        return jsonify({'composition': result})
        
    except Exception as e:
        logger.error(f"Error getting team composition: {e}")
        return jsonify({'error': 'Ошибка получения состава команды'}), 500

@db_api.route('/api/match/<int:match_id>/composition', methods=['POST'])
def add_player_to_composition(match_id):
    """Добавить игрока в состав команды на матч"""
    try:
        # Проверка админских прав
        if not session.get('is_admin'):
            return jsonify({'error': 'Нет прав доступа'}), 403
        
        data = request.get_json()
        team_id = data.get('team_id')
        player_id = data.get('player_id')
        position = data.get('position', 'starting_eleven')  # starting_eleven, substitute, bench
        jersey_number = data.get('jersey_number')
        is_captain = data.get('is_captain', False)
        
        if not all([team_id, player_id, jersey_number]):
            return jsonify({'error': 'Не все обязательные поля заполнены'}), 400
        
        comp_id = db_ops.add_player_to_composition(
            match_id, team_id, player_id, position, jersey_number, is_captain
        )
        
        return jsonify({'success': True, 'composition_id': comp_id})
        
    except Exception as e:
        logger.error(f"Error adding player to composition: {e}")
        return jsonify({'error': 'Ошибка добавления игрока в состав'}), 500

@db_api.route('/api/statistics/refresh', methods=['POST'])
def refresh_statistics():
    """Пересчитать статистику игроков вручную"""
    try:
        # Проверка админских прав
        if not session.get('is_admin'):
            return jsonify({'error': 'Нет прав доступа'}), 403
        
        # Выполняем пересчет статистики через SQL функцию
        with db_manager.get_session() as session:
            # Получаем все уникальные комбинации игрок-турнир из составов
            result = session.execute(text("""
                SELECT DISTINCT tc.player_id, m.tournament_id
                FROM team_compositions tc
                JOIN matches m ON tc.match_id = m.id
            """)).fetchall()
            
            for player_id, tournament_id in result:
                # Вызываем функцию обновления статистики
                session.execute(text("""
                    INSERT INTO player_statistics (
                        player_id, 
                        tournament_id,
                        matches_played,
                        goals_scored,
                        assists,
                        yellow_cards,
                        red_cards
                    )
                    SELECT 
                        :player_id,
                        :tournament_id,
                        COUNT(DISTINCT tc.match_id) as matches_played,
                        COUNT(CASE WHEN me.event_type = 'goal' THEN 1 END) as goals_scored,
                        COUNT(CASE WHEN me.event_type = 'assist' THEN 1 END) as assists,
                        COUNT(CASE WHEN me.event_type = 'yellow_card' THEN 1 END) as yellow_cards,
                        COUNT(CASE WHEN me.event_type = 'red_card' THEN 1 END) as red_cards
                    FROM team_compositions tc
                    JOIN matches m ON tc.match_id = m.id
                    LEFT JOIN match_events me ON :player_id = me.player_id AND m.id = me.match_id
                    WHERE tc.player_id = :player_id AND m.tournament_id = :tournament_id
                    GROUP BY tc.player_id, m.tournament_id
                    ON CONFLICT (player_id, tournament_id) 
                    DO UPDATE SET
                        matches_played = EXCLUDED.matches_played,
                        goals_scored = EXCLUDED.goals_scored,
                        assists = EXCLUDED.assists,
                        yellow_cards = EXCLUDED.yellow_cards,
                        red_cards = EXCLUDED.red_cards,
                        last_updated = CURRENT_TIMESTAMP
                """), {
                    'player_id': player_id,
                    'tournament_id': tournament_id
                })
            
            session.commit()
        
        return jsonify({'success': True, 'message': 'Статистика обновлена'})
        
    except Exception as e:
        logger.error(f"Error refreshing statistics: {e}")
        return jsonify({'error': 'Ошибка обновления статистики'}), 500

@db_api.route('/api/player/create', methods=['POST'])
def create_player():
    """Создать нового игрока"""
    try:
        # Проверка админских прав
        if not session.get('is_admin'):
            return jsonify({'error': 'Нет прав доступа'}), 403
        
        data = request.get_json()
        telegram_id = data.get('telegram_id')
        first_name = data.get('first_name')
        last_name = data.get('last_name')
        username = data.get('username')
        position = data.get('position')
        
        if not first_name:
            return jsonify({'error': 'Имя обязательно для заполнения'}), 400
        
        with db_manager.get_session() as session:
            player = Player(
                telegram_id=telegram_id,
                first_name=first_name,
                last_name=last_name,
                username=username,
                position=position
            )
            session.add(player)
            session.commit()
            
            return jsonify({
                'success': True, 
                'player_id': player.id,
                'message': 'Игрок создан'
            })
        
    except Exception as e:
        logger.error(f"Error creating player: {e}")
        return jsonify({'error': 'Ошибка создания игрока'}), 500

# Error handlers
@db_api.errorhandler(404)
def not_found(error):
    return jsonify({'error': 'Endpoint не найден'}), 404

@db_api.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Внутренняя ошибка сервера'}), 500
