/**
 * Runs in the game page before the game's own scripts (page.addInitScript). It records the text the game
 * draws on canvases, the text inside SVG images (Pixi's HTMLText), and frame times. It only watches:
 * every hook calls through to the original and swallows its own errors.
 */
export function probe() {
  if (window.__preflight) return;

  // every text once, with when it was last drawn
  const texts = new Map();
  const keep = (value, source) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 4000) return;
    const seen = texts.get(text);
    if (seen) seen.last = performance.now();
    else if (texts.size < 20000) texts.set(text, { last: performance.now(), source });
  };

  // With letter spacing, Pixi draws one letter at a time. Letters drawn left to right on one line in the
  // same task are joined back into the word they spell.
  const runs = new Map();
  const flush = (context) => {
    const run = runs.get(context);
    if (!run) return;
    runs.delete(context);
    keep(run.text, 'canvas');
  };
  const record = (context, value, x, y) => {
    const text = String(value ?? '');
    if (Array.from(text).length === 1) {
      const run = runs.get(context);
      if (run && run.y === y && x >= run.x) {
        run.text += text;
        run.x = x;
        return;
      }
      flush(context);
      runs.set(context, { text, x, y });
      queueMicrotask(() => flush(context));
      return;
    }
    flush(context);
    keep(text, 'canvas');
  };
  for (const Context of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D]) {
    if (!Context) continue;
    for (const name of ['fillText', 'strokeText']) {
      const draw = Context.prototype[name];
      Context.prototype[name] = function (text, x, y, ...rest) {
        try {
          record(this, text, x, y);
        } catch {}
        return draw.call(this, text, x, y, ...rest);
      };
    }
  }

  const svgText = (url) => {
    const comma = url.indexOf(',');
    const data = url.slice(comma + 1);
    const markup = url.slice(0, comma).includes(';base64') ? atob(data) : decodeURIComponent(data);
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    doc.querySelectorAll('style, script').forEach((node) => node.remove());
    keep(doc.documentElement?.textContent, 'svg');
  };
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (src?.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value) {
        try {
          if (typeof value === 'string' && value.startsWith('data:image/svg+xml')) svgText(value);
        } catch {}
        src.set.call(this, value);
      },
    });
  }

  // Frame times, kept in a list that drops its oldest half when it grows past ten minutes at 60 fps.
  const frames = [];
  let dropped = 0;
  let last = 0;
  const tick = (now) => {
    if (last) frames.push(now - last);
    last = now;
    if (frames.length > 36000) {
      frames.splice(0, 18000);
      dropped += 18000;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const ATTRIBUTES = ['aria-label', 'title', 'alt', 'placeholder'];

  Object.defineProperty(window, '__preflight', {
    value: Object.freeze({
      now: () => performance.now(),
      /** Texts drawn (again) since `since`. */
      texts(since = 0) {
        for (const context of [...runs.keys()]) flush(context);
        const list = [];
        for (const [text, { last, source }] of texts) if (last >= since) list.push({ text, source });
        return list;
      },
      /** The last few texts drawn, newest first, with how long ago (ms). */
      recent(count = 3) {
        for (const context of [...runs.keys()]) flush(context);
        const now = performance.now();
        return [...texts]
          .sort((a, b) => b[1].last - a[1].last)
          .slice(0, count)
          .map(([text, { last }]) => ({ text, age: now - last }));
      },
      domText() {
        const parts = [document.body?.innerText ?? ''];
        for (const element of document.querySelectorAll(ATTRIBUTES.map((name) => `[${name}]`).join(','))) {
          if (element.checkVisibility && !element.checkVisibility()) continue;
          for (const name of ATTRIBUTES) {
            const value = element.getAttribute(name);
            if (value) parts.push(value);
          }
        }
        return parts.join('\n');
      },
      frameMark: () => dropped + frames.length,
      frames: (mark = 0) => frames.slice(Math.max(0, mark - dropped)),
      memory: () => performance.memory?.usedJSHeapSize ?? null,
    }),
  });
}
