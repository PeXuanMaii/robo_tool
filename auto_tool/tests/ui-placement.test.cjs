'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

function fakeElement(tag, elements) {
    const classes = new Set();
    const element = {
        tagName: tag.toUpperCase(),
        id: '',
        textContent: '',
        title: '',
        style: { cssText: '' },
        children: [],
        attributes: {},
        parentElement: null,
        className: '',
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            contains: name => classes.has(name)
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return this.attributes[name] || null; },
        addEventListener() {},
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
            const roleHeading = selector === '[role="heading"]' && this.attributes.role === 'heading';
            const headingTag = /^(h1|h2|h3|h4)$/.test(selector) && this.tagName.toLowerCase() === selector;
            return (testId && this.attributes['data-testid'] === testId[1]) || roleHeading || headingTag;
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
        },
        appendChild(child) {
            if (child.parentElement) {
                const oldIndex = child.parentElement.children.indexOf(child);
                if (oldIndex >= 0)
                    child.parentElement.children.splice(oldIndex, 1);
            }
            this.children.push(child);
            child.parentElement = this;
            if (child.id)
                elements.set(child.id, child);
            return child;
        },
        append(...children) { children.forEach(child => this.appendChild(child)); },
        prepend(child) {
            if (child.parentElement) {
                const oldIndex = child.parentElement.children.indexOf(child);
                if (oldIndex >= 0)
                    child.parentElement.children.splice(oldIndex, 1);
            }
            this.children.unshift(child);
            child.parentElement = this;
            if (child.id)
                elements.set(child.id, child);
        },
        replaceChildren(...children) {
            this.children.forEach(child => { child.parentElement = null; });
            this.children.length = 0;
            children.forEach(child => this.appendChild(child));
        },
        insertBefore(child, reference) {
            if (child.parentElement) {
                const oldIndex = child.parentElement.children.indexOf(child);
                if (oldIndex >= 0)
                    child.parentElement.children.splice(oldIndex, 1);
            }
            const index = this.children.indexOf(reference);
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            child.parentElement = this;
            if (child.id)
                elements.set(child.id, child);
            return child;
        },
        get nextElementSibling() {
            if (!this.parentElement)
                return null;
            const index = this.parentElement.children.indexOf(this);
            return this.parentElement.children[index + 1] || null;
        }
    };
    return element;
}

test('earnings badges mount beside the page theme toggle', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const actions = fakeElement('div', elements);
    const themeToggle = fakeElement('button', elements);
    actions.appendChild(themeToggle);
    elements.set('theme-toggle', themeToggle);
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    context.document.querySelector = selector => selector === '[data-testid="theme-toggle"]' ? themeToggle
        : selector === '[data-testid="timeline-hours"]' ? { textContent: '2h 15min / 5h' }
            : null;

    modules.earnings.updateTaskEarnings();

    const badgeContainer = elements.get('tb-earnings-header-display');
    assert.ok(badgeContainer);
    assert.equal(actions.children[0], badgeContainer);
    assert.equal(actions.children[1], themeToggle);
    assert.equal(elements.get('tb-earnings-display').parentElement, badgeContainer);
    assert.equal(elements.get('tb-today-earnings-display').parentElement, badgeContainer);
    assert.equal(elements.get('tb-task-earnings-display').parentElement, badgeContainer);
    assert.match(badgeContainer.className, /tbp-earnings-group/);
    assert.match(elements.get('tb-earnings-display').className, /tbp-earnings-total/);
    assert.match(elements.get('tb-today-earnings-display').className, /tbp-earnings-today/);
    assert.match(elements.get('tb-task-earnings-display').className, /tbp-earnings-task/);
});

