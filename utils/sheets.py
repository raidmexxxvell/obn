"""
Google Sheets utilities for Liga Obninska
Handles all Google Sheets operations and data synchronization
"""
import base64
import json
import gspread
from google.oauth2.service_account import Credentials
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

class SheetsManager:
    """Manages Google Sheets operations"""
    
    def __init__(self, credentials_b64: str, spreadsheet_id: str):
        self.spreadsheet_id = spreadsheet_id
        self.client = None
        self.spreadsheet = None
        
        if credentials_b64:
            try:
                creds_json = base64.b64decode(credentials_b64).decode('utf-8')
                creds_data = json.loads(creds_json)
                
                scope = [
                    'https://www.googleapis.com/auth/spreadsheets',
                    'https://www.googleapis.com/auth/drive'
                ]
                
                credentials = Credentials.from_service_account_info(creds_data, scopes=scope)
                self.client = gspread.authorize(credentials)
                self.spreadsheet = self.client.open_by_key(spreadsheet_id)
                
            except Exception as e:
                print(f"[ERROR] Failed to initialize Google Sheets: {e}")
                raise
    
    def get_worksheet(self, name: str):
        """Get worksheet by name"""
        if not self.spreadsheet:
            raise ValueError("Spreadsheet not initialized")
        
        try:
            return self.spreadsheet.worksheet(name)
        except gspread.WorksheetNotFound:
            return None
    
    def read_range(self, worksheet_name: str, range_name: str) -> Optional[List[List[str]]]:
        """Read data from specific range"""
        worksheet = self.get_worksheet(worksheet_name)
        if not worksheet:
            return None
        
        try:
            return worksheet.get(range_name)
        except Exception as e:
            print(f"[WARN] Failed to read range {range_name} from {worksheet_name}: {e}")
            return None
    
    def read_all_values(self, worksheet_name: str) -> Optional[List[List[str]]]:
        """Read all values from worksheet"""
        worksheet = self.get_worksheet(worksheet_name)
        if not worksheet:
            return None
        
        try:
            return worksheet.get_all_values()
        except Exception as e:
            print(f"[WARN] Failed to read all values from {worksheet_name}: {e}")
            return None
    
    def update_range(self, worksheet_name: str, range_name: str, values: List[List[Any]]) -> bool:
        """Update range with values"""
        worksheet = self.get_worksheet(worksheet_name)
        if not worksheet:
            return False
        
        try:
            worksheet.update(range_name, values)
            return True
        except Exception as e:
            print(f"[ERROR] Failed to update range {range_name} in {worksheet_name}: {e}")
            return False
    
    def append_row(self, worksheet_name: str, values: List[Any]) -> bool:
        """Append row to worksheet"""
        worksheet = self.get_worksheet(worksheet_name)
        if not worksheet:
            return False
        
        try:
            worksheet.append_row(values)
            return True
        except Exception as e:
            print(f"[ERROR] Failed to append row to {worksheet_name}: {e}")
            return False

class DataSyncManager:
    """Manages data synchronization between Sheets and database"""
    
    def __init__(self, sheets_manager: SheetsManager, db_session_factory):
        self.sheets = sheets_manager
        self.db_session_factory = db_session_factory
        self.last_sync = {}
    
    def sync_league_table(self) -> Dict[str, Any]:
        """Sync league table from Sheets"""
        values = self.sheets.read_range('ТАБЛИЦА', 'A:H')
        if not values:
            return {'error': 'Failed to read league table'}
        
        return {
            'values': values,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'source': 'sheets'
        }
    
    def sync_stats_table(self) -> Dict[str, Any]:
        """Sync stats table from Sheets"""
        values = self.sheets.read_range('СТАТИСТИКА', 'A:G')
        if not values:
            return {'error': 'Failed to read stats table'}
        
        return {
            'values': values,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'source': 'sheets'
        }
    
    def sync_schedule(self) -> Dict[str, Any]:
        """Sync schedule from Sheets"""
        values = self.sheets.read_range('РАСПИСАНИЕ ИГР', 'A:F')
        if not values:
            return {'error': 'Failed to read schedule'}
        
        # Transform raw values to structured data
        tours = []
        current_tour = None
        
        for row in values[1:]:  # Skip header
            if not row:
                continue
                
            if len(row) >= 1 and row[0].strip():
                # New tour
                if 'тур' in row[0].lower():
                    if current_tour:
                        tours.append(current_tour)
                    current_tour = {
                        'tour': row[0].strip(),
                        'matches': []
                    }
            elif len(row) >= 4 and row[1] and row[2]:
                # Match row
                if current_tour:
                    match = {
                        'date': row[0] if len(row) > 0 else '',
                        'home': row[1].strip(),
                        'away': row[2].strip(),
                        'time': row[3] if len(row) > 3 else ''
                    }
                    current_tour['matches'].append(match)
        
        if current_tour:
            tours.append(current_tour)
        
        return {
            'tours': tours,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'source': 'sheets'
        }
    
    def sync_results(self) -> Dict[str, Any]:
        """Sync results from Sheets"""
        values = self.sheets.read_range('РЕЗУЛЬТАТЫ', 'A:F')
        if not values:
            return {'error': 'Failed to read results'}
        
        results = []
        for row in values[1:]:  # Skip header
            if len(row) >= 4 and row[1] and row[2]:
                result = {
                    'date': row[0] if len(row) > 0 else '',
                    'home': row[1].strip(),
                    'away': row[2].strip(),
                    'score': row[3] if len(row) > 3 else ''
                }
                results.append(result)
        
        return {
            'results': results,
            'updated_at': datetime.now(timezone.utc).isoformat(),
            'source': 'sheets'
        }
    
    def mirror_user_to_sheets(self, user_data: Dict[str, Any]) -> bool:
        """Mirror user data to Sheets"""
        try:
            # Implementation for mirroring user data
            return True
        except Exception as e:
            print(f"[ERROR] Failed to mirror user data: {e}")
            return False
