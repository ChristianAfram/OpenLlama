/**
 * Minimal terminal UI helpers.
 *
 * Prompt 0 keeps this tiny: write streamed tokens to stdout and print simple
 * status lines to stderr. The richer ink-based TUI (approval prompts, etc.)
 * arrives with the approval gate in a later prompt.
 */

export interface OutputStreams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

export const defaultStreams: OutputStreams = {
  out: process.stdout,
  err: process.stderr,
};

/** Write a fragment of streamed model output, without a trailing newline. */
export function writeToken(fragment: string, streams: OutputStreams = defaultStreams): void {
  streams.out.write(fragment);
}

/** Print a status/info line to stderr so it never pollutes piped stdout. */
export function info(message: string, streams: OutputStreams = defaultStreams): void {
  streams.err.write(`${message}\n`);
}

/** Print a warning line to stderr. */
export function warn(message: string, streams: OutputStreams = defaultStreams): void {
  streams.err.write(`warn: ${message}\n`);
}

/** Print an error line to stderr. */
export function error(message: string, streams: OutputStreams = defaultStreams): void {
  streams.err.write(`error: ${message}\n`);
}