test('Fetch settings open from a header popover and hide when Fetch Task is off', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const actions = fakeElement('div', elements);
    const earnings = fakeElement('div', elements);
    earnings.id = 'tb-earnings-header-display';
    const themeToggle = fakeElement('button', elements);
    actions.appendChild(earnings);
    actions.appendChild(themeToggle);
    elements.set(earnings.id, earnings);
    const toolsHost = fakeElement('section', elements);
    const fetchRow = fakeElement('div', elements);
    fetchRow.id = 'tbp-row-fetch';
    elements.set(fetchRow.id, fetchRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => toolsHost });
    Object.defineProperty(modules.taskMonitor, 'tick', { value: () => {} });
    Object.defineProperty(modules.taskMonitor, 'stop', { value: () => {} });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    context.document.querySelector = selector => selector === '[data-testid="theme-toggle"]' ? themeToggle : null;

    modules.controls.injectUIControls();

    const fetchWrapper = elements.get('tb-fetch-control-wrapper');
    assert.ok(fetchWrapper);
    assert.equal(fetchWrapper.parentElement, actions);
    assert.equal(fetchWrapper.style.flexDirection, 'row');
    assert.equal(fetchWrapper.style.flexWrap, 'nowrap');
    assert.ok(actions.children.indexOf(fetchWrapper) < actions.children.indexOf(earnings));
    const fetchToggle = elements.get('tb-fetch-toggle');
    const settingsToggle = elements.get('tb-fetch-settings-toggle');
    const settings = elements.get('tb-fetch-settings-wrapper');
    assert.equal(fetchToggle.parentElement, fetchWrapper);
    assert.equal(settingsToggle.parentElement, fetchWrapper);
    assert.equal(elements.get('tb-enable-notifications').parentElement, fetchWrapper);
    assert.equal(elements.get('tb-api-key').parentElement, fetchWrapper);
    assert.equal(elements.get('tb-api-key-modal').parentElement, fetchWrapper);
    assert.equal(settings.parentElement, fetchWrapper);
    assert.equal(settings.children.length, 5);
    assert.ok(fetchWrapper.children.indexOf(fetchToggle) < fetchWrapper.children.indexOf(settingsToggle));
    assert.ok(fetchWrapper.children.indexOf(settingsToggle) < fetchWrapper.children.indexOf(settings));
    assert.ok(fetchWrapper.children.indexOf(settings) < fetchWrapper.children.indexOf(elements.get('tb-enable-notifications')));
    assert.equal(fetchRow.children.length, 0);
    assert.equal(settings.hidden, true);
    assert.equal(settingsToggle.attributes['aria-expanded'], 'false');
    assert.match(fetchToggle.className, /tbp-btn-primary/);
    assert.match(settingsToggle.className, /tbp-btn-neutral/);
    assert.match(elements.get('tb-enable-notifications').className, /tbp-btn-neutral/);
    assert.match(elements.get('tb-api-key').className, /tbp-btn-neutral/);
    const pollInput = elements.get('tb-fetch-poll-interval');
    const durationInput = elements.get('tb-fetch-min-duration');
    const l1ExceptInput = elements.get('tb-fetch-l1-except');
    assert.match(pollInput.className, /tbp-control-input/);
    assert.match(durationInput.className, /tbp-control-input/);
    assert.match(l1ExceptInput.className, /tbp-control-input/);
    assert.equal(l1ExceptInput.value, 'Automotive and Transport');
    assert.equal(pollInput.parentElement.parentElement, settings);
    assert.equal(durationInput.parentElement.parentElement, settings);
    assert.equal(l1ExceptInput.parentElement.parentElement, settings);

    settingsToggle.onclick();
    assert.equal(settings.hidden, false);
    assert.equal(settingsToggle.attributes['aria-expanded'], 'true');
    pollInput.onchange({ target: { value: '3500' } });
    durationInput.onchange({ target: { value: '1800' } });
    l1ExceptInput.onchange({ target: { value: 'Food Preparation, Automotive and Transport' } });
    assert.equal(modules.config.POLL_INTERVAL, 3500);
    assert.equal(modules.config.MIN_DURATION_SECONDS, 1800);
    assert.equal(modules.config.L1_EXCEPT, 'Food Preparation, Automotive and Transport');
    assert.equal(context.localStorage.getItem('tb_fetch_l1_except'), 'Food Preparation, Automotive and Transport');
    settingsToggle.onclick();
    assert.equal(settings.hidden, true);
    assert.equal(settingsToggle.attributes['aria-expanded'], 'false');

    fetchToggle.onclick();
    assert.equal(fetchToggle.textContent, 'Fetch Task: OFF');
    assert.match(fetchToggle.className, /tbp-btn-neutral/);
    assert.equal(settings.hidden, true);
    assert.equal(settingsToggle.style.display, 'none');
    fetchToggle.onclick();
    assert.equal(fetchToggle.textContent, 'Fetch Task: ON');
    assert.match(fetchToggle.className, /tbp-btn-primary/);
    assert.equal(settings.hidden, true);
    assert.equal(settingsToggle.style.display, '');
});

