import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { cancelJob, createRuntime, enqueue, retryJob, snapshot } from "./runtime.mjs";

const config = loadConfig();
const runtime = createRuntime(config);

function send(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = config.secret;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      await runtime.queue("dead-letter").getJobCounts("waiting", "failed");
      return send(response, 200, { status: "ok", runtime: "bullmq" });
    }
    if (!authorized(request)) return send(response, 401, { error: "UNAUTHORIZED" });
    if (request.method === "GET" && url.pathname === "/v1/jobs") {
      return send(response, 200, await snapshot(runtime));
    }
    if (request.method === "POST" && url.pathname === "/v1/actions") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(response, 400, { error: "ACTION_INVALID" });
      if (body.action === "enqueue") {
        const result = await enqueue(runtime, body.job);
        return send(response, result.duplicate ? 200 : 201, { ok: true, ...result });
      }
      if (body.action === "retry" && typeof body.queue === "string" && typeof body.id === "string") {
        return send(response, 200, { ok: true, job: await retryJob(runtime, body.queue, body.id) });
      }
      if (body.action === "cancel" && typeof body.queue === "string" && typeof body.id === "string") {
        return send(response, 200, { ok: true, job: await cancelJob(runtime, body.queue, body.id) });
      }
      return send(response, 400, { error: "ACTION_INVALID" });
    }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "QUEUE_RUNTIME_ERROR";
    const status = message === "REQUEST_TOO_LARGE" ? 413 : message.endsWith("_INVALID") || message.endsWith("_ALLOWED") ? 400 : message.includes("NOT_FOUND") ? 404 : 409;
    return send(response, status, { error: message });
  }
});

async function shutdown(signal) {
  console.info(JSON.stringify({ event: "queue-api-shutdown", signal }));
  server.close();
  await runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
server.listen(config.port, config.host, () => {
  console.info(JSON.stringify({ event: "queue-api-ready", host: config.host, port: config.port }));
});
