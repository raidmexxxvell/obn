/**
 * Database API Client for Liga Obninska
 * Replaces Google Sheets functionality with PostgreSQL database
 */

class DatabaseAPI {
    constructor() {
        this.baseUrl = '/api';
        this.cache = new Map();
        this.cacheTimeout = 30000; // 30 секунд
    }

    /**
     * Выполнить GET запрос с кэшированием
     */
    async get(endpoint, useCache = true) {
        const cacheKey = `GET:${endpoint}`;
        
        if (useCache && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) {
                return cached.data;
            }
        }

        try {
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin'
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (useCache) {
                this.cache.set(cacheKey, {
                    data: data,
                    timestamp: Date.now()
                });
            }

            return data;
        } catch (error) {
            console.error(`Error in GET ${endpoint}:`, error);
            throw error;
        }
    }

    /**
     * Выполнить POST запрос
     */
    async post(endpoint, data) {
        try {
            const response = await fetch(`${this.baseUrl}${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                credentials: 'same-origin',
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }

            // Очищаем кэш после успешного POST
            this.clearCache();

            return await response.json();
        } catch (error) {
            console.error(`Error in POST ${endpoint}:`, error);
            throw error;
        }
    }

    /**
     * Очистить кэш
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Получить список турниров
     */
    async getTournaments() {
        return await this.get('/tournaments');
    }

    /**
     * Получить список команд
     */
    async getTeams() {
        return await this.get('/teams');
    }

    /**
     * Получить список игроков
     */
    async getPlayers(teamId = null) {
        const params = teamId ? `?team_id=${teamId}` : '';
        return await this.get(`/players${params}`);
    }

    /**
     * Получить список матчей
     */
    async getMatches(tournamentId = null, status = null) {
        const params = new URLSearchParams();
        if (tournamentId) params.append('tournament_id', tournamentId);
        if (status) params.append('status', status);
        
        const queryString = params.toString();
        return await this.get(`/matches${queryString ? '?' + queryString : ''}`);
    }

    /**
     * Обновить счет матча
     */
    async updateMatchScore(matchId, homeScore, awayScore) {
        return await this.post(`/match/${matchId}/score`, {
            home_score: homeScore,
            away_score: awayScore
        });
    }

    /**
     * Добавить событие матча
     */
    async addMatchEvent(matchId, eventData) {
        return await this.post(`/match/${matchId}/event`, eventData);
    }

    /**
     * Получить события матча
     */
    async getMatchEvents(matchId) {
        return await this.get(`/match/${matchId}/events`, false); // Без кэша для событий
    }

    /**
     * Получить рейтинг игроков
     */
    async getPlayerRankings(tournamentId, limit = null) {
        const params = limit ? `?limit=${limit}` : '';
        return await this.get(`/tournament/${tournamentId}/rankings${params}`);
    }

    /**
     * Получить состав команды на матч
     */
    async getTeamComposition(matchId, teamId) {
        return await this.get(`/match/${matchId}/composition/${teamId}`);
    }

    /**
     * Добавить игрока в состав
     */
    async addPlayerToComposition(matchId, compositionData) {
        return await this.post(`/match/${matchId}/composition`, compositionData);
    }

    /**
     * Создать нового игрока
     */
    async createPlayer(playerData) {
        return await this.post('/player/create', playerData);
    }

    /**
     * Обновить статистику
     */
    async refreshStatistics() {
        return await this.post('/statistics/refresh', {});
    }
}

// Создаем глобальный экземпляр API
const dbAPI = new DatabaseAPI();

/**
 * Утилиты для работы с данными
 */
class DataUtils {
    /**
     * Форматировать имя игрока
     */
    static formatPlayerName(player) {
        if (typeof player === 'string') return player;
        
        const firstName = player.first_name || '';
        const lastName = player.last_name || '';
        return `${firstName} ${lastName}`.trim();
    }

    /**
     * Форматировать дату матча
     */
    static formatMatchDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * Получить статус матча на русском
     */
    static getMatchStatus(status) {
        const statusMap = {
            'scheduled': 'Запланирован',
            'live': 'В прямом эфире',
            'finished': 'Завершен',
            'cancelled': 'Отменен',
            'postponed': 'Перенесен'
        };
        return statusMap[status] || status;
    }

    /**
     * Получить тип события на русском
     */
    static getEventType(eventType) {
        const eventMap = {
            'goal': 'Гол',
            'assist': 'Передача',
            'yellow_card': 'Желтая карточка',
            'red_card': 'Красная карточка',
            'substitution_in': 'Выход на замену',
            'substitution_out': 'Замена'
        };
        return eventMap[eventType] || eventType;
    }

    /**
     * Получить иконку события
     */
    static getEventIcon(eventType) {
        const iconMap = {
            'goal': '⚽',
            'assist': '🅰️',
            'yellow_card': '🟨',
            'red_card': '🟥',
            'substitution_in': '🔼',
            'substitution_out': '🔽'
        };
        return iconMap[eventType] || '📝';
    }

    /**
     * Сортировать игроков по рейтингу
     */
    static sortPlayersByRanking(players) {
        return players.sort((a, b) => {
            // Сначала по общим очкам (голы + передачи)
            const aPoints = (a.goals_scored || 0) + (a.assists || 0);
            const bPoints = (b.goals_scored || 0) + (b.assists || 0);
            
            if (aPoints !== bPoints) {
                return bPoints - aPoints; // По убыванию
            }
            
            // Потом по количеству матчей (меньше лучше)
            if (a.matches_played !== b.matches_played) {
                return (a.matches_played || 0) - (b.matches_played || 0);
            }
            
            // Потом по голам
            return (b.goals_scored || 0) - (a.goals_scored || 0);
        });
    }
}

/**
 * Компонент для отображения матчей
 */
class MatchDisplay {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.currentTournament = null;
    }

    async loadMatches(tournamentId = null, status = null) {
        try {
            this.currentTournament = tournamentId;
            const response = await dbAPI.getMatches(tournamentId, status);
            this.renderMatches(response.matches);
        } catch (error) {
            console.error('Error loading matches:', error);
            this.showError('Ошибка загрузки матчей');
        }
    }

    renderMatches(matches) {
        if (!this.container) return;

        if (matches.length === 0) {
            this.container.innerHTML = '<p class="no-data">Матчи не найдены</p>';
            return;
        }

        const matchesHtml = matches.map(match => `
            <div class="match-card" data-match-id="${match.id}">
                <div class="match-header">
                    <div class="match-date">${DataUtils.formatMatchDate(match.match_date)}</div>
                    <div class="match-status status-${match.status}">${DataUtils.getMatchStatus(match.status)}</div>
                </div>
                <div class="match-teams">
                    <div class="team home-team">
                        <img src="${match.home_team_logo || '/static/img/team-logos/default.png'}" alt="${match.home_team_name}" class="team-logo">
                        <span class="team-name">${match.home_team_name}</span>
                    </div>
                    <div class="match-score">
                        <span class="score">${match.home_score} : ${match.away_score}</span>
                    </div>
                    <div class="team away-team">
                        <span class="team-name">${match.away_team_name}</span>
                        <img src="${match.away_team_logo || '/static/img/team-logos/default.png'}" alt="${match.away_team_name}" class="team-logo">
                    </div>
                </div>
                ${match.venue ? `<div class="match-venue">📍 ${match.venue}</div>` : ''}
                ${match.referee ? `<div class="match-referee">👨‍⚖️ ${match.referee}</div>` : ''}
                <div class="match-actions">
                    <button class="btn btn-sm" onclick="matchDisplay.showMatchDetails(${match.id})">Подробности</button>
                    ${window.isAdmin ? `<button class="btn btn-sm btn-primary" onclick="matchDisplay.editMatch(${match.id})">Редактировать</button>` : ''}
                </div>
            </div>
        `).join('');

        this.container.innerHTML = matchesHtml;
    }

    async showMatchDetails(matchId) {
        try {
            const [eventsResponse, matchResponse] = await Promise.all([
                dbAPI.getMatchEvents(matchId),
                dbAPI.getMatches(this.currentTournament)
            ]);

            const match = matchResponse.matches.find(m => m.id === matchId);
            const events = eventsResponse.events;

            this.showMatchModal(match, events);
        } catch (error) {
            console.error('Error loading match details:', error);
            this.showError('Ошибка загрузки деталей матча');
        }
    }

    showMatchModal(match, events) {
        // Создаем модальное окно с деталями матча
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>${match.home_team_name} vs ${match.away_team_name}</h2>
                    <button class="close-btn" onclick="this.closest('.modal').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="match-info">
                        <p><strong>Дата:</strong> ${DataUtils.formatMatchDate(match.match_date)}</p>
                        <p><strong>Счет:</strong> ${match.home_score} : ${match.away_score}</p>
                        <p><strong>Статус:</strong> ${DataUtils.getMatchStatus(match.status)}</p>
                        ${match.venue ? `<p><strong>Место:</strong> ${match.venue}</p>` : ''}
                        ${match.referee ? `<p><strong>Судья:</strong> ${match.referee}</p>` : ''}
                    </div>
                    <div class="match-events">
                        <h3>События матча</h3>
                        ${this.renderMatchEvents(events)}
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        modal.style.display = 'flex';
    }

    renderMatchEvents(events) {
        if (events.length === 0) {
            return '<p class="no-data">События не найдены</p>';
        }

        return events.map(event => `
            <div class="event-item">
                <div class="event-time">${event.minute}'${event.additional_time > 0 ? `+${event.additional_time}` : ''}</div>
                <div class="event-icon">${DataUtils.getEventIcon(event.event_type)}</div>
                <div class="event-description">
                    <strong>${DataUtils.getEventType(event.event_type)}</strong><br>
                    ${event.player_name} (${event.team_name})
                    ${event.assisted_by_name ? `<br><small>Передача: ${event.assisted_by_name}</small>` : ''}
                    ${event.description ? `<br><small>${event.description}</small>` : ''}
                </div>
            </div>
        `).join('');
    }

    editMatch(matchId) {
        // Открыть форму редактирования матча
        window.location.href = `/admin/match/${matchId}/edit`;
    }

    showError(message) {
        if (this.container) {
            this.container.innerHTML = `<div class="error-message">${message}</div>`;
        }
    }
}

/**
 * Компонент для отображения рейтинга игроков
 */
class PlayerRankings {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
    }

    async loadRankings(tournamentId, limit = null) {
        try {
            const response = await dbAPI.getPlayerRankings(tournamentId, limit);
            this.renderRankings(response.rankings);
        } catch (error) {
            console.error('Error loading rankings:', error);
            this.showError('Ошибка загрузки рейтинга');
        }
    }

    renderRankings(rankings) {
        if (!this.container) return;

        if (rankings.length === 0) {
            this.container.innerHTML = '<p class="no-data">Статистика не найдена</p>';
            return;
        }

        const rankingsHtml = `
            <table class="rankings-table">
                <thead>
                    <tr>
                        <th>Место</th>
                        <th>Игрок</th>
                        <th>Матчи</th>
                        <th>Голы</th>
                        <th>Передачи</th>
                        <th>Очки</th>
                        <th>ЖК</th>
                        <th>КК</th>
                    </tr>
                </thead>
                <tbody>
                    ${rankings.map(player => `
                        <tr class="ranking-row">
                            <td class="rank">${player.rank}</td>
                            <td class="player-name">${DataUtils.formatPlayerName(player)}</td>
                            <td class="matches">${player.matches_played}</td>
                            <td class="goals">${player.goals_scored}</td>
                            <td class="assists">${player.assists}</td>
                            <td class="points"><strong>${player.total_points}</strong></td>
                            <td class="yellow-cards">${player.yellow_cards}</td>
                            <td class="red-cards">${player.red_cards}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;

        this.container.innerHTML = rankingsHtml;
    }

    showError(message) {
        if (this.container) {
            this.container.innerHTML = `<div class="error-message">${message}</div>`;
        }
    }
}

// Создаем глобальные экземпляры компонентов
const matchDisplay = new MatchDisplay('matches-container');
const playerRankings = new PlayerRankings('rankings-container');

// Экспортируем для использования в других модулях
window.dbAPI = dbAPI;
window.DataUtils = DataUtils;
window.MatchDisplay = MatchDisplay;
window.PlayerRankings = PlayerRankings;
window.matchDisplay = matchDisplay;
window.playerRankings = playerRankings;
