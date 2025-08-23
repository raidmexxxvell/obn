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
                    
                # Если матч завершён - запускаем расчёт ставок
                if status == 'finished':
                    try: 
                        _settle_open_bets()
                    except Exception as e:
                        app.logger.error(f"Failed to settle open bets: {e}")
                        
                return jsonify({'ok': True, 'status': status})
            finally:
                db.close()
                
        except Exception as e:
            app.logger.error(f"Match status set error: {e}")
            return jsonify({'error': 'Не удалось установить статус матча'}), 500
    
    # Регистрируем blueprint
    app.register_blueprint(admin_bp)
    return admin_bp
