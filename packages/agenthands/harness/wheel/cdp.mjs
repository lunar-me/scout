// Minimal CDP client over the browser websocket, plus a PageLike adapter so
// agenthands can drive the real binary without playwright in the loop.

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) {
    this.listeners.push(fn);
  }
}

export class Session {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }
  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }
}

// PageLike over raw CDP. Deliberately thin: the point of the measurement is
// what Input.dispatchMouseWheel does, so nothing here may smooth it over.
export function pageLike(session, cursor = { x: 400, y: 400 }) {
  return {
    mouse: {
      async move(x, y) {
        cursor.x = x;
        cursor.y = y;
        await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      },
      async down() {
        await session.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1, buttons: 1,
        });
      },
      async up() {
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: cursor.x, y: cursor.y, button: 'left', clickCount: 1, buttons: 0,
        });
      },
      async wheel(deltaX, deltaY) {
        await session.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: cursor.x, y: cursor.y, deltaX, deltaY,
        });
      },
    },
    keyboard: {
      async down() {}, async up() {}, async press() {},
    },
    locator() {
      throw new Error('not used');
    },
    async evaluate(fn) {
      const r = await session.send('Runtime.evaluate', {
        expression: `(${fn.toString()})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    },
  };
}
