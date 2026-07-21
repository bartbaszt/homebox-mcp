// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { startServer } from "./server.js";

startServer()
  .then((started) => {
    const protocol = started.state.config.tlsKeyPath ? "HTTPS" : "HTTP";
    console.error(`Homebox MCP listening over ${protocol} at ${started.url}`);
    if (!started.state.config.apiToken && !started.state.config.oauth?.enabled) {
      console.error("WARNING: HOMEBOX_MCP_API_TOKEN is not set. Do not expose this server externally without it.");
    }

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shutdownPromise) return;
      console.error(`Received ${signal}; shutting down Homebox MCP`);
      shutdownPromise = started.close().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
