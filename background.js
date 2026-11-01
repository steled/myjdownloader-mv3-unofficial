'use strict';

// ============================================================
// Constants (mirroring StorageService keys)
// ============================================================
const SETTINGS_CLIPBOARD_OBSERVER = "CLIPBOARD_OBSERVER";
const SETTINGS_CONTEXT_MENU_SIMPLE = "CONTEXT_MENU_SIMPLE";
const SETTINGS_ENHANCE_CAPTCHA_DIALOG = "ENHANCE_CAPTCHA_DIALOG";
const SETTINGS_CLICKNLOAD_ACTIVE = "CLICKNLOAD_ACTIVE";

const SESSION_STORAGE_KEY = "jdapi/src/core/core.js";

const ITEM_TYPE = { TEXT: "text", LINK: "link", CNL: "cnl" };

// ============================================================
// In-memory state (reset when service worker restarts)
// ============================================================
let isConnected = false;
let settings = {
  [SETTINGS_CLIPBOARD_OBSERVER]: false,
  [SETTINGS_CONTEXT_MENU_SIMPLE]: true,
  [SETTINGS_ENHANCE_CAPTCHA_DIALOG]: true,
  [SETTINGS_CLICKNLOAD_ACTIVE]: true
};
let requestQueue = {};
let requestIDCounter = 0;
let popupCandidates = {};
let previousActiveTab = null;
let rc2TabUpdateCallbacks = {};
let rc2CanCloseIntervalHandles = {};
const buildVersion = chrome.runtime.getManifest().version;

