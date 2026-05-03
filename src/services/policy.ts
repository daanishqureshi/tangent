/**
 * Central action policy metadata for Tangent.
 *
 * The Slack router still owns the conversational UX, but high-risk surfaces
 * should consult this table instead of scattering policy in prompts and routes.
 */

export const APPROVER_ID = 'U07EU7KSG3U';

export type ToolRisk = 'read' | 'write' | 'admin' | 'host';

export interface ActionPolicy {
  risk: ToolRisk;
  requiresConfirmation: boolean;
  requiredUserId?: string;
  dmOnly?: boolean;
  chainable: boolean;
  dashboardAllowed: boolean;
  audit: 'none' | 'standard' | 'sensitive';
}

export const ACTION_POLICIES = {
  deploy:          { risk: 'write', requiresConfirmation: true,  chainable: false, dashboardAllowed: false, audit: 'standard' },
  teardown:        { risk: 'admin', requiresConfirmation: true,  requiredUserId: APPROVER_ID, chainable: false, dashboardAllowed: false, audit: 'sensitive' },
  put_secret:      { risk: 'write', requiresConfirmation: false, chainable: true,  dashboardAllowed: true,  audit: 'sensitive' },
  inject_secret:   { risk: 'write', requiresConfirmation: false, chainable: true,  dashboardAllowed: true,  audit: 'sensitive' },
  db_query:        { risk: 'read',  requiresConfirmation: false, chainable: true,  dashboardAllowed: false, audit: 'standard' },
  db_create_user:  { risk: 'admin', requiresConfirmation: false, requiredUserId: APPROVER_ID, chainable: true, dashboardAllowed: false, audit: 'sensitive' },
  db_drop_user:    { risk: 'admin', requiresConfirmation: false, requiredUserId: APPROVER_ID, chainable: true, dashboardAllowed: false, audit: 'sensitive' },
  bash:            { risk: 'host',  requiresConfirmation: true,  requiredUserId: APPROVER_ID, dmOnly: true, chainable: false, dashboardAllowed: false, audit: 'sensitive' },
  edit_self:       { risk: 'admin', requiresConfirmation: false, requiredUserId: APPROVER_ID, dmOnly: true, chainable: false, dashboardAllowed: false, audit: 'sensitive' },
  push_self:       { risk: 'admin', requiresConfirmation: false, requiredUserId: APPROVER_ID, dmOnly: true, chainable: false, dashboardAllowed: false, audit: 'sensitive' },
} satisfies Record<string, ActionPolicy>;

export function actionPolicy(name: string): ActionPolicy | undefined {
  return ACTION_POLICIES[name as keyof typeof ACTION_POLICIES];
}
