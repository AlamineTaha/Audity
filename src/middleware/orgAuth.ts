/**
 * Org Authentication Middleware
 *
 * Extracts and validates the Salesforce Org ID from request headers.
 * Salesforce Named Credentials automatically inject these headers on every call:
 *   x-sfdc-org-id   — the calling org's 18-char ID
 *   x-auditdelta-secret — a shared secret matching AUDITDELTA_SECRET env var
 *
 * Routes that require org context (all /api/v1 endpoints except /health and /auth)
 * must be protected by this middleware. The validated orgId is stored on res.locals
 * so every downstream handler can access it without touching req.query or req.body.
 */

import { Request, Response, NextFunction } from 'express';

export function orgAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.AUDITDELTA_SECRET;

  // If AUDITDELTA_SECRET is not configured, fail closed
  if (!secret) {
    res.status(500).json({ error: 'Server misconfiguration: AUDITDELTA_SECRET is not set' });
    return;
  }

  const incomingSecret = req.headers['x-auditdelta-secret'];
  if (!incomingSecret || incomingSecret !== secret) {
    res.status(401).json({ error: 'Unauthorized: missing or invalid x-auditdelta-secret header' });
    return;
  }

  const orgId = req.headers['x-sfdc-org-id'];
  if (!orgId || typeof orgId !== 'string' || orgId.trim() === '') {
    res.status(401).json({ error: 'Unauthorized: missing x-sfdc-org-id header' });
    return;
  }

  // Store validated orgId for downstream handlers
  res.locals.orgId = orgId.trim();
  next();
}
