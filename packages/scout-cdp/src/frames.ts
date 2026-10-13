/** The id of the frame a `Page.getFrameTree` node describes, or `''`. */
export function frameTreeId(node: unknown): string {
  const frame = typeof node === 'object' && node !== null && 'frame' in node ? node.frame : undefined;
  return typeof frame === 'object' && frame !== null && 'id' in frame && typeof frame.id === 'string' ? frame.id : '';
}

/** Every frame below `node` in a `Page.getFrameTree` reply, depth first. */
export function childFrameIds(node: unknown): readonly string[] {
  const children = typeof node === 'object' && node !== null && 'childFrames' in node ? node.childFrames : undefined;
  if (!Array.isArray(children)) return [];
  return children.flatMap((child: unknown) => {
    const id = frameTreeId(child);
    return [...(id === '' ? [] : [id]), ...childFrameIds(child)];
  });
}