test('mobile Fetch controls fall back to the task panel and install responsive styles', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const toolsHost = fakeElement('section', elements);
    const fetchRow = fakeElement('div', elements);
    fetchRow.id = 'tbp-row-fetch';
    elements.set(fetchRow.id, fetchRow);
    const head = fakeElement('head', elements);
    context.document.head = head;
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => toolsHost });
    Object.defineProperty(modules.taskMonitor, 'tick', { value: () => {} });
    Object.defineProperty(modules.taskMonitor, 'stop', { value: () => {} });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    context.document.querySelector = () => null;

    modules.controls.injectUIControls();
    modules.earnings.updateTaskEarnings();

    const fetchWrapper = elements.get('tb-fetch-control-wrapper');
    const responsiveStyle = elements.get('tb-fetch-responsive-style');
    assert.equal(fetchWrapper.parentElement, fetchRow);
    assert.ok(fetchRow.classList.contains('tb-fetch-mobile-host'));
    assert.equal(elements.get('tb-earnings-header-display').parentElement, fetchRow);
    assert.ok(responsiveStyle.textContent.includes('@media screen and (max-width:700px)'));
    assert.match(responsiveStyle.textContent, /#tb-page-tools \.tbp-btn,[^}]*height:31px/);
    assert.ok(responsiveStyle.textContent.includes('.tbp-btn-danger'));
    assert.ok(responsiveStyle.textContent.includes('.tbp-btn:disabled'));
    assert.ok(responsiveStyle.textContent.includes('button:focus-visible'));
    assert.match(responsiveStyle.textContent, /#tb-fetch-control-wrapper\{[^}]*flex-wrap:wrap!important/);
    assert.ok(responsiveStyle.textContent.includes('#tb-api-key,#tb-api-key-modal,#tb-earnings-header-display{display:none!important}'));
    assert.ok(responsiveStyle.textContent.includes('#tb-page-tools .tbp-row:not(#tbp-row-fetch)'));
    assert.equal(elements.get('tb-enable-notifications').disabled, true);
});

test('My report working-hours card is mounted once after Hours labelled and remounts after React removal', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const report = fakeElement('section', elements);
    report.setAttribute('data-testid', 'my-labelling-report');
    const heading = fakeElement('h2', elements);
    heading.textContent = 'My labelling work';
    const grid = fakeElement('div', elements);
    const testIds = [
        'my-labelling-sessions',
        'my-labelling-hours',
        'my-labelling-pending',
        'my-labelling-passed',
        'my-labelling-failed',
        'my-labelling-pass-rate'
    ];
    const nativeCards = testIds.map(testId => {
        const card = fakeElement('div', elements);
        card.setAttribute('data-testid', testId);
        card.className = 'rounded-xl border bg-card p-4 border-t-4 border-emerald-500';
        grid.appendChild(card);
        return card;
    });
    report.append(heading, grid);
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.querySelector = selector => selector === '[data-testid="my-labelling-report"]' ? report : null;

    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    let injected = report.querySelector('[data-testid="tb-working-hours-card"]');
    assert.ok(injected);
    assert.equal(injected.parentElement, grid);
    assert.equal(grid.children[nativeCards.indexOf(nativeCards[1]) + 1], injected);
    assert.match(injected.className, /rounded-xl border bg-card p-4/);
    assert.equal(injected.querySelector('[data-testid="tb-working-hours-month"]').textContent, '—');
    assert.equal(injected.querySelector('[data-testid="tb-working-hours-today"]').textContent, '—');
    assert.equal(grid.children.length, 7);

    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    assert.equal(report.querySelectorAll('[data-testid="tb-working-hours-card"]').length, 1);
    assert.equal(injected.querySelectorAll('[data-testid="my-labelling-hours"]').length, 0);

    injected.remove();
    assert.equal(modules.earnings.ensureMyReportWorkingHoursCard(), true);
    injected = report.querySelector('[data-testid="tb-working-hours-card"]');
    assert.ok(injected);
    assert.equal(report.querySelectorAll('[data-testid="tb-working-hours-card"]').length, 1);
    assert.equal(grid.children.length, 7);
});