// ============================================================
// Badge
// ============================================================
function updateBadge() {
  let text = isConnected ? "" : "!";
  let color = isConnected ? "#000000" : "#f3d435";
  if (settings[SETTINGS_CLIPBOARD_OBSERVER]) {
    text = "Clip";
    color = "#368a8f";
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ============================================================
// Context Menus
// ============================================================
function initMenuItems() {
  chrome.contextMenus.removeAll(() => {
    const noop = () => { if (chrome.runtime.lastError) {} };
    if (settings[SETTINGS_CONTEXT_MENU_SIMPLE]) {
      chrome.contextMenus.create({
        id: "simple_menu_item",
        title: chrome.i18n.getMessage("context_menu_download_with_jdownloader"),
        contexts: ["all"]
      }, noop);
    } else {
      const items = [
        { id: "download_page",      key: "context_menu_add_page",      ctx: ["all"] },
        { id: "download_selection", key: "context_menu_add_selection",  ctx: ["selection"] },
        { id: "download_link",      key: "context_menu_add_link",       ctx: ["link"] },
        { id: "download_video",     key: "context_menu_add_video",      ctx: ["video"] },
        { id: "download_audio",     key: "context_menu_add_audio",      ctx: ["audio"] },
        { id: "download_image",     key: "context_menu_add_image",      ctx: ["image"] }
      ];
      items.forEach(({ id, key, ctx }) =>
        chrome.contextMenus.create({ id, title: chrome.i18n.getMessage(key), contexts: ctx }, noop)
      );
    }
  });
}

// ============================================================
// Content script injection (for already-open tabs on install/update)
// ============================================================
function isBlockedUrl(url) {
  return (!url.startsWith("http://") && !url.startsWith("https://")) ||
    url.startsWith("https://chrome.google.com/webstore/");
}

function injectContentScripts() {
  chrome.windows.getAll({ populate: true }, windows => {
    if (!windows) return;
    const allScripts = chrome.runtime.getManifest().content_scripts.flatMap(cs => cs.js);
    for (const win of windows) {
      if (!win.tabs) continue;
      for (const tab of win.tabs) {
        if (!tab.url || isBlockedUrl(tab.url)) continue;
        for (const cs of chrome.runtime.getManifest().content_scripts) {
          for (const script of cs.js) {
            if (script === "contentscripts/webinterfaceEnhancer.js" &&
                !tab.url.startsWith("https://my.jdownloader.org")) continue;
            if (script === "contentscripts/browserSolverEnhancer.js") continue;

            const opts = {
              target: { tabId: tab.id, allFrames: true },
              files: [script]
            };
            if (cs.world === "MAIN") {
              chrome.scripting.executeScript(Object.assign(opts, { world: "MAIN" })).catch(() => {});
            } else {
              chrome.scripting.executeScript(opts).catch(() => {});
            }
          }
        }
      }
    }
  });
}

// ============================================================
// Request queue helpers
// ============================================================
function addPageToRequestQueue(tab) {
  const time = Date.now();
  const id = `${tab.id}${time}${Math.random() * 10000}`;
  if (!requestQueue[tab.id]) requestQueue[tab.id] = [];
  const link = {
    id, time,
    parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    content: tab.url,
    type: ITEM_TYPE.LINK
  };
  if (!requestQueue[tab.id].some(v => v.type === ITEM_TYPE.LINK && v.content === link.content)) {
    requestQueue[tab.id].push(link);
    safeSendTabMessage(tab.id, { action: "open-in-page-toolbar", tabId: tab.id });
    safeSendTabMessage(tab.id, { action: "link-info-update", tabId: tab.id });
  }
}

function addLinkToRequestQueue(linkUrl, tab) {
  const time = Date.now();
  const id = `${tab.id}${time}${Math.random() * 10000}`;
  if (!requestQueue[tab.id]) requestQueue[tab.id] = [];
  const link = {
    id, time,
    parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    content: linkUrl,
    type: ITEM_TYPE.LINK
  };
  if (!requestQueue[tab.id].some(v => v.type === ITEM_TYPE.LINK && v.content === linkUrl)) {
    requestQueue[tab.id].push(link);
    safeSendTabMessage(tab.id, { action: "open-in-page-toolbar", tabId: tab.id });
    safeSendTabMessage(tab.id, { action: "link-info-update", tabId: tab.id });
  }
}

function addTextToRequestQueue(previewText, content, tab) {
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: false },
    files: ["contentscripts/toolbarContentscript.js"]
  }).then(() => {
    safeSendTabMessage(tab.id, { action: "open-in-page-toolbar", tabId: tab.id });
    setTimeout(() => {
      const time = Date.now();
      const id = `${tab.id}${time}${Math.random() * 10000}`;
      if (!requestQueue[tab.id]) requestQueue[tab.id] = [];
      requestQueue[tab.id].push({
        id, time,
        parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
        content,
        previewText,
        type: ITEM_TYPE.TEXT
      });
      safeSendTabMessage(tab.id, { action: "link-info-update", tabId: tab.id });
    }, 200);
  }).catch(() => {});
}

function safeSendTabMessage(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ============================================================
// Rc2 / captcha helpers
// ============================================================
function onNewCaptchaAvailable(tabId, callbackUrl, params) {
  if (!rc2TabUpdateCallbacks[tabId]) {
    rc2TabUpdateCallbacks[tabId] = {
      captchaParams: { callbackUrl, params },
      callback: innerTabId => {
        chrome.scripting.executeScript({
          target: { tabId: innerTabId, allFrames: true },
          files: ['/contentscripts/rc2Contentscript.js']
        }).then(() => {
          safeSendTabMessage(innerTabId, { name: "myjdrc2", action: "captcha-available" });
        }).catch(() => {});
      }
    };
    chrome.tabs.update(tabId, { url: params.finalUrl + "#rc2jdt" });
  }
}

function sendRc2SolutionToJd(request, sender) {
  const { callbackUrl, token, captchaId } = request.data;
  if (callbackUrl && callbackUrl !== "undefined" && callbackUrl !== "MYJD") {
    fetch(callbackUrl + "&do=solve&response=" + token, {
      headers: { "X-Myjd-Appkey": "webextension-" + buildVersion }
    }).then(() => {
      if (sender && sender.tab && sender.tab.id) {
        setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 2000);
      }
    }).catch(console.error);
  } else if (captchaId && callbackUrl === "MYJD") {
    chrome.tabs.query({ url: ["http://my.jdownloader.org/*", "https://my.jdownloader.org/*"] }, tabs => {
      for (const tab of (tabs || [])) {
        safeSendTabMessage(tab.id, {
          name: "response", type: "myjdrc2",
          data: { captchaId, token }
        });
      }
    });
  }
}

