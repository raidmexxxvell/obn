"""
Betting utilities for Liga Obninska
Calculations for odds, payouts, and bet validation
"""
from datetime import datetime, timezone, timedelta
from typing import Dict, Any, Optional, Tuple
import math

class BettingCalculator:
    """Handles betting calculations and odds generation"""
    
    def __init__(self, margin: float = 0.06):
        self.margin = margin  # House margin (6% by default)
    
    def calculate_1x2_odds(self, home_team: str, away_team: str, 
                          league_table_ranks: Dict[str, int] = None) -> Dict[str, float]:
        """Calculate 1x2 odds based on team strengths"""
        
        # Default probabilities
        home_prob = 0.45
        draw_prob = 0.30
        away_prob = 0.25
        
        # Adjust based on league positions if available
        if league_table_ranks:
            home_rank = league_table_ranks.get(self._normalize_team_name(home_team), 10)
            away_rank = league_table_ranks.get(self._normalize_team_name(away_team), 10)
            
            # Better rank = lower number, higher probability
            if home_rank < away_rank:
                home_prob += 0.1
                away_prob -= 0.05
                draw_prob -= 0.05
            elif away_rank < home_rank:
                away_prob += 0.1
                home_prob -= 0.05
                draw_prob -= 0.05
        
        # Add home advantage
        home_prob += 0.05
        away_prob -= 0.025
        draw_prob -= 0.025
        
        # Normalize probabilities
        total = home_prob + draw_prob + away_prob
        home_prob /= total
        draw_prob /= total  
        away_prob /= total
        
        # Apply margin and convert to odds
        return {
            'home': round(1 / (home_prob * (1 - self.margin)), 2),
            'draw': round(1 / (draw_prob * (1 - self.margin)), 2),
            'away': round(1 / (away_prob * (1 - self.margin)), 2)
        }
    
    def calculate_totals_odds(self, home_team: str, away_team: str,
                            line: float = 2.5) -> Dict[str, float]:
        """Calculate over/under odds for total goals"""
        
        # Base probability for over (adjust based on teams)
        over_prob = 0.52
        
        # Adjust based on line
        if line >= 3.5:
            over_prob -= 0.15
        elif line <= 1.5:
            over_prob += 0.15
        
        under_prob = 1 - over_prob
        
        # Apply margin
        return {
            f'over_{line}': round(1 / (over_prob * (1 - self.margin)), 2),
            f'under_{line}': round(1 / (under_prob * (1 - self.margin)), 2)
        }
    
    def calculate_specials_odds(self, home_team: str, away_team: str, 
                              market: str) -> Dict[str, float]:
        """Calculate odds for special markets (penalty, red card, etc.)"""
        
        # Base probabilities for special events
        event_probs = {
            'penalty': 0.25,    # 25% chance of penalty
            'redcard': 0.15,    # 15% chance of red card
            'corner_10': 0.60,  # 60% chance of 10+ corners
            'yellow_5': 0.70    # 70% chance of 5+ yellow cards
        }
        
        yes_prob = event_probs.get(market, 0.30)
        no_prob = 1 - yes_prob
        
        # Apply margin
        return {
            'yes': round(1 / (yes_prob * (1 - self.margin)), 2),
            'no': round(1 / (no_prob * (1 - self.margin)), 2)
        }
    
    def calculate_payout(self, stake: int, odds: float) -> int:
        """Calculate payout for winning bet"""
        return int(round(stake * odds))
    
    def validate_bet(self, market: str, selection: str, stake: int,
                    min_stake: int, max_stake: int) -> Tuple[bool, str]:
        """Validate bet parameters"""
        
        # Check market
        valid_markets = ['1x2', 'totals', 'penalty', 'redcard']
        if market not in valid_markets:
            return False, f"Invalid market: {market}"
        
        # Check selection based on market
        if market == '1x2' and selection not in ['home', 'draw', 'away']:
            return False, f"Invalid 1x2 selection: {selection}"
        
        if market == 'totals' and not (selection.startswith('over_') or selection.startswith('under_')):
            return False, f"Invalid totals selection: {selection}"
        
        if market in ['penalty', 'redcard'] and selection not in ['yes', 'no']:
            return False, f"Invalid {market} selection: {selection}"
        
        # Check stake limits
        if stake < min_stake:
            return False, f"Stake below minimum: {stake} < {min_stake}"
        
        if stake > max_stake:
            return False, f"Stake above maximum: {stake} > {max_stake}"
        
        return True, "Valid bet"
    
    def check_bet_timing(self, match_datetime: Optional[datetime], 
                        lock_ahead_minutes: int = 5) -> Tuple[bool, str]:
        """Check if bet timing is valid"""
        
        if not match_datetime:
            return True, "No match time restriction"
        
        now = datetime.now(timezone.utc)
        lock_time = match_datetime - timedelta(minutes=lock_ahead_minutes)
        
        if now >= lock_time:
            return False, f"Betting closed {lock_ahead_minutes} minutes before match"
        
        if now >= match_datetime:
            return False, "Match has already started"
        
        return True, "Betting open"
    
    def _normalize_team_name(self, name: str) -> str:
        """Normalize team name for comparison"""
        if not name:
            return ''
        return name.strip().lower().replace(' ', '').replace('-', '').replace('_', '')

class BetSettlement:
    """Handles bet settlement and result calculation"""
    
    @staticmethod
    def settle_1x2_bet(selection: str, home_score: int, away_score: int) -> Optional[bool]:
        """Settle 1x2 bet based on match result"""
        
        if home_score > away_score:
            result = 'home'
        elif away_score > home_score:
            result = 'away'
        else:
            result = 'draw'
        
        return result == selection
    
    @staticmethod
    def settle_totals_bet(selection: str, total_goals: int) -> Optional[bool]:
        """Settle totals bet based on total goals"""
        
        if not selection.startswith(('over_', 'under_')):
            return None
        
        try:
            parts = selection.split('_', 1)
            side = parts[0]  # 'over' or 'under'
            line = float(parts[1])
            
            if side == 'over':
                return total_goals > line
            else:  # under
                return total_goals < line
                
        except (ValueError, IndexError):
            return None
    
    @staticmethod
    def settle_special_bet(selection: str, event_occurred: bool) -> Optional[bool]:
        """Settle special market bet"""
        
        if selection == 'yes':
            return event_occurred
        elif selection == 'no':
            return not event_occurred
        else:
            return None
