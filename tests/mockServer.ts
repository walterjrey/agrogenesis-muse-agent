import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

export interface MockServer {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

type Handler = (req: MockRequest) => { status: number; body: unknown; delayMs?: number; headers?: Record<string, string> };

/** Local HTTP server standing in for the simulator or the Meta Model API in MOCKED tests. */
export async function startMockServer(handler: Handler): Promise<MockServer> {
  const requests: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const mock: MockRequest = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      requests.push(mock);
      const out = handler(mock);
      setTimeout(() => {
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(JSON.stringify(out.body));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
