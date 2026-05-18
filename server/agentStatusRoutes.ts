import { Router, Request, Response } from "express";
import * as db from "./db";
import { appendPanelLog } from "./_core/panelLogger";

export function registerAgentStatusRoutes(agentRouter: Router) {
agentRouter.post("/api/agent/rule-status", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = authHeader.substring(7);
    const host = await db.getHostByAgentToken(token);
    if (!host) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const { ruleId, tunnelId, statusType, isRunning } = req.body;
    const rawMessage = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const message = rawMessage.length > 300 ? `${rawMessage.slice(0, 300)}...` : rawMessage;
    if (statusType === "tunnel") {
      if (typeof tunnelId !== "number") {
        res.status(400).json({ error: "tunnelId is required" });
        return;
      }
      const tunnel = await db.getTunnelById(tunnelId);
      if (!tunnel || (tunnel.entryHostId !== host.id && tunnel.exitHostId !== host.id)) {
        res.status(404).json({ error: "tunnel not found" });
        return;
      }
      await db.updateTunnelRunningStatus(tunnelId, !!isRunning);
      appendPanelLog(
        !!isRunning ? "info" : "warn",
        `[Tunnel] status tunnel=${tunnelId} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
      );
      res.json({ success: true });
      return;
    }
    if (typeof ruleId !== "number") {
      res.status(400).json({ error: "ruleId is required" });
      return;
    }

    await db.updateRuleRunningStatus(ruleId, !!isRunning);
    appendPanelLog(
      !!isRunning ? "info" : "warn",
      `[Rule] status rule=${ruleId} host=${host.id} running=${!!isRunning}${message ? ` message=${message}` : ""}`,
    );
    res.json({ success: true });
  } catch (error) {
    console.error("[Agent Rule Status] Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Agent 上报转发自测结果

}
