import { createServer } from "node:http";
import { createNote, listNotes } from "./notes.js";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApp() {
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/notes") return send(res, 200, listNotes());
    if (req.method === "POST" && req.url === "/api/notes") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        const { text } = JSON.parse(raw || "{}");
        if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "text is required" });
        return send(res, 201, createNote(text));
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
    }
    send(res, 404, { error: "not found" });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(3000, () => console.log("notes-api on http://localhost:3000"));
}