function onRc2MouseMove(callbackUrl, timestamp) {
  fetch(callbackUrl + "&do=canClose&useractive=true&ts=" + timestamp, {
    headers: { "X-Myjd-Appkey": "webextension-" + buildVersion },
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

function onRc2FrameLoaded(request) {
  const p = request.params;
  const qs = `&x=${encodeURIComponent(p.x)}&y=${encodeURIComponent(p.y)}`
    + `&w=${encodeURIComponent(p.w)}&h=${encodeURIComponent(p.h)}`
    + `&vw=${encodeURIComponent(p.vw)}&vh=${encodeURIComponent(p.vh)}`
    + `&eleft=${encodeURIComponent(p.eleft)}&etop=${encodeURIComponent(p.etop)}`
    + `&ew=${encodeURIComponent(p.ew)}&eh=${encodeURIComponent(p.eh)}`
    + `&dpi=${encodeURIComponent(p.dpi)}`;
  fetch(request.callbackUrl + "&do=loaded" + qs, {
    headers: { "X-Myjd-Appkey": "webextension-" + buildVersion },
    signal: AbortSignal.timeout(5000)
  }).catch(() => {});
}

function removeRc2CanCloseCheck(tabId) {
  clearInterval(rc2CanCloseIntervalHandles[tabId]);
  delete rc2CanCloseIntervalHandles[tabId];
}

function checkRc2TabModeCanClose(request, sender) {
  fetch(request.data.callbackUrl + "&do=canClose", {
    headers: { "X-Myjd-Appkey": "webextension-" + buildVersion },
    signal: AbortSignal.timeout(5000)
  }).then(r => r.text()).then(text => {
    if (text === "true") {
      removeRc2CanCloseCheck(sender.tab.id);
      chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
  }).catch(e => {
    console.error(e);
    removeRc2CanCloseCheck(sender.tab.id);
  });
}

function onSkipRequest(sender, data) {
  if (!data.callbackUrl || data.callbackUrl === "undefined" || data.callbackUrl === "MYJD") return;
  const skipType = { all: "all", hoster: "hoster", package: "package", single: "single" }[data.skipType];
  if (!skipType) return;
  fetch(data.callbackUrl + "&do=skip&skiptype=" + skipType, {
    headers: { "X-Myjd-Appkey": "webextension-" + buildVersion },
    signal: AbortSignal.timeout(5000)
  }).then(() => {
    if (sender && sender.tab && sender.tab.id) {
      setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 2000);
    }
  }).catch(() => {});
}

// ============================================================
// Message dispatch (mirrors ExtensionMessagingService pattern)
// ============================================================
const msgListeners = Object.create(null);

function addMsgListener(name, action, cb) {
  const _action = typeof action === "function" ? "_all" : (action || "_all");
  const _cb = typeof action === "function" ? action : cb;
  if (!msgListeners[name]) msgListeners[name] = {};
  if (!msgListeners[name][_action]) msgListeners[name][_action] = [];
  msgListeners[name][_action].push(_cb);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.name) {
    const action = request.action || "_all";
    const cbs = (msgListeners[request.name] && msgListeners[request.name][action]) || [];
    cbs.forEach(cb => { try { cb(request, sender, sendResponse); } catch (e) { console.error(e); } });
  }
  return true; // keep port open for async responses
});

// ============================================================
// Message listeners
// ============================================================

// --- Queue management ---
addMsgListener("myjd-toolbar", "link-info", (req, _s, respond) => {
  const q = requestQueue[req.data];
  q ? respond({ data: q }) : respond({ error: "not_found" });
});

addMsgListener("myjd-toolbar", "remove-all-requests", req => {
  requestQueue[req.data.tabId] = [];
});

addMsgListener("myjd-toolbar", "remove-request", req => {
  const { tabId, requestId } = req.data;
  if (requestQueue[tabId]) {
    requestQueue[tabId] = requestQueue[tabId].filter(r => r.id !== requestId);
  }
});

addMsgListener("myjd-toolbar", "tab-contentscript-injected", (req, sender) => {
  if (sender && sender.tab && sender.tab.id) delete requestQueue[sender.tab.id];
});

addMsgListener("myjd-toolbar", "close-in-page-toolbar", (req) => {
  const raw = req.data && req.data.tabId ? parseFloat(req.data.tabId) : NaN;
  if (!isNaN(raw)) {
    safeSendTabMessage(raw, { action: "close-in-page-toolbar", tabId: req.data.tabId });
    delete requestQueue[raw];
  } else {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      if (tabs && tabs[0]) {
        delete requestQueue[tabs[0].id];
        safeSendTabMessage(tabs[0].id, { action: "close-in-page-toolbar", tabId: req.data && req.data.tabId });
      }
    });
  }
});

