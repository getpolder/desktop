const { app, BaseWindow, WebContentsView, Menu, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://backlog.polder.work';
const TAB_BAR_HEIGHT = 38;
// A named partition keeps the login across restarts, separate from anything else.
const PARTITION = 'persist:polder';

const statePath = () => path.join(app.getPath('userData'), 'state.json');

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

// Start URL: POLDER_URL, then `url` in <userData>/config.json, then the default.
const startUrl = process.env.POLDER_URL || readJson(path.join(app.getPath('userData'), 'config.json')).url || DEFAULT_URL;
const startHost = new URL(startUrl).hostname;

// Backlog, chat, docs and flows each have their own subdomain (config/domains.php) and share one
// login, so "ours" is the whole domain: backlog.polder.work -> polder.work. A bare host stays as is.
const parts = startHost.split('.');
const baseDomain = process.env.POLDER_DOMAIN || (parts.length >= 3 ? parts.slice(1).join('.') : startHost);
const MODULES = { Backlog: 'backlog', Chat: 'chat', Docs: 'docs', Flows: 'flows' };

let win = null;
let bar = null;
let tabs = [];
let activeId = null;
let nextId = 1;

const active = () => tabs.find((tab) => tab.id === activeId);

function layout() {
    if (!win) return;

    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });

    for (const tab of tabs) {
        tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT });
    }
}

function publish() {
    if (!bar || bar.webContents.isDestroyed()) return;

    bar.webContents.send('tabs:state', { tabs: tabs.map(({ id, title }) => ({ id, title })), active: activeId });
    saveState();
}

function saveState() {
    const urls = tabs.map((tab) => tab.view.webContents.getURL()).filter(Boolean);
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeId));

    fs.writeFileSync(statePath(), JSON.stringify({ urls, activeIndex, bounds: win?.getBounds() }));
}