test('notification control requests browser permission only after a click', async () => {
    const context = browser();
    let permissionRequests = 0;
    function TestNotification() {}
    TestNotification.permission = 'default';
    TestNotification.requestPermission = async () => {
        permissionRequests++;
        TestNotification.permission = 'granted';
        return 'granted';
    };
    context.Notification = TestNotification;
    const { modules } = loadModules(context);
    const elements = new Map();
    const actions = fakeElement('div', elements);
    const themeToggle = fakeElement('button', elements);
    actions.appendChild(themeToggle);
    const toolsHost = fakeElement('section', elements);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => toolsHost });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    context.document.querySelector = selector => selector === '[data-testid="theme-toggle"]' ? themeToggle : null;

    await modules.notifications.ensurePermission();
    modules.controls.injectUIControls();

    const notificationButton = elements.get('tb-enable-notifications');
    assert.equal(permissionRequests, 0);
    assert.equal(notificationButton.textContent, '🔔 Bật Noti');
    await notificationButton.onclick();
    assert.equal(permissionRequests, 1);
    assert.equal(notificationButton.textContent, '🔔 Noti ON');
    assert.match(notificationButton.className, /tbp-btn-success/);
});

test('Fetch monitor wakes when the tab becomes visible or is restored', () => {
    const context = browser();
    const { modules } = loadModules(context);
    let wakeCalls = 0;
    Object.defineProperty(modules.taskMonitor, 'wake', { value: () => { wakeCalls++; } });

    modules.controls.init();
    modules.controls.init();
    const visibilityHandler = context.__listeners.find(listener => listener[0] === 'visibilitychange')[1];
    const pageShowHandler = context.__listeners.find(listener => listener[0] === 'pageshow')[1];
    const focusHandler = context.__listeners.find(listener => listener[0] === 'focus')[1];
    context.document.hidden = false;
    visibilityHandler();
    pageShowHandler();
    focusHandler();

    assert.equal(wakeCalls, 3);
    assert.equal(context.__listeners.filter(listener => listener[0] === 'pageshow').length, 1);
    assert.equal(context.__listeners.filter(listener => listener[0] === 'focus').length, 1);
});

test('submitted work does not mount editable task controls', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const submittedHeader = fakeElement('div', elements);
    const heading = fakeElement('h2', elements);
    heading.textContent = 'Your submitted work';
    const status = fakeElement('span', elements);
    status.textContent = 'Delivered';
    submittedHeader.appendChild(heading);
    submittedHeader.appendChild(status);
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    context.document.querySelector = () => null;
    context.document.querySelectorAll = selector => selector === 'span, [role="status"], [data-testid*="status" i]' ? [status]
        : selector === 'h1, h2, h3, [role="heading"]' ? [heading] : [];

    const toolbar = modules.panel.ensurePanel();

    assert.equal(toolbar, null);
    assert.equal(submittedHeader.classList.contains('tbp-task-header'), false);
    assert.equal(elements.has('tb-page-tools'), false);
});