addMsgListener("close-me", (req, sender) => {
  if (!req.data || !req.data.tabId) return;
  const tabId = req.data.tabId === "self" ? sender.tab.id : parseInt(req.data.tabId, 10);
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError) return;
    chrome.tabs.remove(tabId).catch(() => {});
    chrome.windows.get(tab.windowId, { populate: true }, win => {
      if (chrome.runtime.lastError) return;
      const isEmpty = !win.tabs.length || (win.tabs.length === 1 && win.tabs[0].url === "about:newtab");
      if (isEmpty) chrome.windows.remove(win.id).catch(() => {});
    });
  });
});

// --- Clipboard ---
addMsgListener("myjd-toolbar", "new-copy-event", (req, sender) => {
  if (sender.tab && settings[SETTINGS_CLIPBOARD_OBSERVER]) {
    safeSendTabMessage(sender.tab.id, { action: "get-selection", tabId: sender.tab.id });
  }
});

addMsgListener("myjd-selection", "new-selection", (req, sender) => {
  if (sender.tab) addTextToRequestQueue(req.data.text, req.data.html, sender.tab);
});

// --- Web interface enhancer ---
addMsgListener("webinterface-enhancer", "settings", (req, sender, respond) => {
  if (sender.tab) respond({ active: settings[SETTINGS_ENHANCE_CAPTCHA_DIALOG] });
});

// --- CNL from MAIN-world interceptor (via isolated relay) ---
addMsgListener("myjd-cnl", "add-request", (req, sender, respond) => {
  if (!sender.tab) { respond({}); return; }
  const tab = sender.tab;
  const formData = req.data.formData;
  requestIDCounter++;
  const time = Date.now();
  const newReq = {
    id: `${requestIDCounter}${time}${Math.random() * 10000}`,
    type: ITEM_TYPE.CNL, time,
    parent: { url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl },
    content: {
      source: Array.isArray(formData.source) ? formData.source[0] : formData.source,
      urls: formData.urls,
      passwords: formData.passwords,
      package: Array.isArray(formData.package) ? formData.package[0] : formData.package,
      tabId: tab.id,
      isCrypted: req.data.isCrypted,
      requestBody: { formData }
    }
  };
  if (!requestQueue[tab.id]) requestQueue[tab.id] = [];
  requestQueue[tab.id].push(newReq);
  safeSendTabMessage(tab.id, { action: "open-in-page-toolbar", tabId: tab.id });
  safeSendTabMessage(tab.id, { action: "link-info-update", tabId: tab.id });

  // CNL popups (opened via window.open()) auto-close via countdown before the
  // user can interact with the toolbar.  Mirror the item into the opener tab's
  // queue so the toolbar there survives the popup closing.
  //
  // chrome.tabs.get() is async and the popup may already be closed by the time
  // it resolves (countdown is only ~1 s).  Instead, use popupCandidates which
  // records the full Tab object — including openerTabId — synchronously in
  // chrome.tabs.onCreated, before the tab has a chance to close.
  const candidate = popupCandidates[tab.id];
  const openerTabId = (candidate && candidate.tab && candidate.tab.openerTabId)
                    || tab.openerTabId;
  console.log('[JD CNL background] CNL received from tab', tab.id, '— openerTabId:', openerTabId);
  if (openerTabId) {
    if (!requestQueue[openerTabId]) requestQueue[openerTabId] = [];
    requestQueue[openerTabId].push(newReq);
    safeSendTabMessage(openerTabId, { action: "open-in-page-toolbar", tabId: openerTabId });
    safeSendTabMessage(openerTabId, { action: "link-info-update", tabId: openerTabId });
  }

  respond({});
});

