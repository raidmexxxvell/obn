"""
Migration script to initialize Liga Obninska database
Only imports schedule from Google Sheets, leaves statistics empty
"""

import os
import sys
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime, timedelta
import json
import pathlib

# Ensure project root on sys.path for package imports when executed via web route
CURRENT_DIR = pathlib.Path(__file__).resolve().parent
ROOT_DIR = CURRENT_DIR.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    # Correct package-qualified import
    from database.database_models import db_manager, Tournament, Team, Player, Match
except ImportError as e:
    raise ImportError(f"Failed to import database models: {e}. Ensure 'database' package is present and PYTHONPATH includes project root.")

# Google Sheets configuration
GOOGLE_SHEETS_CREDS_JSON = os.environ.get('GOOGLE_SHEETS_CREDS_JSON', '{}')
GOOGLE_SHEET_URL = os.environ.get('GOOGLE_SHEET_URL', '')

def get_google_sheets_client():
    """Initialize Google Sheets client"""
    try:
        if not GOOGLE_SHEETS_CREDS_JSON or GOOGLE_SHEETS_CREDS_JSON == '{}':
            print("ERROR: GOOGLE_SHEETS_CREDS_JSON not configured")
            return None
            
        creds_data = json.loads(GOOGLE_SHEETS_CREDS_JSON)
        scope = [
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive'
        ]
        creds = Credentials.from_service_account_info(creds_data, scopes=scope)
        client = gspread.authorize(creds)
        
        if GOOGLE_SHEET_URL:
            sheet = client.open_by_url(GOOGLE_SHEET_URL)
        else:
            print("ERROR: GOOGLE_SHEET_URL not configured")
            return None
            
        return sheet
        
    except Exception as e:
        print(f"ERROR initializing Google Sheets: {e}")
        return None

def import_schedule_from_sheets():
    """Import schedule from Google Sheets"""
    print("[INFO] Starting schedule import from Google Sheets...")
    
    sheet = get_google_sheets_client()
    if not sheet:
        print("[ERROR] Could not connect to Google Sheets")
        return False
    
    try:
        # Get the schedule worksheet
        schedule_ws = None
        for worksheet in sheet.worksheets():
            if 'расписание' in worksheet.title.lower() or 'schedule' in worksheet.title.lower():
                schedule_ws = worksheet
                break
        
        if not schedule_ws:
            print("[ERROR] Schedule worksheet not found")
            return False
        
        print(f"[INFO] Found schedule worksheet: {schedule_ws.title}")
        
        # Get all records from the schedule
        records = schedule_ws.get_all_records()
        print(f"[INFO] Found {len(records)} schedule records")
        
        if not records:
            print("[WARN] No schedule records found")
            return True
        
        # Process records
        with db_manager.get_session() as session:
            # Get or create default tournament
            tournament = session.query(Tournament).filter(Tournament.name == 'Лига Обнинск').first()
            if not tournament:
                tournament = Tournament(
                    name='Лига Обнинск',
                    season='2025',
                    status='active',
                    start_date=datetime.now().date(),
                    description='Основной турнир сезона 2025'
                )
                session.add(tournament)
                session.commit()
                print("[INFO] Created default tournament")
            
            imported_count = 0
            
            for record in records:
                try:
                    # Extract match data from record
                    # Adjust field names based on your Google Sheets structure
                    date_str = record.get('Дата', '') or record.get('Date', '')
                    time_str = record.get('Время', '') or record.get('Time', '')
                    home_team = record.get('Дома', '') or record.get('Home', '')
                    away_team = record.get('Гости', '') or record.get('Away', '')
                    venue = record.get('Место', '') or record.get('Venue', '')
                    
                    if not all([date_str, home_team, away_team]):
                        print(f"[WARN] Skipping incomplete record: {record}")
                        continue
                    
                    # Parse date and time
                    try:
                        if time_str:
                            match_datetime = datetime.strptime(f"{date_str} {time_str}", "%d.%m.%Y %H:%M")
                        else:
                            match_datetime = datetime.strptime(date_str, "%d.%m.%Y")
                    except ValueError:
                        try:
                            # Try alternative date format
                            match_datetime = datetime.strptime(date_str, "%Y-%m-%d")
                        except ValueError:
                            print(f"[WARN] Could not parse date: {date_str}")
                            continue
                    
                    # Get or create teams
                    home_team_obj = session.query(Team).filter(Team.name == home_team).first()
                    if not home_team_obj:
                        home_team_obj = Team(name=home_team, is_active=True)
                        session.add(home_team_obj)
                        session.flush()  # To get the ID
                    
                    away_team_obj = session.query(Team).filter(Team.name == away_team).first()
                    if not away_team_obj:
                        away_team_obj = Team(name=away_team, is_active=True)
                        session.add(away_team_obj)
                        session.flush()  # To get the ID
                    
                    # Check if match already exists
                    existing_match = session.query(Match).filter(
                        Match.tournament_id == tournament.id,
                        Match.home_team_id == home_team_obj.id,
                        Match.away_team_id == away_team_obj.id,
                        Match.match_date == match_datetime
                    ).first()
                    
                    if existing_match:
                        print(f"[INFO] Match already exists: {home_team} vs {away_team} on {match_datetime}")
                        continue
                    
                    # Create match
                    match = Match(
                        tournament_id=tournament.id,
                        home_team_id=home_team_obj.id,
                        away_team_id=away_team_obj.id,
                        match_date=match_datetime,
                        venue=venue,
                        status='scheduled'
                    )
                    
                    session.add(match)
                    imported_count += 1
                    print(f"[INFO] Imported match: {home_team} vs {away_team} on {match_datetime}")
                    
                except Exception as e:
                    print(f"[ERROR] Error processing record {record}: {e}")
                    continue
            
            session.commit()
            print(f"[INFO] Successfully imported {imported_count} matches")
            
        return True
        
    except Exception as e:
        print(f"[ERROR] Error importing schedule: {e}")
        return False