test('active claimed and reworked task headers mount the controls', () => {
    for (const statusText of ['Claimed', 'Rework', 'Reworked']) {
        const context = browser();
        const { modules } = loadModules(context);
        const elements = new Map();
        const taskHeader = fakeElement('div', elements);
        const title = fakeElement('h1', elements);
        title.textContent = 'robocap_task';
        const status = fakeElement('span', elements);
        status.textContent = statusText;
        taskHeader.appendChild(title);
        taskHeader.appendChild(status);
        context.document.createElement = tag => fakeElement(tag, elements);
        context.document.getElementById = id => elements.get(id) || null;
        const descriptionField = { disabled: false, readOnly: false };
        context.document.querySelector = selector => selector === modules.config.CONFIG.selectors.description[0] ? descriptionField : null;
        context.document.querySelectorAll = selector => selector === 'span, [role="status"], [data-testid*="status" i]' ? [status]
            : selector === 'h1, h2, h3, [role="heading"]' ? [title] : [];

        const toolbar = modules.panel.ensurePanel();

        assert.ok(toolbar, `${statusText} task mounts the toolbar`);
        assert.equal(toolbar.parentElement, taskHeader);
        assert.ok(taskHeader.classList.contains('tbp-task-header'));
        assert.match(toolbar.innerHTML, /id="tbp-row-fill"/);
        assert.match(toolbar.innerHTML, /id="tbp-row-fetch"/);
        assert.match(toolbar.innerHTML, /id="tbp-row-tools"/);
        assert.match(toolbar.innerHTML, /@media screen and \(max-width:700px\)/);
        assert.match(toolbar.innerHTML, /min-height:40px/);
        assert.doesNotMatch(toolbar.innerHTML, /#tb-fetch-control-wrapper\{[^}]*flex-wrap:nowrap!important/);
        assert.doesNotMatch(toolbar.innerHTML, /tbp-speed-shortcut-hint|Ctrl \+ Shift trái/);
        assert.match(toolbar.innerHTML, /#tb-inject-fill::after\{content:'!'\}/);
        assert.doesNotMatch(toolbar.innerHTML, /tb-inject-autocut/);
        assert.doesNotMatch(toolbar.innerHTML, /tb-panel-log|tbp-copy-log|tbp-clear-log|tb-float-panel/);
        if (statusText === 'Claimed') {
            status.textContent = 'Delivered';
            assert.equal(modules.panel.ensurePanel(), null);
            assert.equal(toolbar.style.display, 'none');
            status.textContent = 'Rework';
            assert.equal(modules.panel.ensurePanel(), toolbar);
            assert.equal(toolbar.style.display, '');
        }
    }
});

test('Fill/Paste shortcuts remain and cut row contains only R2 suggestion controls', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    for (const id of ['tbp-row-fill', 'tbp-row-cut', 'tbp-row-fetch'])
        elements.set(id, fakeElement('div', elements));
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    modules.controls.injectUIControls();
    modules.controls.injectUIControls();
    modules.r2Bridge.injectR2Btns();
    assert.match(elements.get('tb-helper-toolbar').className, /tbp-toolbar/);
    assert.equal(elements.has('tb-inject-single-l3'), false);
    assert.ok(elements.get('tb-inject-l3-loop'));
    for (const [id, key] of [
        ['tb-inject-fill', '!'],
        ['tb-inject-loop', '@'],
        ['tb-inject-l3-loop', '#'],
        ['tb-inject-paste', '$'],
        ['tb-inject-paste-all', '%']
    ]) {
        const button = elements.get(id);
        assert.ok(button, `${id} was mounted`);
        assert.equal(button.attributes['aria-keyshortcuts'], key);
        assert.match(button.title, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(elements.get('tb-inject-fill').className, /tbp-btn-primary/);
    assert.equal(elements.get('tb-inject-fill').style.backgroundColor, undefined);
    assert.match(elements.get('tb-inject-loop').className, /tbp-btn-primary/);
    assert.match(elements.get('tb-inject-l3-loop').className, /tbp-btn-success/);
    assert.match(elements.get('tb-inject-paste').className, /tbp-btn-info/);
    assert.match(elements.get('tb-inject-paste-all').className, /tbp-btn-info/);
    assert.equal(elements.has('tb-inject-autocut'), false);
    assert.deepEqual(elements.get('tbp-row-cut').children.map(control => control.id), ['tb-inject-r2-open', 'tb-r2-sensitivity', 'tb-inject-r2-paste', 'tb-inject-r2-cancel']);
    assert.match(elements.get('tbp-row-cut').className, /tbp-toolbar/);
    assert.equal(elements.get('tb-inject-r2-open').textContent, '🔗 Mở video');
    assert.match(elements.get('tb-inject-r2-open').className, /tbp-btn-info/);
    assert.equal(elements.get('tb-r2-sensitivity').value, 'balanced');
    assert.match(elements.get('tb-r2-sensitivity').className, /tbp-control-select/);
    assert.deepEqual(elements.get('tb-r2-sensitivity').children.map(option => option.value), ['balanced', 'sensitive', 'conservative']);
    assert.equal(elements.get('tb-inject-r2-paste').textContent, '📋 Dán gợi ý');
    assert.match(elements.get('tb-inject-r2-paste').className, /tbp-btn-info/);
    assert.equal(elements.get('tb-inject-r2-cancel').textContent, '✕ Hủy gợi ý');
    assert.match(elements.get('tb-inject-r2-cancel').className, /tbp-btn-danger/);
    assert.equal(elements.get('tb-inject-r2-cancel').disabled, true);
});

test('Ctrl plus left Shift temporarily boosts playback and restores the selected rate', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const video = {
        duration: 120,
        playbackRate: 1.5,
        addEventListener() {},
        removeEventListener() {}
    };
    context.document.querySelectorAll = selector => selector === 'video' ? [video] : [];
    modules.controls.init();
    const speedKeyDown = context.__listeners.find(([type, , capture]) => type === 'keydown' && capture === true)[1];
    const speedKeyUp = context.__listeners.find(([type, , capture]) => type === 'keyup' && capture === true)[1];
    const keyEvent = (code, ctrlKey, shiftKey) => ({
        code,
        ctrlKey,
        shiftKey,
        prevented: false,
        preventDefault() { this.prevented = true; }
    });

    speedKeyDown(keyEvent('ControlLeft', true, false));
    const shiftDown = keyEvent('ShiftLeft', true, true);
    speedKeyDown(shiftDown);
    assert.equal(video.playbackRate, 16);
    assert.equal(shiftDown.prevented, true);

    speedKeyUp(keyEvent('ShiftLeft', true, false));
    assert.equal(video.playbackRate, 1.5);

    speedKeyDown(keyEvent('ShiftLeft', false, true));
    speedKeyDown(keyEvent('ControlRight', true, true));
    assert.equal(video.playbackRate, 16);
    speedKeyUp(keyEvent('ControlRight', false, true));
    assert.equal(video.playbackRate, 1.5);
});

test('Ctrl plus left Shift requests at most 16x and falls back when unsupported', () => {
    const context = browser();
    const { modules } = loadModules(context);
    let playbackRate = 1.5;
    const attempts = [];
    const video = {
        duration: 120,
        addEventListener() {},
        removeEventListener() {}
    };
    Object.defineProperty(video, 'playbackRate', {
        get() { return playbackRate; },
        set(rate) {
            attempts.push(rate);
            if (rate > 8) {
                const error = new Error('Unsupported playback rate');
                error.name = 'NotSupportedError';
                throw error;
            }
            playbackRate = rate;
        }
    });
    context.document.querySelectorAll = selector => selector === 'video' ? [video] : [];
    modules.controls.init();
    const speedKeyDown = context.__listeners.find(([type, , capture]) => type === 'keydown' && capture === true)[1];
    const speedKeyUp = context.__listeners.find(([type, , capture]) => type === 'keyup' && capture === true)[1];
    const keyEvent = (code, ctrlKey, shiftKey) => ({
        code,
        ctrlKey,
        shiftKey,
        preventDefault() {}
    });

    speedKeyDown(keyEvent('ControlLeft', true, false));
    speedKeyDown(keyEvent('ShiftLeft', true, true));
    assert.equal(playbackRate, 8);
    assert.deepEqual(attempts, [16, 12, 10, 8]);
    assert.ok(attempts.every(rate => rate <= 16));

    speedKeyDown(keyEvent('ShiftLeft', true, true));
    assert.deepEqual(attempts, [16, 12, 10, 8], 'repeated keydown must not retry the boost');
    speedKeyUp(keyEvent('ShiftLeft', true, false));
    assert.equal(playbackRate, 1.5);
});

test('logger sends tool and QC messages only to the browser console', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const initialLogCount = context.__logs.length;

    modules.logger.console.log('tool message');
    modules.logger.console.warn('warning');
    modules.logger.qcStatusLog('check', {
        key: 'activity',
        status: 'MATCH',
        error: '',
        feedback: [{ scope: 'EPISODE', id: 'f1', text: 'Correct the activity' }],
        mappings: [{ field: 'activity_key', before: 'old', value: 'new', status: 'PROPOSED', quote: 'Correct', reason: 'Matches feedback' }]
    });

    assert.deepEqual(context.__logs.slice(initialLogCount).map(entry => entry[0]), ['log', 'warn', 'log']);
    assert.equal(context.__logs.at(-1)[2].feedback[0].text, 'Correct the activity');
    assert.equal(context.__logs.at(-1)[2].mappings[0].reason, 'Matches feedback');
    assert.equal('panelLogBuf' in modules.logger, false);
    assert.equal('appendLogNode' in modules.logger, false);
});

test('QC controls show CheckQC and FixQC while feedback detail stays in the console', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const body = fakeElement('div', elements);
    const panel = fakeElement('section', elements);
    panel.querySelector = selector => selector === '.tbp-body' ? body : null;
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => panel });
    Object.defineProperty(modules.qcController, 'refreshEligibility', { value: () => {} });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.createTextNode = text => ({ textContent: String(text), parentElement: null });
    context.document.getElementById = id => elements.get(id) || null;

    modules.qcStore.state.taskId = 'test-task';
    modules.qcStore.state.eligibilityTaskId = 'test-task';
    modules.qcStore.state.eligibilityChecked = true;
    modules.qcStore.state.isReworkTask = false;
    modules.qcStore.state.feedback = [{ scope: 'EPISODE', id: 'f1', text: 'Detailed feedback text' }];
    modules.qcStore.state.items = [{
        start: 1,
        end: 2,
        key: 'episode-1',
        status: 'PROPOSED',
        error: 'Detailed error',
        mappings: [{
            field: 'activity_key',
            before: 'old',
            value: 'new',
            status: 'PROPOSED',
            approved: false,
            mode: 'SET',
            quote: 'Detailed quote',
            reason: 'Detailed reason'
        }]
    }];
    modules.qcView.mount();

    const section = elements.get('tb-q21');
    const row = section.children[0];
    assert.equal(section.hidden, true);
    assert.equal(elements.has('tb-q21-visual'), false);

    modules.qcStore.state.isReworkTask = true;
    modules.qcView.render();
    assert.equal(section.hidden, false);
    assert.deepEqual(row.children.filter(child => child.tagName === 'BUTTON' && buttonIsVisible(child)).map(button => button.textContent), ['CheckQC', 'FixQC']);
    assert.match(elements.get('tb-q21-check').className, /tbp-btn-info/);
    assert.match(elements.get('tb-q21-fix').className, /tbp-btn-info/);
    const visibleText = (node) => (node.textContent || '') + (node.children || []).map(visibleText).join('');
    const rendered = visibleText(section);
    assert.doesNotMatch(rendered, /Detailed feedback text|Detailed error|Detailed quote|Detailed reason/);
    assert.match(rendered, /activity_key: old → new/);
    assert.ok(context.__logs.some(entry => entry.some(value => typeof value === 'string' && value.includes('[QC]'))));

    modules.qcStore.state.workflow = true;
    modules.qcStore.state.action = 'check';
    modules.qcView.render();
    assert.match(elements.get('tb-q21-check').className, /tbp-btn-warning/);
    assert.match(elements.get('tb-q21-check').className, /tbp-btn-loading/);
});

