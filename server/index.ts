import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import { createServer } from "http";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { agentRouter } from "./agentRoutes";
import { paymentCallbackRouter } from "./payment";
import { migrationRouter } from "./migration";
import { initDatabase } from "./db";
import { installPanelLogger } from "./_core/panelLogger";
import { startScheduler } from "./scheduler";
import { startTelegramBot } from "./telegramBot";

installPanelLogger();

const serverDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

function serveStatic(app: express.Express) {
  const clientDist = path.resolve(serverDir, "../client/dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

function installMobileCors(app: express.Express) {
  const allowedOrigins = new Set([
    "capacitor://localhost",
    "ionic://localhost",
    "http://localhost",
    "https://localhost",
  ]);

  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    const allowed = allowedOrigins.has(origin) || /^https?:\/\/localhost:\d+$/i.test(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-forwardx-mobile,trpc-accept,x-trpc-source");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS" && allowed) {
      res.status(204).end();
      return;
    }
    next();
  });
}

async function startServer() {
  await initDatabase();

  const app = express();
  const server = createServer(app);

  // Payment webhooks need the original request body for signature verification.
  app.use(paymentCallbackRouter);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use(cookieParser());
  installMobileCors(app);
  app.use(agentRouter);
  app.use(migrationRouter);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );
  serveStatic(app);

  const preferredPort = Number.parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.warn(`[Server] Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.info(`Server running on http://localhost:${port}/`);
    console.info(`[Server] ForwardX panel started on port ${port}`);
  });

  startScheduler();
  startTelegramBot().catch((error) => {
    console.warn(`[Telegram] Failed to start bot: ${error instanceof Error ? error.message : String(error)}`);
  });
}

startServer().catch(console.error);
