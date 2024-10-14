let active = new Set<string>();
const server = Bun.serve<{ pubChannel?: string; subChannel?: string }>({
  port: 10300,
  fetch(req, server) {
    const pathname = new URL(req.url).pathname;
    if (pathname.startsWith("/publish/")) {
      const pubChannel = decodeURIComponent(pathname.slice("/publish/".length));
      if (active.has(pubChannel)) {
        return new Response("channel already active", { status: 403 });
      }
      const success = server.upgrade(req, { data: { pubChannel } });
      if (success) return undefined;
      return new Response("y u no websocket", { status: 400 });
    } else if (pathname.startsWith("/subscribe/")) {
      const subChannel = decodeURIComponent(
        pathname.slice("/subscribe/".length)
      );
      const success = server.upgrade(req, { data: { subChannel } });
      if (success) return undefined;
      return new Response("y u no websocket", { status: 400 });
    } else {
      return new Response("wrong route", { status: 404 });
    }
  },
  websocket: {
    open(ws) {
      if (ws.data.subChannel) ws.subscribe(ws.data.subChannel);
    },
    message(ws, message) {
      if (ws.data.pubChannel) server.publish(ws.data.pubChannel, message);
    },
    close(ws) {
      if (ws.data.subChannel) ws.unsubscribe(ws.data.subChannel);
    },
  },
});

console.log(`Listening on ${server.hostname}:${server.port}`);
