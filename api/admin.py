"""
Admin API routes for Liga Obninska
Handles all admin-related endpoints and operations
"""
from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
import os
from sqlalchemy import text

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

                if status == 'finished':
                    # Расчёт открытых ставок
                    try:
                        _settle_open_bets()
                    except Exception as e:
                        app.logger.error(f"Failed to settle open bets: {e}")
                    # Корректный пересчёт статистики игроков учаcтвовавших в ИМЕННО этом матче
                    try:
                        from database.database_models import Team, Match, TeamComposition, PlayerStatistics
                        # Точное сопоставление названий с Team
                        home_team = db.query(Team).filter(Team.name==home).first()
                        away_team = db.query(Team).filter(Team.name==away).first()
                        match_obj = None
                        if home_team and away_team:
                            match_obj = db.query(Match).filter(
                                Match.home_team_id==home_team.id,
                                Match.away_team_id==away_team.id
                            ).order_by(Match.match_date.desc()).first()
                        if match_obj:
                            if match_obj.status != 'finished':
                                match_obj.status = 'finished'
                            tournament_id = match_obj.tournament_id
                            player_ids = [pid for (pid,) in db.query(TeamComposition.player_id).filter(TeamComposition.match_id==match_obj.id).all()]
                            for pid in player_ids:
                                # Идемпотентный агрегирующий пересчёт
                                db.execute(text("""
                                    INSERT INTO player_statistics (
                                        player_id, tournament_id, matches_played, goals_scored, assists, yellow_cards, red_cards
                                    )
                                    SELECT
                                        :pid, :tid,
                                        COUNT(DISTINCT tc.match_id) FILTER (WHERE m.status = 'finished') AS matches_played,
                                        COUNT(CASE WHEN me.event_type = 'goal' THEN 1 END) AS goals_scored,
                                        COUNT(CASE WHEN me.event_type = 'assist' THEN 1 END) AS assists,
                                        COUNT(CASE WHEN me.event_type = 'yellow_card' THEN 1 END) AS yellow_cards,
                                        COUNT(CASE WHEN me.event_type = 'red_card' THEN 1 END) AS red_cards
                                    FROM team_compositions tc
                                    JOIN matches m ON tc.match_id = m.id
                                    LEFT JOIN match_events me ON me.player_id = tc.player_id AND me.match_id = m.id
                                    WHERE tc.player_id = :pid AND m.tournament_id = :tid
                                    GROUP BY tc.player_id
                                    ON CONFLICT (player_id, tournament_id) DO UPDATE SET
                                        matches_played = EXCLUDED.matches_played,
                                        goals_scored = EXCLUDED.goals_scored,
                                        assists = EXCLUDED.assists,
                                        yellow_cards = EXCLUDED.yellow_cards,
                                        red_cards = EXCLUDED.red_cards,
                                        last_updated = CURRENT_TIMESTAMP
                                """), {'pid': pid, 'tid': tournament_id})
                            db.commit()
                            # Инвалидация кэша статистики
                            try:
                                from optimizations.multilevel_cache import get_cache
                                get_cache().invalidate('stats_table')
                            except Exception as _inv_err:
                                app.logger.warning(f"stats_table cache invalidate failed: {_inv_err}")
                        else:
                            app.logger.warning(f"Finished status set but Match not resolved for pair {home} vs {away}")
                    except Exception as stats_err:
                        app.logger.error(f"Failed to update matches_played stats: {stats_err}")

                return jsonify({'ok': True, 'status': status})
            finally:
                db.close()
        except Exception as e:
            app.logger.error(f"Match status set error: {e}")
            return jsonify({'error': 'Не удалось установить статус матча'}), 500

    app.register_blueprint(admin_bp)
    return admin_bp
