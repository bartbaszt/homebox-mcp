// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { startServer } from "./server.js";

startServer()
  .then(({ state, url }) => {
    const protocol = state.config.tlsKeyPath ? "HTTPS" : "HTTP";
    console.error(`Homebox MCP listening over ${protocol} at ${url}`);
    if (!state.config.apiToken && !state.config.oauth?.enabled) {
      console.error("WARNING: HOMEBOX_MCP_API_TOKEN is not set. Do not expose this server externally without it.");
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
