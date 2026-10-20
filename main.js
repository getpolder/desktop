const { app, BaseWindow, WebContentsView, Menu, shell, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://backlog.polder.work';
const TAB_BAR_HEIGHT = 38;
// While hovering a tab the (transparent) bar view grows downwards to make room for the preview card.
const PREVIEW_HEIGHT = 250;
// A named partition keeps the login across restarts, separate from anything else.
const PARTITION = 'persist:polder';

// `npm start` runs inside Electron's own bundle; this at least fixes the names in the app menu.
app.setName('Polder');

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
// New tabs open on the login page: signed out you land there instead of on the marketing home, and
// signed in the guest middleware sends you straight on to the app.
const loginUrl = new URL('/login', startUrl).href;

// Backlog, chat, docs and flows each have their own subdomain (config/domains.php) and share one
// login, so "ours" is the whole domain: backlog.polder.work -> polder.work. A bare host stays as is.
const parts = startHost.split('.');
const baseDomain = process.env.POLDER_DOMAIN || (parts.length >= 3 ? parts.slice(1).join('.') : startHost);
const MODULES = { Backlog: 'backlog', Chat: 'chat', Docs: 'docs', Flows: 'flows' };

// One entry per window: its tabs, which one is active, and the preview state of its tab bar.
const windows = [];
let nextId = 1;
let quitting = false;

const focused = () => windows.find((w) => w.win.isFocused()) ?? windows[windows.length - 1];
const active = (w) => w?.tabs.find((tab) => tab.id === w.activeId);
const windowOf = (event) => windows.find((w) => w.bar.webContents === event.sender);

function layout(w) {
    const { width, height } = w.win.getContentBounds();
    w.bar.setBounds({ x: 0, y: 0, width, height: w.barHeight });

    for (const tab of w.tabs) {
        tab.view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT });
    }
}

// Hidden views cannot be captured, so tabs keep the last picture taken while they were visible.
async function snapshot(tab) {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return;

    try {
        const image = await contents.capturePage();
        if (!image.isEmpty()) tab.preview = `data:image/jpeg;base64,${image.resize({ width: 360 }).toJPEG(70).toString('base64')}`;
    } catch {
        // The page was closing; the old picture stays.
    }
}

function hidePreview(w) {
    w.hoverId = null;
    w.barHeight = TAB_BAR_HEIGHT;
    layout(w);
}

function publish(w) {
    if (w.bar.webContents.isDestroyed()) return;

    w.bar.webContents.send('tabs:state', { tabs: w.tabs.map(({ id, title, pinned, favicon }) => ({ id, title, pinned, favicon })), active: w.activeId });
    saveState();
}

