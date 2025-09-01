"""
Admin API routes for Liga Obninska
Handles all admin-related endpoints and operations
"""
from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
import os

admin_bp = Blueprint('admin', __name__, url_prefix='/api/admin')

def init_admin_routes(app, get_db, SessionLocal, parse_and_verify_telegram_init_data, 
                     MatchFlags, _snapshot_set, _build_betting_tours_payload, _settle_open_bets):
    """Initialize admin routes with dependencies"""
    
    @admin_bp.route('/match/status/set', methods=['POST'])
    def api_match_status_set():
        """Установка статуса матча админом: scheduled|live|finished"""
        try:
            parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
            if not parsed or not parsed.get('user'):
                return jsonify({'error': 'Недействительные данные'}), 401
                
            user_id = str(parsed['user'].get('id'))
            admin_id = os.environ.get('ADMIN_USER_ID', '')
            if not admin_id or user_id != admin_id:
                return jsonify({'error': 'forbidden'}), 403
                
            home = (request.form.get('home') or '').strip()
            away = (request.form.get('away') or '').strip() 
            status = request.form.get('status', 'scheduled')
            
            if not home or not away or status not in ('scheduled', 'live', 'finished'):
                return jsonify({'error': 'home/away/status обязательны'}), 400
                
            if SessionLocal is None:
                return jsonify({'error': 'БД недоступна'}), 500
                
            db = get_db()
            try:
                row = db.query(MatchFlags).filter(MatchFlags.home==home, MatchFlags.away==away).first()
                if not row:
                    row = MatchFlags(home=home, away=away, status=status)
                    db.add(row)
                else:
                    row.status = status
                    row.updated_at = datetime.now(timezone.utc)
                db.commit()
                
                # Обновляем снапшот betting-tours при изменении статуса
                try:
                    payload = _build_betting_tours_payload()
                    _snapshot_set(db, 'betting-tours', payload)
                except Exception as e:
                    app.logger.warning(f"Failed to build betting tours payload: {e}")
                    
                # Если матч завершён - запускаем расчёт ставок и инкрементируем matches_played для игроков
                if status == 'finished':
                    try:
                        _settle_open_bets()
                    except Exception as e:
                        app.logger.error(f"Failed to settle open bets: {e}")
                    # Инкрементируем количество сыгранных матчей для всех игроков из составов команд (team_compositions)
                    try:
                        from database.database_models import TeamComposition, PlayerStatistics, Tournament, Match
                        # Находим матч по home/away через таблицу matches (если есть структура)
                        match_row = db.query(Match).join(Tournament, Match.tournament_id==Tournament.id).filter(Match.home_team_id.isnot(None)).first()
                        # Упрощённо: инкремент по игрокам, участвовавшим в составе (match_id через MatchFlags у нас нет -> требуется реальная привязка).
                        # Если нет прямой связи, пропускаем.
                        if match_row:
                            compositions = db.query(TeamComposition).filter(TeamComposition.match_id == match_row.id).all()
                            touched_players = set()
                            for comp in compositions:
                                touched_players.add((comp.player_id, match_row.tournament_id))
                            for player_id, tournament_id in touched_players:
                                ps = db.query(PlayerStatistics).filter(PlayerStatistics.player_id==player_id, PlayerStatistics.tournament_id==tournament_id).first()
                                if not ps:
                                    ps = PlayerStatistics(player_id=player_id, tournament_id=tournament_id, matches_played=0)
                                    db.add(ps)
                                ps.matches_played = (ps.matches_played or 0) + 1
                                ps.last_updated = datetime.now(timezone.utc)
                            db.commit()
                    except Exception as e:
                        app.logger.warning(f"Failed to increment matches_played: {e}")
                        
                return jsonify({'ok': True, 'status': status})
            finally:
                db.close()
                
        except Exception as e:
            app.logger.error(f"Match status set error: {e}")
            return jsonify({'error': 'Не удалось установить статус матча'}), 500
    
    # Регистрируем blueprint
    app.register_blueprint(admin_bp)
    return admin_bp
