'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

function installDisplays(context) {
    const total = { textContent: '', title: '' };
    const today = { textContent: '', title: '' };
    const task = { textContent: '', title: '' };
    context.document.getElementById = id => ({
        'tb-earnings-display': total,
        'tb-today-earnings-display': today,
        'tb-task-earnings-display': task
    })[id] || null;
    return { total, today, task };
}

function dateKey(date) {
    const pad = value => String(value).padStart(2, '0');
    const utcPlus7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return `${utcPlus7.getUTCFullYear()}-${pad(utcPlus7.getUTCMonth() + 1)}-${pad(utcPlus7.getUTCDate())}`;
}

function mockDate(context, iso) {
    const timestamp = Date.parse(iso);
    class FixedDate extends Date {
        constructor(...args) {
            super(...(args.length ? args : [timestamp]));
        }
        static now() {
            return timestamp;
        }
    }
    context.Date = FixedDate;
}

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function installFetch(modules, handler) {
    const requests = [];
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-session-token' }) });
    Object.defineProperty(modules.auth, 'origFetch', {
        value: async (url, options) => {
            requests.push({ url, options });
            return handler(url, options);
        }
    });
    return requests;
}

function installImmediateBgSleep(modules, delays = []) {
    Object.defineProperty(modules.runtime, 'bgSleep', {
        value: async milliseconds => { delays.push(milliseconds); }
    });
    return delays;
}

function tasksPage(data, total = data.length) {
    return { data, pagination: { total } };
}

function installWorkingHoursReport(context) {
    function element(tagName) {
        const node = {
            tagName: tagName.toUpperCase(),
            textContent: '',
            title: '',
            className: '',
            style: { cssText: '' },
            attributes: {},
            children: [],
            parentElement: null,
            setAttribute(name, value) { this.attributes[name] = String(value); },
            getAttribute(name) { return this.attributes[name] || null; },
            appendChild(child) {
                if (child.parentElement) {
                    const index = child.parentElement.children.indexOf(child);
                    if (index >= 0)
                        child.parentElement.children.splice(index, 1);
                }
                this.children.push(child);
                child.parentElement = this;
                return child;
            },
            append(...children) { children.forEach(child => this.appendChild(child)); },
            insertBefore(child, reference) {
                if (child.parentElement) {
                    const index = child.parentElement.children.indexOf(child);
                    if (index >= 0)
                        child.parentElement.children.splice(index, 1);
                }
                const index = this.children.indexOf(reference);
                this.children.splice(index < 0 ? this.children.length : index, 0, child);
                child.parentElement = this;
                return child;
            },
            remove() {
                if (!this.parentElement)
                    return;
                const index = this.parentElement.children.indexOf(this);
                if (index >= 0)
                    this.parentElement.children.splice(index, 1);
                this.parentElement = null;
            },
            matches(selector) {
                const testId = selector.match(/^\[data-testid="([^"]+)"\]$/);
                const headingTag = /^(h1|h2|h3|h4)$/.test(selector) && this.tagName.toLowerCase() === selector;
                const roleHeading = selector === '[role="heading"]' && this.attributes.role === 'heading';
                return (testId && this.attributes['data-testid'] === testId[1]) || headingTag || roleHeading;
            },
            querySelectorAll(selector) {
                const selectors = selector.split(',').map(part => part.trim());
                const found = [];
                const visit = parent => parent.children.forEach(child => {
                    if (selectors.some(part => child.matches(part)))
                        found.push(child);
                    visit(child);
                });
                visit(this);
                return found;
            },
            querySelector(selector) {
                return this.querySelectorAll(selector)[0] || null;
            }
        };
        Object.defineProperty(node, 'nextElementSibling', {
            get() {
                if (!this.parentElement)
                    return null;
                const index = this.parentElement.children.indexOf(this);
                return this.parentElement.children[index + 1] || null;
            }
        });
        return node;
    }

    const report = element('section');
    report.setAttribute('data-testid', 'my-labelling-report');
    const heading = element('h2');
    heading.textContent = 'My labelling work';
    const grid = element('div');
    [
        'my-labelling-sessions',
        'my-labelling-hours',
        'my-labelling-pending',
        'my-labelling-passed',
        'my-labelling-failed',
        'my-labelling-pass-rate'
    ].forEach(testId => {
        const card = element('div');
        card.setAttribute('data-testid', testId);
        card.className = 'rounded-xl border bg-card p-4';
        grid.appendChild(card);
    });
    report.append(heading, grid);
    context.document.createElement = tagName => element(tagName);
    context.document.querySelector = selector => selector === '[data-testid="my-labelling-report"]' ? report : null;
    return { report, grid };
}

