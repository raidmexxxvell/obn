"""
Admin API routes for Liga Obninska
Handles all admin-related endpoints and operations
"""
from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
import os
from sqlalchemy import text
import hashlib, json, time

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

    @admin_bp.route('/season/rollover', methods=['POST'])
    def api_season_rollover():
        """Завершает активный турнир и создаёт следующий сезон (формат YY-YY).
        Параметры:
          ?dry=1  — только показать, что будет сделано, без изменений
          ?soft=1 — не очищать legacy таблицы, только переключить сезон
        Аудит пишется в season_rollovers."""
        try:
            parsed = parse_and_verify_telegram_init_data(request.form.get('initData', ''))
            if not parsed or not parsed.get('user'):
                return jsonify({'error': 'Недействительные данные'}), 401
            user_id = str(parsed['user'].get('id'))
            admin_id = os.environ.get('ADMIN_USER_ID', '')
            if not admin_id or user_id != admin_id:
                return jsonify({'error': 'forbidden'}), 403

            # Работаем с расширенной схемой (tournaments)
            try:
                from database.database_models import db_manager as adv_db_manager, Tournament
            except Exception as imp_err:
                return jsonify({'error': f'advanced schema unavailable: {imp_err}'}), 500
            try:
                adv_db_manager._ensure_initialized()
            except Exception as init_err:
                return jsonify({'error': f'db init failed: {init_err}'}), 500

            dry_run = request.args.get('dry') in ('1','true','yes')
            soft_mode = request.args.get('soft') in ('1','true','yes')

            adv_sess = adv_db_manager.get_session()
            try:
                # Находим активный турнир (берём самый последний по start_date/created_at)
                active = (adv_sess.query(Tournament)
                          .filter(Tournament.status=='active')
                          .order_by(Tournament.start_date.desc().nullslast(), Tournament.created_at.desc())
                          .first())

                def compute_next(season_str: str|None):
                    import re, datetime as _dt
                    if season_str:
                        m = re.match(r'^(\d{2})[-/](\d{2})$', season_str.strip())
                        if m:
                            a = int(m.group(1)); b = int(m.group(2))
                            return f"{(a+1)%100:02d}-{(b+1)%100:02d}"
                    # fallback: текущий / следующий год
                    now = _dt.date.today()
                    # Сезон начинается с июля: если до июля — считаем прошлый/текущий
                    if now.month >= 7:
                        a = now.year % 100
                        b = (now.year + 1) % 100
                    else:
                        a = (now.year - 1) % 100
                        b = now.year % 100
                    return f"{a:02d}-{b:02d}"

                prev_season = active.season if active else None
                # Если активный найден — завершаем
                from datetime import date
                new_season = compute_next(active.season if active else None)

                # Rate-limit (кроме dry): не чаще одного успешного запуска (soft/full) за 600 сек
                if not dry_run:
                    try:
                        last_row = adv_sess.execute(text("SELECT created_at FROM season_rollovers ORDER BY created_at DESC LIMIT 1"))
                        last_ts = None
                        for r in last_row:
                            last_ts = r[0]
                        if last_ts:
                            # сравнение в секундах
                            from datetime import datetime as _dtm, timezone as _tz
                            now_utc = _dtm.now(_tz.utc)
                            delta = (now_utc - last_ts).total_seconds()
                            if delta < 600:  # 10 минут
                                return jsonify({'error':'rate_limited','retry_after_seconds': int(600-delta)}), 429
                    except Exception as rl_err:
                        app.logger.warning(f"season rollover rate-limit check failed: {rl_err}")

                # Сбор предварительного состояния
                def collect_state_summary():
                    summary = {}
                    try:
                        # tournaments
                        t_total = adv_sess.execute(text('SELECT COUNT(*) FROM tournaments')).scalar() or 0
                        t_active = adv_sess.execute(text("SELECT COUNT(*) FROM tournaments WHERE status='active'" )).scalar() or 0
                        last_season_row = adv_sess.execute(text('SELECT season FROM tournaments ORDER BY created_at DESC LIMIT 1')).fetchone()
                        summary['tournaments_total'] = t_total
                        summary['tournaments_active'] = t_active
                        summary['last_season'] = last_season_row[0] if last_season_row else None
                        ps_rows = adv_sess.execute(text('SELECT COUNT(*) FROM player_statistics')).scalar() or 0
                        summary['player_statistics_rows'] = ps_rows
                    except Exception as _e:
                        summary['error_tournaments'] = str(_e)
                    # legacy counts (separate connection)
                    legacy_counts = {}
                    legacy_db_local = get_db()
                    try:
                        for tbl in ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags']:
                            try:
                                cnt = legacy_db_local.execute(text(f'SELECT COUNT(*) FROM {tbl}')).scalar() or 0
                                legacy_counts[tbl] = cnt
                            except Exception as _tbl_e:
                                legacy_counts[tbl] = f"err:{_tbl_e}"
                    finally:
                        try: legacy_db_local.close()
                        except Exception: pass
                    summary['legacy'] = legacy_counts
                    # hash
                    try:
                        h = hashlib.sha256(json.dumps(summary, sort_keys=True).encode('utf-8')).hexdigest()
                        summary['_hash'] = h
                    except Exception:
                        summary['_hash'] = None
                    return summary

                pre_summary = collect_state_summary()

                # Dry-run: возвращаем план
                if dry_run:
                    return jsonify({
                        'ok': True,
                        'dry_run': True,
                        'would_complete': active.season if active else None,
                        'would_create': new_season,
                        'soft_mode': soft_mode,
                        'legacy_cleanup': [] if soft_mode else ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags'],
                        'pre_hash': pre_summary.get('_hash'),
                        'pre_summary': pre_summary
                    })

                prev_id = active.id if active else None
                prev_season = active.season if active else None
                if active:
                    active.status = 'completed'
                    active.end_date = date.today()
                new_tournament = Tournament(
                    name=f"Лига Обнинска {new_season}",
                    season=new_season,
                    status='active',
                    start_date=date.today(),
                    description=f"Сезон {new_season}"
                )
                adv_sess.add(new_tournament)
                adv_sess.flush()  # получить ID до потенциального аудита

                # Лог аудит / эволюция таблицы
                try:
                    adv_sess.execute(text("""
                        CREATE TABLE IF NOT EXISTS season_rollovers (
                            id SERIAL PRIMARY KEY,
                            prev_tournament_id INT NULL,
                            prev_season TEXT NULL,
                            new_tournament_id INT NOT NULL,
                            new_season TEXT NOT NULL,
                            soft_mode BOOLEAN NOT NULL DEFAULT FALSE,
                            legacy_cleanup_done BOOLEAN NOT NULL DEFAULT FALSE,
                            pre_hash TEXT NULL,
                            post_hash TEXT NULL,
                            pre_meta TEXT NULL,
                            post_meta TEXT NULL,
                            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                        )"""))
                    # ALTER для старых таблиц (идемпотентно)
                    for col in ['pre_hash TEXT','post_hash TEXT','pre_meta TEXT','post_meta TEXT']:
                        try:
                            adv_sess.execute(text(f'ALTER TABLE season_rollovers ADD COLUMN IF NOT EXISTS {col}'))
                        except Exception:
                            pass
                except Exception as crt_err:
                    app.logger.warning(f"season_rollovers create/alter failed: {crt_err}")

                # Сброс legacy если не soft
                legacy_cleanup_done = False
                legacy_list = ['team_player_stats','match_scores','match_player_events','match_lineups','match_stats','match_flags']
                if not soft_mode:
                    legacy_db = get_db()
                    try:
                        for tbl in legacy_list:
                            try:
                                legacy_db.execute(text(f'DELETE FROM {tbl}'))
                            except Exception as tbl_err:
                                app.logger.warning(f"Failed to clear {tbl}: {tbl_err}")
                        legacy_db.commit()
                        legacy_cleanup_done = True
                    finally:
                        try: legacy_db.close()
                        except Exception: pass

                # Запись аудита (предварительно, без post_hash)
                audit_id = None
                try:
                    res = adv_sess.execute(text("""
                        INSERT INTO season_rollovers (prev_tournament_id, prev_season, new_tournament_id, new_season, soft_mode, legacy_cleanup_done, pre_hash, pre_meta)
                        VALUES (:pid, :ps, :nid, :ns, :soft, :lcd, :ph, :pm)
                        RETURNING id
                    """), {
                        'pid': prev_id,
                        'ps': prev_season,
                        'nid': new_tournament.id,
                        'ns': new_season,
                        'soft': soft_mode,
                        'lcd': legacy_cleanup_done,
                        'ph': pre_summary.get('_hash'),
                        'pm': json.dumps(pre_summary, ensure_ascii=False)
                    })
                    row = res.fetchone()
                    if row:
                        audit_id = row[0]
                except Exception as ins_audit_err:
                    app.logger.warning(f"season_rollovers audit insert failed: {ins_audit_err}")

                # Post summary (после изменений)
                post_summary = collect_state_summary()
                try:
                    if audit_id is not None:
                        adv_sess.execute(text("""
                            UPDATE season_rollovers SET post_hash=:h, post_meta=:pm WHERE id=:id
                        """), {'h': post_summary.get('_hash'), 'pm': json.dumps(post_summary, ensure_ascii=False), 'id': audit_id})
                except Exception as upd_audit_err:
                    app.logger.warning(f"season_rollovers audit post update failed: {upd_audit_err}")

                adv_sess.commit()

                # Инвалидация кэшей (после фиксации транзакции)

                # Инвалидация кэшей
                try:
                    from optimizations.multilevel_cache import get_cache
                    cache = get_cache()
                    for key in ('league_table','stats_table','results','schedule','tours','betting-tours'):
                        try: cache.invalidate(key)
                        except Exception: pass
                except Exception as _c_err:
                    app.logger.warning(f"cache invalidate failed season rollover: {_c_err}")

                return jsonify({
                    'ok': True,
                    'previous_season': prev_season,
                    'new_season': new_season,
                    'tournament_id': new_tournament.id,
                    'soft_mode': soft_mode,
                    'legacy_cleanup_done': (not soft_mode) and legacy_cleanup_done,
                    'pre_hash': pre_summary.get('_hash'),
                    'post_hash': post_summary.get('_hash')
                })
            finally:
                try:
                    adv_sess.close()
                except Exception:
                    pass
        except Exception as e:
            app.logger.error(f"Season rollover error: {e}")
            return jsonify({'error': 'season rollover failed'}), 500

    app.register_blueprint(admin_bp)
    return admin_bp