function saveState() {
    const saved = windows
        .filter((w) => w.tabs.length > 0)
        .map((w) => {
            const loaded = w.tabs.filter((tab) => tab.view.webContents.getURL());

            return {
                urls: loaded.map((tab) => tab.view.webContents.getURL()),
                pinned: loaded.map((tab) => tab.pinned),
                activeIndex: Math.max(0, loaded.findIndex((tab) => tab.id === w.activeId)),
                bounds: w.win.getBounds(),
            };
        });

    fs.writeFileSync(statePath(), JSON.stringify({ windows: saved }));
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

function openTab(w, url = loginUrl, { activate = true, pinned = false } = {}) {
    const view = new WebContentsView({ webPreferences: { partition: PARTITION, spellcheck: true } });
    const contents = view.webContents;
    const tab = { id: nextId++, view, title: '', pinned, favicon: '', preview: '' };

    // Without the Electron token sites treat us like the Chrome we are.
    contents.setUserAgent(contents.getUserAgent().replace(/ Electron\/\S+/, ''));

    contents.on('page-title-updated', (_event, title) => {
        tab.title = title;
        publish(w);
    });

    contents.on('page-favicon-updated', (_event, favicons) => {
        tab.favicon = favicons[0] ?? '';
        publish(w);
    });

    contents.on('did-finish-load', () => setTimeout(() => snapshot(tab), 800));
    contents.on('did-navigate', () => publish(w));
    contents.on('did-navigate-in-page', () => publish(w));

    // target="_blank" and window.open: our pages become a tab, everything else the default browser.
    contents.setWindowOpenHandler(({ url: target }) => {
        if (isOurs(target)) {
            openTab(w, target);
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

    contents.on('context-menu', (_event, params) => contextMenu(w, contents, params).popup());

    w.tabs.push(tab);
    w.win.contentView.addChildView(view);
    contents.loadURL(url);
    layout(w);

    if (activate) activateTab(w, tab.id);
    else publish(w);

    return tab;
}

function activateTab(w, id) {
    const tab = w.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    const previous = active(w);
    if (previous && previous !== tab) snapshot(previous);

    w.activeId = id;

    for (const other of w.tabs) {
        other.view.setVisible(other.id === id);
    }

    // Move keyboard focus into the page so Polder's own shortcuts work at once.
    tab.view.webContents.focus();
    publish(w);
}

function closeTab(w, id) {
    const index = w.tabs.findIndex((tab) => tab.id === id);
    // Pinned tabs have to be unpinned first.
    if (index === -1 || w.tabs[index].pinned) return;

    const [tab] = w.tabs.splice(index, 1);
    w.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();

    if (w.tabs.length === 0) {
        w.win.close();
        return;
    }

    if (id === w.activeId) activateTab(w, w.tabs[Math.min(index, w.tabs.length - 1)].id);
    else publish(w);
}

// Pinned tabs always sit first: pinning moves a tab to the end of that group, unpinning to just after it.
function setPinned(w, id, pinned) {
    const tab = w.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    tab.pinned = pinned;
    w.tabs.splice(w.tabs.indexOf(tab), 1);
    w.tabs.splice(w.tabs.filter((other) => other.pinned).length, 0, tab);
    publish(w);
}

function step(w, offset) {
    if (!w) return;

    const index = w.tabs.findIndex((tab) => tab.id === w.activeId);
    activateTab(w, w.tabs[(index + offset + w.tabs.length) % w.tabs.length].id);
}

function contextMenu(w, contents, params) {
    const items = [];

    if (params.linkURL) {
        items.push(
            { label: 'Open Link in New Tab', click: () => (isOurs(params.linkURL) ? openTab(w, params.linkURL, { activate: false }) : shell.openExternal(params.linkURL)) },
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
        click: () => {
            const w = focused();
            const tab = w?.tabs[i === 8 ? w.tabs.length - 1 : i];
            if (tab) activateTab(w, tab.id);
        },
    }));

    // Deliberately few accelerators: whatever the menu claims, the web page never sees.
    // Cmd+K, Cmd+F, Cmd+A and Cmd+Enter belong to Polder and are left alone.
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            { role: 'appMenu' },
            {
                label: 'File',
                submenu: [
                    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => (focused() ? openTab(focused()) : createWindow()) },
                    { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
                    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => focused() && closeTab(focused(), focused().activeId) },
                ],
            },
            { role: 'editMenu' },
            {
                label: 'Go',
                submenu: Object.entries(MODULES).map(([label, sub], i) => ({
                    label: `${label} in New Tab`,
                    accelerator: `CmdOrCtrl+Alt+${i + 1}`,
                    click: () => {
                        const url = `${new URL(startUrl).protocol}//${sub}.${baseDomain}/login`;
                        if (focused()) openTab(focused(), url);
                        else createWindow({ urls: [url] });
                    },
                })),
            },
            {
                label: 'View',
                submenu: [
                    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => active(focused())?.view.webContents.reload() },
                    { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => active(focused())?.view.webContents.reloadIgnoringCache() },
                    { type: 'separator' },
                    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => active(focused())?.view.webContents.setZoomLevel(0) },
                    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
                    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
                    { type: 'separator' },
                    { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => active(focused())?.view.webContents.toggleDevTools() },
                    { role: 'togglefullscreen' },
                ],
            },
            {
                label: 'History',
                submenu: [
                    { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => active(focused())?.view.webContents.navigationHistory.goBack() },
                    { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => active(focused())?.view.webContents.navigationHistory.goForward() },
                ],
            },
            {
                label: 'Window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    { type: 'separator' },
                    { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => step(focused(), 1) },
                    { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => step(focused(), -1) },
                    { label: 'Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: () => step(focused(), 1), visible: false },
                    { label: 'Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: () => step(focused(), -1), visible: false },
                    { type: 'separator' },
                    ...tabItems,
                ],
            },
        ]),
    );
}

function zoom(delta) {
    const contents = active(focused())?.view.webContents;
    if (contents) contents.setZoomLevel(contents.getZoomLevel() + delta);
}