test('earnings config exposes project endpoints and hourly rate', () => {
    const { modules } = loadModules();
    assert.equal(modules.config.STATS_API_URL, `${modules.config.API_BASE}/api/v1/tasks/my-stats?projectId=${modules.config.PROJECT_ID}`);
    assert.equal(modules.config.EXTRA_HOURS_API_URL, `${modules.config.API_BASE}/api/v1/my/extra-hours?projectId=${modules.config.PROJECT_ID}`);
    assert.equal(modules.config.EARNINGS_RATE_VND_PER_HOUR, 50000);
});

test('task earnings use the recorded portion of timeline-hours', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const timeline = { textContent: '1h 30min / 4h' };
    context.document.querySelector = selector => selector === '[data-testid="timeline-hours"]' ? timeline : null;

    assert.equal(modules.earnings.calculateTaskEarningsFromTimeline(), 75000);
    timeline.textContent = '0h 1min / 4h';
    assert.equal(modules.earnings.calculateTaskEarningsFromTimeline(), 833);
    timeline.textContent = 'Loading';
    assert.equal(modules.earnings.calculateTaskEarningsFromTimeline(), 0);
});

test('total earnings combine labelled seconds and extra hours using the session token', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 3600 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([{ seconds: 1800 }]);
        return jsonResponse(tasksPage([]));
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.deepEqual(requests
        .filter(request => request.url === modules.config.STATS_API_URL || request.url === modules.config.EXTRA_HOURS_API_URL)
        .map(request => request.url)
        .sort(), [
        modules.config.EXTRA_HOURS_API_URL,
        modules.config.STATS_API_URL
    ].sort());
    for (const request of requests) {
        assert.equal(request.options.method, 'GET');
        assert.equal(request.options.headers.Authorization, 'Bearer test-session-token');
        assert.equal(request.options.credentials, 'include');
    }
    assert.equal(displays.total.textContent, `💰 ${(75000).toLocaleString('vi-VN')} đ`);
    assert.match(displays.total.title, /1\.50h/);
    assert.match(displays.total.title, /5400 giây/);
});

test('today earnings include dated extra hours when no submitted tasks are listed', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    const today = dateKey(new Date());
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = dateKey(yesterdayDate);
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-session-token' }) });
    Object.defineProperty(modules.auth, 'origFetch', {
        value: async url => {
            const body = url === modules.config.STATS_API_URL
                ? { labelledSeconds: 86400 }
                : url === modules.config.EXTRA_HOURS_API_URL
                    ? [
                        { date: today, seconds: 1800 },
                        { date: yesterday, seconds: 3600 }
                    ]
                    : tasksPage([]);
            return { ok: true, status: 200, json: async () => body };
        }
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);

    assert.equal(displays.today.textContent, `📅 Hôm nay: ${(25000).toLocaleString('vi-VN')} đ`);
    assert.match(displays.today.title, new RegExp(today));
    assert.match(displays.today.title, /0\.50h/);
    assert.match(displays.today.title, /1800 giây/);
    assert.equal(displays.total.textContent, `💰 ${(1275000).toLocaleString('vi-VN')} đ`);
});