// --- Connection state (sent by popup/toolbar after login/logout) ---
addMsgListener("myjd-toolbar", "CONNECTION_STATE_CHANGE", req => {
  if (req.data === "CONNECTED") {
    isConnected = true;
    updateBadge();
    initMenuItems();
    chrome.runtime.sendMessage({
      name: "myjd-toolbar",
      action: "session-change",
      data: { isLoggedIn: true }
    }).catch(() => {});
  } else if (req.data === "DISCONNECTED") {
    isConnected = false;
    updateBadge();
    chrome.contextMenus.removeAll();
    chrome.tabs.query({}, tabs => {
      for (const tab of (tabs || [])) {
        safeSendTabMessage(tab.id, "remove-dialog");
        delete requestQueue[tab.id];
      }
    });
    chrome.runtime.sendMessage({
      name: "myjd-toolbar",
      action: "session-change",
      data: { isLoggedIn: false }
    }).catch(() => {});
  }
  // CONNECTING / RECONNECTING: keep the current state. The session is still
  // stored and the API reconnects on its own, so flipping to "!" here would
  // only make the badge flash.
});

// The session persisted by jdapi is the source of truth for "connected": the
// service worker is restarted all the time and loses its in-memory state.
function hasStoredSession(value) {
  try {
    const opts = typeof value === "string" ? JSON.parse(value) : value;
    return !!(opts && opts.sessiontoken);
  } catch (e) {
    return false;
  }
}

function applyConnectionState(connected) {
  if (connected === isConnected) return;
  isConnected = connected;
  updateBadge();
  if (connected) initMenuItems();
  else chrome.contextMenus.removeAll();
}

// --- Rc2 captcha messages ---
addMsgListener("myjdrc2", "loaded", (req, sender) => {
  if (req.callbackUrl && req.callbackUrl !== "undefined" && req.callbackUrl !== "MYJD") {
    onRc2FrameLoaded(req, sender);
  }
});

addMsgListener("myjdrc2", "response", (req, sender) => sendRc2SolutionToJd(req, sender));

addMsgListener("myjdrc2", "mouse-move", req => onRc2MouseMove(req.callbackUrl, req.timestamp));

addMsgListener("myjdrc2", "captcha-new", (req, sender) => {
  onNewCaptchaAvailable(sender.tab.id, req.data.callbackUrl, JSON.parse(req.data.params));
});

addMsgListener("myjdrc2", "captcha-get", (req, sender) => {
  const info = rc2TabUpdateCallbacks[sender.tab.id];
  if (!info) { console.log("no captcha available:", sender.tab.id); return; }
  safeSendTabMessage(sender.tab.id, {
    name: "myjdrc2", action: "captcha-set",
    data: { callbackUrl: info.captchaParams.callbackUrl, params: info.captchaParams.params }
  });
});

