// A local HTTP server for the provider tests: it records each request and answers with
// whatever the test's handler writes, such as a stream of server-sent events.
import { createServer as createNetServer } from "node:net";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";

export type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: any };
export type Handler = (seen: Seen, res: ServerResponse) => void;

const open = new Set<() => Promise<unknown>>();
// Closes every server still open; test files call it in after(), so a failed assertion
// can't leave one keeping the process alive.
export const closeAll = () => Promise.all([...open].map((close) => close()));

export async function mock(handler: Handler) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const raw = await text(req);
    const s = { method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(s);
    handler(s, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    open.delete(close);
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  };
  open.add(close);
  return { url, seen, close };
}

export function sse(res: ServerResponse, events: unknown[], named = false) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) {
    const data = typeof e === "string" ? e : JSON.stringify(e);
    res.write(`${named ? `event: ${(e as { type: string }).type}\n` : ""}data: ${data}\n\n`);
  }
  res.end();
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// A port nothing listens on.
export function closedPort(): Promise<number> {
  return new Promise((done) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => done(port));
    });
  });
}