test('submission earnings sum UTC+7 episodes, exclude drafts, and use only GET requests', async () => {
    const context = browser();
    mockDate(context, '2026-10-31T12:00:00.000Z');
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    const tasks = [
        { id: 'near-midnight', status: 'delivered' },
        { id: 'before-midnight', status: 'submitted' },
        { id: 'draft-task', status: 'submitted' },
        { id: 'claimed-task', status: 'claimed' }
    ];
    const details = {
        'near-midnight': { submission: { id: 'submission-today' } },
        'before-midnight': { submission: { id: 'submission-yesterday' } },
        'draft-task': { submission: { id: 'submission-draft' } }
    };
    const submissions = {
        'submission-today': {
            status: 'in_review',
            submittedAt: '2026-10-30T17:00:30.000Z',
            artifacts: [{ data: { episodes: [
                { start_seconds: 0, end_seconds: 10 },
                { start_seconds: 15, end_seconds: 30 }
            ] } }]
        },
        'submission-yesterday': {
            status: 'pending_delivery',
            submittedAt: '2026-10-30T16:59:30.000Z',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 3600 }] } }]
        },
        'submission-draft': {
            status: 'draft',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 5000 }] } }]
        }
    };
    const delays = installImmediateBgSleep(modules);
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 86400 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([{ date: '2026-10-31', seconds: 1800 }, { date: '2026-10-30', seconds: 3600 }]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks' && parsed.searchParams.get('page') === '1')
            return jsonResponse(tasksPage(tasks));
        if (parsed.pathname.startsWith('/api/v1/tasks/'))
            return jsonResponse(details[decodeURIComponent(parsed.pathname.split('/').pop())]);
        if (parsed.pathname.startsWith('/api/v1/submissions/'))
            return jsonResponse(submissions[decodeURIComponent(parsed.pathname.split('/').pop())]);
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);

    const expected = Math.round((1825 / 3600) * 50000);
    assert.equal(displays.today.textContent, `📅 Hôm nay: ${expected.toLocaleString('vi-VN')} đ`);
    assert.match(displays.today.title, /2026-10-31/);
    assert.match(displays.today.title, /1825 giây/);
    assert.equal(displays.total.textContent, `💰 ${(1275000).toLocaleString('vi-VN')} đ`);
    assert.ok(requests.some(request => request.url.includes('page=1&pageSize=100')));
    assert.equal(requests.filter(request => request.url.includes('/api/v1/tasks/claimed-task')).length, 0);
    assert.equal(requests.filter(request => request.url.includes('/api/v1/submissions/submission-draft')).length, 1);
    assert.ok(requests.every(request => request.options.method === 'GET'));
    assert.ok(requests.every(request => /^Bearer .+/.test(request.options.headers.Authorization)));
    assert.ok(delays.length > 0 && delays.every(delay => delay === 200));
    assert.equal(JSON.stringify(context.__logs).includes('Bearer'), false);

    const cached = JSON.parse(context.localStorage.getItem(`tb_earnings_submissions_${modules.config.PROJECT_ID}`));
    assert.equal(cached['submission-today'].seconds, 25);
    assert.equal(cached['submission-today'].submittedDay, '2026-10-31');
    assert.equal(cached['submission-draft'].status, 'draft');
});

test('same-day submission cache avoids detail requests until task status changes', async () => {
    const context = browser();
    mockDate(context, '2026-10-31T12:00:00.000Z');
    const { modules } = loadModules(context);
    installDisplays(context);
    let taskStatus = 'submitted';
    const details = [];
    const submissions = [];
    installImmediateBgSleep(modules);
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 3600 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks')
            return jsonResponse(tasksPage([{ id: 'cached-task', status: taskStatus }]));
        if (parsed.pathname === '/api/v1/tasks/cached-task') {
            details.push(url);
            return jsonResponse({ submission: { id: 'cached-submission' } });
        }
        if (parsed.pathname === '/api/v1/submissions/cached-submission') {
            submissions.push(url);
            return jsonResponse({
                status: 'in_review',
                submittedAt: '2026-10-30T17:00:00.000Z',
                artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 60 }] } }]
            });
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    await modules.earnings.updateMyEarnings();
    await modules.earnings.updateMyEarnings();
    assert.equal(details.length, 1);
    assert.equal(submissions.length, 1);

    taskStatus = 'delivered';
    await modules.earnings.updateMyEarnings();
    assert.equal(details.length, 2);
    assert.equal(submissions.length, 2);
    assert.equal(requests.filter(request => request.url.includes('/api/v1/tasks?page=')).length, 3);

    mockDate(context, '2026-11-01T12:00:00.000Z');
    await modules.earnings.updateMyEarnings();
    assert.equal(details.length, 2);
    assert.equal(submissions.length, 2);
});

test('submission list paginates when total exceeds 100', async () => {
    const context = browser();
    mockDate(context, '2026-10-31T12:00:00.000Z');
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: `claimed-${index}`, status: 'claimed' }));
    const pageTwo = [{ id: 'claimed-100', status: 'claimed' }];
    const pages = [];
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 0 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks') {
            const page = Number(parsed.searchParams.get('page'));
            pages.push(page);
            return jsonResponse(tasksPage(page === 1 ? pageOne : pageTwo, 101));
        }
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(requests.filter(request => request.url.includes('/api/v1/tasks/claimed-')).length, 0);
    assert.equal(displays.today.textContent, '📅 Hôm nay: 0 đ');
});

