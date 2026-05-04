/**
 * routes/dashboard.ts
 *
 * VPC-only, Basic Auth protected dashboard for service visibility and
 * development Secrets Manager operations.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { DescribeServicesCommand, ListServicesCommand, type Service } from '@aws-sdk/client-ecs';
import { config } from '../config.js';
import { ecsClient } from '../services/aws.js';
import { getRecentAuditEventsFromDb } from '../services/audit.js';
import { requireDashboardAuth } from '../services/auth.js';
import { getMessagesSince } from '../services/conversations.js';
import { injectSecretIntoService, listSecrets, putSecret } from '../services/environment.js';
import { getRecentMemoryRuns, listActiveMemories } from '../services/memories.js';
import { SERVICE_PREFIX } from '../utils/constants.js';

const CSRF_TOKEN = randomBytes(24).toString('hex');

interface SecretBody {
  csrf?: string;
  name?: string;
  value?: string;
  description?: string;
}

interface InjectBody {
  csrf?: string;
  repo?: string;
  secretName?: string;
  envVarName?: string;
}

interface DashboardQuery {
  notice?: string;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/dashboard')) return;
    if (!await requireDashboardAuth(req, reply)) return reply;
  });

  app.get<{ Querystring: DashboardQuery }>('/dashboard', async (req, reply) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [services, secrets, auditEvents, conversations, memories, memoryRuns] = await Promise.all([
      listManagedServices(),
      listSecrets().catch(() => []),
      getRecentAuditEventsFromDb(25).catch(() => []),
      getMessagesSince(since, 25).catch(() => []),
      listActiveMemories(25).catch(() => []),
      getRecentMemoryRuns(10).catch(() => []),
    ]);
    return reply.type('text/html').send(renderDashboard({
      services,
      secrets,
      auditEvents,
      conversations,
      memories,
      memoryRuns,
      notice: req.query.notice,
    }));
  });

  app.post<{ Body: SecretBody }>('/dashboard/secrets', async (req, reply) => {
    if (!validCsrf(req.body.csrf)) return reply.status(403).send('Invalid CSRF token');
    const name = (req.body.name ?? '').trim();
    const value = req.body.value ?? '';
    if (!name || !value) return reply.status(400).send('Secret name and value are required');

    const saved = await putSecret(
      { name, value, description: req.body.description?.trim() || undefined },
      { actor: 'dashboard-user', surface: 'dashboard' },
    );
    return redirect(reply, `/dashboard?notice=${encodeURIComponent(`Secret ${saved.created ? 'created' : 'updated'}: ${saved.name}`)}`);
  });

  app.post<{ Body: InjectBody }>('/dashboard/inject', async (req, reply) => {
    if (!validCsrf(req.body.csrf)) return reply.status(403).send('Invalid CSRF token');
    const repo = (req.body.repo ?? '').trim();
    const secretName = (req.body.secretName ?? '').trim();
    const envVarName = req.body.envVarName?.trim() || undefined;
    if (!repo || !secretName) return reply.status(400).send('Repo and secret name are required');

    const injected = await injectSecretIntoService(
      { repo, secretName, envVarName },
      { actor: 'dashboard-user', surface: 'dashboard' },
    );
    return redirect(reply, `/dashboard?notice=${encodeURIComponent(`Injected ${injected.envVarName} into ${repo}`)}`);
  });
}

function validCsrf(token: string | undefined): boolean {
  return token === CSRF_TOKEN;
}

function redirect(reply: FastifyReply, location: string) {
  return reply.status(303).header('Location', location).send();
}

async function listManagedServices(): Promise<Service[]> {
  const { ecsClusterName } = config();
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const r = await ecsClient().send(new ListServicesCommand({ cluster: ecsClusterName, nextToken, maxResults: 100 }));
    arns.push(...(r.serviceArns ?? []).filter((arn) => arn.includes(SERVICE_PREFIX)));
    nextToken = r.nextToken;
  } while (nextToken);

  const services: Service[] = [];
  for (let i = 0; i < arns.length; i += 10) {
    const r = await ecsClient().send(new DescribeServicesCommand({
      cluster: ecsClusterName,
      services: arns.slice(i, i + 10),
    }));
    services.push(...(r.services ?? []).filter((s) => s.status !== 'INACTIVE'));
  }
  return services;
}

function renderDashboard(opts: {
  services: Service[];
  secrets: Array<{ name: string; description?: string }>;
  auditEvents: Array<{ ts: string; surface: string; actor: string; action: string; target?: string }>;
  conversations: Array<{ id: number; role: string; slack_user_id: string | null; text: string; created_at: Date }>;
  memories: Array<{ id: number; kind: string; subject_type: string; subject_id: string; content: string; importance: number }>;
  memoryRuns: Array<Record<string, unknown>>;
  notice: string | undefined;
}): string {
  const serviceRows = opts.services.map((s) => {
    const name = s.serviceName ?? '';
    const repo = name.replace(SERVICE_PREFIX, '');
    return `<tr><td>${esc(repo)}</td><td>${esc(s.status ?? 'UNKNOWN')}</td><td>${s.runningCount ?? 0}/${s.desiredCount ?? 0}</td><td>${esc(s.createdAt?.toISOString() ?? '')}</td></tr>`;
  }).join('');

  const secretOptions = opts.secrets
    .map((s) => `<option value="${escAttr(s.name)}">${esc(s.name)}</option>`)
    .join('');
  const secretRows = opts.secrets
    .map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.description ?? '')}</td></tr>`)
    .join('');
  const auditRows = opts.auditEvents
    .map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.surface)}</td><td>${esc(e.actor)}</td><td>${esc(e.action)}</td><td>${esc(e.target ?? '')}</td></tr>`)
    .join('');
  const conversationRows = opts.conversations
    .map((m) => `<tr><td>${m.id}</td><td>${esc(m.created_at.toISOString())}</td><td>${esc(m.role)}</td><td>${esc(m.slack_user_id ?? '')}</td><td>${esc(m.text.slice(0, 240))}</td></tr>`)
    .join('');
  const memoryRows = opts.memories
    .map((m) => `<tr><td>${m.id}</td><td>${esc(m.kind)}</td><td>${esc(`${m.subject_type}:${m.subject_id}`)}</td><td>${m.importance}</td><td>${esc(m.content)}</td></tr>`)
    .join('');
  const memoryRunRows = opts.memoryRuns
    .map((r) => `<tr><td>${esc(String(r['id'] ?? ''))}</td><td>${esc(String(r['status'] ?? ''))}</td><td>${esc(String(r['started_at'] ?? ''))}</td><td>${esc(String(r['memories_created'] ?? 0))}</td><td>${esc(String(r['error'] ?? ''))}</td></tr>`)
    .join('');

  const notice = opts.notice ? `<div class="notice">${esc(opts.notice)}</div>` : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tangent Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; background: #0f172a; color: #e2e8f0; }
    a { color: #93c5fd; }
    section { background: #111827; border: 1px solid #334155; border-radius: 12px; padding: 20px; margin: 0 0 20px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid #334155; padding: 8px; vertical-align: top; }
    label { display: block; margin: 10px 0 4px; color: #cbd5e1; }
    input, select { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 8px; border: 1px solid #475569; background: #020617; color: #e2e8f0; }
    button { margin-top: 12px; padding: 9px 14px; border: 0; border-radius: 8px; background: #2563eb; color: white; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
    .notice { background: #064e3b; border: 1px solid #10b981; border-radius: 8px; padding: 10px 12px; margin-bottom: 20px; }
    .muted { color: #94a3b8; }
  </style>
</head>
<body>
  <h1>Tangent Dashboard</h1>
  <p class="muted">VPC-only operational view. Secret values are write-only and never rendered after submit.</p>
  ${notice}

  <section>
    <h2>Services</h2>
    <table><thead><tr><th>Repo</th><th>Status</th><th>Tasks</th><th>Created</th></tr></thead><tbody>${serviceRows || '<tr><td colspan="4">No services found</td></tr>'}</tbody></table>
  </section>

  <div class="grid">
    <section>
      <h2>Create Or Update Secret</h2>
      <form method="post" action="/dashboard/secrets">
        <input type="hidden" name="csrf" value="${CSRF_TOKEN}">
        <label>Secret name</label>
        <input name="name" placeholder="tangent/MY_SECRET or MY_SECRET" required>
        <label>Secret value</label>
        <input name="value" type="password" autocomplete="new-password" required>
        <label>Description</label>
        <input name="description" placeholder="Optional">
        <button type="submit">Save Secret</button>
      </form>
    </section>

    <section>
      <h2>Inject Secret Into Service</h2>
      <form method="post" action="/dashboard/inject">
        <input type="hidden" name="csrf" value="${CSRF_TOKEN}">
        <label>Repo</label>
        <input name="repo" placeholder="my-service" required>
        <label>Secret</label>
        <select name="secretName" required>${secretOptions}</select>
        <label>Env var name</label>
        <input name="envVarName" placeholder="Defaults to secret basename">
        <button type="submit">Inject And Redeploy</button>
      </form>
    </section>
  </div>

  <section>
    <h2>Secrets</h2>
    <table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>${secretRows || '<tr><td colspan="2">No secrets found</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Recent Audit Events</h2>
    <table><thead><tr><th>Time</th><th>Surface</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${auditRows || '<tr><td colspan="5">No audit events yet</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Recent Conversations</h2>
    <table><thead><tr><th>ID</th><th>Time</th><th>Role</th><th>User</th><th>Preview</th></tr></thead><tbody>${conversationRows || '<tr><td colspan="5">No conversation rows yet</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Memories</h2>
    <table><thead><tr><th>ID</th><th>Kind</th><th>Subject</th><th>Importance</th><th>Content</th></tr></thead><tbody>${memoryRows || '<tr><td colspan="5">No active memories yet</td></tr>'}</tbody></table>
  </section>

  <section>
    <h2>Memory Runs</h2>
    <table><thead><tr><th>ID</th><th>Status</th><th>Started</th><th>Created</th><th>Error</th></tr></thead><tbody>${memoryRunRows || '<tr><td colspan="5">No memory runs yet</td></tr>'}</tbody></table>
  </section>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function escAttr(s: string): string {
  return esc(s);
}
