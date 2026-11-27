/**
 * The JavaScript for Automation program that every browser operation runs through
 * `osascript`. It reads one JSON request from standard input and writes one JSON
 * reply.
 *
 * Browser events are raw Apple Events addressed to one process ID. JXA's
 * `Application(pid)` is not used: with several processes of one bundle running,
 * it delivered events to another process than the one named. An event to a
 * process that has exited fails instead of launching the application.
 */

export const JXA_PROGRAM = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]);
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]);
ObjC.bindFunction('CGRequestScreenCaptureAccess', ['bool', []]);
const D = $.NSAppleEventDescriptor;

function readRequest() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
}
function fail(code, message, extra, number) {
  const error = new Error(message);
  error.pbCode = code;
  if (extra) error.extra = extra;
  if (typeof number === 'number') error.errorNumber = number;
  throw error;
}
function nsText(value) {
  return value === undefined || value === null || value.isNil() ? null : value.js;
}
function fcc(s) {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}
function codeText(n) {
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
function osType(type, value) {
  const bytes = $(value.split('').reverse().join('')).dataUsingEncoding($.NSASCIIStringEncoding);
  return D.descriptorWithDescriptorTypeData(fcc(type), bytes);
}
function specifier(want, from, form, selector) {
  const record = D.recordDescriptor;
  record.setDescriptorForKeyword(D.descriptorWithTypeCode(fcc(want)), fcc('want'));
  record.setDescriptorForKeyword(from || D.nullDescriptor, fcc('from'));
  record.setDescriptorForKeyword(D.descriptorWithEnumCode(fcc(form)), fcc('form'));
  record.setDescriptorForKeyword(selector, fcc('seld'));
  return record.coerceToDescriptorType(fcc('obj '));
}
function every(want, from) { return specifier(want, from, 'indx', osType('abso', 'all ')); }
function byId(want, from, id) { return specifier(want, from, 'ID  ', D.descriptorWithString(String(id))); }
function property(code, from) { return specifier('prop', from, 'prop', D.descriptorWithTypeCode(fcc(code))); }

function send(pid, eventClass, eventId, direct, params, seconds) {
  const event = D.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
    fcc(eventClass), fcc(eventId), D.descriptorWithProcessIdentifier(pid), -1, 0);
  if (direct) event.setParamDescriptorForKeyword(direct, fcc('----'));
  for (const key of Object.keys(params || {})) event.setParamDescriptorForKeyword(params[key], fcc(key));
  const failure = $();
  const reply = event.sendEventWithOptionsTimeoutError(3, seconds || 30, failure);
  if (reply.isNil()) {
    const known = !failure.isNil();
    fail(null, known ? failure.localizedDescription.js : 'Apple Event failed.', null, known ? Number(failure.code) : null);
  }
  const errorNumber = reply.paramDescriptorForKeyword(fcc('errn'));
  if (!errorNumber.isNil()) {
    const message = reply.paramDescriptorForKeyword(fcc('errs'));
    fail(null, message.isNil() ? 'The browser returned an error.' : message.stringValue.js, null, errorNumber.int32Value);
  }
  return reply.paramDescriptorForKeyword(fcc('----'));
}
function value(descriptor) {
  if (descriptor.isNil()) return null;
  const type = codeText(descriptor.descriptorType);
  if (type === 'list') {
    const result = [];
    for (let i = 1; i <= descriptor.numberOfItems; i++) result.push(value(descriptor.descriptorAtIndex(i)));
    return result;
  }
  if (type === 'bool' || type === 'true' || type === 'fals') return Boolean(descriptor.booleanValue);
  if (type === 'long' || type === 'shor' || type === 'comp' || type === 'magn') return Number(descriptor.int32Value);
  if (type === 'doub' || type === 'sing') return Number(descriptor.doubleValue);
  if (type === 'qdrt') return { qdrect: descriptor.data.base64EncodedStringWithOptions(0).js };
  if (type === 'null' || type === 'msng') return null;
  const text = descriptor.stringValue;
  return text.isNil() ? null : text.js;
}
function get(pid, code, from, seconds) {
  return value(send(pid, 'core', 'getd', property(code, from), null, seconds));
}
function getAll(pid, code, from) {
  try {
    const result = get(pid, code, from);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    if (error.errorNumber === -1728) return [];
    throw error;
  }
}
function optionalGet(pid, code, from) {
  // A metadata read can fail after the page script ran, for example when the tab closes.
  // The script result stays valid, so the failure is returned beside it, not thrown.
  try {
    return { value: get(pid, code, from), error: null };
  } catch (error) {
    return {
      value: null,
      error: {
        number: typeof error.errorNumber === 'number' ? error.errorNumber : null,
        message: String(error && error.message ? error.message : error).slice(0, 500),
      },
    };
  }
}

