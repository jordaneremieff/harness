// @ts-nocheck: This test-only classic JavaScript runs in WebKit, not Node.
// This host exercises native delivery, cancellation and reading state, not the product interface.
(() => {
  const doc = document.getElementById("doc");
  const overlay = document.getElementById("overlay");
  const policy = trustedTypes.createPolicy("cmark", { createHTML: value => value });
  let source = "", blocks = [], sourceShown = false, front = null, lock = "reading";
  let findOpen = false, findQuery = "", messageId = 0;

  async function send(type, fields = {}) {
    const reply = await window.webkit.messageHandlers.reader.postMessage({ v: 1, type, id: `fixture-${++messageId}`, ...fields });
    if (reply?.ok === false) throw new Error(reply.error || "Bridge refused");
    return reply || {};
  }

  function nodes(html) {
    const parsed = new DOMParser().parseFromString(policy.createHTML(html), "text/html");
    return Array.from(parsed.body.childNodes, node => document.importNode(node, true));
  }

  function renderBlocks() {
    doc.replaceChildren();
    for (const block of blocks) {
      const element = document.createElement("div");
      element.className = "blk";
      element.dataset.block = String(block.key);
      element.dataset.start = String(block.start);
      element.dataset.end = String(block.end);
      element.append(...nodes(String(block.html ?? "")));
      doc.append(element);
    }
  }

  function renderSource() {
    const pre = document.createElement("pre");
    pre.className = "source";
    const code = document.createElement("code");
    code.textContent = source;
    pre.append(code);
    doc.replaceChildren(pre);
  }

  function reportState(extra = {}) {
    const visible = Array.from(doc.querySelectorAll("[data-block]")).find(element => element.getBoundingClientRect().bottom > 0);
    const selection = window.getSelection();
    return send("state", {
      lock, overlay: sourceShown ? "source" : front,
      canUndo: false, canRedo: false,
      hasSelection: Boolean(selection && !selection.isCollapsed), findOpen,
      scroll: { blockStart: Number(visible?.dataset.start || 0), offsetY: visible ? -visible.getBoundingClientRect().top : 0 },
      ...extra
    });
  }

  function find(query) {
    findOpen = true;
    findQuery = String(query ?? "");
    const haystack = (front ? overlay.textContent : doc.textContent).toLowerCase();
    const needle = findQuery.toLowerCase();
    let count = 0, at = needle ? haystack.indexOf(needle) : -1;
    while (at >= 0) { count++; at = haystack.indexOf(needle, at + needle.length); }
    return reportState({ find: { query: findQuery, count, index: count ? 0 : -1 } });
  }

  async function command(name, args) {
    switch (name) {
    case "showSource":
      sourceShown = !sourceShown;
      if (sourceShown) renderSource(); else renderBlocks();
      break;
    case "showReview": {
      const result = await send("query", { kind: "review", against: args.against ?? "previous" });
      overlay.replaceChildren(...nodes(result.html));
      overlay.hidden = false;
      front = "review";
      break;
    }
    case "inspectImage":
      await send("query", { kind: "image", index: args.index });
      front = "image";
      break;
    case "find": return find(args.query);
    case "toggleLock":
      lock = args.lock ?? (lock === "reading" ? "writing" : "reading");
      await send("lock", { lock, copy: false });
      break;
    case "escape":
      findOpen = false; findQuery = ""; front = null;
      overlay.hidden = true; overlay.replaceChildren();
      break;
    }
    await reportState();
  }

  window.reader = { async receive(message) {
    if (message?.v !== 1) throw new Error("Unsupported version");
    switch (message.type) {
    case "document": {
      source = String(message.source);
      blocks = message.blocks;
      lock = message.settings.lock;
      findOpen = false;
      if (sourceShown) renderSource(); else renderBlocks();
      if (message.position && !sourceShown) {
        const block = Array.from(doc.querySelectorAll("[data-block]")).find(element => Number(element.dataset.start) === message.position.blockStart);
        if (block) window.scrollTo(0, block.getBoundingClientRect().top + window.scrollY + message.position.offsetY);
      }
      await reportState();
      break;
    }
    case "command": await command(message.name, message.args || {}); break;
    }
    return true;
  } };

  let pending = false;
  window.addEventListener("scroll", () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; reportState().catch(() => {}); });
  }, { passive: true });
  send("ready", { version: "reader-host-fixture-1", capabilities: {} }).catch(error => console.error(String(error)));
})();