test('submission lookup failure falls back to local daily deltas and leaves lifetime total intact', async () => {
    const context = browser();
    mockDate(context, '2026-10-31T12:00:00.000Z');
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    let statsSeconds = 3600;
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: statsSeconds });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks')
            return jsonResponse(tasksPage([
                { id: 'one', status: 'submitted' },
                { id: 'two', status: 'submitted' },
                { id: 'three', status: 'submitted' }
            ]));
        if (parsed.pathname === '/api/v1/tasks/one')
            return jsonResponse({ submission: { id: 'one-submission' } });
        if (parsed.pathname === '/api/v1/submissions/one-submission')
            return jsonResponse({
                status: 'in_review',
                submittedAt: '2026-10-30T17:00:00.000Z',
                artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 1800 }] } }]
            });
        if (parsed.pathname === '/api/v1/tasks/two')
            return jsonResponse({ submission: { id: 'two-submission' } });
        if (parsed.pathname === '/api/v1/submissions/two-submission')
            return jsonResponse({}, 429);
        throw new Error(`Unexpected request: ${url}`);
    });
    installImmediateBgSleep(modules);

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(displays.today.textContent, '📅 Hôm nay: ~0 đ');
    assert.match(displays.today.title, /HTTP 429/);
    assert.equal(displays.total.textContent, `💰 ${(50000).toLocaleString('vi-VN')} đ`);
    assert.equal(requests.filter(request => request.url.endsWith('/submissions/two-submission')).length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/tasks/three')).length, 0);
    assert.equal(JSON.stringify(context.__logs).includes('test-session-token'), false);

    statsSeconds = 3700;
    await modules.earnings.updateMyEarnings();
    assert.equal(displays.today.textContent, `📅 Hôm nay: ~${Math.round((100 / 3600) * 50000).toLocaleString('vi-VN')} đ`);
    assert.equal(displays.total.textContent, `💰 ${Math.round((3700 / 3600) * 50000).toLocaleString('vi-VN')} đ`);
});

test('submission list HTTP 429 uses the clearly marked local estimate', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-session-token' }) });
    Object.defineProperty(modules.auth, 'origFetch', {
        value: async url => {
            const listRequest = url.includes('/api/v1/tasks?page=');
            return {
                ok: !listRequest,
                status: listRequest ? 429 : 200,
                json: async () => url === modules.config.STATS_API_URL
                    ? { labelledSeconds: 36000 }
                    : [{ seconds: 1200 }]
            };
        }
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);

    assert.equal(displays.today.textContent, '📅 Hôm nay: ~0 đ');
    assert.match(displays.today.title, /Tạm tính/);
    assert.match(displays.today.title, /không gồm dữ liệu trước thời điểm này/);
    assert.match(displays.today.title, /HTTP 429/);
    assert.notEqual(displays.total.textContent, '💰 —');
});

test('daily earnings accumulate only new totals and persist across module reloads', async () => {
    const context = browser();
    let displays = installDisplays(context);
    let statsSeconds = 36000;
    let extraSeconds = 1200;
    const installApi = modules => {
        Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-session-token' }) });
        Object.defineProperty(modules.auth, 'origFetch', {
            value: async url => ({
                ok: true,
                status: 200,
                json: async () => url === modules.config.STATS_API_URL
                    ? { labelledSeconds: statsSeconds }
                    : [{ seconds: extraSeconds }]
            })
        });
    };
    let { modules } = loadModules(context);
    installApi(modules);

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(displays.today.textContent, '📅 Hôm nay: ~0 đ');

    statsSeconds = 37800;
    extraSeconds = 1500;
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    const afterFirstIncrease = Math.round((2100 / 3600) * 50000);
    assert.equal(displays.today.textContent, `📅 Hôm nay: ~${afterFirstIncrease.toLocaleString('vi-VN')} đ`);

    modules = loadModules(context).modules;
    displays = installDisplays(context);
    installApi(modules);
    statsSeconds = 39600;
    extraSeconds = 1800;
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    const afterReload = Math.round((4200 / 3600) * 50000);
    assert.equal(displays.today.textContent, `📅 Hôm nay: ~${afterReload.toLocaleString('vi-VN')} đ`);
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(displays.today.textContent, `📅 Hôm nay: ~${afterReload.toLocaleString('vi-VN')} đ`);
});

