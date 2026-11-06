/*
 * Synthetic, height-driven virtual list for the fold-window experiment tests.
 * This is not ChatGPT's renderer. It never reads the probe or the fold CSS gate:
 * window membership follows actual measured row heights and scroll geometry.
 * Only mounted rows are retained as nodes. Offscreen history is numeric heights.
 */
(function () {
  "use strict";
  const viewport = document.getElementById("synthetic-viewport");
  const thread = document.getElementById("synthetic-thread");
  // Capture fixture scheduling before the test installs its probe resource
  // audit, so native fixture work is not mistaken for a leftover probe task.
  const requestFrame = requestAnimationFrame.bind(window);
  const cancelFrame = cancelAnimationFrame.bind(window);
  const count = 120, overscan = 2, gap = 12;
  const heights = Array(count).fill(740);
  const rows = new Map();
  let offsets = [], totalHeight = 0, rendered = null;
  let frame = null, paused = false, hysteresis = false, windowed = true;
  let layoutCount = 0, createdCount = 0, removedCount = 0;

  function recalculate() {
    let top = 0;
    offsets = heights.map(height => { const position = top; top += height + gap; return position; });
    totalHeight = Math.max(viewport.clientHeight, top - gap);
    thread.style.height = `${totalHeight}px`;
  }

  function indexAt(position) {
    let low = 0, high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsets[middle] + heights[middle] + gap <= position) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, Math.min(count - 1, low));
  }

  function makeRow(index) {
    const row = document.createElement("section");
    row.className = "synthetic-turn";
    row.dataset.turnKey = `SYNTHETIC_PRIVATE_TURN_w83c-${index}`;
    row.dataset.talvtTurnState = "complete";
    row.dataset.fixtureIndex = String(index);
    const question = document.createElement("div");
    question.className = "synthetic-question";
    question.dataset.userMessageBubble = "true";
    question.dataset.chatgptSearchMessageIds = `SYNTHETIC_PRIVATE_USER_w83c-${index}`;
    question.textContent = `SYNTHETIC_PRIVATE_CHAT_w83c question ${index}`;
    const answer = document.createElement("div");
    answer.className = "synthetic-answer";
    answer.dataset.messageRole = "assistant";
    answer.dataset.chatgptSearchUnitKey = `SYNTHETIC_PRIVATE_UNIT_w83c-${index}:assistant`;
    answer.dataset.chatgptSearchMessageIds = `SYNTHETIC_PRIVATE_MESSAGE_w83c-${index}`;
    answer.dataset.chatgptSelectionMessageId = `SYNTHETIC_PRIVATE_MESSAGE_w83c-${index}`;
    const body = document.createElement("div");
    body.dataset.markdownTextStyle = "assistant-message";
    body.className = "synthetic-answer-body";
    for (let paragraph = 0; paragraph < 4; paragraph += 1) {
      const p = document.createElement("p");
      p.textContent = `SYNTHETIC_PRIVATE_CHAT_w83c answer ${index}, paragraph ${paragraph}. ` +
        "This is controlled fixture prose used to measure real layout height. ".repeat(5);
      body.append(p);
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    for (let line = 0; line < 14; line += 1) {
      const wrapper = document.createElement("span");
      wrapper.className = "synthetic-code-line";
      for (const text of ["const ", `value_${index}_${line}`, ` = ${index * 17 + line};`, " // synthetic"]) {
        const span = document.createElement("span");
        span.textContent = text;
        wrapper.append(span);
      }
      code.append(wrapper);
    }
    pre.append(code); body.append(pre); answer.append(body); row.append(question, answer);
    createdCount += 1;
    return row;
  }

  function schedule() {
    if (paused || frame !== null) return;
    frame = requestFrame(layout);
  }

  const observer = new ResizeObserver(schedule);

  function layout() {
    frame = null;
    if (paused) return;
    // Use the PREVIOUS numeric geometry for scroll anchoring. Reading expanded
    // row rectangles before repositioning would choose an overlapping overscan
    // row, an artifact of this absolute-positioned synthetic layout.
    const anchor = indexAt(viewport.scrollTop);
    const offset = offsets[anchor] - viewport.scrollTop;
    let changed = false;
    for (const [index, row] of rows) {
      const height = row.getBoundingClientRect().height;
      if (height > 0 && Math.abs(height - heights[index]) > .25) {
        heights[index] = height;
        changed = true;
      }
    }
    if (changed) {
      recalculate();
      viewport.scrollTop = offsets[anchor] - offset;
    }
    const required = windowed
      ? { start: Math.max(0, indexAt(viewport.scrollTop) - overscan),
          end: Math.min(count, indexAt(viewport.scrollTop + viewport.clientHeight) + 1 + overscan) }
      : { start: 0, end: count };
    const next = hysteresis && rendered && rendered.start <= required.start && rendered.end >= required.end
      ? rendered : required;
    for (const [index, row] of rows) {
      if (index >= next.start && index < next.end) continue;
      observer.unobserve(row); row.remove(); rows.delete(index); removedCount += 1;
    }
    for (let index = next.start; index < next.end; index += 1) {
      if (!rows.has(index)) {
        const row = makeRow(index);
        rows.set(index, row); thread.append(row); observer.observe(row);
      }
      const row = rows.get(index), top = `${offsets[index]}px`;
      if (row.style.top !== top) row.style.top = top;
    }
    // Keep document order coherent with conversation order, independently of
    // the order in which rows entered this synthetic native window.
    let previous = null;
    for (const index of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(index);
      const expectedPrevious = previous;
      if (row.previousElementSibling !== expectedPrevious) {
        thread.insertBefore(row, expectedPrevious ? expectedPrevious.nextElementSibling : thread.firstElementChild);
      }
      previous = row;
    }
    rendered = { ...next };
    layoutCount += 1;
  }

  viewport.addEventListener("scroll", schedule, { passive: true });
  observer.observe(viewport);
  recalculate();
  viewport.scrollTop = offsets[48];
  layout();

  globalThis.syntheticWindowFixture = Object.freeze({
    state() {
      const rect = viewport.getBoundingClientRect();
      return { mode: windowed ? "measured-height-window" : "all-rows-mounted",
        hysteresis, count, overscan, mounted: rows.size, range: rendered && { ...rendered },
        measuredHeightMin: Math.min(...heights), measuredHeightMax: Math.max(...heights),
        scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight,
        viewportHeight: viewport.clientHeight, viewportTop: rect.top,
        layoutCount, createdCount, removedCount };
    },
    configure(options) {
      if (typeof options.hysteresis === "boolean") hysteresis = options.hysteresis;
      if (typeof options.windowed === "boolean") windowed = options.windowed;
      rendered = null;
      schedule();
    },
    seek(index = 48) {
      viewport.scrollTop = offsets[Math.max(0, Math.min(count - 1, index))];
      schedule();
    },
    pause() {
      paused = true;
      if (frame !== null) cancelFrame(frame);
      frame = null;
      observer.disconnect();
    },
    resume() {
      if (!paused) return;
      paused = false;
      observer.observe(viewport);
      for (const row of rows.values()) observer.observe(row);
      schedule();
    }
  });
})();
