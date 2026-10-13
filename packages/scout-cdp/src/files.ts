import type { FileManifest } from '@outcrawl/runtime';

/**
 * One run's files, as `attachFile` reaches them: the manifest the prompt names
 * a file from, plus an owned local path for a handle the browser reads the
 * file from. Bound per run; the run is closed over and never passed.
 */
export interface FilePort extends FileManifest {
  /**
   * An owned local path for one handle, or `undefined` if this run does not
   * hold it. Its basename is the file's name. The browser may read it for as
   * long as the run lasts.
   */
  stage(fileId: string): Promise<string | undefined>;
}
