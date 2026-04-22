import { WebSocketServer } from "ws";

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const rooms = new Map();

export function attachRealtime(server, { getElevatorByToken, onPlayerConnected }) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "", `https://${host}`);
      const token = url.searchParams.get("token") || "";
      const row = getElevatorByToken(token);
      if (!row) {
        ws.close(4001, "Unauthorized");
        return;
      }
      const id = row.id;
      onPlayerConnected?.(id);
      if (!rooms.has(id)) rooms.set(id, new Set());
      rooms.get(id).add(ws);
      ws.send(JSON.stringify({ type: "hello", elevatorId: id }));
      ws.on("close", () => {
        rooms.get(id)?.delete(ws);
        if (rooms.get(id)?.size === 0) rooms.delete(id);
      });
      ws.on("error", () => {});
    } catch {
      try {
        ws.close(1011, "Error");
      } catch {
        /* ignore */
      }
    }
  });

  return wss;
}

export function notifyElevator(elevatorId, payload = {}) {
  const set = rooms.get(elevatorId);
  if (!set?.size) return;
  const msg = JSON.stringify({ type: "refresh", at: Date.now(), ...payload });
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}
