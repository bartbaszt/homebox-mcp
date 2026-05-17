// homebox-mcp
// Copyright (C) 2026 Bartłomiej Basztura
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

import { randomUUID } from "node:crypto";

import { HomeboxMcpError } from "./errors.js";

export interface HomeboxSession {
  sessionKey: string;
  token: string;
  username?: string;
  expiresAt?: string;
  attachmentToken?: string;
  createdAt: string;
  refreshedAt?: string;
}

export interface PublicSessionInfo {
  sessionKey: string;
  username?: string;
  expiresAt?: string;
  hasAttachmentToken: boolean;
  createdAt: string;
  refreshedAt?: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, HomeboxSession>();

  set(session: Omit<HomeboxSession, "sessionKey" | "createdAt"> & { sessionKey?: string; createdAt?: string }): PublicSessionInfo {
    const sessionKey = session.sessionKey?.trim() || randomUUID();
    const createdAt = session.createdAt ?? new Date().toISOString();
    const stored: HomeboxSession = { ...session, sessionKey, createdAt };
    this.sessions.set(sessionKey, stored);
    return this.toPublic(stored);
  }

  get(sessionKey: string): HomeboxSession {
    const session = this.sessions.get(sessionKey);
    if (!session) throw new HomeboxMcpError("auth", `Unknown sessionKey '${sessionKey}'. Call homebox_login first.`);
    return session;
  }

  updateToken(sessionKey: string, token: string, expiresAt?: string, attachmentToken?: string): PublicSessionInfo {
    const session = this.get(sessionKey);
    session.token = token;
    session.expiresAt = expiresAt;
    session.attachmentToken = attachmentToken ?? session.attachmentToken;
    session.refreshedAt = new Date().toISOString();
    return this.toPublic(session);
  }

  delete(sessionKey: string): boolean {
    return this.sessions.delete(sessionKey);
  }

  list(): PublicSessionInfo[] {
    return [...this.sessions.values()].map((session) => this.toPublic(session));
  }

  private toPublic(session: HomeboxSession): PublicSessionInfo {
    return {
      sessionKey: session.sessionKey,
      username: session.username,
      expiresAt: session.expiresAt,
      hasAttachmentToken: Boolean(session.attachmentToken),
      createdAt: session.createdAt,
      refreshedAt: session.refreshedAt,
    };
  }
}
