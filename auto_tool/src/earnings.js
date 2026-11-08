/**
 * earnings
 * Reads Tbrain time statistics and renders earnings in the page header.
 * Dependencies: auth, config, environment, logger, runtime.
 */
module.exports = function createEarnings(modules) {
    'use strict';
    const TOTAL_REFRESH_MS = 30000;
    const TASK_REFRESH_MS = 1000;
    const TASK_LIST_PAGE_SIZE = 100;
    const SUBMISSION_REQUEST_DELAY_MS = 200;
    const UTC_PLUS_7_MS = 7 * 60 * 60 * 1000;
    const TIMELINE_SELECTOR = '[data-testid="timeline-hours"]';
    const HEADER_DISPLAY_ID = 'tb-earnings-header-display';
    const TOTAL_DISPLAY_ID = 'tb-earnings-display';
    const TODAY_DISPLAY_ID = 'tb-today-earnings-display';
    const TASK_DISPLAY_ID = 'tb-task-earnings-display';
    const MY_REPORT_SELECTOR = '[data-testid="my-labelling-report"]';
    const MY_REPORT_CARD_SELECTORS = [
        '[data-testid="my-labelling-sessions"]',
        '[data-testid="my-labelling-hours"]',
        '[data-testid="my-labelling-pending"]',
        '[data-testid="my-labelling-passed"]',
        '[data-testid="my-labelling-failed"]',
        '[data-testid="my-labelling-pass-rate"]'
    ];
    const WORKING_HOURS_CARD_SELECTOR = '[data-testid="tb-working-hours-card"]';
    const DAILY_TRACKING_STORAGE_KEY = `tb_earnings_daily_${modules.config.PROJECT_ID}`;
    const SUBMISSION_CACHE_STORAGE_KEY = `tb_earnings_submissions_${modules.config.PROJECT_ID}`;
    let started = false;
    let updatingTotal = false;
    let totalSeconds = null;
    let todaySeconds = null;
    let reportTodaySeconds = null;
    let monthSeconds = null;
    let todayDateKey = '';
    let reportTodayDateKey = '';
    let reportMonthKey = '';
    let lastReportRefreshPeriod = '';
    let todayIsEstimated = false;
    let todayTrackingStartedAt = 0;
    let todayDataError = '';
    let reportDataError = '';
    let reportDataWarning = '';
    let lastTodayDataWarning = '';
    let lastExtraDateWarning = '';
    let lastUpdateError = '';
    let dailyTracking = null;
    let dailyTrackingLoaded = false;
    let dailyTrackingStorageWarningLogged = false;

    function formatMoney(amount) {
        return `${Math.round(amount).toLocaleString('vi-VN')} đ`;
    }

    function formatDuration(seconds) {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
            return '—';
        const totalMinutes = Math.floor(seconds / 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        return `${hours} h ${String(minutes).padStart(2, '0')} min`;
    }

    function ensureHeaderDisplays() {
        const themeToggle = document.querySelector('[data-testid="theme-toggle"]');
        const actionGroup = themeToggle && themeToggle.parentElement
            ? themeToggle.parentElement
            : document.getElementById('tbp-row-fetch');
        if (!actionGroup)
            return;
        const insertionTarget = themeToggle && themeToggle.parentElement === actionGroup ? themeToggle : null;
        let container = document.getElementById(HEADER_DISPLAY_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = HEADER_DISPLAY_ID;
            container.className = 'tbp-earnings-group';
        }
        if (container.parentElement !== actionGroup)
            actionGroup.insertBefore(container, insertionTarget);
        else if (insertionTarget)
            actionGroup.insertBefore(container, insertionTarget);
        let total = document.getElementById(TOTAL_DISPLAY_ID);
        if (!total) {
            total = document.createElement('span');
            total.id = TOTAL_DISPLAY_ID;
            total.className = 'tbp-earnings-total';
            total.textContent = '💰 —';
        }
        if (total.parentElement !== container)
            container.appendChild(total);
        let today = document.getElementById(TODAY_DISPLAY_ID);
        if (!today) {
            today = document.createElement('span');
            today.id = TODAY_DISPLAY_ID;
            today.className = 'tbp-earnings-today';
            today.textContent = '📅 Hôm nay: —';
        }
        if (today.parentElement !== container)
            container.appendChild(today);
        let task = document.getElementById(TASK_DISPLAY_ID);
        if (!task) {
            task = document.createElement('span');
            task.id = TASK_DISPLAY_ID;
            task.className = 'tbp-earnings-task';
            task.textContent = '🎯 Task: —';
        }
        if (task.parentElement !== container)
            container.appendChild(task);
    }

    function localDateKey(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        const utcPlus7 = new Date(date.getTime() + UTC_PLUS_7_MS);
        return `${utcPlus7.getUTCFullYear()}-${pad(utcPlus7.getUTCMonth() + 1)}-${pad(utcPlus7.getUTCDate())}`;
    }

    function localMonthKey(date = new Date()) {
        const pad = value => String(value).padStart(2, '0');
        const utcPlus7 = new Date(date.getTime() + UTC_PLUS_7_MS);
        return `${utcPlus7.getUTCFullYear()}-${pad(utcPlus7.getUTCMonth() + 1)}`;
    }

    function syncWorkingHoursPeriod(today, month) {
        const now = new Date();
        today = today || localDateKey(now);
        month = month || localMonthKey(now);
        let changed = false;
        if (reportTodayDateKey !== today) {
            reportTodayDateKey = today;
            reportTodaySeconds = null;
            reportDataError = '';
            changed = true;
        }
        if (reportMonthKey !== month) {
            reportMonthKey = month;
            monthSeconds = null;
            reportDataError = '';
            changed = true;
        }
        if (changed)
            reportDataWarning = '';
        return `${today}|${month}`;
    }

    function isMyLabellingReport(report) {
        if (!report)
            return false;
        const reportText = String(report.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (reportText.includes('my labelling work'))
            return true;
        const headings = report.querySelectorAll('h1, h2, h3, h4, [role="heading"]');
        return Array.from(headings).some(heading => String(heading.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase() === 'my labelling work');
    }

    function findDirectGridChild(grid, element) {
        let current = element;
        while (current && current.parentElement !== grid)
            current = current.parentElement;
        return current && current.parentElement === grid ? current : null;
    }

    function findMyReportGrid(report) {
        const cards = MY_REPORT_CARD_SELECTORS.map(selector => report.querySelector(selector));
        if (cards.some(card => !card))
            return null;
        let candidate = cards[1].parentElement;
        while (candidate && candidate !== report) {
            const directChildren = cards.map(card => findDirectGridChild(candidate, card));
            if (directChildren.every(Boolean) && new Set(directChildren).size === cards.length)
                return candidate;
            candidate = candidate.parentElement;
        }
        return null;
    }

    function createWorkingHoursCard(hoursCard) {
        const card = document.createElement('div');
        const sourceClassName = typeof hoursCard.className === 'string'
            ? hoursCard.className
            : hoursCard.getAttribute('class') || '';
        card.className = sourceClassName;
        card.setAttribute('data-testid', 'tb-working-hours-card');
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', 'Working hours this month and today');
        card.style.cssText = 'position:relative;overflow:hidden;height:100%;'
            + 'border-top:3px solid var(--tb-brand-blue,#38bdf8);';

        const content = document.createElement('div');
        content.style.cssText = 'display:flex;flex-direction:column;justify-content:space-between;'
            + 'gap:6px;min-height:84px;padding-top:2px;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
        const title = document.createElement('span');
        title.textContent = 'WORKING HOURS';
        title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            + 'font-size:10px;font-weight:700;letter-spacing:.07em;'
            + 'color:var(--tb-brand-blue,#0ea5e9);';
        const clock = document.createElement('span');
        clock.textContent = '◷';
        clock.setAttribute('aria-hidden', 'true');
        clock.style.cssText = 'flex:0 0 auto;font-size:19px;line-height:1;'
            + 'color:var(--tb-brand-blue,#38bdf8);';
        header.append(title, clock);
        content.appendChild(header);

        const addMetric = (labelText, testId, valueColor, valueSize) => {
            const metric = document.createElement('div');
            metric.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
            const label = document.createElement('span');
            label.textContent = labelText;
            label.style.cssText = 'font-size:10px;line-height:1.15;'
                + 'color:var(--muted-foreground,#64748b);';
            const value = document.createElement('span');
            value.setAttribute('data-testid', testId);
            value.textContent = '—';
            value.style.cssText = `font-size:${valueSize}px;line-height:1.2;font-weight:700;`
                + `white-space:nowrap;color:${valueColor};`;
            metric.append(label, value);
            content.appendChild(metric);
        };
        addMetric('Tháng này', 'tb-working-hours-month', 'var(--foreground,inherit)', 15);
        addMetric('Hôm nay', 'tb-working-hours-today', 'var(--tb-brand-blue,#38bdf8)', 13);
        card.appendChild(content);
        return card;
    }

    function renderMyReportWorkingHours() {
        const report = document.querySelector(MY_REPORT_SELECTOR);
        const card = report && report.querySelector(WORKING_HOURS_CARD_SELECTOR);
        if (!card)
            return;
        const month = card.querySelector('[data-testid="tb-working-hours-month"]');
        const today = card.querySelector('[data-testid="tb-working-hours-today"]');
        if (month)
            month.textContent = formatDuration(monthSeconds);
        if (today)
            today.textContent = formatDuration(reportTodaySeconds);
        card.title = [reportDataError, reportDataWarning].filter(Boolean).join('\n');
    }

    function ensureMyReportWorkingHoursCard() {
        const now = new Date();
        const today = localDateKey(now);
        const month = localMonthKey(now);
        const periodKey = syncWorkingHoursPeriod(today, month);
        const report = document.querySelector(MY_REPORT_SELECTOR);
        if (!isMyLabellingReport(report))
            return false;
        const grid = findMyReportGrid(report);
        if (!grid)
            return false;
        const hoursCard = report.querySelector(MY_REPORT_CARD_SELECTORS[1]);
        const hoursGridChild = findDirectGridChild(grid, hoursCard);
        if (!hoursGridChild)
            return false;

        const existingCards = Array.from(report.querySelectorAll(WORKING_HOURS_CARD_SELECTOR));
        const card = existingCards[0] || createWorkingHoursCard(hoursCard);
        existingCards.slice(1).forEach(duplicate => duplicate.remove());
        if (card.parentElement !== grid || card !== hoursGridChild.nextElementSibling)
            grid.insertBefore(card, hoursGridChild.nextElementSibling);
        renderMyReportWorkingHours();

        if (started && !updatingTotal && lastReportRefreshPeriod !== periodKey) {
            lastReportRefreshPeriod = periodKey;
            void updateMyEarnings();
        }
        return true;
    }

    function submissionDateKey(value) {
        const timestamp = typeof value === 'number'
            ? Math.abs(value) < 1e12 ? value * 1000 : value
            : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
        return Number.isFinite(timestamp) ? localDateKey(new Date(timestamp)) : '';
    }

    function renderTodayEarnings() {
        const currentDate = localDateKey();
        if (todayDateKey !== currentDate) {
            todayDateKey = currentDate;
            todaySeconds = null;
            todayIsEstimated = false;
            todayTrackingStartedAt = 0;
            todayDataError = 'Chưa có thống kê cho ngày hiện tại';
            lastTodayDataWarning = '';
        }
        const element = document.getElementById(TODAY_DISPLAY_ID);
        if (!element)
            return;
        if (todaySeconds === null) {
            element.textContent = '📅 Hôm nay: —';
            element.title = todayDataError || 'Đang tải thống kê theo ngày';
            if (lastUpdateError)
                element.title += `\nLỗi cập nhật gần nhất: ${lastUpdateError}`;
            return;
        }
        const hours = todaySeconds / 3600;
        const amount = hours * modules.config.EARNINGS_RATE_VND_PER_HOUR;
        element.textContent = `📅 Hôm nay: ${todayIsEstimated ? '~' : ''}${formatMoney(amount)}`;
        element.title = `${todayIsEstimated ? 'Tạm tính' : 'Theo dữ liệu ngày'} ${todayDateKey}: ${hours.toFixed(2)}h (${todaySeconds.toFixed(0)} giây)`;
        if (todayIsEstimated && todayTrackingStartedAt) {
            const startedAt = new Date(todayTrackingStartedAt);
            const time = startedAt.toLocaleTimeString('vi-VN', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: 'Asia/Ho_Chi_Minh'
            });
            element.title += `\nTheo dõi từ ${time}; không gồm dữ liệu trước thời điểm này.`;
        }
        if (todayDataError)
            element.title += `\n${todayDataError}`;
        if (lastUpdateError)
            element.title += `\nLỗi cập nhật gần nhất: ${lastUpdateError}`;
    }

    function renderTotalEarnings() {
        ensureHeaderDisplays();
        const element = document.getElementById(TOTAL_DISPLAY_ID);
        if (element) {
            if (totalSeconds === null) {
                element.textContent = '💰 —';
                element.title = lastUpdateError ? `Không cập nhật được: ${lastUpdateError}` : 'Đang tải thống kê thu nhập';
            }
            else {
                const hours = totalSeconds / 3600;
                const amount = hours * modules.config.EARNINGS_RATE_VND_PER_HOUR;
                element.textContent = `💰 ${formatMoney(amount)}`;
                element.title = `Tổng thời gian: ${hours.toFixed(2)}h (${totalSeconds.toFixed(0)} giây)`;
                if (lastUpdateError)
                    element.title += `\nLỗi cập nhật gần nhất: ${lastUpdateError}`;
            }
        }
        renderTodayEarnings();
    }

    function readRecordedDuration() {
        const timelineElement = document.querySelector(TIMELINE_SELECTOR);
        if (!timelineElement)
            return null;
        const recordedPart = (timelineElement.textContent || '').split('/')[0].trim();
        const hourMatch = recordedPart.match(/(\d+)\s*h\b/i);
        const minuteMatch = recordedPart.match(/(\d+)\s*min\b/i);
        if (!hourMatch && !minuteMatch)
            return { recordedPart, minutes: null };
        const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0;
        const minutes = minuteMatch ? parseInt(minuteMatch[1], 10) : 0;
        return { recordedPart, minutes: hours * 60 + minutes };
    }

    function calculateTaskEarningsFromTimeline() {
        const duration = readRecordedDuration();
        if (!duration || duration.minutes === null)
            return 0;
        return Math.round((duration.minutes / 60) * modules.config.EARNINGS_RATE_VND_PER_HOUR);
    }

    function updateTaskEarnings() {
        renderTotalEarnings();
        const element = document.getElementById(TASK_DISPLAY_ID);
        if (!element)
            return;
        try {
            const duration = readRecordedDuration();
            if (!duration || duration.minutes === null) {
                element.textContent = '🎯 Task: —';
                element.title = 'Chưa đọc được thời lượng đã record trên timeline';
                return;
            }
            const amount = (duration.minutes / 60) * modules.config.EARNINGS_RATE_VND_PER_HOUR;
            element.textContent = `🎯 Task: ${formatMoney(amount)}`;
            element.title = `Thời lượng đã record: ${duration.recordedPart}`;
        }
        catch (error) {
            modules.logger.console.warn('[Earnings] Không đọc được thời lượng task:', error);
        }
    }

    function readNonNegativeSeconds(value, label) {
        if (value === null || value === undefined || (typeof value === 'string' && !value.trim()))
            throw new Error(`${label} không hợp lệ`);
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0)
            throw new Error(`${label} không hợp lệ`);
        return seconds;
    }

    function normalizeDateKey(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            const timestamp = Math.abs(value) < 1e12 ? value * 1000 : value;
            const date = new Date(timestamp);
            return Number.isFinite(date.getTime()) ? localDateKey(date) : '';
        }
        if (typeof value !== 'string' || !value.trim())
            return '';
        const text = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
            const [year, month, day] = text.split('-').map(Number);
            const date = new Date(Date.UTC(year, month - 1, day));
            return date.getUTCFullYear() === year
                && date.getUTCMonth() + 1 === month
                && date.getUTCDate() === day
                ? text
                : '';
        }
        const timestamp = Date.parse(text);
        return Number.isFinite(timestamp) ? localDateKey(new Date(timestamp)) : '';
    }

    function recordDateKey(record) {
        if (!record || typeof record !== 'object' || Array.isArray(record))
            return '';
        for (const field of [
            'date', 'day', 'dateKey', 'createdAt', 'created_at',
            'recordedAt', 'recorded_at', 'timestamp', 'startDate', 'start_date'
        ]) {
            const key = normalizeDateKey(record[field]);
            if (key)
                return key;
        }
        return '';
    }

    function readExtraSecondsForPeriod(extraData, predicate) {
        if (!Array.isArray(extraData))
            throw new Error('Dữ liệu extra-hours không đúng định dạng');
        let total = 0;
        for (let index = 0; index < extraData.length; index++) {
            const item = extraData[index];
            const itemDate = recordDateKey(item);
            if (!itemDate)
                return null;
            if (predicate(itemDate))
                total += readNonNegativeSeconds(item.seconds, `extra-hours[${index}].seconds`);
        }
        return total;
    }

    function readTodayExtraSeconds(extraData, today) {
        return readExtraSecondsForPeriod(extraData, itemDate => itemDate === today);
    }

    function readMonthExtraSeconds(extraData, month) {
        return readExtraSecondsForPeriod(extraData, itemDate => itemDate.slice(0, 7) === month);
    }

    function readDatedExtraSecondsForPeriod(extraData, predicate) {
        if (!Array.isArray(extraData))
            throw new Error('Dữ liệu extra-hours không đúng định dạng');
        let total = 0;
        let hasUndatedRecords = false;
        for (let index = 0; index < extraData.length; index++) {
            const item = extraData[index];
            const itemDate = recordDateKey(item);
            if (!itemDate) {
                hasUndatedRecords = true;
                continue;
            }
            if (predicate(itemDate))
                total += readNonNegativeSeconds(item.seconds, `extra-hours[${index}].seconds`);
        }
        return { seconds: total, hasUndatedRecords };
    }

    function loadSubmissionCache() {
        const raw = modules.environment.W.localStorage.getItem(SUBMISSION_CACHE_STORAGE_KEY);
        if (!raw)
            return new Map();
        const stored = JSON.parse(raw);
        if (!stored || typeof stored !== 'object' || Array.isArray(stored))
            throw new Error('Cache submissions không đúng định dạng');
        const cache = new Map();
        for (const [submissionId, record] of Object.entries(stored)) {
            const validDate = value => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
            const validRecord = record
                && typeof record === 'object'
                && typeof record.taskId === 'string'
                && typeof record.taskStatus === 'string'
                && typeof record.status === 'string'
                && validDate(record.submittedDay)
                && typeof record.checkedDay === 'string'
                && /^\d{4}-\d{2}-\d{2}$/.test(record.checkedDay)
                && typeof record.seconds === 'number'
                && Number.isFinite(record.seconds)
                && record.seconds >= 0;
            if (!submissionId || !validRecord)
                throw new Error('Cache submissions chứa mục không hợp lệ');
            cache.set(submissionId, record);
        }
        return cache;
    }

    function saveSubmissionCache(cache) {
        modules.environment.W.localStorage.setItem(
            SUBMISSION_CACHE_STORAGE_KEY,
            JSON.stringify(Object.fromEntries(cache))
        );
    }

    function indexSubmissionCache(cache) {
        const byTaskId = new Map();
        for (const [submissionId, record] of cache) {
            const previous = byTaskId.get(record.taskId);
            const recordDay = record.submittedDay || record.checkedDay;
            const previousDay = previous ? previous.submittedDay || previous.checkedDay : '';
            if (!previous || recordDay >= previousDay)
                byTaskId.set(record.taskId, { ...record, submissionId });
        }
        return byTaskId;
    }

    function submissionEpisodeSeconds(submission) {
        if (!Array.isArray(submission.artifacts))
            throw new Error('Submission thiếu artifacts');
        let total = 0;
        for (let artifactIndex = 0; artifactIndex < submission.artifacts.length; artifactIndex++) {
            const artifact = submission.artifacts[artifactIndex];
            const episodes = artifact && artifact.data && artifact.data.episodes;
            if (!Array.isArray(episodes))
                throw new Error(`artifacts[${artifactIndex}].data.episodes không hợp lệ`);
            for (let episodeIndex = 0; episodeIndex < episodes.length; episodeIndex++) {
                const episode = episodes[episodeIndex];
                if (!episode || typeof episode !== 'object')
                    throw new Error(`episodes[${episodeIndex}] không hợp lệ`);
                const start = readNonNegativeSeconds(episode.start_seconds, `episodes[${episodeIndex}].start_seconds`);
                const end = readNonNegativeSeconds(episode.end_seconds, `episodes[${episodeIndex}].end_seconds`);
                if (end < start)
                    throw new Error(`episodes[${episodeIndex}] có end_seconds nhỏ hơn start_seconds`);
                total += end - start;
            }
        }
        return total;
    }

    async function readSubmissionSecondsByPeriod(token, todayLocalKey, monthKey) {
        const cache = loadSubmissionCache();
        const tasksUrl = page => `${modules.config.API_BASE}/api/v1/tasks?page=${page}&pageSize=${TASK_LIST_PAGE_SIZE}&projectId=${encodeURIComponent(modules.config.PROJECT_ID)}`;
        const firstPage = await getJson(tasksUrl(1), token);
        if (!firstPage || !Array.isArray(firstPage.data) || !firstPage.pagination)
            throw new Error('Danh sách tasks không đúng định dạng');
        const totalTasks = Number(firstPage.pagination.total);
        if (!Number.isSafeInteger(totalTasks) || totalTasks < 0)
            throw new Error('pagination.total không hợp lệ');
        const tasks = firstPage.data.slice();
        const pageCount = Math.max(1, Math.ceil(totalTasks / TASK_LIST_PAGE_SIZE));
        for (let page = 2; page <= pageCount; page++) {
            const result = await getJson(tasksUrl(page), token);
            if (!result || !Array.isArray(result.data))
                throw new Error(`Danh sách tasks trang ${page} không đúng định dạng`);
            tasks.push(...result.data);
        }

        const uniqueTasks = new Map();
        for (const task of tasks) {
            if (!task || task.id === null || task.id === undefined || typeof task.status !== 'string')
                throw new Error('Task trong danh sách không hợp lệ');
            uniqueTasks.set(String(task.id), task);
        }
        const cachedByTaskId = indexSubmissionCache(cache);
        let todayTotalSeconds = 0;
        let monthTotalSeconds = 0;
        const addSubmissionSeconds = (submittedDay, seconds) => {
            if (!submittedDay)
                return;
            if (submittedDay === todayLocalKey)
                todayTotalSeconds += seconds;
            if (submittedDay.slice(0, 7) === monthKey)
                monthTotalSeconds += seconds;
        };
        for (const [taskId, task] of uniqueTasks) {
            const taskStatus = task.status.toLowerCase();
            if (taskStatus === 'claimed')
                continue;
            const cached = cachedByTaskId.get(taskId);
            if (cached && cached.submittedDay && cached.submittedDay < todayLocalKey) {
                addSubmissionSeconds(cached.submittedDay, cached.seconds);
                continue;
            }
            if (cached && cached.taskStatus === taskStatus && cached.status === 'draft')
                continue;
            if (cached && cached.taskStatus === taskStatus && cached.submittedDay === todayLocalKey) {
                addSubmissionSeconds(cached.submittedDay, cached.seconds);
                continue;
            }

            await modules.runtime.bgSleep(SUBMISSION_REQUEST_DELAY_MS);
            const taskDetailsUrl = `${modules.config.API_BASE}/api/v1/tasks/${encodeURIComponent(taskId)}`;
            const taskDetails = await getJson(taskDetailsUrl, token);
            const submissionIdValue = taskDetails && taskDetails.submission && taskDetails.submission.id;
            if (submissionIdValue === null || submissionIdValue === undefined || String(submissionIdValue) === '')
                throw new Error(`Task ${taskId} không có submission.id`);
            const submissionId = String(submissionIdValue);

            await modules.runtime.bgSleep(SUBMISSION_REQUEST_DELAY_MS);
            const submissionUrl = `${modules.config.API_BASE}/api/v1/submissions/${encodeURIComponent(submissionId)}`;
            const submission = await getJson(submissionUrl, token);
            if (!submission || typeof submission !== 'object' || Array.isArray(submission))
                throw new Error(`Submission ${submissionId} không đúng định dạng`);
            const submissionStatus = typeof submission.status === 'string' ? submission.status.toLowerCase() : '';
            if (!submissionStatus)
                throw new Error(`Submission ${submissionId} thiếu status`);
            const submittedDay = submissionStatus === 'draft'
                ? null
                : submissionDateKey(submission.submittedAt);
            if (submissionStatus !== 'draft' && !submittedDay)
                throw new Error(`Submission ${submissionId} thiếu submittedAt hợp lệ`);
            const seconds = submissionStatus === 'draft' ? 0 : submissionEpisodeSeconds(submission);
            const record = {
                taskId,
                taskStatus,
                status: submissionStatus,
                submittedDay,
                seconds,
                checkedDay: todayLocalKey
            };
            cache.set(submissionId, record);
            saveSubmissionCache(cache);
            cachedByTaskId.set(taskId, { ...record, submissionId });
            if (submissionStatus !== 'draft')
                addSubmissionSeconds(submittedDay, seconds);
        }
        return { todaySeconds: todayTotalSeconds, monthSeconds: monthTotalSeconds };
    }

    function warnDailyTrackingStorage(error) {
        if (dailyTrackingStorageWarningLogged)
            return;
        dailyTrackingStorageWarningLogged = true;
        modules.logger.console.warn('[Earnings] Không truy cập được bộ đếm thu nhập ngày cục bộ:', error);
    }

    function loadDailyTracking() {
        if (dailyTrackingLoaded)
            return dailyTracking;
        dailyTrackingLoaded = true;
        try {
            const storage = modules.environment.W.localStorage;
            const raw = storage.getItem(DAILY_TRACKING_STORAGE_KEY);
            if (!raw)
                return null;
            const stored = JSON.parse(raw);
            const validDate = stored && typeof stored.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored.date);
            const validCounters = stored
                && ['labelledSeconds', 'extraSeconds', 'lastLabelledSeconds', 'lastExtraSeconds', 'trackingStartedAt']
                    .every(field => typeof stored[field] === 'number' && Number.isFinite(stored[field]) && stored[field] >= 0);
            if (!validDate || !validCounters)
                throw new Error('Dữ liệu bộ đếm ngày không hợp lệ');
            dailyTracking = stored;
        }
        catch (error) {
            warnDailyTrackingStorage(error);
        }
        return dailyTracking;
    }

    function saveDailyTracking() {
        try {
            modules.environment.W.localStorage.setItem(DAILY_TRACKING_STORAGE_KEY, JSON.stringify(dailyTracking));
        }
        catch (error) {
            warnDailyTrackingStorage(error);
        }
    }

    function updateDailyTracking(statsSeconds, extraSeconds, today) {
        const previous = loadDailyTracking();
        if (!previous || previous.date !== today) {
            dailyTracking = {
                date: today,
                labelledSeconds: 0,
                extraSeconds: 0,
                lastLabelledSeconds: statsSeconds,
                lastExtraSeconds: 0,
                trackingStartedAt: Date.now()
            };
        }
        else {
            dailyTracking = {
                ...previous,
                labelledSeconds: previous.labelledSeconds + Math.max(0, statsSeconds - previous.lastLabelledSeconds),
                extraSeconds: 0,
                lastLabelledSeconds: statsSeconds,
                lastExtraSeconds: 0
            };
        }
        saveDailyTracking();
        return dailyTracking;
    }

    async function getJson(url, token) {
        const controller = new AbortController();
        const timeout = modules.runtime.bgSetTimeout(() => controller.abort(), modules.config.REQUEST_TIMEOUT);
        try {
            const response = await modules.auth.origFetch.call(modules.environment.W, url, {
                method: 'GET',
                headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
                credentials: 'include',
                cache: 'no-store',
                signal: controller.signal
            });
            if (!response.ok)
                throw new Error(`Thu nhập API HTTP ${response.status}`);
            return await response.json();
        }
        finally {
            modules.runtime.bgClearTimeout(timeout);
        }
    }

    async function updateMyEarnings() {
        if (updatingTotal)
            return false;
        updatingTotal = true;
        const startedAt = new Date();
        lastReportRefreshPeriod = syncWorkingHoursPeriod(localDateKey(startedAt), localMonthKey(startedAt));
        let backgroundJobStarted = false;
        try {
            modules.runtime.bgBegin();
            backgroundJobStarted = true;
            const candidate = modules.auth.findToken() || modules.auth.findToken(true);
            if (!candidate || !candidate.token)
                throw new Error('Chưa tìm được phiên đăng nhập Tbrain');
            const [statsData, extraData] = await Promise.all([
                getJson(modules.config.STATS_API_URL, candidate.token),
                getJson(modules.config.EXTRA_HOURS_API_URL, candidate.token)
            ]);
            if (!statsData || typeof statsData !== 'object' || Array.isArray(statsData))
                throw new Error('Dữ liệu my-stats không đúng định dạng');
            if (!Array.isArray(extraData))
                throw new Error('Dữ liệu extra-hours không đúng định dạng');
            const statsSeconds = readNonNegativeSeconds(statsData.labelledSeconds, 'labelledSeconds');
            const extraSeconds = extraData.reduce((total, item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item))
                    throw new Error(`extra-hours[${index}] không hợp lệ`);
                return total + readNonNegativeSeconds(item.seconds, `extra-hours[${index}].seconds`);
            }, 0);
            totalSeconds = statsSeconds;
            lastUpdateError = '';
            const periodReadAt = new Date();
            const today = localDateKey(periodReadAt);
            const month = localMonthKey(periodReadAt);
            const periodKey = syncWorkingHoursPeriod(today, month);
            lastReportRefreshPeriod = periodKey;
            todayDateKey = today;
            const localTracking = updateDailyTracking(statsSeconds, extraSeconds, today);
            let submissionPeriodSeconds = null;
            let submissionsReadError = '';
            let extraTodaySeconds = null;
            let extraMonthSeconds = null;
            let extraReadError = '';
            let reportTodayExtra = { seconds: 0, hasUndatedRecords: false };
            let reportMonthExtra = { seconds: 0, hasUndatedRecords: false };
            try {
                submissionPeriodSeconds = await readSubmissionSecondsByPeriod(candidate.token, today, month);
            }
            catch (error) {
                submissionsReadError = error && error.message ? error.message : String(error);
            }
            try {
                extraTodaySeconds = readTodayExtraSeconds(extraData, today);
            }
            catch (error) {
                extraTodaySeconds = null;
                extraReadError = error && error.message ? error.message : String(error);
            }
            try {
                extraMonthSeconds = readMonthExtraSeconds(extraData, month);
            }
            catch (error) {
                extraMonthSeconds = null;
                extraReadError = extraReadError || (error && error.message ? error.message : String(error));
            }
            try {
                reportTodayExtra = readDatedExtraSecondsForPeriod(extraData, itemDate => itemDate === today);
                reportMonthExtra = readDatedExtraSecondsForPeriod(extraData, itemDate => itemDate.slice(0, 7) === month);
            }
            catch (error) {
                reportTodayExtra = { seconds: 0, hasUndatedRecords: true };
                reportMonthExtra = { seconds: 0, hasUndatedRecords: true };
                extraReadError = extraReadError || (error && error.message ? error.message : String(error));
            }
            todayTrackingStartedAt = localTracking.trackingStartedAt;
            if (submissionPeriodSeconds !== null) {
                todaySeconds = submissionPeriodSeconds.todaySeconds;
                todayIsEstimated = false;
                todayDataError = extraTodaySeconds === null
                    ? `extra-hours không có ngày để lọc; khoản này chưa được cộng vào tổng ngày${extraReadError ? ` (${extraReadError})` : ''}`
                    : '';
                if (todayDataError && todayDataError !== lastTodayDataWarning)
                    modules.logger.console.info('[Earnings]', todayDataError);
                lastTodayDataWarning = todayDataError;
                const completedAt = new Date();
                const currentToday = localDateKey(completedAt);
                const currentMonth = localMonthKey(completedAt);
                syncWorkingHoursPeriod(currentToday, currentMonth);
                if (today === currentToday && reportTodayDateKey === today)
                    reportTodaySeconds = submissionPeriodSeconds.todaySeconds
                        + (extraTodaySeconds === null ? reportTodayExtra.seconds : extraTodaySeconds);
                if (month === currentMonth && reportMonthKey === month)
                    monthSeconds = submissionPeriodSeconds.monthSeconds
                        + (extraMonthSeconds === null ? reportMonthExtra.seconds : extraMonthSeconds);
                reportDataError = '';
                const hasUndatedExtra = reportTodayExtra.hasUndatedRecords || reportMonthExtra.hasUndatedRecords;
                reportDataWarning = hasUndatedExtra
                    ? 'Một số extra-hours không có ngày hợp lệ nên không được cộng vào WORKING HOURS.'
                    : '';
                if (reportDataWarning && reportDataWarning !== lastExtraDateWarning)
                    modules.logger.console.warn('[Earnings]', reportDataWarning);
                lastExtraDateWarning = reportDataWarning;
            }
            else {
                todaySeconds = localTracking.labelledSeconds;
                todayIsEstimated = true;
                todayDataError = `Không đọc được submissions; dùng bộ đếm cục bộ: ${submissionsReadError}`;
                if (todayDataError !== lastTodayDataWarning)
                    modules.logger.console.warn('[Earnings]', todayDataError);
                lastTodayDataWarning = todayDataError;
                reportDataError = `Không đọc được submissions cho WORKING HOURS: ${submissionsReadError}`;
            }
            renderTotalEarnings();
            renderMyReportWorkingHours();
            return true;
        }
        catch (error) {
            const previousError = lastUpdateError;
            lastUpdateError = error && error.message ? error.message : String(error);
            reportDataError = `Không cập nhật được WORKING HOURS: ${lastUpdateError}`;
            renderTotalEarnings();
            renderMyReportWorkingHours();
            if (lastUpdateError !== previousError)
                modules.logger.console.error('[Earnings] Lỗi cập nhật thu nhập:', error);
            return false;
        }
        finally {
            if (backgroundJobStarted)
                modules.runtime.bgEnd();
            updatingTotal = false;
        }
    }

    async function refreshTotalLoop() {
        await updateMyEarnings();
        if (started)
            modules.runtime.bgSetTimeout(refreshTotalLoop, TOTAL_REFRESH_MS);
    }

    function refreshTaskLoop() {
        if (!started)
            return;
        updateTaskEarnings();
        modules.runtime.bgSetTimeout(refreshTaskLoop, TASK_REFRESH_MS);
    }

    function start() {
        if (started)
            return;
        started = true;
        renderTotalEarnings();
        void refreshTotalLoop();
        refreshTaskLoop();
    }

    return {
        get updateMyEarnings() { return updateMyEarnings; },
        get calculateTaskEarningsFromTimeline() { return calculateTaskEarningsFromTimeline; },
        get updateTaskEarnings() { return updateTaskEarnings; },
        get formatDuration() { return formatDuration; },
        get localDateKey() { return localDateKey; },
        get localMonthKey() { return localMonthKey; },
        get readTodayExtraSeconds() { return readTodayExtraSeconds; },
        get readMonthExtraSeconds() { return readMonthExtraSeconds; },
        get readSubmissionSecondsByPeriod() { return readSubmissionSecondsByPeriod; },
        get renderMyReportWorkingHours() { return renderMyReportWorkingHours; },
        get ensureMyReportWorkingHoursCard() { return ensureMyReportWorkingHoursCard; },
        get start() { return start; }
    };
};
