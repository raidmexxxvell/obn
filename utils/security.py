"""
Security utilities for Liga Obninska
Input validation, sanitization, and security helpers
"""
import re
import html
import hashlib
import hmac
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union
from urllib.parse import parse_qs

class InputValidator:
    """Validates and sanitizes user input"""
    
    # Regex patterns for validation
    TEAM_NAME_PATTERN = re.compile(r'^[а-яА-Яa-zA-Z0-9\s\-_\.]{1,50}$')
    USERNAME_PATTERN = re.compile(r'^[a-zA-Z0-9_]{3,32}$')
    SCORE_PATTERN = re.compile(r'^\d{1,2}:\d{1,2}$')
    SELECTION_PATTERN = re.compile(r'^(home|draw|away|over_\d+\.?\d*|under_\d+\.?\d*|yes|no)$')
    
    @classmethod
    def validate_team_name(cls, name: str) -> tuple[bool, str]:
        """Validate team name"""
        if not name or not isinstance(name, str):
            return False, "Team name is required"
        
        name = name.strip()
        if len(name) < 1:
            return False, "Team name cannot be empty"
        
        if len(name) > 50:
            return False, "Team name too long (max 50 characters)"
        
        if not cls.TEAM_NAME_PATTERN.match(name):
            return False, "Team name contains invalid characters"
        
        return True, name
    
    @classmethod
    def validate_score(cls, score: str) -> tuple[bool, str]:
        """Validate match score format"""
        if not score or not isinstance(score, str):
            return False, "Score is required"
        
        score = score.strip()
        if not cls.SCORE_PATTERN.match(score):
            return False, "Invalid score format (use X:Y)"
        
        return True, score
    
    @classmethod
    def validate_selection(cls, market: str, selection: str) -> tuple[bool, str]:
        """Validate betting selection"""
        if not selection or not isinstance(selection, str):
            return False, "Selection is required"
        
        selection = selection.strip().lower()
        
        if market == '1x2':
            if selection not in ['home', 'draw', 'away']:
                return False, "Invalid 1x2 selection"
        elif market == 'totals':
            if not (selection.startswith('over_') or selection.startswith('under_')):
                return False, "Invalid totals selection"
        elif market in ['penalty', 'redcard']:
            if selection not in ['yes', 'no']:
                return False, f"Invalid {market} selection"
        else:
            return False, "Invalid market"
        
        return True, selection
    
    @classmethod
    def validate_stake(cls, stake: Any, min_stake: int, max_stake: int) -> tuple[bool, int]:
        """Validate betting stake"""
        try:
            stake = int(stake)
        except (ValueError, TypeError):
            return False, 0
        
        if stake < min_stake:
            return False, 0
        
        if stake > max_stake:
            return False, 0
        
        return True, stake
    
    @classmethod
    def sanitize_string(cls, value: str, max_length: int = 255) -> str:
        """Sanitize string input"""
        if not isinstance(value, str):
            return ""
        
        # HTML escape
        value = html.escape(value.strip())
        
        # Truncate if too long
        if len(value) > max_length:
            value = value[:max_length]
        
        return value
    
    @classmethod
    def validate_telegram_id(cls, telegram_id: Any) -> tuple[bool, int]:
        """Validate Telegram user ID"""
        try:
            telegram_id = int(telegram_id)
        except (ValueError, TypeError):
            return False, 0
        
        # Telegram IDs are positive integers
        if telegram_id <= 0:
            return False, 0
        
        # Reasonable upper bound for Telegram IDs
        if telegram_id > 10**12:
            return False, 0
        
        return True, telegram_id