test('working-hours formatting and month keys use whole minutes and UTC+7', () => {
    const { modules } = loadModules();
    assert.equal(modules.earnings.formatDuration(0), '0 h 00 min');
    assert.equal(modules.earnings.formatDuration(65 * 60), '1 h 05 min');
    assert.equal(modules.earnings.formatDuration(12 * 3600 + 34 * 60 + 59), '12 h 34 min');
    assert.equal(modules.earnings.formatDuration(100 * 3600 + 8 * 60), '100 h 08 min');
    for (const invalid of [null, undefined, NaN, Infinity, -1])
        assert.equal(modules.earnings.formatDuration(invalid), '—');
    assert.equal(modules.earnings.localMonthKey(new Date('2026-10-31T16:59:59.000Z')), '2026-10');
    assert.equal(modules.earnings.localMonthKey(new Date('2026-10-31T17:00:00.000Z')), '2026-11');
});

test('WORKING HOURS counts only current UTC+7 day/month submissions and dated extra-hours, reusing cache', async () => {
    const context = browser();
    mockDate(context, '2026-11-02T03:00:00.000Z');
    const { modules } = loadModules(context);
    installDisplays(context);
    const { report } = installWorkingHoursReport(context);
    const tasks = [
        { id: 'today-task', status: 'submitted' },
        { id: 'month-task', status: 'delivered' },
        { id: 'previous-month-task', status: 'delivered' },
        { id: 'draft-task', status: 'submitted' },
        { id: 'claimed-task', status: 'claimed' }
    ];
    const details = {
        'today-task': { submission: { id: 'today-submission' } },
        'month-task': { submission: { id: 'month-submission' } },
        'previous-month-task': { submission: { id: 'previous-month-submission' } },
        'draft-task': { submission: { id: 'draft-submission' } }
    };
    const submissions = {
        'today-submission': {
            status: 'in_review',
            submittedAt: '2026-11-01T17:00:00.000Z',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 3661 }] } }]
        },
        'month-submission': {
            status: 'pending_delivery',
            submittedAt: '2026-11-01T16:59:00.000Z',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 3599 }] } }]
        },
        'previous-month-submission': {
            status: 'in_review',
            submittedAt: '2026-10-31T16:59:00.000Z',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 7200 }] } }]
        },
        'draft-submission': {
            status: 'draft',
            artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 999999 }] } }]
        }
    };
    installImmediateBgSleep(modules);
    const requests = installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 86400 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([
                { date: '2026-11-02', seconds: 120 },
                { date: '2026-11-01', seconds: 300 },
                { date: '2026-10-31', seconds: 900 },
                { seconds: 600 }
            ]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks')
            return jsonResponse(tasksPage(tasks));
        if (parsed.pathname.startsWith('/api/v1/tasks/'))
            return jsonResponse(details[decodeURIComponent(parsed.pathname.split('/').pop())]);
        if (parsed.pathname.startsWith('/api/v1/submissions/'))
            return jsonResponse(submissions[decodeURIComponent(parsed.pathname.split('/').pop())]);
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '—');
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '1 h 03 min');
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '2 h 08 min');
    assert.match(report.querySelector('[data-testid="tb-working-hours-card"]').title, /không có ngày hợp lệ/);

    const detailsRequestCount = requests.filter(request =>
        /\/api\/v1\/(tasks|submissions)\/(today-task|month-task|previous-month-task|draft-task|today-submission|month-submission|previous-month-submission|draft-submission)$/.test(request.url)
    ).length;
    assert.equal(detailsRequestCount, 8);
    await modules.earnings.updateMyEarnings();
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '1 h 03 min');
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '2 h 08 min');
    assert.equal(requests.filter(request =>
        /\/api\/v1\/(tasks|submissions)\/(today-task|month-task|previous-month-task|draft-task|today-submission|month-submission|previous-month-submission|draft-submission)$/.test(request.url)
    ).length, detailsRequestCount);
    assert.equal(requests.filter(request => request.url.includes('/api/v1/tasks?page=')).length, 2);
    assert.equal(requests.filter(request => request.url === modules.config.STATS_API_URL).length, 2);
    assert.equal(report.querySelectorAll('[data-testid="tb-working-hours-card"]').length, 1);

    mockDate(context, '2026-12-01T03:00:00.000Z');
    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '—');
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '—');
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '0 h 00 min');
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '0 h 00 min');
});

