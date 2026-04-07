/**
 * API Key Authentication Middleware
 *
 * Reads Authorization: Bearer <key> header.
 * Resolves the key against the store and attaches ctx to req.
 *
 * If REQUIRE_AUTH=false (default in dev) and no key is provided,
 * the request is allowed through as a guest with role "instructor"
 * on "default-org" so the demo works without setup.
 */

import { Request, Response, NextFunction } from "express";
import { resolveApiKey } from "./store";
import { Role } from "./types";

export interface AuthContext {
  api_key_id: string | null;
  org_id: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth: AuthContext;
    }
  }
}

const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "true";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers["authorization"] ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (raw) {
    const key = resolveApiKey(raw);
    if (!key) {
      res.status(401).json({ error: "Invalid or revoked API key." });
      return;
    }
    req.auth = { api_key_id: key.id, org_id: key.org_id, role: key.role };
    next();
    return;
  }

  if (!REQUIRE_AUTH) {
    // Dev mode: treat all unauthenticated requests as instructor on default-org
    req.auth = { api_key_id: null, org_id: "default-org", role: "instructor" };
    next();
    return;
  }

  res.status(401).json({ error: "Authorization: Bearer <api_key> header required." });
}

/** Guard that rejects unless the caller has one of the allowed roles */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (roles.includes(req.auth.role)) {
      next();
      return;
    }
    res.status(403).json({ error: `Requires role: ${roles.join(" | ")}` });
  };
}
