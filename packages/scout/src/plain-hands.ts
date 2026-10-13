/**
 * Plain input: each action as the fewest CDP input events that perform it,
 * with no timing of its own.
 *
 * For a browser that plans input itself. Outcrawl's `/connect` re-plans every
 * input command it receives (pointer moves into paths, key events into a
 * typing rhythm), so a planned gesture sent there would be planned twice.
 * Scout sends this there instead, and the agenthands planner everywhere else.
 */
import { editingChord, keyEventParams, type HandsPort, type HandsStep, type HandsTarget } from '@outcrawl/scout-cdp';

function centre(target: HandsTarget): { readonly x: number; readonly y: number } {
  return { x: target.x + target.width / 2, y: target.y + target.height / 2 };
}

function moveTo(at: { readonly x: number; readonly y: number }, buttons?: number): HandsStep {
  return {
    command: 'Outcrawl.dispatchPointerPath',
    params: { path: [{ x: at.x, y: at.y, offsetMs: 0 }], pointerType: 'mouse', ...(buttons === undefined ? {} : { buttons }) },
  };
}

function button(type: 'mousePressed' | 'mouseReleased', at: { readonly x: number; readonly y: number }): HandsStep {
  return {
    command: 'Input.dispatchMouseEvent',
    params:
      type === 'mousePressed'
        ? { type, x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1, force: 0.5 }
        : { type, x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 },
  };
}

function keys(key: string, mac: boolean): HandsStep[] {
  const chord = editingChord(key, mac);
  if (chord === undefined) {
    return [
      { command: 'Input.dispatchKeyEvent', params: keyEventParams(key, 'keyDown') },
      { command: 'Input.dispatchKeyEvent', params: keyEventParams(key, 'keyUp') },
    ];
  }
  const main = keyEventParams(chord.key, 'keyDown');
  const plain = {
    key: main.key,
    code: main.code,
    windowsVirtualKeyCode: main.windowsVirtualKeyCode,
    nativeVirtualKeyCode: main.nativeVirtualKeyCode,
  };
  const steps: HandsStep[] = [];
  let bits = 0;
  for (const mod of chord.modifiers) {
    bits |= mod.bit;
    steps.push({
      command: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.keyCode, nativeVirtualKeyCode: mod.keyCode, modifiers: bits },
    });
  }
  steps.push(
    {
      command: 'Input.dispatchKeyEvent',
      params: { type: 'keyDown', ...plain, modifiers: bits, ...(chord.command === undefined ? {} : { commands: [chord.command] }) },
    },
    { command: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...plain, modifiers: bits } },
  );
  for (const mod of [...chord.modifiers].reverse()) {
    bits &= ~mod.bit;
    steps.push({
      command: 'Input.dispatchKeyEvent',
      params: {
        type: 'keyUp',
        key: mod.key,
        code: mod.code,
        windowsVirtualKeyCode: mod.keyCode,
        nativeVirtualKeyCode: mod.keyCode,
        ...(bits === 0 ? {} : { modifiers: bits }),
      },
    });
  }
  return steps;
}

/**
 * The plain planner. `mac` picks the select-all chord's modifier: Meta on
 * macOS, Control elsewhere, read from the remote browser's own platform.
 */
export function plainHands(mac: boolean): HandsPort {
  return {
    click: (target) => {
      const at = centre(target);
      return [moveTo(at), button('mousePressed', at), button('mouseReleased', at)];
    },
    hover: (target) => [moveTo(centre(target))],
    scroll: (request, context) => {
      const at = request.target === undefined ? { x: context.viewport.width / 2, y: context.viewport.height / 2 } : centre(request.target);
      return [
        {
          command: 'Outcrawl.dispatchWheelPath',
          params: { x: at.x, y: at.y, path: [{ offsetMs: 0, deltaX: request.dx, deltaY: request.dy, phase: 'changed' }] },
        },
      ];
    },
    drag: (from, to) => {
      const start = centre(from);
      const end = centre(to);
      return [moveTo(start), button('mousePressed', start), moveTo(end, 1), button('mouseReleased', end)];
    },
    type: (text, options) => [
      ...(options.replace ? keys('Control+a', mac) : []),
      ...[...text].flatMap((char) => keys(char, mac)),
    ],
    press: (key) => keys(key, mac),
  };
}
