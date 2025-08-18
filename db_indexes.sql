-- PostgreSQL index creation script for hot queries
-- Safe to run multiple times thanks to IF NOT EXISTS

-- Bets
CREATE INDEX IF NOT EXISTS idx_bet_user_placed_at ON bets (user_id, placed_at);
CREATE INDEX IF NOT EXISTS idx_bet_match_status ON bets (home, away, status);
CREATE INDEX IF NOT EXISTS idx_bet_match_datetime ON bets (home, away, match_datetime);

-- Match specials and scores
CREATE INDEX IF NOT EXISTS idx_specials_home_away ON match_specials (home, away);
CREATE INDEX IF NOT EXISTS idx_score_home_away ON match_scores (home, away);

-- Shop orders
CREATE INDEX IF NOT EXISTS idx_shop_order_user_created ON shop_orders (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_shop_order_created ON shop_orders (created_at);

-- Comments and streams (if not already present)
CREATE INDEX IF NOT EXISTS idx_stream_home_away_date ON match_streams (home, away, date);
CREATE INDEX IF NOT EXISTS idx_comment_match_time ON match_comments (home, away, date, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_user_match_time ON match_comments (user_id, home, away, date, created_at);