addMsgListener("myjdrc2", "tabmode-init", (req, sender) => {
  const { callbackUrl } = req.data;
  if (callbackUrl && callbackUrl !== "undefined" && callbackUrl !== "MYJD") {
    const handle = setInterval(() => {
      if (!rc2CanCloseIntervalHandles[sender.tab.id]) { clearInterval(handle); return; }
      checkRc2TabModeCanClose(req, sender);
    }, 1000);
    rc2CanCloseIntervalHandles[sender.tab.id] = handle;
  }
});

addMsgListener("myjdrc2", "tabmode-skip-request", (req, sender) => onSkipRequest(sender, req.data));

addMsgListener("webinterface-enhancer", "captcha-done", req => {
  chrome.runtime.sendMessage({ name: "myjdrc2", action: "captcha-done", data: req.data }).catch(() => {});
});

// ============================================================
// Chrome event listeners
// ============================================================
chrome.tabs.onCreated.addListener(tab => {
  popupCandidates[tab.id] = { tab, creationTime: Date.now(), lastActiveTab: previousActiveTab };
  previousActiveTab = tab;
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete rc2TabUpdateCallbacks[tabId];
  delete requestQueue[tabId];
  delete popupCandidates[tabId];
  if (rc2CanCloseIntervalHandles[tabId]) {
    clearInterval(rc2CanCloseIntervalHandles[tabId]);
    delete rc2CanCloseIntervalHandles[tabId];
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tabInfo) => {
  // Fire pending Rc2 callback when page finishes loading
  const captchaInfo = rc2TabUpdateCallbacks[tabId];
  if (captchaInfo && captchaInfo.callback && changeInfo.status === "complete") {
    captchaInfo.callback(tabId);
    delete captchaInfo.callback;
  }

  // Update popup-candidate info
  if (popupCandidates[tabId] && changeInfo.url) {
    popupCandidates[tabId].tab = tabInfo;
  }

  // Inject browser-solver scripts when JD opens a local captcha page
  if (changeInfo.status === "complete" && tabInfo.url &&
      /http:\/\/127\.0\.0\.1:\d+\/captcha\/(recaptchav(2|3)|hcaptcha)\/.*\?id=\d+$/.test(tabInfo.url)) {
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['/contentscripts/browserSolverEnhancer.js']
    }).catch(() => {});
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  switch (info.menuItemId) {
    case "download_page":
      addPageToRequestQueue(tab); break;
    case "download_selection":
      safeSendTabMessage(tab.id, { action: "get-selection", tabId: tab.id }); break;
    case "simple_menu_item":
      if (info.selectionText) safeSendTabMessage(tab.id, { action: "get-selection", tabId: tab.id });
      else if (info.linkUrl) addLinkToRequestQueue(info.linkUrl, tab);
      else if (info.srcUrl)  addLinkToRequestQueue(info.srcUrl, tab);
      else addPageToRequestQueue(tab);
      break;
    case "download_link":
      if (info.linkUrl) addLinkToRequestQueue(info.linkUrl, tab); break;
    case "download_video":
    case "download_image":
    case "download_audio":
      if (info.srcUrl) addLinkToRequestQueue(info.srcUrl, tab); break;
  }
});

chrome.commands.onCommand.addListener(command => {
  if (command === "toggle-clipboard-observer") {
    chrome.storage.local.get([SETTINGS_CLIPBOARD_OBSERVER], result => {
      const cur = result[SETTINGS_CLIPBOARD_OBSERVER];
      const newVal = typeof cur === "boolean" ? !cur : true;
      chrome.storage.local.get(null, data => {
        chrome.storage.local.set(Object.assign({}, data, { [SETTINGS_CLIPBOARD_OBSERVER]: newVal }));
      });
    });
  }
});

