import { Agent } from "node:https";

// Track sockets returned before CONNECT completes; Agent.destroy alone does not own them yet.
export class DiagnosticAgent extends Agent {
  pending = new Set();
  createConnection(...args) {
    const socket = super.createConnection(...args);
    this.pending.add(socket);
    socket.once("close", () => this.pending.delete(socket));
    return socket;
  }
  destroy() {
    for (const socket of this.pending) socket.destroy();
    super.destroy();
  }
}
