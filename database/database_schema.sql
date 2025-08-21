-- Liga Obninska Database Schema
-- PostgreSQL Database Schema for render.com
-- Created: 21.08.2025

-- Drop existing tables if they exist (in correct order due to foreign keys)
DROP TABLE IF EXISTS match_events CASCADE;
DROP TABLE IF EXISTS team_compositions CASCADE;
DROP TABLE IF EXISTS player_statistics CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS players CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS tournaments CASCADE;

-- 1. Tournaments table
CREATE TABLE tournaments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    season VARCHAR(100) NOT NULL,
    status VARCHAR(50) DEFAULT 'active', -- active, completed, paused
    start_date DATE,
    end_date DATE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Teams table
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    logo_url VARCHAR(500),
    description TEXT,
    founded_year INTEGER,
    city VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Players table
CREATE TABLE players (
    id SERIAL PRIMARY KEY,
    telegram_id BIGINT UNIQUE,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100),
    username VARCHAR(100),
    position VARCHAR(50), -- goalkeeper, defender, midfielder, forward
    birth_date DATE,
    phone VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Matches table
CREATE TABLE matches (
    id SERIAL PRIMARY KEY,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    home_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    away_team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    match_date TIMESTAMP NOT NULL,
    venue VARCHAR(255),
    home_score INTEGER DEFAULT 0,
    away_score INTEGER DEFAULT 0,
    status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, live, finished, cancelled, postponed
    referee VARCHAR(100),
    duration_minutes INTEGER DEFAULT 90,
    weather_conditions VARCHAR(100),
    attendance INTEGER,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Team Compositions table (составы команд для конкретных матчей)
CREATE TABLE team_compositions (
    id SERIAL PRIMARY KEY,
    match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    position VARCHAR(50), -- starting_eleven, substitute, bench
    jersey_number INTEGER,
    is_captain BOOLEAN DEFAULT false,
    substituted_in_minute INTEGER, -- когда игрок вышел на замену
    substituted_out_minute INTEGER, -- когда игрок был заменен
    yellow_cards INTEGER DEFAULT 0,
    red_cards INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Уникальность: один игрок может быть только один раз в составе на матч
    UNIQUE(match_id, player_id),
    -- Уникальность номера в команде на матч
    UNIQUE(match_id, team_id, jersey_number)
);

-- 6. Match Events table (события матча: голы, передачи, карточки)
CREATE TABLE match_events (
    id SERIAL PRIMARY KEY,
    match_id INTEGER REFERENCES matches(id) ON DELETE CASCADE,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL, -- goal, assist, yellow_card, red_card, substitution_in, substitution_out
    minute INTEGER NOT NULL,
    additional_time INTEGER DEFAULT 0, -- добавленное время
    description TEXT,
    assisted_by_player_id INTEGER REFERENCES players(id) ON DELETE SET NULL, -- кто сделал передачу на гол
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Проверка корректности минут
    CHECK (minute >= 0 AND minute <= 120),
    CHECK (additional_time >= 0 AND additional_time <= 15)
);

-- 7. Player Statistics table (автоматически обновляемая статистика)
CREATE TABLE player_statistics (
    id SERIAL PRIMARY KEY,
    player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
    tournament_id INTEGER REFERENCES tournaments(id) ON DELETE CASCADE,
    
    -- Основная статистика
    matches_played INTEGER DEFAULT 0,
    goals_scored INTEGER DEFAULT 0,
    assists INTEGER DEFAULT 0,
    yellow_cards INTEGER DEFAULT 0,
    red_cards INTEGER DEFAULT 0,
    
    -- Расчетные поля
    total_points INTEGER GENERATED ALWAYS AS (goals_scored + assists) STORED,
    
    -- Время обновления
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Уникальность: один игрок в одном турнире
    UNIQUE(player_id, tournament_id)
);

-- Indexes for better performance
CREATE INDEX idx_matches_tournament ON matches(tournament_id);
CREATE INDEX idx_matches_date ON matches(match_date);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_team_compositions_match ON team_compositions(match_id);
CREATE INDEX idx_team_compositions_team ON team_compositions(team_id);
CREATE INDEX idx_team_compositions_player ON team_compositions(player_id);
CREATE INDEX idx_match_events_match ON match_events(match_id);
CREATE INDEX idx_match_events_player ON match_events(player_id);
CREATE INDEX idx_match_events_type ON match_events(event_type);
CREATE INDEX idx_player_statistics_player ON player_statistics(player_id);
CREATE INDEX idx_player_statistics_tournament ON player_statistics(tournament_id);
CREATE INDEX idx_player_statistics_ranking ON player_statistics(total_points DESC, matches_played ASC, goals_scored DESC);

-- Function to update player statistics when match events are added/updated
CREATE OR REPLACE FUNCTION update_player_statistics()
RETURNS TRIGGER AS $$
BEGIN
    -- Обновляем статистику для игрока
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
        p.id,
        m.tournament_id,
        COUNT(DISTINCT tc.match_id) as matches_played,
        COUNT(CASE WHEN me.event_type = 'goal' THEN 1 END) as goals_scored,
        COUNT(CASE WHEN me.event_type = 'assist' THEN 1 END) as assists,
        COUNT(CASE WHEN me.event_type = 'yellow_card' THEN 1 END) as yellow_cards,
        COUNT(CASE WHEN me.event_type = 'red_card' THEN 1 END) as red_cards
    FROM players p
    JOIN team_compositions tc ON p.id = tc.player_id
    JOIN matches m ON tc.match_id = m.id
    LEFT JOIN match_events me ON p.id = me.player_id AND m.id = me.match_id
    WHERE p.id = COALESCE(NEW.player_id, OLD.player_id)
        AND m.tournament_id = (
            SELECT tournament_id FROM matches 
            WHERE id = COALESCE(NEW.match_id, OLD.match_id)
        )
    GROUP BY p.id, m.tournament_id
    ON CONFLICT (player_id, tournament_id) 
    DO UPDATE SET
        matches_played = EXCLUDED.matches_played,
        goals_scored = EXCLUDED.goals_scored,
        assists = EXCLUDED.assists,
        yellow_cards = EXCLUDED.yellow_cards,
        red_cards = EXCLUDED.red_cards,
        last_updated = CURRENT_TIMESTAMP;
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update statistics
CREATE TRIGGER trigger_update_stats_on_event
    AFTER INSERT OR UPDATE OR DELETE ON match_events
    FOR EACH ROW EXECUTE FUNCTION update_player_statistics();

-- Function to update statistics when team composition changes
CREATE OR REPLACE FUNCTION update_stats_on_composition_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Обновляем статистику при изменении состава
    PERFORM update_player_statistics() 
    WHERE player_id = COALESCE(NEW.player_id, OLD.player_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_stats_on_composition
    AFTER INSERT OR UPDATE OR DELETE ON team_compositions
    FOR EACH ROW EXECUTE FUNCTION update_stats_on_composition_change();

-- Function to get player rankings with proper sorting
CREATE OR REPLACE FUNCTION get_player_rankings(tournament_id_param INTEGER)
RETURNS TABLE (
    rank INTEGER,
    player_id INTEGER,
    first_name VARCHAR,
    last_name VARCHAR,
    username VARCHAR,
    matches_played INTEGER,
    goals_scored INTEGER,
    assists INTEGER,
    total_points INTEGER,
    yellow_cards INTEGER,
    red_cards INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ROW_NUMBER() OVER (
            ORDER BY 
                ps.total_points DESC,  -- Сначала по сумме голов + передач
                ps.matches_played ASC, -- Потом кто сыграл меньше игр
                ps.goals_scored DESC   -- Потом кто забил больше голов
        )::INTEGER as rank,
        ps.player_id,
        p.first_name,
        p.last_name,
        p.username,
        ps.matches_played,
        ps.goals_scored,
        ps.assists,
        ps.total_points,
        ps.yellow_cards,
        ps.red_cards
    FROM player_statistics ps
    JOIN players p ON ps.player_id = p.id
    WHERE ps.tournament_id = tournament_id_param
        AND ps.matches_played > 0  -- Только те, кто играл
    ORDER BY 
        ps.total_points DESC,
        ps.matches_played ASC,
        ps.goals_scored DESC;
END;
$$ LANGUAGE plpgsql;

-- Insert sample data for testing
INSERT INTO tournaments (name, season, status, start_date, description) VALUES
('Лига Обнинск', '2025', 'active', '2025-08-01', 'Основной турнир сезона 2025');

-- Sample teams (you can add your actual teams)
INSERT INTO teams (name, logo_url, description, city) VALUES
('Дождь', '/static/img/team-logos/дождь.png', 'Команда Дождь', 'Обнинск'),
('Звезда', '/static/img/team-logos/звезда.png', 'Команда Звезда', 'Обнинск'),
('Киборги', '/static/img/team-logos/киборги.png', 'Команда Киборги', 'Обнинск'),
('Креатив', '/static/img/team-logos/креатив.png', 'Команда Креатив', 'Обнинск'),
('Полет', '/static/img/team-logos/полет.png', 'Команда Полет', 'Обнинск'),
('Серпантин', '/static/img/team-logos/серпантин.png', 'Команда Серпантин', 'Обнинск'),
('ФК Обнинск', '/static/img/team-logos/фкобнинск.png', 'ФК Обнинск', 'Обнинск'),
('ФК Setka4Real', '/static/img/team-logos/фкsetka4real.png', 'ФК Setka4Real', 'Обнинск'),
('Ювелиры', '/static/img/team-logos/ювелиры.png', 'Команда Ювелиры', 'Обнинск');

COMMENT ON TABLE tournaments IS 'Турниры (сезоны)';
COMMENT ON TABLE teams IS 'Команды';
COMMENT ON TABLE players IS 'Игроки';
COMMENT ON TABLE matches IS 'Матчи';
COMMENT ON TABLE team_compositions IS 'Составы команд на матч';
COMMENT ON TABLE match_events IS 'События матча (голы, передачи, карточки)';
COMMENT ON TABLE player_statistics IS 'Статистика игроков (автоматически обновляется)';