chrome.storage.onChanged.addListener(changes => {
  if (changes[SESSION_STORAGE_KEY]) {
    applyConnectionState(hasStoredSession(changes[SESSION_STORAGE_KEY].newValue));
  }
  if (changes[SETTINGS_CONTEXT_MENU_SIMPLE]) {
    settings[SETTINGS_CONTEXT_MENU_SIMPLE] = changes[SETTINGS_CONTEXT_MENU_SIMPLE].newValue;
    if (isConnected) initMenuItems();
  }
  if (changes[SETTINGS_ENHANCE_CAPTCHA_DIALOG]) {
    settings[SETTINGS_ENHANCE_CAPTCHA_DIALOG] = changes[SETTINGS_ENHANCE_CAPTCHA_DIALOG].newValue;
  }
  if (changes[SETTINGS_CLIPBOARD_OBSERVER]) {
    settings[SETTINGS_CLIPBOARD_OBSERVER] = changes[SETTINGS_CLIPBOARD_OBSERVER].newValue;
    updateBadge();
  }
  if (changes[SETTINGS_CLICKNLOAD_ACTIVE] !== undefined) {
    settings[SETTINGS_CLICKNLOAD_ACTIVE] = changes[SETTINGS_CLICKNLOAD_ACTIVE].newValue;
  }
});

// Ensure DNR rules are in place every time the service worker starts,
// not just on install/update (dynamic rules persist but defensive reset is cheap).
setupDynamicRules();

chrome.runtime.onInstalled.addListener(details => {
  if (chrome.runtime.lastError) console.log(chrome.runtime.lastError.message);
  if (details.reason === "update" || details.reason === "install") {
    injectContentScripts();
  }
  setupDynamicRules();
});

// ============================================================
// Dynamic declarativeNetRequest rules
// ============================================================
function setupDynamicRules() {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1, 2],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { url: chrome.runtime.getURL("res/jdcheck.js") }
        },
        condition: {
          urlFilter: "||127.0.0.1:9666/jdcheck.js",
          resourceTypes: ["script", "xmlhttprequest", "main_frame", "sub_frame"]
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { url: chrome.runtime.getURL("res/jdcheck.js") }
        },
        condition: {
          urlFilter: "||localhost:9666/jdcheck.js",
          resourceTypes: ["script", "xmlhttprequest", "main_frame", "sub_frame"]
        }
      }
    ]
  });
}

// ============================================================
// Init
// ============================================================
async function initSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      [SETTINGS_CLIPBOARD_OBSERVER, SETTINGS_CONTEXT_MENU_SIMPLE,
       SETTINGS_ENHANCE_CAPTCHA_DIALOG, SETTINGS_CLICKNLOAD_ACTIVE, SESSION_STORAGE_KEY],
      result => {
        isConnected = hasStoredSession(result[SESSION_STORAGE_KEY]);
        settings[SETTINGS_CLIPBOARD_OBSERVER]    = result[SETTINGS_CLIPBOARD_OBSERVER]    ?? false;
        settings[SETTINGS_CONTEXT_MENU_SIMPLE]   = result[SETTINGS_CONTEXT_MENU_SIMPLE]   ?? true;
        settings[SETTINGS_ENHANCE_CAPTCHA_DIALOG]= result[SETTINGS_ENHANCE_CAPTCHA_DIALOG]?? true;
        settings[SETTINGS_CLICKNLOAD_ACTIVE]     = result[SETTINGS_CLICKNLOAD_ACTIVE]     ?? true;
        resolve();
      }
    );
  });
}

async function init() {
  await initSettings();
  updateBadge();
  if (isConnected) initMenuItems();
  setupDynamicRules();
  // Inject browser-solver for already-open local captcha tabs
  chrome.tabs.query({ url: "http://127.0.0.1/*" }, tabs => {
    for (const tab of (tabs || [])) {
      if (tab.url && /http:\/\/127\.0\.0\.1:\d*\/captcha\/.*\?id=\d+/.test(tab.url)) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["contentscripts/browserSolverEnhancer.js"]
        }).catch(() => {});
      }
    }
  });
}

chrome.runtime.onStartup.addListener(init);
init();
