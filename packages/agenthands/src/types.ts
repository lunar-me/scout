// Structural types for the subset of Playwright this library touches. Depending
// on shapes rather than importing Playwright keeps this usable with any driver
// exposing an equivalent surface, and keeps playwright an optional peer.

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageMouse {
  move(x: number, y: number, options?: { steps?: number }): Promise<void>;
  down(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
  up(options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface PageKeyboard {
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  press(key: string): Promise<void>;
}

export interface PageLocator {
  scrollIntoViewIfNeeded(): Promise<void>;
  boundingBox(): Promise<BoundingBox | null>;
}

export interface PageLike {
  mouse: PageMouse;
  keyboard: PageKeyboard;
  locator(selector: string): PageLocator;
  /**
   * Optional. Used only to probe how the browser derives wheel ticks; without
   * it, scrolling falls back to whole ticks, which is correct everywhere.
   */
  evaluate?<R>(fn: (arg: never) => R): Promise<R>;
}

export interface Point {
  x: number;
  y: number;
}

export type Target = string | Point;