function installed(bundleId) {
  const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundleId);
  if (url.isNil()) return null;
  const path = url.path.js;
  const bundle = $.NSBundle.bundleWithPath(path);
  const version = bundle.isNil() ? null : nsText(bundle.objectForInfoDictionaryKey('CFBundleShortVersionString'));
  return { path: path, version: version };
}
function instances(bundleId) {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
  const count = Number(apps.count);
  const result = [];
  for (let i = 0; i < count; i++) {
    const app = apps.objectAtIndex(i);
    if (app.terminated) continue;
    result.push({ pid: Number(app.processIdentifier), hidden: Boolean(app.hidden), active: Boolean(app.active) });
  }
  return result;
}
function checkProcess(pid, bundleId) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (app.isNil() || app.terminated) fail('not-running', 'No running process has this pid.');
  const actual = nsText(app.bundleIdentifier);
  if (actual !== bundleId) fail('pid-mismatch', 'The pid belongs to another application.', { bundleId: actual });
  return app;
}
function permission(target, ask) {
  const status = $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, Boolean(ask));
  if (status === 0) return 'granted';
  if (status === -1743) return 'denied';
  if (status === -1744) return 'not-determined';
  if (status === -600) return 'not-running';
  return 'unknown';
}
function ready(request) {
  const app = checkProcess(request.pid, request.bundleId);
  const automation = permission(D.descriptorWithProcessIdentifier(request.pid), false);
  if (automation !== 'granted') fail('automation-' + automation, 'macOS Automation permission for this browser is ' + automation + '.');
  return app;
}
function windowList(pid) {
  const windows = every('cwin', null);
  const tabs = every('CrTb', windows);
  const ids = getAll(pid, 'ID  ', windows);
  if (ids.length === 0) return [];
  const columns = {
    title: getAll(pid, 'pnam', windows), mode: getAll(pid, 'mode', windows), minimized: getAll(pid, 'pmnd', windows),
    visible: getAll(pid, 'pvis', windows), bounds: getAll(pid, 'pbnd', windows), activeTabIndex: getAll(pid, 'acTI', windows),
    tabIds: getAll(pid, 'ID  ', tabs), urls: getAll(pid, 'URL ', tabs), titles: getAll(pid, 'pnam', tabs), loading: getAll(pid, 'ldng', tabs),
  };
  for (const key of Object.keys(columns)) {
    if (columns[key].length !== ids.length) fail('changed', 'Browser windows changed during the listing.');
  }
  return ids.map(function (id, i) {
    const tabIds = columns.tabIds[i] || [];
    for (const column of [columns.urls[i], columns.titles[i], columns.loading[i]]) {
      if (!Array.isArray(column) || column.length !== tabIds.length) fail('changed', 'Browser tabs changed during the listing.');
    }
    return {
      id: String(id), title: columns.title[i], mode: columns.mode[i], minimized: Boolean(columns.minimized[i]),
      visible: Boolean(columns.visible[i]), bounds: columns.bounds[i], activeTabIndex: Number(columns.activeTabIndex[i]),
      tabs: tabIds.map(function (tabId, j) {
        return { id: String(tabId), url: columns.urls[i][j], title: columns.titles[i][j], loading: Boolean(columns.loading[i][j]) };
      }),
    };
  });
}
function locate(pid, tabId) {
  const windows = every('cwin', null);
  const windowIds = getAll(pid, 'ID  ', windows);
  const tabIds = getAll(pid, 'ID  ', every('CrTb', windows));
  for (let i = 0; i < windowIds.length; i++) {
    const row = tabIds[i] || [];
    for (let j = 0; j < row.length; j++) {
      if (String(row[j]) === tabId) {
        const window = byId('cwin', null, windowIds[i]);
        return { window: window, windowId: String(windowIds[i]), tab: byId('CrTb', window, row[j]) };
      }
    }
  }
  fail('tab-not-found', 'No open tab has this id in the selected browser process.');
}
// A JavaScript dialog or print preview blocks every page script until a person answers it.
// A trivial script with a short limit finds that before the request sends its own script.
function responsive(pid, tab, seconds) {
  if (!seconds) return;
  try {
    send(pid, 'CrSu', 'ExJa', tab, { JvSc: D.descriptorWithString('1') }, seconds);
  } catch (error) {
    if (error.errorNumber === -1712)
      fail('page-blocked', 'The page did not answer a trivial script within ' + seconds + ' s.');
    throw error;
  }
}
function originOf(url) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]*)/i.exec(url || '');
  return match ? match[1].toLowerCase() : null;
}
// The page script's JSON envelope, or null when the result is not a JSON object.
function envelopeOf(result) {
  if (result === null) return null;
  try {
    const parsed = JSON.parse(String(result));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    return null;
  }
}
// Reads the tab URL through Apple Events and refuses another origin.
function tabURL(request, found) {
  const url = get(request.pid, 'URL ', found.tab);
  if (request.expectOrigin !== null && originOf(url) !== request.expectOrigin)
    fail('origin-mismatch', 'The tab does not show the expected origin.', { url: url });
  return url;
}
function cgWindows(pid) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))) || [];
  return list.filter(function (item) { return item.kCGWindowOwnerPID === pid && item.kCGWindowLayer === 0; }).map(function (item) {
    const b = item.kCGWindowBounds || {};
    return { id: item.kCGWindowNumber, onScreen: Boolean(item.kCGWindowIsOnscreen), name: item.kCGWindowName === undefined ? null : String(item.kCGWindowName), bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height } };
  });
}
function readWindows(pid) {
  try {
    return windowList(pid);
  } catch (error) {
    // A column read can disagree with the window ids when the browser changes
    // during the listing. One repeated read-only listing resolves that race.
    if (!error || error.pbCode !== 'changed') throw error;
    return windowList(pid);
  }
}
// A QuickDraw rectangle as Apple Events report window bounds: top, left, bottom, right as
// native (little-endian) 16-bit integers.
function rectOf(qd) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of String(qd || '').replace(/=+$/, '')) {
    buffer = ((buffer << 6) | alphabet.indexOf(ch)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  if (bytes.length !== 8) return null;
  const int16 = function (i) { const v = bytes[i] | (bytes[i + 1] << 8); return v >= 32768 ? v - 65536 : v; };
  return { x: int16(2), y: int16(0), width: int16(6) - int16(2), height: int16(4) - int16(0) };
}
// Accessibility reads. Element references are cast to objects before use.
function axValue(element, name) {
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(name), ref) === 0 && ref[0] ? ObjC.castRefToObject(ref[0]) : null;
}
function axString(element, name) {
  const v = axValue(element, name);
  if (!v) return null;
  try {
    const text = v.js;
    return typeof text === 'string' ? text : null;
  } catch (error) {
    return null;
  }
}
function axList(element, name) {
  const list = axValue(element, name);
  const out = [];
  if (!list) return out;
  const count = Number(list.count);
  for (let i = 0; i < count; i++) out.push(list.objectAtIndex(i));
  return out;
}
function axChildren(element) {
  return axList(element, 'AXChildren');
}
// Position and size are AXValue structures; their description carries the numbers.
function axFrame(element) {
  const position = axValue(element, 'AXPosition');
  const size = axValue(element, 'AXSize');
  if (!position || !size) return null;
  const p = /x:\s*(-?[\d.]+)\s+y:\s*(-?[\d.]+)/.exec(String(position.description.js));
  const s = /w:\s*(-?[\d.]+)\s+h:\s*(-?[\d.]+)/.exec(String(size.description.js));
  if (!p || !s) return null;
  return { x: Math.round(Number(p[1])), y: Math.round(Number(p[2])), width: Math.round(Number(s[1])), height: Math.round(Number(s[2])) };
}
function pause(seconds) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
}
// The Save sheet (AppKit's save panel) attached to the Accessibility window with the given frame.
function saveSheet(pid, frame) {
  const app = $.AXUIElementCreateApplication(pid);
  // A browser that does not answer Accessibility within two seconds fails the read instead of hanging it.
  $.AXUIElementSetMessagingTimeout(app, 2);
  const windows = axList(app, 'AXWindows');
  const matching = windows.filter(function (w) {
    const f = axFrame(w);
    return f && f.x === frame.x && f.y === frame.y && f.width === frame.width && f.height === frame.height;
  });
  if (matching.length !== 1) fail('window-not-matched', 'Accessibility shows no single window at the bounds of this tab\'s window.');
  const sheets = axChildren(matching[0]).filter(function (c) { return axString(c, 'AXRole') === 'AXSheet' && axString(c, 'AXIdentifier') === 'save-panel'; });
  return { window: matching[0], sheet: sheets.length ? sheets[0] : null };
}
// The parts of a save panel, searched breadth first: the name field, the folder popup, the
// folders of the listed files, and the Save and Cancel buttons. The search reads only the
// attributes that an element's role can carry and ends once it knows the parts and a listed
// folder with the popup's name, or after a bounded number of elements, since the file list can
// hold many rows. The panel reports no default or cancel button attribute; the Save button
// carries the identifier OKButton, and Cancel is the one other plain button beside it apart
// from New Folder.
function panelParts(sheet) {
  const manager = $.NSFileManager.defaultManager;
  const parts = { name: null, where: null, folders: [], save: null, cancel: null };
  let listed = false;
  let saveParent = null;
  let level = [{ element: sheet, parent: null }];
  let visits = 0;
  const done = function () { return parts.name && parts.save && parts.where !== null && listed; };
  while (level.length && visits < 800 && !done()) {
    const next = [];
    for (const item of level) {
      if (++visits > 800 || done()) break;
      const element = item.element;
      const role = axString(element, 'AXRole');
      const id = role === 'AXTextField' || role === 'AXPopUpButton' || role === 'AXButton' ? axString(element, 'AXIdentifier') : null;
      if (id === 'saveAsNameTextField') parts.name = element;
      else if (id === 'where popup') parts.where = axString(element, 'AXValue');
      else if (id === 'OKButton' && role === 'AXButton') {
        parts.save = element;
        saveParent = item.parent;
      } else if (role === 'AXTextField' && parts.folders.length < 20) {
        const url = axValue(element, 'AXURL');
        try {
          const path = url ? url.filePathURL.path.js : null;
          const folder = path ? path.replace(/\/+$/, '').replace(/\/[^\/]*$/, '') || '/' : null;
          if (folder && parts.folders.indexOf(folder) < 0) {
            parts.folders.push(folder);
            if (parts.where !== null && manager.displayNameAtPath(folder).js === parts.where) listed = true;
          }
        } catch (error) {
          // A row whose URL does not resolve to a file path names no folder; the other rows still can.
        }
      }
      for (const child of axChildren(element)) next.push({ element: child, parent: element });
    }
    level = next;
  }
  if (saveParent) {
    const others = axChildren(saveParent).filter(function (element) {
      const id = axString(element, 'AXIdentifier');
      return axString(element, 'AXRole') === 'AXButton' && !axString(element, 'AXSubrole') && id !== 'OKButton' && id !== 'NewFolderButton';
    });
    if (others.length === 1) parts.cancel = others[0];
  }
  return parts;
}
// The folder in which the save panel last saved, which macOS keeps as a bookmark in the
// browser's preferences domain; read after a save, it names the folder of that save.
function lastSaveFolder(bundleId) {
  $.CFPreferencesAppSynchronize($(bundleId));
  const data = $.NSUserDefaults.alloc.initWithSuiteName(bundleId).objectForKey('NSOSPLastRootDirectory');
  if (data.isNil()) return null;
  const url = $.NSURL.URLByResolvingBookmarkDataOptionsRelativeToURLBookmarkDataIsStaleError(data, (1 << 8) | (1 << 9), $(), Ref(), Ref());
  return url.isNil() ? null : url.path.js;
}
// Folders that can be the one the panel shows: the folders of its listed files and the standard
// folders whose display name the folder popup shows, then the Downloads folder.
function panelFolders(parts) {
  const manager = $.NSFileManager.defaultManager;
  const home = $.NSHomeDirectory().js;
  const named = function (folder) { return parts.where !== null && manager.displayNameAtPath(folder).js === parts.where; };
  const standard = [home + '/Downloads', home + '/Desktop', home + '/Documents', home].filter(named);
  const folders = [];
  for (const folder of parts.folders.filter(named).concat(standard, [home + '/Downloads']))
    if (folders.indexOf(folder) < 0 && manager.fileExistsAtPath(folder)) folders.push(folder);
  return folders;
}
// Whether the file or the browser's partial file is already in the folder.
function present(folder, name) {
  const manager = $.NSFileManager.defaultManager;
  return manager.fileExistsAtPath(folder + '/' + name) || manager.fileExistsAtPath(folder + '/' + name + '.crdownload');
}
// Text of an alert that a save panel shows over itself, such as a question about replacing a file.
function panelAlert(sheet) {
  for (const child of axChildren(sheet)) {
    if (axString(child, 'AXRole') !== 'AXSheet') continue;
    const texts = [];
    for (const part of axChildren(child)) {
      const text = axString(part, 'AXRole') === 'AXStaticText' ? axString(part, 'AXValue') : null;
      if (text) texts.push(text);
    }
    return { sheet: child, text: texts.join(' ').slice(0, 500) };
  }
  return null;
}
function stillOpen(window) {
  return axChildren(window).some(function (c) { return axString(c, 'AXIdentifier') === 'save-panel'; });
}
function inventoryOf(bundleId) {
  return { installed: installed(bundleId), instances: instances(bundleId) };
}
function tabsResult(kind, found, extra) {
  return Object.assign(
    { kind: kind, inventory: found, pid: null, automation: null, windows: [], blocked: null, instances: [] },
    extra || {},
  );
}
function blockedResult(kind, found, reason, message, extra) {
  return tabsResult(kind, found, Object.assign({ blocked: { reason: reason, message: message } }, extra || {}));
}
const operations = {
  availability: function (request) {
    const browsers = (request.queries || []).map(function (query) {
      const found = inventoryOf(query.bundleId);
      return {
        browser: query.browser,
        installed: found.installed,
        instances: found.instances,
        automation:
          query.checkAutomation && found.instances.length > 0
            ? permission(D.descriptorWithBundleIdentifier(query.bundleId), false)
            : 'not-checked',
      };
    });
    return { browsers: browsers };
  },
  tabs: function (request) {
    const found = inventoryOf(request.bundleId);
    if (!request.inspectAllowed) return blockedResult('blocked', found, 'access-missing', 'Apple Events are not configured for this browser.');
    if (found.instances.length === 0)
      return blockedResult('blocked', found, 'not-running', 'The browser is not running. The tool never starts a browser.');
    let pid = request.pid;
    if (pid === undefined) {
      if (found.instances.length > 1)
        return tabsResult('ambiguous-process', found, { instances: found.instances });
      pid = found.instances[0].pid;
    } else if (!found.instances.some(function (item) { return item.pid === pid; })) {
      return blockedResult('blocked', found, 'not-running', 'No running process has this pid.', { pid: pid });
    }
    let automation = null;
    if (request.requestPermission) {
      automation = permission(D.descriptorWithProcessIdentifier(pid), true);
      if (automation !== 'granted')
        return blockedResult('blocked', found, 'automation-' + automation, 'Automation permission is ' + automation + '.', { pid: pid, automation: automation });
    }
    try {
      ready({ pid: pid, bundleId: request.bundleId });
    } catch (error) {
      if (!error || !error.pbCode) throw error;
      return blockedResult('blocked', found, error.pbCode, error.message, { pid: pid });
    }
    return tabsResult('ok', found, { pid: pid, automation: automation, windows: readWindows(pid) });
  },
  execute: function (request) {
    ready(request);
    const found = locate(request.pid, request.tab);
    responsive(request.pid, found.tab, request.probeSeconds);
    const result = value(send(request.pid, 'CrSu', 'ExJa', found.tab, { JvSc: D.descriptorWithString(request.script) }, request.seconds));
    const text = result === null ? null : String(result);
    // The envelope carries the page identity; the tab URL and title are read only without one.
    if (envelopeOf(text)) return { window: found.windowId, url: null, title: null, result: text, metadataError: null };
    const url = optionalGet(request.pid, 'URL ', found.tab);
    const title = optionalGet(request.pid, 'pnam', found.tab);
    return { window: found.windowId, url: url.value, title: title.value, result: text, metadataError: url.error || title.error };
  },
  // The page navigates itself when its script can: Chromium makes itself the active
  // application when Apple Events set a tab URL, and not when the page navigates. This
  // operation never sets the URL; when the page did not navigate, the caller arms its focus
  // watch and sends setURL.
  navigate: function (request) {
    ready(request);
    const found = locate(request.pid, request.tab);
    const before = tabURL(request, found);
    let reply = null;
    let pageError = null;
    try {
      responsive(request.pid, found.tab, request.probeSeconds);
      reply = envelopeOf(value(send(request.pid, 'CrSu', 'ExJa', found.tab, { JvSc: D.descriptorWithString(request.script) }, request.seconds)));
    } catch (error) {
      // A blocked page or a closed tab refuses; any other page-script failure leaves the URL to Apple Events.
      if (error.pbCode || typeof error.errorNumber !== 'number' || error.errorNumber === -1712 || error.errorNumber === -1728) throw error;
      pageError = error.errorNumber;
    }
    if (reply && reply.kind === 'origin-mismatch')
      fail('origin-mismatch', 'The page does not show the expected origin.', { url: before, page: reply.page || null });
    if (reply && reply.kind === 'expired')
      fail('page-blocked', 'The page ran the navigation only after the tool stopped waiting for it, so nothing ran.');
    return { window: found.windowId, before: before, navigated: Boolean(reply && reply.kind === 'navigating'), page: reply ? reply.page || null : null, pageError: pageError };
  },
  setURL: function (request) {
    ready(request);
    const found = locate(request.pid, request.tab);
    const before = tabURL(request, found);
    send(request.pid, 'core', 'setd', property('URL ', found.tab), { data: D.descriptorWithString(request.url) });
    return { window: found.windowId, before: before };
  },
  // Answers the Save sheet of the tab's window through Accessibility: no keystroke reaches
  // the browser, and the browser does not become the active application. The panel itself
  // decides whether the name exists: its replace question is answered Cancel and reported.
  saveDialog: function (request) {
    ready(request);
    const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front.isNil() && Number(front.processIdentifier) === request.pid)
      fail('browser-in-use', 'The browser is the active application.');
    ObjC.import('ApplicationServices');
    ObjC.bindFunction('CFPreferencesAppSynchronize', ['bool', ['id']]);
    if (!$.AXIsProcessTrusted()) {
      if (request.requestPermission) $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
      fail('accessibility-not-granted', 'macOS Accessibility permission for this host application is missing.');
    }
    const found = locate(request.pid, request.tab);
    const bounds = get(request.pid, 'pbnd', found.window);
    const frame = bounds && bounds.qdrect ? rectOf(bounds.qdrect) : null;
    if (!frame) fail('window-not-matched', 'The bounds of this tab\'s window are unreadable.');
    const target = saveSheet(request.pid, frame);
    if (!target.sheet) fail('no-save-dialog', 'The window of this tab shows no Save dialog.', { window: found.windowId });
    const parts = panelParts(target.sheet);
    const suggested = parts.name ? axString(parts.name, 'AXValue') : null;
    const facts = { window: found.windowId, suggestedName: suggested, folderName: parts.where };
    // A dialog that suggests another name than the download the agent started can be the operator's.
    const stem = function (value) { return String(value || '').replace(/\.[^.]+$/, ''); };
    if (request.expect && suggested !== request.expect && stem(suggested) !== stem(request.expect))
      fail('dialog-mismatch', 'The Save dialog suggests another name than expectedName, so it can belong to the operator.', facts);
    const button = request.cancel ? parts.cancel || axValue(target.sheet, 'AXCancelButton') : parts.save || axValue(target.sheet, 'AXDefaultButton');
    if (!button) fail('dialog-unreadable', 'The Save dialog shows no ' + (request.cancel ? 'Cancel' : 'Save') + ' button to Accessibility. A dialog of a hidden or minimized window shows none.', facts);
    let name = suggested;
    if (!request.cancel) {
      if (!parts.name) fail('dialog-unreadable', 'The Save dialog shows no file name field to Accessibility.', facts);
      if (request.name !== null && request.name !== undefined) {
        $.AXUIElementSetAttributeValue(parts.name, $('AXValue'), $(request.name));
        name = axString(parts.name, 'AXValue');
        if (name !== request.name) fail('name-not-set', 'The Save dialog did not take the file name.', Object.assign({ shown: name }, facts));
      }
      if (!name) fail('name-not-set', 'The Save dialog has no file name.', facts);
    }
    const before = request.cancel ? [] : panelFolders(parts).map(function (folder) { return { folder: folder, existed: present(folder, name) }; });
    // The folder that the popup names, when a listed or standard folder carries that name: a file
    // of this name there would make the panel ask about replacing it, which it shows to
    // Accessibility only in part, so the tool refuses before the press.
    // A name without an extension gets the download's extension, which the panel can hide, so
    // only a name with one is checked.
    const shown = before.filter(function (item) { return parts.where !== null && $.NSFileManager.defaultManager.displayNameAtPath(item.folder).js === parts.where; });
    if (!request.cancel && /^.+\.[^.]+$/.test(name) && shown.length && shown[0].existed)
      fail('file-exists', 'A file with this name already exists in the folder the dialog shows; choose another name.', Object.assign({ name: name, folder: shown[0].folder }, facts));
    const pressedAt = Date.now();
    if ($.AXUIElementPerformAction(button, $('AXPress')) !== 0)
      fail('dialog-unreadable', 'The Save dialog did not accept the button press.', facts);
    for (let waited = 0; waited < 3000 && stillOpen(target.window); waited += 50) pause(0.05);
    if (stillOpen(target.window)) {
      const question = panelAlert(target.sheet);
      const cancel = question ? axValue(question.sheet, 'AXCancelButton') : null;
      if (cancel) $.AXUIElementPerformAction(cancel, $('AXPress'));
      fail(
        'save-question',
        question
          ? 'The Save dialog asked: ' + question.text + (cancel ? ' The tool answered Cancel; the dialog is still open.' : '')
          : 'The Save dialog did not close within three seconds; it can be asking whether to replace a file of this name. Cancel it with cancel true, or ask the operator.',
        Object.assign({ name: name, answeredCancel: Boolean(cancel) }, facts),
      );
    }
    if (request.cancel) return Object.assign({ action: 'cancelled', name: null, candidates: [], pressedAt: pressedAt }, facts);
    // The folder of this save first; a folder where the name existed before the save is not it.
    const saved = lastSaveFolder(request.bundleId);
    const candidates = saved ? [{ folder: saved, existed: false }] : [];
    for (const item of before) if (item.folder !== saved) candidates.push(item);
    return Object.assign({ action: 'saved', name: name, candidates: candidates.filter(function (item) { return !item.existed; }), pressedAt: pressedAt }, facts);
  },
  window: function (request) {
    const app = ready(request);
    const found = locate(request.pid, request.tab);
    return {
      window: found.windowId, title: get(request.pid, 'pnam', found.window), bounds: get(request.pid, 'pbnd', found.window),
      minimized: Boolean(get(request.pid, 'pmnd', found.window)), visible: Boolean(get(request.pid, 'pvis', found.window)),
      activeTab: String(get(request.pid, 'ID  ', property('acTa', found.window))), url: get(request.pid, 'URL ', found.tab),
      tabTitle: get(request.pid, 'pnam', found.tab), hidden: Boolean(app.hidden), windows: cgWindows(request.pid),
      screenRecording: Boolean($.CGPreflightScreenCaptureAccess()),
    };
  },
  screenRecording: function (request) {
    return { granted: Boolean(request.ask ? $.CGRequestScreenCaptureAccess() : $.CGPreflightScreenCaptureAccess()) };
  },
};
function run() {
  let request;
  try {
    request = readRequest();
  } catch (error) {
    return JSON.stringify({ ok: false, error: { code: 'bad-request', number: null, message: 'The request was not JSON.', extra: null } });
  }
  try {
    const operation = operations[request.op];
    if (!operation) fail('bad-request', 'Unknown operation.');
    return JSON.stringify({ ok: true, value: operation(request) });
  } catch (error) {
    return JSON.stringify({ ok: false, error: {
      code: error && error.pbCode ? error.pbCode : null,
      number: error && typeof error.errorNumber === 'number' ? error.errorNumber : null,
      message: String(error && error.message ? error.message : error).slice(0, 2000),
      extra: error && error.extra ? error.extra : null,
    } });
  }
}
`;