function buttonIsVisible(button) {
    return button.style.display !== 'none';
}

test('QC Undo remains available for a task with backup after rework actions are hidden', () => {
    const context = browser();
    const { modules } = loadModules(context);
    const elements = new Map();
    const body = fakeElement('div', elements);
    const panel = fakeElement('section', elements);
    panel.querySelector = selector => selector === '.tbp-body' ? body : null;
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => panel });
    Object.defineProperty(modules.qcController, 'refreshEligibility', { value: () => {} });
    context.document.createElement = tag => fakeElement(tag, elements);
    context.document.createTextNode = text => ({ textContent: String(text), parentElement: null });
    context.document.getElementById = id => elements.get(id) || null;

    modules.qcStore.state.taskId = 'test-task';
    modules.qcStore.state.submissionId = 'submission-1';
    modules.qcStore.state.eligibilityTaskId = 'test-task';
    modules.qcStore.state.eligibilityChecked = true;
    modules.qcStore.state.isReworkTask = false;
    modules.qcStore.state.backups = [{ taskId: 'test-task', submissionId: 'submission-1', episodeKey: 'episode-1' }];
    modules.qcView.mount();

    const section = elements.get('tb-q21');
    const buttons = section.children[0].children;
    assert.equal(section.hidden, false);
    assert.deepEqual(buttons.filter(button => button.tagName === 'BUTTON' && buttonIsVisible(button)).map(button => button.textContent), ['Undo FixQC']);
    assert.equal(elements.get('tb-q21-check').style.display, 'none');
    assert.equal(elements.get('tb-q21-fix').style.display, 'none');
});

