import { z } from 'zod';
import { authService } from '../services/container';
import { explainFailure, fetchDetails, FINAL_STATUSES, getDeploy, headline, progressLines } from '../deploys/deployAnalysis';
import { defineTool, fail, ok } from './types';

export const getDeploymentStatusTool = defineTool({
  name: 'get_deployment_status',
  title: 'Explain a Deployment or Validation',
  description:
    'Status of a Salesforce deployment or validation (from the CLI, CI, DevOps Center or a change set) and, when it failed, ' +
    'a plain-language explanation of each failing component, test or coverage problem with how to fix it, including ' +
    'dependencies missing from the target org. Without a deployId it uses the most recent deploy of the last 7 days. ' +
    'Use for "why did the last deploy fail?", "what is the status of deploy 0Af…?", "did my validation pass?".',
  inputSchema: z.object({
    deployId: z
      .string()
      .regex(/^0Af[0-9A-Za-z]{12}([0-9A-Za-z]{3})?$/, 'A deploy ID starts with 0Af and has 15 or 18 characters')
      .optional()
      .describe('DeployRequest ID (starts with 0Af). Omit for the most recent deploy.'),
  }),
  async handler(ctx, { deployId }) {
    const conn = await authService.getConnection(ctx.tenant.orgId);
    const deploy = await getDeploy(conn, deployId);
    if (!deploy) {
      return fail(404, deployId ? `No deployment ${deployId} found in this org.` : 'No deployment or validation in the last 7 days.');
    }

    let explanation: string | null = null;
    if (deploy.status === 'Failed' || deploy.status === 'SucceededPartial') {
      explanation = await explainFailure(conn, deploy, await fetchDetails(conn, deploy.id));
    }
    const lines = [
      `${headline(deploy)} · \`${deploy.id}\` by ${deploy.createdByName}`,
      ...(FINAL_STATUSES.has(deploy.status) && !explanation ? [] : progressLines(deploy)),
      ...(explanation ? ['', explanation] : []),
    ];
    return ok({ displayText: lines.join('\n'), deploy });
  },
});

export const deployTools = [getDeploymentStatusTool];
