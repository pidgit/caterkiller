const WebSocketCtor = globalThis.WebSocket || require('ws');

const apiKey = process.env.PUMPPORTAL_API_KEY;
const mint = process.env.TOKEN_MINT;

if (!apiKey || !mint) {
  throw new Error("Missing API key or token mint");
}
const ws = new WebSocketCtor(`wss://pumpportal.fun/api/data?api-key=${apiKey}`);
/*

ws.onopen = () => {
  console.log("Connected");

  ws.send(JSON.stringify({
    method: "subscribeTokenTrade",
    keys: [mint]
  }));

  console.log("Subscribed to", mint);
};

ws.onmessage = (event) => {
  console.log("RAW:", event.data.toString());
};

ws.onerror = console.error;

ws.onclose = (event) => {
  console.log("Disconnected:", event.code, event.reason.toString());
};*/

ws.onopen = () => {

  ws.send(JSON.stringify({
    method: "subscribeTokenTrade",
    keys: [
      "C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump"
    ]
  }));
}

ws.onmessage = event => {
  console.log("PumpPortal RAW:", event.data.toString());
};