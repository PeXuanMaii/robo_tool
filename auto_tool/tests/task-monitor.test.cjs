'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

test('auto-fetch skips Automotive and Transport L1 while allowing null L1', async () => {
    const context = browser();
    const tasks = [
        { id: 'blocked-lowercase', l1: ' Automotive and Transport ', durationSeconds: 10000 },
        { id: 'blocked-uppercase', L1: 'Automotive and Transport', durationSeconds: 10000 },
        { id: 'allowed-null', l1: null, durationSeconds: 10000 },
        { id: 'allowed-uppercase-null', L1: null, durationSeconds: 10000 },
        { id: 'allowed-other', l1: 'Food Preparation', durationSeconds: 10000 }
    ];
    const requests = [];
    let poolUrl = '';
    context.fetch = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, method: init.method });
        if (url === poolUrl)
            return new Response(JSON.stringify({ tasks }), { status: 200 });
        if (init.method === 'POST')
            return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
    };
    const { modules } = loadModules(context);
    poolUrl = modules.config.API_URL;
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-token' }) });
    const notified = [];
    Object.defineProperty(modules.notifications, 'showAcquireNotification', {
        value: async acquired => notified.push(...acquired)
    });

    try {
        await modules.taskMonitor.tick();

        const acquiredIds = requests
            .filter(request => request.method === 'POST')
            .map(request => request.url.split('/api/v1/tasks/')[1].split('/acquire')[0]);
        assert.deepEqual(acquiredIds, ['allowed-null', 'allowed-uppercase-null', 'allowed-other']);
        assert.deepEqual(notified.map(task => task.id), acquiredIds);
    }
    finally {
        modules.taskMonitor.stop();
    }
});

test('auto-fetch applies comma-separated L1 exclusions case-insensitively', async () => {
    const context = browser();
    const tasks = [
        { id: 'excluded-first', L1: 'Food Preparation', durationSeconds: 10000 },
        { id: 'excluded-second', l1: 'automotive and transport', durationSeconds: 10000 },
        { id: 'allowed-null', L1: null, durationSeconds: 10000 },
        { id: 'allowed-other', l1: 'Retail Operations', durationSeconds: 10000 }
    ];
    const requests = [];
    let poolUrl = '';
    context.fetch = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, method: init.method });
        if (url === poolUrl)
            return new Response(JSON.stringify({ tasks }), { status: 200 });
        if (init.method === 'POST')
            return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
    };
    const { modules } = loadModules(context);
    poolUrl = modules.config.API_URL;
    modules.config.L1_EXCEPT = ' Food Preparation , Automotive and Transport ';
    Object.defineProperty(modules.auth, 'findToken', { value: () => ({ token: 'test-token' }) });
    Object.defineProperty(modules.notifications, 'showAcquireNotification', { value: async () => {} });

    try {
        await modules.taskMonitor.tick();

        const acquiredIds = requests
            .filter(request => request.method === 'POST')
            .map(request => request.url.split('/api/v1/tasks/')[1].split('/acquire')[0]);
        assert.deepEqual(acquiredIds, ['allowed-null', 'allowed-other']);

        modules.config.L1_EXCEPT = 'Food Preparation';
        await modules.taskMonitor.tick();
        const acquiredAfterUpdatingExclusions = requests
            .filter(request => request.method === 'POST')
            .map(request => request.url.split('/api/v1/tasks/')[1].split('/acquire')[0]);
        assert.deepEqual(acquiredAfterUpdatingExclusions, ['allowed-null', 'allowed-other', 'excluded-second']);
    }
    finally {
        modules.taskMonitor.stop();
    }
});