test('undated extra-hours never count as report today or month time', async () => {
    const context = browser();
    mockDate(context, '2026-11-02T03:00:00.000Z');
    const { modules } = loadModules(context);
    installDisplays(context);
    const { report } = installWorkingHoursReport(context);
    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 86400 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([{ seconds: 3600 }]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks')
            return jsonResponse(tasksPage([]));
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '0 h 00 min');
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, '0 h 00 min');
    assert.match(report.querySelector('[data-testid="tb-working-hours-card"]').title, /không có ngày hợp lệ/);
});

test('WORKING HOURS retains last successful values after submission API errors', async () => {
    const context = browser();
    mockDate(context, '2026-11-02T03:00:00.000Z');
    const { modules } = loadModules(context);
    installDisplays(context);
    const { report } = installWorkingHoursReport(context);
    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    let failTaskList = false;
    installImmediateBgSleep(modules);
    installFetch(modules, url => {
        if (url === modules.config.STATS_API_URL)
            return jsonResponse({ labelledSeconds: 3600 });
        if (url === modules.config.EXTRA_HOURS_API_URL)
            return jsonResponse([]);
        const parsed = new URL(url);
        if (parsed.pathname === '/api/v1/tasks')
            return failTaskList ? jsonResponse({}, 429) : jsonResponse(tasksPage([{ id: 'cached-task', status: 'submitted' }]));
        if (parsed.pathname === '/api/v1/tasks/cached-task')
            return jsonResponse({ submission: { id: 'cached-submission' } });
        if (parsed.pathname === '/api/v1/submissions/cached-submission')
            return jsonResponse({
                status: 'in_review',
                submittedAt: '2026-11-02T02:00:00.000Z',
                artifacts: [{ data: { episodes: [{ start_seconds: 0, end_seconds: 120 }] } }]
            });
        throw new Error(`Unexpected request: ${url}`);
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, '0 h 02 min');
    const lastToday = report.querySelector('[data-testid="tb-working-hours-today"]').textContent;
    const lastMonth = report.querySelector('[data-testid="tb-working-hours-month"]').textContent;
    failTaskList = true;
    assert.equal(await modules.earnings.updateMyEarnings(), true);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-today"]').textContent, lastToday);
    assert.equal(report.querySelector('[data-testid="tb-working-hours-month"]').textContent, lastMonth);
    assert.match(report.querySelector('[data-testid="tb-working-hours-card"]').title, /HTTP 429/);
});

test('task earnings badge refreshes from the current timeline', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    context.document.querySelector = () => ({ textContent: '2h 15min / 5h' });

    modules.earnings.updateTaskEarnings();

    assert.equal(displays.task.textContent, `🎯 Task: ${(112500).toLocaleString('vi-VN')} đ`);
    assert.match(displays.task.title, /2h 15min/);
});

test('failed earnings refresh preserves the last valid total and reports the error', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const displays = installDisplays(context);
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-session-token' }) });
    let status = 200;
    Object.defineProperty(modules.auth, 'origFetch', {
        value: async url => ({
            ok: status === 200,
            status,
            json: async () => url === modules.config.STATS_API_URL
                ? { labelledSeconds: 3600, todayLabelledSeconds: 1800 }
                : []
        })
    });

    assert.equal(await modules.earnings.updateMyEarnings(), true);
    const lastValidTotal = displays.total.textContent;
    const lastValidToday = displays.today.textContent;
    status = 503;
    assert.equal(await modules.earnings.updateMyEarnings(), false);
    assert.equal(displays.total.textContent, lastValidTotal);
    assert.equal(displays.today.textContent, lastValidToday);
    assert.match(displays.total.title, /Lỗi cập nhật gần nhất/);
});

test('earnings background refresh is idempotent and schedules both update rates', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    modules.earnings.start();
    modules.earnings.start();
    await new Promise(resolve => setImmediate(resolve));

    const delays = context.__timers.filter(timer => timer.kind === 'timeout').map(timer => timer.ms);
    assert.equal(delays.filter(delay => delay === 1000).length, 1);
    assert.equal(delays.filter(delay => delay === 30000).length, 1);
    assert.equal(context.__requests.length, 0);
});