test('QC rework visibility is detected from active feedback', async () => {
    for (const [decision, expected] of [['rework', true], ['approved', false]]) {
        const context = browser();
        const { modules } = loadModules(context);
        const requests = [];
        Object.defineProperty(modules.qcApi, 'getJson', {
            value: async path => {
                requests.push(path);
                if (path === '/api/v1/tasks/test-task')
                    return { submission: { id: 'submission-1' } };
                if (path === '/api/v1/submissions/submission-1')
                    return { taskId: 'test-task', reviewHistory: [{ id: 'review-1', layer: 'QC1', round: 1, decision, reason: decision === 'rework' ? 'Change difficulty to easy' : '' }], artifacts: [] };
                return [];
            }
        });
        Object.defineProperty(modules.qcView, 'render', { value: () => {} });

        await modules.qcController.refreshEligibility();

        assert.equal(modules.qcStore.state.isReworkTask, expected);
        assert.equal(modules.qcStore.state.eligibilityChecked, true);
        assert.equal(modules.qcStore.state.eligibilityPending, false);
        assert.equal(requests.length, 3);
    }
});

test('CheckQC always captures four frames without a frame-selection checkbox', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const labels = {
        environment_l3: 'kitchen',
        task_description: 'Washing a cup',
        activity_key: 'washing-cup',
        skill_group: 'Household Chores',
        task_difficulty: 'easy'
    };
    const prepareCalls = [];
    let capturedFrames = 0;
    let groqImageCount = 0;
    modules.qcStore.state.eligibilityTaskId = 'test-task';
    modules.qcStore.state.eligibilityChecked = true;
    modules.qcStore.state.isReworkTask = true;
    Object.defineProperty(modules.qcView, 'render', { value: () => {} });
    Object.defineProperty(modules.qcApi, 'getJson', {
        value: async path => {
            if (path === '/api/v1/tasks/test-task')
                return { submission: { id: 'submission-1' } };
            if (path === '/api/v1/submissions/submission-1')
                return {
                    id: 'submission-1',
                    taskId: 'test-task',
                    reviewHistory: [],
                    artifacts: [{ id: 'artifact-1', data: { episodes: [{ episode_key: 'episode-1', start_seconds: 0, end_seconds: 10, labels }] } }]
                };
            return [{ episodeKey: 'episode-1', artifactInstanceId: 'artifact-1', decision: 'rework', reason: 'Change difficulty to easy' }];
        }
    });
    Object.defineProperty(modules.media, 'prepareFrameSource', {
        value: enabled => {
            prepareCalls.push(enabled);
            return Promise.resolve(true);
        }
    });
    Object.defineProperty(modules.media, 'grabSegmentFrames', {
        value: async () => {
            capturedFrames++;
            return ['frame-1', 'frame-2', 'frame-3', 'frame-4'];
        }
    });
    Object.defineProperty(modules.media, 'composeFrameContactSheet', {
        value: async frames => {
            assert.equal(frames.length, 4);
            return 'contact-sheet';
        }
    });
    Object.defineProperty(modules.gemini, 'geminiGenerate', {
        value: async ({ parts }) => {
            groqImageCount = parts.filter(part => part.inline_data).length;
            return '{}';
        }
    });
    Object.defineProperty(modules.gemini, 'parseJsonLoose', { value: () => ({ mappings: [] }) });
    Object.defineProperty(modules.annotationDom, 'readCurrentSegmentData', { value: () => ({
        l3: labels.environment_l3,
        description: labels.task_description,
        activity: labels.activity_key,
        skillGroup: labels.skill_group,
        difficulty: labels.task_difficulty
    }) });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', {
        value: () => [{
            getAttribute: name => name === 'data-testid' ? 'episode-index-row-episode-1' : null,
            scrollIntoView() {},
            click() {}
        }]
    });
    Object.defineProperty(modules.timeline, 'readActiveEpisodeRange', { value: () => ({ start: 0, end: 10 }) });
    Object.defineProperty(modules.runtime, 'sleep', { value: async () => {} });

    await modules.qcController.onCheckClick();

    assert.deepEqual(prepareCalls, [true]);
    assert.equal(capturedFrames, 1);
    assert.equal(groqImageCount, 1);
    assert.equal(context.document.getElementById('tb-q21-visual'), null);
    assert.equal(modules.qcStore.state.workflow, false);
});
