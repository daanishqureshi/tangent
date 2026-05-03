import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyBasicAuth(header: string | undefined): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const expected = config().dashboard;
  if (!expected.password) return false;
  return safeEqual(username, expected.username) && safeEqual(password, expected.password);
}

export function verifyApiToken(header: string | undefined): boolean {
  const token = config().dashboard.apiToken;
  if (!token || !header?.startsWith('Bearer ')) return false;
  return safeEqual(header.slice('Bearer '.length), token);
}

export function isDashboardAuthenticated(req: FastifyRequest): boolean {
  return verifyBasicAuth(req.headers.authorization);
}

export function isMutationAuthenticated(req: FastifyRequest): boolean {
  return verifyBasicAuth(req.headers.authorization) || verifyApiToken(req.headers.authorization);
}

export async function requireDashboardAuth(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (isDashboardAuthenticated(req)) return true;
  await reply
    .header('WWW-Authenticate', 'Basic realm="Tangent Dashboard"')
    .status(401)
    .send('Authentication required');
  return false;
}

export async function requireMutationAuth(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (isMutationAuthenticated(req)) return true;
  await reply
    .header('WWW-Authenticate', 'Basic realm="Tangent API"')
    .status(401)
    .send({ error: 'Authentication required' });
  return false;
}
