/**
 * stdio transport guard. Imported FIRST by index.ts so it runs before any
 * other module evaluates. With `--stdio` on argv, process.stdout is reserved
 * for MCP JSON-RPC frames: every other write (logger.info, console.log, a
 * chatty dependency) is rerouted to stderr. The real stdout is exposed as
 * `jsonRpcStdout` for the StdioServerTransport only.
 *
 * Without `--stdio` this module does nothing.
 */
import { Writable } from 'node:stream';

export const STDIO_MODE = process.argv.slice(2).includes('--stdio');

type WriteFn = typeof process.stdout.write;

let realStdoutWrite: WriteFn | null = null;

if (STDIO_MODE) {
  realStdoutWrite = process.stdout.write.bind(process.stdout) as WriteFn;
  process.stdout.write = process.stderr.write.bind(process.stderr) as WriteFn;
}

/**
 * Writable that targets the real stdout (bypassing the redirect). Only
 * meaningful in stdio mode; otherwise it is plain process.stdout.
 */
export const jsonRpcStdout: Writable = STDIO_MODE
  ? new Writable({
      decodeStrings: false,
      write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
        realStdoutWrite!(chunk, callback);
      },
    })
  : process.stdout;