def create_sample_data():
    """Create sample data for testing if Google Sheets import fails"""
    print("[INFO] Creating sample data...")
    
    with db_manager.get_session() as session:
        # Create tournament
        tournament = Tournament(
            name='Лига Обнинск',
            season='2025',
            status='active',
            start_date=datetime.now().date(),
            description='Основной турнир сезона 2025'
        )
        session.add(tournament)
        session.flush()
        
        # Create teams based on existing logos
        team_names = [
            'Дождь', 'Звезда', 'Киборги', 'Креатив', 'Полет', 
            'Серпантин', 'ФК Обнинск', 'ФК Setka4Real', 'Ювелиры'
        ]
        
        teams = []
        for team_name in team_names:
            team = Team(
                name=team_name,
                logo_url=f'/static/img/team-logos/{team_name.lower()}.png',
                is_active=True,
                city='Обнинск'
            )
            session.add(team)
            teams.append(team)
        
        session.flush()
        
        # Create sample matches
        for i in range(5):
            home_team = teams[i % len(teams)]
            away_team = teams[(i + 1) % len(teams)]
            
            match = Match(
                tournament_id=tournament.id,
                home_team_id=home_team.id,
                away_team_id=away_team.id,
                match_date=datetime.now() + timedelta(days=i),
                venue='Стадион Обнинск',
                status='scheduled'
            )
            session.add(match)
        
        session.commit()
        print("[INFO] Sample data created successfully")

def main():
    """Main initialization function"""
    print("Liga Obninska Database Initialization")
    print("=" * 40)
    
    # Check if database connection is available
    try:
        db_manager.create_tables()
        print("[INFO] Database tables created/verified")
    except Exception as e:
        print(f"[ERROR] Database connection failed: {e}")
        return 1
    
    # Try to import from Google Sheets
    success = import_schedule_from_sheets()
    
    if not success:
        print("[WARN] Google Sheets import failed, creating sample data...")
        create_sample_data()
    
    print("\n[INFO] Database initialization completed!")
    print("[INFO] Statistics tables are empty and will be populated from match events.")
    print("[INFO] Access admin panel at /admin to manage matches and events.")
    
    return 0

if __name__ == "__main__":
    exit_code = main()
    sys.exit(exit_code)