// Only Polder's own domain may live in a tab; anything else goes to the real browser.
const isOurs = (url) => {
    try {
        const { protocol, hostname } = new URL(url);

        return ['http:', 'https:'].includes(protocol) && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`));
    } catch {
        return false;
    }
};

function openTab(url = startUrl, { activate = true } = {}) {
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, spellcheck: true } });
    const contents = view.webContents;
    const tab = { id: nextId++, view, title: '' };

    // Without the Electron token sites treat us like the Chrome we are.
    contents.setUserAgent(contents.getUserAgent().replace(/ Electron\/\S+/, ''));

    contents.on('page-title-updated', (_event, title) => {
        tab.title = title;
        publish();
    });

    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);

    // target="_blank" and window.open: our pages become a tab, everything else the default browser.
    contents.setWindowOpenHandler(({ url: target }) => {
        if (isOurs(target)) {
            openTab(target);
        } else {
            shell.openExternal(target);
        }

        return { action: 'deny' };
    });

    contents.on('will-navigate', (event, target) => {
        if (!isOurs(target)) {
            event.preventDefault();
            shell.openExternal(target);
        }
    });

    contents.on('context-menu', (_event, params) => contextMenu(contents, params).popup());

    tabs.push(tab);
    win.contentView.addChildView(view);
    contents.loadURL(url);
    layout();

    if (activate) activateTab(tab.id);
    else publish();

    return tab;
}

function activateTab(id) {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    activeId = id;

    for (const other of tabs) {
        other.view.setVisible(other.id === id);
    }

    // Move keyboard focus into the page so Polder's own shortcuts work at once.
    tab.view.webContents.focus();
    publish();
}

function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    const [tab] = tabs.splice(index, 1);
    win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();

    if (tabs.length === 0) {
        win.close();
        return;
    }

    if (id === activeId) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
    else publish();
}

function step(offset) {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    activateTab(tabs[(index + offset + tabs.length) % tabs.length].id);
}

function contextMenu(contents, params) {
    const items = [];

    if (params.linkURL) {
        items.push(
            { label: 'Open Link in New Tab', click: () => (isOurs(params.linkURL) ? openTab(params.linkURL, { activate: false }) : shell.openExternal(params.linkURL)) },
            { label: 'Open Link in Browser', click: () => shell.openExternal(params.linkURL) },
            { label: 'Copy Link', click: () => require('electron').clipboard.writeText(params.linkURL) },
            { type: 'separator' },
        );
    }

    if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
        }
        items.push({ type: 'separator' });
    }

    if (params.isEditable) {
        items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    } else if (params.selectionText) {
        items.push({ role: 'copy' });
    } else {
        items.push(
            { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
            { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
            { label: 'Reload', click: () => contents.reload() },
        );
    }

    items.push({ type: 'separator' }, { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) });

    return Menu.buildFromTemplate(items);
}

function buildMenu() {
    const tabItems = Array.from({ length: 9 }, (_, i) => ({
        label: `Tab ${i + 1}`,
        accelerator: `CmdOrCtrl+${i + 1}`,
        click: () => tabs[i === 8 ? tabs.length - 1 : i] && activateTab(tabs[i === 8 ? tabs.length - 1 : i].id),
    }));

    // Deliberately few accelerators: whatever the menu claims, the web page never sees.
    // Cmd+K, Cmd+F, Cmd+A and Cmd+Enter belong to Polder and are left alone.
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: 'appMenu' },
            {
                label: 'File',
                submenu: [
                    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => openTab() },
                    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => activeId && closeTab(activeId) },
                ],
            },
            { role: 'editMenu' },
            {
                label: 'Go',
                submenu: Object.entries(MODULES).map(([label, sub], i) => ({
                    label: `${label} in New Tab`,
                    accelerator: `CmdOrCtrl+Alt+${i + 1}`,
                    click: () => openTab(`${new URL(startUrl).protocol}//${sub}.${baseDomain}`),
                })),
            },
            {
                label: 'View',
                submenu: [
                    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => active()?.view.webContents.reload() },
                    { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => active()?.view.webContents.reloadIgnoringCache() },
                    { type: 'separator' },
                    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => active()?.view.webContents.setZoomLevel(0) },
                    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
                    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
                    { type: 'separator' },
                    { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => active()?.view.webContents.toggleDevTools() },
                    { role: 'togglefullscreen' },
                ],
            },
            {
                label: 'History',
                submenu: [
                    { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => active()?.view.webContents.navigationHistory.goBack() },
                    { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => active()?.view.webContents.navigationHistory.goForward() },
                ],
            },
            {
                label: 'Window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    { type: 'separator' },
                    { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => step(1) },
                    { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => step(-1) },
                    { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: () => step(1), visible: false },
                    { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: () => step(-1), visible: false },
                    { type: 'separator' },
                    ...tabItems,
                ],
            },
        ]),
    );
}

function zoom(delta) {
    const contents = active()?.view.webContents;
    if (contents) contents.setZoomLevel(contents.getZoomLevel() + delta);
}

function createWindow() {
    const saved = readJson(statePath());

    win = new BaseWindow({
        width: 1280,
        height: 860,
        ...saved.bounds,
        minWidth: 640,
        minHeight: 400,
        title: 'Polder',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 12 },
    });

    bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'tabbar-preload.js'), sandbox: true } });
    win.contentView.addChildView(bar);
    bar.webContents.loadFile(path.join(__dirname, 'tabbar.html'));

    win.on('resize', layout);
    win.on('close', saveState);
    win.on('closed', () => {
        win = bar = null;
        tabs = [];
        activeId = null;
    });

    const urls = saved.urls?.filter(isOurs) ?? [];

    (urls.length ? urls : [startUrl]).forEach((url) => openTab(url, { activate: false }));
    activateTab(tabs[Math.min(saved.activeIndex ?? 0, tabs.length - 1)].id);
    layout();
}

ipcMain.on('tabs:ready', publish);
ipcMain.on('tabs:activate', (_event, id) => activateTab(id));
ipcMain.on('tabs:close', (_event, id) => closeTab(id));
ipcMain.on('tabs:new', () => openTab());

app.whenReady().then(() => {
    // Only the camera-less basics a project tool needs; everything else is refused by default.
    session.fromPartition(PARTITION).setPermissionRequestHandler((_contents, permission, callback) =>
        callback(['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission)),
    );

    buildMenu();
    createWindow();

    app.on('activate', () => {
        if (BaseWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