class TelegramSecurity:
    """Security utilities for Telegram WebApp integration"""
    
    @staticmethod
    def verify_init_data(init_data: str, bot_token: str, max_age_seconds: int = 86400) -> tuple[bool, Optional[Dict]]:
        """Verify Telegram WebApp initData signature (correct HMAC per spec).
        Spec: secret_key = HMAC_SHA256("WebAppData", bot_token), then
              check_hash = HMAC_SHA256(secret_key, data_check_string)
        data_check_string = lines key=value sorted by key (excluding hash).
        """
        if not init_data or not bot_token:
            return False, None
        try:
            parsed = parse_qs(init_data)
            if 'hash' not in parsed:
                return False, None
            received_hash = parsed.pop('hash')[0]
            data_check_string = '\n'.join([f"{k}={v[0]}" for k,v in sorted(parsed.items())])
            # Correct secret key derivation
            secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
            calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(received_hash, calculated_hash):
                return False, None
            # Age check
            try:
                auth_date = int(parsed.get('auth_date', ['0'])[0])
            except Exception:
                auth_date = 0
            if auth_date:
                now = int(datetime.now(timezone.utc).timestamp())
                if now - auth_date > max_age_seconds:
                    return False, None
            # Parse user JSON
            user_data = None
            if 'user' in parsed:
                try:
                    import json
                    user_data = json.loads(parsed['user'][0])
                except Exception:
                    return False, None
            return True, { 'user': user_data, 'auth_date': auth_date, 'raw': parsed }
        except Exception as e:
            # Silent fail (return False) to not leak details
            return False, None
    
    @staticmethod
    def generate_csrf_token() -> str:
        """Generate CSRF token"""
        return secrets.token_urlsafe(32)
    
    @staticmethod
    def verify_csrf_token(token: str, expected: str) -> bool:
        """Verify CSRF token"""
        if not token or not expected:
            return False
        return hmac.compare_digest(token, expected)

class RateLimiter:
    """Simple in-memory rate limiter"""
    
    def __init__(self):
        self.requests = {}  # {identifier: [timestamp1, timestamp2, ...]}
    
    def is_allowed(self, identifier: str, max_requests: int, time_window: int) -> bool:
        """Check if request is allowed"""
        now = datetime.now(timezone.utc).timestamp()
        
        # Clean old requests
        if identifier in self.requests:
            self.requests[identifier] = [
                req_time for req_time in self.requests[identifier]
                if now - req_time < time_window
            ]
        else:
            self.requests[identifier] = []
        
        # Check limit
        if len(self.requests[identifier]) >= max_requests:
            return False
        
        # Add current request
        self.requests[identifier].append(now)
        return True
    
    def cleanup_old_entries(self, max_age: int = 3600):
        """Clean up old entries"""
        now = datetime.now(timezone.utc).timestamp()
        to_remove = []
        
        for identifier, timestamps in self.requests.items():
            # Remove old timestamps
            self.requests[identifier] = [
                req_time for req_time in timestamps
                if now - req_time < max_age
            ]
            
            # Mark empty entries for removal
            if not self.requests[identifier]:
                to_remove.append(identifier)
        
        # Remove empty entries
        for identifier in to_remove:
            del self.requests[identifier]

class SQLInjectionPrevention:
    """SQL injection prevention utilities"""
    
    DANGEROUS_PATTERNS = [
        r"('|(\\')|(;)|(\\;)|(\|)|(\*)|(%)|(\+)|(=))",
        r"(union|select|insert|update|delete|drop|create|alter|exec|execute)",
        r"(script|javascript|vbscript|onload|onerror|onclick)"
    ]
    
    @classmethod
    def is_safe_string(cls, value: str) -> bool:
        """Check if string is safe from SQL injection"""
        if not isinstance(value, str):
            return True
        
        value_lower = value.lower()
        
        for pattern in cls.DANGEROUS_PATTERNS:
            if re.search(pattern, value_lower, re.IGNORECASE):
                return False
        
        return True
    
    @classmethod
    def sanitize_for_query(cls, value: str) -> str:
        """Sanitize string for use in queries (basic protection)"""
        if not isinstance(value, str):
            return str(value)
        
        # Remove dangerous characters
        value = re.sub(r"[;'\"\\]", "", value)
        
        # Limit length
        if len(value) > 255:
            value = value[:255]
        
        return value.strip()

# Global instances
input_validator = InputValidator()
telegram_security = TelegramSecurity()
rate_limiter = RateLimiter()
sql_prevention = SQLInjectionPrevention()
