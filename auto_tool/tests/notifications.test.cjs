'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

test('startup permission check does not prompt; explicit enable requests permission', async () => {
    const context = browser();
    let permissionRequests = 0;
    const shownNotifications = [];
    function TestNotification(title, options) {
        this.title = title;
        this.options = options;
        this.close = () => { this.closed = true; };
        shownNotifications.push(this);
    }
    TestNotification.permission = 'default';
    TestNotification.requestPermission = async () => {
        permissionRequests++;
        TestNotification.permission = 'granted';
        return 'granted';
    };
    context.Notification = TestNotification;
    const { modules } = loadModules(context);

    assert.equal(await modules.notifications.ensurePermission(), false);
    assert.equal(permissionRequests, 0);
    assert.equal(await modules.notifications.enableNotifications(), 'granted');
    assert.equal(permissionRequests, 1);

    await modules.notifications.showAcquireNotification([{ id: 'task-1', durationSeconds: 3600 }]);
    assert.equal(shownNotifications.length, 1);
    assert.equal(shownNotifications[0].title, '🚀 Đã nhận Task mới thành công!');
    assert.equal(shownNotifications[0].options.body, 'ID: task-1\nThời lượng: 1.00 giờ');
    assert.equal(shownNotifications[0].options.tag, 'tbrain-acquired-task-1');
});

test('userscript-manager notifications work without page Notification permission', async () => {
    const context = browser();
    const notifications = [];
    context.GM_notification = details => { notifications.push(details); };
    const { modules } = loadModules(context);

    assert.equal(modules.notifications.getPermissionState(), 'userscript');
    assert.equal(await modules.notifications.ensurePermission(), true);
    await modules.notifications.showAcquireNotification([{ id: 'task-2', durationSeconds: 1800 }]);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].text, 'ID: task-2\nThời lượng: 0.50 giờ');
    assert.equal(notifications[0].tag, 'tbrain-acquired-task-2');
    assert.equal(typeof notifications[0].onclick, 'function');
});
