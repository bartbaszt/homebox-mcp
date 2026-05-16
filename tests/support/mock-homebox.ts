import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockHomeboxRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  bodyText: string;
  body: unknown;
}

export type MockHomeboxHandler = (request: MockHomeboxRequest, response: ServerResponse) => void | Promise<void>;

export interface MockHomeboxServer {
  url: string;
  requests: MockHomeboxRequest[];
  close: () => Promise<void>;
}

export async function startMockHomebox(handler: MockHomeboxHandler): Promise<MockHomeboxServer> {
  const requests: MockHomeboxRequest[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const bodyText = await readBody(req);
    const request: MockHomeboxRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      bodyText,
      body: parseBody(bodyText),
    };
    requests.push(request);
    try {
      await handler(request, res);
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind to a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(bodyText: string): unknown {
  if (!bodyText) return undefined;
  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
