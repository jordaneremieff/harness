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
function originOf(url) {
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^\/?#]*)/i.exec(url || '');
  return match ? match[1].toLowerCase() : null;
}
function cgWindows(pid) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID))) || [];
  return list.filter(function (item) { return item.kCGWindowOwnerPID === pid && item.kCGWindowLayer === 0; }).map(function (item) {
    const b = item.kCGWindowBounds || {};
    return { id: item.kCGWindowNumber, onScreen: Boolean(item.kCGWindowIsOnscreen), name: item.kCGWindowName === undefined ? null : String(item.kCGWindowName), bounds: { x: b.X, y: b.Y, width: b.Width, height: b.Height } };
  });
}
const operations = {
  inventory: function (request) {
    return { installed: installed(request.bundleId), instances: instances(request.bundleId) };
  },
  permission: function (request) {
    const target = request.pid ? D.descriptorWithProcessIdentifier(request.pid) : D.descriptorWithBundleIdentifier(request.bundleId);
    return { automation: permission(target, request.ask) };
  },
  windows: function (request) {
    ready(request);
    return { windows: windowList(request.pid) };
  },
  execute: function (request) {
    ready(request);
    const found = locate(request.pid, request.tab);
    const result = value(send(request.pid, 'CrSu', 'ExJa', found.tab, { JvSc: D.descriptorWithString(request.script) }, request.seconds));
    const url = optionalGet(request.pid, 'URL ', found.tab);
    const title = optionalGet(request.pid, 'pnam', found.tab);
    return {
      window: found.windowId, url: url.value, title: title.value, result: result === null ? null : String(result),
      metadataError: url.error || title.error,
    };
  },
  navigate: function (request) {
    ready(request);
    const found = locate(request.pid, request.tab);
    const before = get(request.pid, 'URL ', found.tab);
    if (request.expectOrigin !== null && originOf(before) !== request.expectOrigin)
      fail('origin-mismatch', 'The tab does not show the expected origin.', { url: before });
    send(request.pid, 'core', 'setd', property('URL ', found.tab), { data: D.descriptorWithString(request.url) });
    return { window: found.windowId, before: before };
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
