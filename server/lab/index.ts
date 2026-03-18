import express from "express";
import { createServer } from "http";
import { registerLabRoutes, getLabCleanup } from "./routes";

const LAB_PORT = parseInt(process.env.LAB_PORT || "5050", 10);

const app = express();
const httpServer = createServer(app);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

app.use(
  express.json({
    limit: "10mb",
  }),
);
app.use(express.urlencoded({ extended: false }));

registerLabRoutes(app);

function startListening(retries = 5, delay = 2000) {
  httpServer.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`[QuantumLab] Port ${LAB_PORT} in use, retrying in ${delay}ms (${retries} attempts left)`);
      setTimeout(() => startListening(retries - 1, delay), delay);
    } else {
      console.error(`[QuantumLab] Fatal listen error:`, err);
      process.exit(1);
    }
  });

  httpServer.listen({ port: LAB_PORT, host: "127.0.0.1" }, () => {
    console.log(`[QuantumLab] Child process listening on port ${LAB_PORT}`);
    if (process.send) {
      process.send({ type: "ready", port: LAB_PORT });
    }
  });
}

startListening();

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[QuantumLab] ${signal} received, cleaning up...`);

  const cleanup = getLabCleanup();
  if (cleanup) {
    try {
      await cleanup(signal);
    } catch (err: any) {
      console.log(`[QuantumLab] Cleanup error: ${err.message}`);
    }
  }

  console.log(`[QuantumLab] Stopping HTTP server...`);
  httpServer.close(() => {
    console.log(`[QuantumLab] HTTP server closed, exiting`);
    process.exit(0);
  });

  setTimeout(() => {
    console.log(`[QuantumLab] Forced exit after shutdown timeout`);
    process.exit(1);
  }, 8000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
