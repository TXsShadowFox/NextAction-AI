/* ===================================================================
   NextAction — "What Should I Do Next?"
   A smart productivity app that picks ONE next action for you.
   =================================================================== */

(function () {
    'use strict';

    // ===== CONSTANTS =====
    const STORAGE_KEY = 'nextaction_goals';
    const CATEGORY_LABELS = {
        work: '💼 Work',
        personal: '🏠 Personal',
        health: '💪 Health',
        learning: '📚 Learning',
        creative: '🎨 Creative',
        finance: '💰 Finance',
        social: '👥 Social',
    };
    const PRIORITY_LABELS = { 3: '🔥 High', 2: '⚡ Medium', 1: '💤 Low' };
    const PRIORITY_CLASSES = { 3: 'high', 2: 'medium', 1: 'low' };

    // ===== GOAL MANAGER =====
    const GoalManager = {
        goals: [],

        load() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                this.goals = raw ? JSON.parse(raw) : [];
            } catch {
                this.goals = [];
            }
        },

        save() {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.goals));
        },

        add(goal) {
            goal.id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
            goal.createdAt = new Date().toISOString();
            goal.lastWorkedAt = null;
            goal.completed = false;
            goal.skippedCount = 0;
            this.goals.push(goal);
            this.save();
            return goal;
        },

        update(id, updates) {
            const goal = this.goals.find(g => g.id === id);
            if (goal) {
                Object.assign(goal, updates);
                this.save();
            }
            return goal;
        },

        remove(id) {
            this.goals = this.goals.filter(g => g.id !== id);
            this.save();
        },

        markCompleted(id) {
            const goal = this.goals.find(g => g.id === id);
            if (goal) {
                goal.completed = true;
                goal.completedAt = new Date().toISOString();
                this.save();
            }
        },

        markWorkedOn(id) {
            const goal = this.goals.find(g => g.id === id);
            if (goal) {
                goal.lastWorkedAt = new Date().toISOString();
                this.save();
            }
        },

        skip(id) {
            const goal = this.goals.find(g => g.id === id);
            if (goal) {
                goal.skippedCount = (goal.skippedCount || 0) + 1;
                this.save();
            }
        },

        getActive() {
            return this.goals.filter(g => !g.completed);
        },

        get(id) {
            return this.goals.find(g => g.id === id);
        }
    };

    // ===== RECOMMENDATION ENGINE =====
    const RecommendationEngine = {
        WEIGHTS: {
            urgency: 0.35,
            priority: 0.25,
            timeFit: 0.20,
            staleness: 0.15,
            skipPenalty: 0.05,
        },

        /**
         * Score a single goal given available minutes.
         * Returns an object { score, reason } or null if it definitely doesn't fit.
         */
        scoreGoal(goal, availableMinutes) {
            const now = new Date();

            // --- Time fit ---
            const estMinutes = parseInt(goal.estimatedMinutes) || 30;
            if (estMinutes > availableMinutes * 1.5) return null; // way too long, filter out

            let timeFitScore;
            if (estMinutes <= availableMinutes) {
                // Fits perfectly — the closer to filling the time, the better
                timeFitScore = 0.5 + 0.5 * (estMinutes / availableMinutes);
            } else {
                // Slightly over — penalise gently
                timeFitScore = Math.max(0, 1 - (estMinutes - availableMinutes) / availableMinutes);
            }

            // --- Priority ---
            const priorityVal = parseInt(goal.priority) || 2;
            const priorityScore = priorityVal / 3;

            // --- Urgency (deadline) ---
            let urgencyScore = 0.3; // default if no deadline
            let urgencyReason = '';
            if (goal.deadline) {
                const deadline = new Date(goal.deadline + 'T23:59:59');
                const hoursLeft = (deadline - now) / (1000 * 60 * 60);
                if (hoursLeft <= 0) {
                    urgencyScore = 1.0;
                    urgencyReason = 'This is overdue!';
                } else if (hoursLeft <= 24) {
                    urgencyScore = 0.95;
                    urgencyReason = 'Due today!';
                } else if (hoursLeft <= 72) {
                    urgencyScore = 0.8;
                    urgencyReason = 'Due very soon';
                } else if (hoursLeft <= 168) {
                    urgencyScore = 0.6;
                    urgencyReason = 'Due this week';
                } else {
                    urgencyScore = Math.max(0.1, 0.5 - (hoursLeft / (720)));
                }
            }

            // --- Staleness (time since last worked on) ---
            let stalenessScore = 0.5;
            if (goal.lastWorkedAt) {
                const hoursSinceWorked = (now - new Date(goal.lastWorkedAt)) / (1000 * 60 * 60);
                stalenessScore = Math.min(1, hoursSinceWorked / 72); // maxes out after 3 days
            } else {
                // Never worked on — high staleness
                const hoursSinceCreated = (now - new Date(goal.createdAt)) / (1000 * 60 * 60);
                stalenessScore = Math.min(1, 0.5 + hoursSinceCreated / 48);
            }

            // --- Skip penalty ---
            const skipPenalty = Math.min(1, (goal.skippedCount || 0) * 0.15);

            // --- Weighted total ---
            const W = this.WEIGHTS;
            const score =
                W.urgency * urgencyScore +
                W.priority * priorityScore +
                W.timeFit * timeFitScore +
                W.staleness * stalenessScore -
                W.skipPenalty * skipPenalty;

            // Build human-readable reason
            const reasons = [];
            if (urgencyReason) reasons.push(urgencyReason);
            if (priorityVal === 3) reasons.push("It's high priority");
            if (stalenessScore > 0.7 && !goal.lastWorkedAt) reasons.push("You haven't started this yet");
            else if (stalenessScore > 0.7) reasons.push("It's been a while since you touched this");
            if (timeFitScore > 0.8) reasons.push("It fits your time window perfectly");

            const reason = reasons.length > 0
                ? reasons.join('. ') + '.'
                : 'This is a solid next step based on your priorities.';

            return { score, reason };
        },

        /**
         * Get the single best next action given available minutes.
         * Returns { goal, reason } or null.
         */
        recommend(goals, availableMinutes, skipIds = []) {
            const candidates = goals
                .filter(g => !skipIds.includes(g.id))
                .map(g => {
                    const result = this.scoreGoal(g, availableMinutes);
                    return result ? { goal: g, ...result } : null;
                })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score);

            return candidates.length > 0 ? candidates[0] : null;
        }
    };

    // ===== UI CONTROLLER =====
    const UI = {
        selectedMinutes: 30,
        currentRecommendation: null,
        skippedIds: [],

        // Cache DOM references
        els: {},

        init() {
            this.cacheElements();
            this.bindEvents();
            this.createParticles();
            GoalManager.load();
            this.updateGoalCount();
            this.renderGoalsList();
            this.updateHeroHint();
        },

        cacheElements() {
            const ids = [
                'btn-open-goals', 'btn-close-goals', 'btn-get-action',
                'btn-done', 'btn-skip', 'btn-back', 'btn-add-first-goal',
                'btn-no-match-back', 'btn-save-goal', 'btn-cancel-edit',
                'goal-count', 'goal-form', 'goal-id',
                'goal-title', 'goal-category', 'goal-priority',
                'goal-time', 'goal-deadline', 'goal-notes',
                'goals-panel', 'goals-list', 'overlay',
                'hero-section', 'result-section', 'empty-state', 'no-match-state',
                'result-badge', 'result-title', 'result-category',
                'result-time', 'result-priority', 'result-deadline',
                'result-reason', 'result-card',
                'time-available', 'form-title', 'hero-hint',
                'particles'
            ];
            ids.forEach(id => {
                this.els[id] = document.getElementById(id);
            });
        },

        bindEvents() {
            // Goals panel
            this.els['btn-open-goals'].addEventListener('click', () => this.openGoalsPanel());
            this.els['btn-close-goals'].addEventListener('click', () => this.closeGoalsPanel());
            this.els['overlay'].addEventListener('click', () => this.closeGoalsPanel());

            // Time chips
            document.querySelectorAll('.time-chip').forEach(chip => {
                chip.addEventListener('click', () => {
                    document.querySelectorAll('.time-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                    this.selectedMinutes = parseInt(chip.dataset.minutes);
                    this.els['time-available'].value = '';
                });
            });

            // Custom time input
            this.els['time-available'].addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                if (val > 0) {
                    document.querySelectorAll('.time-chip').forEach(c => c.classList.remove('active'));
                    this.selectedMinutes = val;
                }
            });

            // Main action button
            this.els['btn-get-action'].addEventListener('click', () => this.getNextAction());

            // Result actions
            this.els['btn-done'].addEventListener('click', () => this.markDone());
            this.els['btn-skip'].addEventListener('click', () => this.skipAction());
            this.els['btn-back'].addEventListener('click', () => this.goBack());

            // Empty state buttons
            this.els['btn-add-first-goal'].addEventListener('click', () => this.openGoalsPanel());
            this.els['btn-no-match-back'].addEventListener('click', () => this.goBack());

            // Goal form
            this.els['goal-form'].addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveGoal();
            });
            this.els['btn-cancel-edit'].addEventListener('click', () => this.resetForm());

            // Keyboard shortcut
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.closeGoalsPanel();
            });
        },

        // --- Particles ---
        createParticles() {
            const container = this.els['particles'];
            const colors = ['rgba(139,92,246,0.3)', 'rgba(6,182,212,0.2)', 'rgba(244,63,94,0.15)'];
            for (let i = 0; i < 20; i++) {
                const p = document.createElement('div');
                p.className = 'particle';
                const size = Math.random() * 4 + 2;
                p.style.width = size + 'px';
                p.style.height = size + 'px';
                p.style.left = Math.random() * 100 + '%';
                p.style.top = (80 + Math.random() * 20) + '%';
                p.style.background = colors[Math.floor(Math.random() * colors.length)];
                p.style.animationDelay = (Math.random() * 12) + 's';
                p.style.animationDuration = (8 + Math.random() * 8) + 's';
                container.appendChild(p);
            }
        },

        // --- Panels ---
        openGoalsPanel() {
            this.els['goals-panel'].classList.add('open');
            this.els['overlay'].classList.remove('hidden');
            requestAnimationFrame(() => this.els['overlay'].classList.add('visible'));
        },

        closeGoalsPanel() {
            this.els['goals-panel'].classList.remove('open');
            this.els['overlay'].classList.remove('visible');
            setTimeout(() => this.els['overlay'].classList.add('hidden'), 300);
            this.resetForm();
        },

        // --- Sections ---
        showSection(sectionId) {
            ['hero-section', 'result-section', 'empty-state', 'no-match-state'].forEach(id => {
                this.els[id].classList.add('hidden');
            });
            this.els[sectionId].classList.remove('hidden');
        },

        goBack() {
            this.skippedIds = [];
            this.currentRecommendation = null;
            this.showSection('hero-section');
        },

        // --- Main Flow ---
        getNextAction() {
            const active = GoalManager.getActive();
            if (active.length === 0) {
                this.showSection('empty-state');
                return;
            }

            const minutes = this.selectedMinutes;
            const result = RecommendationEngine.recommend(active, minutes, this.skippedIds);

            if (!result) {
                // Try without skip filter
                const fallback = RecommendationEngine.recommend(active, minutes, []);
                if (!fallback) {
                    // Truly no match — suggest the quickest goal
                    const quickest = [...active].sort((a, b) =>
                        (parseInt(a.estimatedMinutes) || 30) - (parseInt(b.estimatedMinutes) || 30)
                    )[0];
                    const quickMin = parseInt(quickest.estimatedMinutes) || 30;
                    document.getElementById('no-match-text').textContent =
                        `Your quickest goal "${quickest.title}" needs about ${quickMin} minutes. Try giving yourself a bit more time.`;
                }
                this.showSection('no-match-state');
                return;
            }

            this.currentRecommendation = result;
            this.showResult(result);
        },

        showResult({ goal, reason }) {
            this.showSection('result-section');

            // Populate
            this.els['result-title'].textContent = goal.notes
                ? goal.notes
                : goal.title;

            this.els['result-category'].textContent =
                (goal.notes ? `Goal: ${goal.title} · ` : '') +
                (CATEGORY_LABELS[goal.category] || goal.category);

            this.els['result-time'].textContent = `~${goal.estimatedMinutes || 30} min`;
            this.els['result-priority'].textContent = PRIORITY_LABELS[goal.priority] || 'Medium';

            if (goal.deadline) {
                const d = new Date(goal.deadline + 'T00:00:00');
                const now = new Date();
                const diffDays = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
                let deadlineText;
                if (diffDays < 0) deadlineText = `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? 's' : ''}`;
                else if (diffDays === 0) deadlineText = 'Due today';
                else if (diffDays === 1) deadlineText = 'Due tomorrow';
                else deadlineText = `${diffDays} days left`;
                this.els['result-deadline'].textContent = deadlineText;
                document.getElementById('meta-deadline').style.display = 'flex';
            } else {
                document.getElementById('meta-deadline').style.display = 'none';
            }

            this.els['result-reason'].textContent = `"${reason}"`;

            // Trigger animation
            this.els['result-card'].style.animation = 'none';
            this.els['result-card'].offsetHeight; // reflow
            this.els['result-card'].style.animation = 'resultReveal 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)';
        },

        markDone() {
            if (this.currentRecommendation) {
                GoalManager.markCompleted(this.currentRecommendation.goal.id);
                this.miniConfetti();
                this.updateGoalCount();
                this.renderGoalsList();
                this.updateHeroHint();

                // Auto-get next
                this.skippedIds = [];
                setTimeout(() => {
                    const active = GoalManager.getActive();
                    if (active.length > 0) {
                        this.getNextAction();
                    } else {
                        this.showSection('hero-section');
                    }
                }, 800);
            }
        },

        skipAction() {
            if (this.currentRecommendation) {
                GoalManager.skip(this.currentRecommendation.goal.id);
                this.skippedIds.push(this.currentRecommendation.goal.id);
                this.getNextAction();
            }
        },

        miniConfetti() {
            const colors = ['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e'];
            for (let i = 0; i < 30; i++) {
                const piece = document.createElement('div');
                piece.className = 'confetti-piece';
                piece.style.left = (30 + Math.random() * 40) + 'vw';
                piece.style.top = (30 + Math.random() * 20) + 'vh';
                piece.style.width = (Math.random() * 8 + 4) + 'px';
                piece.style.height = (Math.random() * 8 + 4) + 'px';
                piece.style.background = colors[Math.floor(Math.random() * colors.length)];
                piece.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
                piece.style.animationDuration = (1 + Math.random()) + 's';
                document.body.appendChild(piece);
                setTimeout(() => piece.remove(), 2000);
            }
        },

        // --- Goal CRUD ---
        saveGoal() {
            const id = this.els['goal-id'].value;
            const data = {
                title: this.els['goal-title'].value.trim(),
                category: this.els['goal-category'].value,
                priority: parseInt(this.els['goal-priority'].value),
                estimatedMinutes: parseInt(this.els['goal-time'].value) || 30,
                deadline: this.els['goal-deadline'].value || null,
                notes: this.els['goal-notes'].value.trim() || null,
            };

            if (!data.title) return;

            if (id) {
                GoalManager.update(id, data);
            } else {
                GoalManager.add(data);
            }

            this.resetForm();
            this.renderGoalsList();
            this.updateGoalCount();
            this.updateHeroHint();
        },

        editGoal(id) {
            const goal = GoalManager.get(id);
            if (!goal) return;

            this.els['goal-id'].value = goal.id;
            this.els['goal-title'].value = goal.title;
            this.els['goal-category'].value = goal.category;
            this.els['goal-priority'].value = goal.priority;
            this.els['goal-time'].value = goal.estimatedMinutes || 30;
            this.els['goal-deadline'].value = goal.deadline || '';
            this.els['goal-notes'].value = goal.notes || '';
            this.els['form-title'].textContent = 'Edit Goal';
            this.els['goal-title'].focus();
        },

        deleteGoal(id) {
            GoalManager.remove(id);
            this.renderGoalsList();
            this.updateGoalCount();
            this.updateHeroHint();
        },

        resetForm() {
            this.els['goal-form'].reset();
            this.els['goal-id'].value = '';
            this.els['form-title'].textContent = 'Add New Goal';
            this.els['goal-priority'].value = '2';
            this.els['goal-time'].value = '30';
        },

        // --- Render ---
        renderGoalsList() {
            const list = this.els['goals-list'];
            const goals = GoalManager.goals;

            if (goals.length === 0) {
                list.innerHTML = `
                    <div class="goals-empty">
                        <div class="goals-empty-icon">📋</div>
                        <p>No goals yet. Add one above to get started!</p>
                    </div>`;
                return;
            }

            // Sort: active first (by priority desc), then completed
            const sorted = [...goals].sort((a, b) => {
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                return (b.priority || 2) - (a.priority || 2);
            });

            list.innerHTML = sorted.map(g => {
                const pClass = PRIORITY_CLASSES[g.priority] || 'medium';
                const catLabel = CATEGORY_LABELS[g.category] || g.category;
                let deadlineMeta = '';
                if (g.deadline) {
                    const d = new Date(g.deadline + 'T00:00:00');
                    deadlineMeta = `<span>📅 ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
                }
                return `
                <div class="goal-item ${g.completed ? 'completed' : ''}" data-id="${g.id}">
                    <div class="goal-priority-dot ${pClass}"></div>
                    <div class="goal-item-body">
                        <div class="goal-item-title">${this.escapeHtml(g.title)}</div>
                        <div class="goal-item-meta">
                            <span>${catLabel}</span>
                            <span>⏱ ${g.estimatedMinutes || 30}m</span>
                            ${deadlineMeta}
                        </div>
                    </div>
                    <div class="goal-item-actions">
                        ${g.completed ? '' : `
                            <button class="btn-edit" title="Edit" data-id="${g.id}">✏️</button>
                        `}
                        <button class="btn-delete" title="Delete" data-id="${g.id}">🗑️</button>
                    </div>
                </div>`;
            }).join('');

            // Bind action buttons
            list.querySelectorAll('.btn-edit').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.editGoal(btn.dataset.id);
                });
            });
            list.querySelectorAll('.btn-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.deleteGoal(btn.dataset.id);
                });
            });
        },

        updateGoalCount() {
            const active = GoalManager.getActive();
            this.els['goal-count'].textContent = active.length;
        },

        updateHeroHint() {
            const active = GoalManager.getActive();
            const hint = this.els['hero-hint'];
            if (active.length === 0) {
                hint.textContent = 'Add some goals first using the "My Goals" button above →';
            } else if (active.length === 1) {
                hint.textContent = '1 active goal ready';
            } else {
                hint.textContent = `${active.length} active goals — I'll pick the best one for you`;
            }
        },

        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
    };

    // ===== BOOT =====
    document.addEventListener('DOMContentLoaded', () => UI.init());
})();
