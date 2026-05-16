import { startServer } from "./server.js";

startServer()
  .then(({ state, url }) => {
    const protocol = state.config.tlsKeyPath ? "HTTPS" : "HTTP";
    console.error(`Homebox MCP listening over ${protocol} at ${url}`);
    if (!state.config.apiToken) {
      console.error("WARNING: HOMEBOX_MCP_API_TOKEN is not set. Do not expose this server externally without it.");
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
