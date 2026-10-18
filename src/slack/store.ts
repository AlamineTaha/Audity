import { Installation, InstallationQuery, InstallationStore } from '@slack/bolt';
import { DatabaseService } from '../services/databaseService';

let db: DatabaseService | null = null;

export function initSlackStore(database: DatabaseService): void {
  db = database;
}

export function slackDb(): DatabaseService {
  if (!db) throw new Error('Slack store not initialized');
  return db;
}

function installKey(enterpriseId: string | undefined, teamId: string | undefined, isEnterpriseInstall?: boolean): string {
  if (isEnterpriseInstall && enterpriseId) return `E:${enterpriseId}`;
  if (!teamId) throw new Error('Slack installation has no team id');
  return `T:${teamId}`;
}

export const installationStore: InstallationStore = {
  async storeInstallation(installation: Installation) {
    const key = installKey(installation.enterprise?.id, installation.team?.id, installation.isEnterpriseInstall);
    await slackDb().saveSlackInstallation(key, installation.team?.id, installation.enterprise?.id, installation);
  },
  async fetchInstallation(query: InstallationQuery<boolean>) {
    const key = installKey(query.enterpriseId, query.teamId, query.isEnterpriseInstall);
    const installation = await slackDb().getSlackInstallation<Installation>(key);
    if (!installation) throw new Error(`No Slack installation for ${key}`);
    return installation;
  },
  async deleteInstallation(query: InstallationQuery<boolean>) {
    await slackDb().deleteSlackInstallation(installKey(query.enterpriseId, query.teamId, query.isEnterpriseInstall));
  },
};

/** Bot token for a workspace: the OAuth installation, or SLACK_BOT_TOKEN in single-workspace mode. */
export async function botTokenForTeam(teamId: string): Promise<string | null> {
  if (process.env.SLACK_BOT_TOKEN && !process.env.SLACK_CLIENT_ID) return process.env.SLACK_BOT_TOKEN;
  const installation = await slackDb().getSlackInstallation<Installation>(`T:${teamId}`);
  return installation?.bot?.token ?? null;
}