// `entry` is one saved window ({ urls, pinned, activeIndex, bounds }); without it you get a fresh one.
function createWindow(entry = {}) {
    // A new window opens a little offset from the one in front, so it does not hide it.
    const front = focused()?.win.getBounds();
    const bounds = entry.bounds ?? (front && { ...front, x: front.x + 28, y: front.y + 28 });

    const win = new BaseWindow({
        width: 1280,
        height: 860,
        ...bounds,
        minWidth: 640,
        minHeight: 400,
        title: 'Polder',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 12 },
    });

    const bar = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'tabbar-preload.js'), sandbox: true } });
    bar.setBackgroundColor('#00000000');

    const w = { win, bar, tabs: [], activeId: null, barHeight: TAB_BAR_HEIGHT, hoverId: null };
    windows.push(w);

    win.contentView.addChildView(bar);
    bar.webContents.loadFile(path.join(__dirname, 'tabbar.html'));

    win.on('resize', () => layout(w));
    win.on('close', () => !quitting && saveState());
    win.on('closed', () => {
        windows.splice(windows.indexOf(w), 1);
        if (!quitting) saveState();
    });

    // A restored identity page has lost its OAuth request: signing in there lands on the account profile
    // instead of the app. Start such a tab over from the login page, which comes back to Backlog.
    const entries = (entry.urls ?? [])
        .map((url, i) => ({ url, pinned: Boolean(entry.pinned?.[i]) }))
        .filter(({ url }) => isOurs(url))
        .map(({ url, pinned }) => ({ url: new URL(url).hostname === `id.${baseDomain}` ? loginUrl : url, pinned }));

    (entries.length ? entries : [{ url: loginUrl, pinned: false }]).forEach(({ url, pinned }) => openTab(w, url, { activate: false, pinned }));
    activateTab(w, w.tabs[Math.min(entry.activeIndex ?? 0, w.tabs.length - 1)].id);
    layout(w);
}

// IPC from a tab bar: look up which window it belongs to.
const onBar = (channel, handler) =>
    ipcMain.on(channel, (event, ...args) => {
        const w = windowOf(event);
        if (w) handler(w, ...args);
    });

onBar('tabs:ready', publish);
onBar('tabs:activate', (w, id) => activateTab(w, id));
onBar('tabs:close', (w, id) => closeTab(w, id));
onBar('tabs:new', (w) => openTab(w));
onBar('tabs:menu', (w, id) => {
    const tab = w.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    Menu.buildFromTemplate([
        { label: tab.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => setPinned(w, id, !tab.pinned) },
        { label: 'Close Tab', enabled: !tab.pinned, click: () => closeTab(w, id) },
    ]).popup({ window: w.win });
});
onBar('tabs:hover', async (w, id) => {
    const tab = w.tabs.find((candidate) => candidate.id === id);
    if (!tab) return;

    w.hoverId = id;
    if (id === w.activeId) await snapshot(tab);
    if (w.hoverId !== id || !windows.includes(w)) return;

    // Re-adding moves the bar above the page views, which were added later.
    w.barHeight = TAB_BAR_HEIGHT + PREVIEW_HEIGHT;
    w.win.contentView.addChildView(w.bar);
    layout(w);
    w.bar.webContents.send('tabs:preview', { id, image: tab.preview, host: new URL(tab.view.webContents.getURL() || startUrl).hostname });
});
onBar('tabs:unhover', hidePreview);
onBar('tabs:move', (w, id, to) => {
    const from = w.tabs.findIndex((tab) => tab.id === id);
    if (from === -1 || !Number.isInteger(to)) return;

    // A tab cannot leave its group: pinned ones stay in front.
    const pinnedCount = w.tabs.filter((tab) => tab.pinned).length;
    const [min, max] = w.tabs[from].pinned ? [0, pinnedCount - 1] : [pinnedCount, w.tabs.length - 1];

    w.tabs.splice(Math.min(Math.max(to, min), max), 0, ...w.tabs.splice(from, 1));
    publish(w);
});

app.whenReady().then(() => {
    // Only the camera-less basics a project tool needs; everything else is refused by default.
    session.fromPartition(PARTITION).setPermissionRequestHandler((_contents, permission, callback) =>
        callback(['clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(permission)),
    );

    // The packaged app gets its icon from the bundle (and build/ is not inside the asar); this covers `npm start`.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png'));

    buildMenu();

    // state.json used to hold a single window ({ urls, ... }); that still restores as one.
    const saved = readJson(statePath());
    const entries = saved.windows ?? (saved.urls ? [saved] : []);

    for (const entry of entries.length ? entries : [{}]) createWindow(entry);

    app.on('activate', () => {
        if (windows.length === 0) createWindow();
    });
});

// Freeze the saved state first: windows closing one by one during quit must not erase themselves from it.
app.on('before-quit', () => {
    saveState();
    quitting = true;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
