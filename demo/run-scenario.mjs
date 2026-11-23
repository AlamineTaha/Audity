#!/usr/bin/env node
/**
 * AuditDelta demo scenarios: makes real, varied setup changes in the DEMO org so the
 * AuditDelta Slack alerts have something to show. Run: npm run demo -- <scenario>
 * Every run produces a different change (values rotate), so each run alerts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORG_ALIAS = process.env.DEMO_ORG_ALIAS || 'auditdelta-test';
// The CLI is also logged in to customer orgs: refuse anything that is not the demo org.
const EXPECTED_ORG_ID = process.env.DEMO_ORG_ID || '00DgL00000gRdgDUAS';
const AGENT_USERNAME = process.env.DEMO_AGENT_USERNAME || 'auditdelta@salesforce.om';
const API = '68.0';

const FLOW = 'AD_Test_Lead_Routing';
const PERMSET = 'AD_Test_Elevated_Access';
const tick = Math.floor(Date.now() / 60000); // rotates every minute
const pick = (values) => values[tick % values.length];
/** Next value after the one currently in the org, so every run is a real change. */
const nextAfter = (values, isCurrent) => values[(values.findIndex(isCurrent) + 1) % values.length];

function toolingMetadata(soql) {
  const r = sf(['data', 'query', '-o', ORG_ALIAS, '--use-tooling-api', '-q', soql]);
  return r.records[0]?.Metadata ?? null;
}
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

function sf(args, cwd) {
  let out;
  try {
    out = execFileSync('sf', [...args, '--json'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // sf exits non-zero on failed deploys; the reason is still in the JSON on stdout.
    out = error.stdout || '';
    if (!out.trim().startsWith('{')) throw new Error(`sf ${args.slice(0, 3).join(' ')} failed: ${(error.stderr || error.message).split('\n')[0]}`);
  }
  const json = JSON.parse(out);
  if (json.status !== 0) {
    const failures = (json.data?.files ?? json.result?.files ?? []).filter((f) => f.state === 'Failed');
    const detail = failures.map((f) => `${f.type} ${f.fullName}: ${f.error}`).join('; ');
    throw new Error(detail || json.message || out.slice(0, 500));
  }
  return json.result;
}

function assertDemoOrg() {
  const org = sf(['org', 'display', '-o', ORG_ALIAS]);
  if (org.id !== EXPECTED_ORG_ID) {
    throw new Error(`Alias "${ORG_ALIAS}" points to org ${org.id}, not the demo org ${EXPECTED_ORG_ID}. Refusing to change it.`);
  }
  return org;
}

/** Check-only validation: creates a DeployRequest for Deploy Watch without changing the org. */
function validate(files) {
  const dir = mkdtempSync(join(tmpdir(), 'auditdelta-demo-'));
  try {
    writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API }));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, 'force-app/main/default', rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    try {
      const result = sf(['project', 'deploy', 'validate', '-o', ORG_ALIAS, '--source-dir', 'force-app', '--wait', '20'], dir);
      console.log(`   validation ${result.status} (${result.id})`);
    } catch (error) {
      // A failing validation is the point of some scenarios.
      console.log(`   validation failed as expected: ${error.message.slice(0, 200)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const apexMeta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${API}</apiVersion><status>Active</status></ApexClass>
`;

function deploy(files, { runTests } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'auditdelta-demo-'));
  try {
    writeFileSync(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], sourceApiVersion: API }));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, 'force-app/main/default', rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    // sf only deploys from inside an SFDX project directory.
    const args = ['project', 'deploy', 'start', '-o', ORG_ALIAS, '--source-dir', 'force-app', '--wait', '20'];
    if (runTests) args.push('--test-level', 'RunSpecifiedTests', '--tests', ...runTests);
    const result = sf(args, dir);
    const seen = new Set();
    for (const f of result.files ?? []) {
      const key = `${f.state} ${f.type} ${f.fullName}`;
      if (!seen.has(key)) console.log(`   ${key}${f.error ? ` — ${f.error}` : ''}`);
      seen.add(key);
    }
    if (result.status !== 'Succeeded') throw new Error(`Deploy ${result.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- Flow ----------

function flowXml({ risky, hotMessage }) {
  const queueFilter = risky
    ? '<field>Id</field><operator>EqualTo</operator><value><stringValue>00G5g000004AbCdEAK</stringValue></value>'
    : '<field>DeveloperName</field><operator>EqualTo</operator><value><stringValue>AD_Test_Hot_Leads</stringValue></value>';
  const usersFilter = risky
    ? ''
    : '<filterLogic>and</filterLogic><filters><field>IsActive</field><operator>EqualTo</operator><value><booleanValue>true</booleanValue></value></filters>';
  const fault = risky ? '' : '<faultConnector><targetReference>Owner_Update_Failed</targetReference></faultConnector>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${API}</apiVersion>
    <label>AD Test Lead Routing</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <runInMode>${risky ? 'SystemModeWithoutSharing' : 'DefaultMode'}</runInMode>
    <interviewLabel>AD Test Lead Routing {!$Flow.CurrentDateTime}</interviewLabel>
    <start>
        <locationX>50</locationX><locationY>0</locationY>
        <object>Lead</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
        <connector><targetReference>Check_Rating</targetReference></connector>
    </start>
    <decisions>
        <name>Check_Rating</name><label>Check Rating</label>
        <locationX>182</locationX><locationY>120</locationY>
        <defaultConnectorLabel>Default</defaultConnectorLabel>
        <rules>
            <name>Is_Hot</name><conditionLogic>and</conditionLogic>
            <conditions><leftValueReference>$Record.Rating</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>Hot</stringValue></rightValue></conditions>
            <connector><targetReference>Get_Hot_Queue</targetReference></connector>
            <label>Is Hot</label>
        </rules>
        <rules>
            <name>Is_Warm</name><conditionLogic>and</conditionLogic>
            <conditions><leftValueReference>$Record.Rating</leftValueReference><operator>EqualTo</operator><rightValue><stringValue>Warm</stringValue></rightValue></conditions>
            <connector><targetReference>Get_All_Users</targetReference></connector>
            <label>Is Warm</label>
        </rules>
    </decisions>
    <recordLookups>
        <name>Get_Hot_Queue</name><label>Get Hot Queue</label>
        <locationX>50</locationX><locationY>240</locationY>
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        <connector><targetReference>Reassign_Owner</targetReference></connector>
        <filterLogic>and</filterLogic>
        <filters>${queueFilter}</filters>
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <object>Group</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
    <recordLookups>
        <name>Get_All_Users</name><label>Get All Users</label>
        <locationX>314</locationX><locationY>240</locationY>
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        ${usersFilter}
        <getFirstRecordOnly>false</getFirstRecordOnly>
        <object>User</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
    <recordUpdates>
        <name>Reassign_Owner</name><label>Reassign Owner</label>
        ${fault}
        <locationX>50</locationX><locationY>360</locationY>
        <filterLogic>and</filterLogic>
        <filters><field>Id</field><operator>EqualTo</operator><value><elementReference>$Record.Id</elementReference></value></filters>
        <inputAssignments><field>OwnerId</field><value><elementReference>Get_Hot_Queue.Id</elementReference></value></inputAssignments>
        <object>Lead</object>
    </recordUpdates>
    <customErrors>
        <name>Owner_Update_Failed</name><label>Owner Update Failed</label>
        <locationX>314</locationX><locationY>480</locationY>
        <customErrorMessages><errorMessage>${hotMessage}</errorMessage><isFieldError>false</isFieldError></customErrorMessages>
    </customErrors>
</Flow>
`;
}

const flowFile = (xml) => ({ [`flows/${FLOW}.flow-meta.xml`]: xml });

// ---------- Scenarios ----------

const scenarios = {
  'flow-risky': {
    about: 'New Flow version with CRITICAL risk: system mode, hardcoded ID, no fault path, unfiltered User query',
    expect: '[FLOW] … Risk introduced: CRITICAL',
    // Deploy a safe version first so the risky one always *introduces* the risk.
    run: () => {
      deploy(flowFile(flowXml({ risky: false, hotMessage: `Could not route this lead to the hot-leads queue (${stamp}).` })));
      deploy(flowFile(flowXml({ risky: true, hotMessage: `Could not route this lead (${stamp}).` })));
    },
  },
  'flow-fix': {
    about: 'Fixes the Flow: default run mode, lookup by name, fault path, filtered query',
    expect: '[FLOW] … Risk introduced: none (risks removed)',
    run: () => deploy(flowFile(flowXml({ risky: false, hotMessage: `Could not route this lead to the hot-leads queue (${stamp}).` }))),
  },
  'flow-normal': {
    about: 'Harmless Flow change: only the error message wording changes',
    expect: '[FLOW] … small diff, no new risk',
    run: () =>
      deploy(flowFile(flowXml({ risky: false, hotMessage: pick(['Routing failed — please contact the sales ops team.', 'This hot lead could not be assigned. Ask sales ops for help.', 'Lead routing failed; the lead stays with its current owner.']) + ` (${stamp})` }))),
  },
  'vr-change': {
    about: 'Validation rule: the revenue threshold changes',
    expect: '[VALIDATION RULE] Lead.AD_Test_Hot_Lead_Needs_Phone',
    run: () => {
      const current = toolingMetadata(
        "SELECT Metadata FROM ValidationRule WHERE ValidationName = 'AD_Test_Hot_Lead_Needs_Phone' AND EntityDefinition.QualifiedApiName = 'Lead' LIMIT 1"
      )?.errorConditionFormula ?? '';
      const threshold = nextAfter([100000, 250000, 500000, 750000], (t) => current.includes(`> ${t})`));
      deploy({
        'objects/Lead/validationRules/AD_Test_Hot_Lead_Needs_Phone.validationRule-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AD_Test_Hot_Lead_Needs_Phone</fullName>
    <active>true</active>
    <description>AuditDelta demo: hot leads above the revenue threshold need a phone number.</description>
    <errorConditionFormula>AND(ISPICKVAL(Rating, &apos;Hot&apos;), ISBLANK(Phone), AnnualRevenue &gt; ${threshold})</errorConditionFormula>
    <errorDisplayField>Phone</errorDisplayField>
    <errorMessage>Hot leads with revenue over ${threshold.toLocaleString('en-US')} need a phone number before saving.</errorMessage>
</ValidationRule>
`,
      });
    },
  },
  'formula-change': {
    about: 'Formula field: the revenue bands change',
    expect: '[FORMULA FIELD] Lead.AD_Test_Revenue_Band__c',
    run: () => {
      const current = toolingMetadata(
        "SELECT Metadata FROM CustomField WHERE DeveloperName = 'AD_Test_Revenue_Band' AND TableEnumOrId = 'Lead' LIMIT 1"
      )?.formula ?? '';
      const [ent, mid] = nextAfter([[10000000, 1000000], [5000000, 500000], [20000000, 2000000]], ([e]) => current.includes(`>= ${e},`));
      deploy({
        'objects/Lead/fields/AD_Test_Revenue_Band__c.field-meta.xml': `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AD_Test_Revenue_Band__c</fullName>
    <label>AD Test Revenue Band</label>
    <description>AuditDelta demo formula field.</description>
    <formula>IF(AnnualRevenue &gt;= ${ent}, &apos;Enterprise&apos;, IF(AnnualRevenue &gt;= ${mid}, &apos;Mid-Market&apos;, &apos;SMB&apos;))</formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
`,
      });
    },
  },
  'apex-change': {
    about: 'Apex class change (no Slack alert yet — feeds hotspots, archive and reports)',
    expect: 'no alert; visible in hotspots / audit search',
    run: () => {
      const body = sf(['data', 'query', '-o', ORG_ALIAS, '--use-tooling-api', '-q', "SELECT Body FROM ApexClass WHERE Name = 'AD_Test_LeadScoring' LIMIT 1"]).records[0]?.Body ?? '';
      const coldScore = nextAfter([5, 10, 15], (v) => body.includes(`'Cold') s += ${v};`));
      const meta = `<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>${API}</apiVersion><status>Active</status></ApexClass>
`;
      deploy(
        {
          'classes/AD_Test_LeadScoring.cls': `public with sharing class AD_Test_LeadScoring {
    public static Integer score(Lead l) {
        Integer s = 0;
        if (l.Rating == 'Hot') s += 50;
        if (l.Rating == 'Warm') s += 25;
        if (l.Rating == 'Cold') s += ${coldScore};
        if (String.isNotBlank(l.Phone)) s += 20;
        if (l.AnnualRevenue != null && l.AnnualRevenue > 1000000) s += 30;
        return s;
    }
}
`,
          'classes/AD_Test_LeadScoring.cls-meta.xml': meta,
        },
        { runTests: ['AD_Test_LeadScoringTest'] }
      );
    },
  },
  'deploy-fail': {
    about: 'Check-only validation of a class that references a field and a class missing from the org',
    expect: 'Deploy channel: live progress, then ":x: Validation failed" + AI explanation listing the missing dependencies',
    run: () =>
      validate({
        'classes/AD_Test_LeadRouterService.cls': `public with sharing class AD_Test_LeadRouterService {
    public static void routeHotLeads(List<Lead> leads) {
        for (Lead l : leads) {
            if (l.Rating == 'Hot' && l.AD_Test_Region__c == 'EMEA') {
                l.OwnerId = AD_Test_QueueSelector.hotLeadsQueueId();
            }
        }
    }
}
`,
        'classes/AD_Test_LeadRouterService.cls-meta.xml': apexMeta,
      }),
  },
  'deploy-ok': {
    about: 'Check-only validation that succeeds (nothing is saved)',
    expect: 'Deploy channel: ":white_check_mark: Validation succeeded · ready to quick deploy"',
    run: () =>
      validate({
        'classes/AD_Test_LeadRouterService.cls': `public with sharing class AD_Test_LeadRouterService {
    public static Integer hotLeadCount(List<Lead> leads) {
        Integer count = 0;
        for (Lead l : leads) {
            if (l.Rating == 'Hot') count++;
        }
        return count;
    }
}
`,
        'classes/AD_Test_LeadRouterService.cls-meta.xml': apexMeta,
      }),
  },
  'perm-grant': {
    about: `Assigns ${PERMSET} (View All Data) to the agent user`,
    expect: '[SECURITY] Privileged access changed · CRITICAL',
    run: () => {
      if (findAssignment()) return console.log('   already assigned — run perm-revoke first');
      sf(['org', 'assign', 'permset', '-o', ORG_ALIAS, '--name', PERMSET, '--on-behalf-of', AGENT_USERNAME]);
      console.log(`   assigned ${PERMSET} to ${AGENT_USERNAME}`);
    },
  },
  'perm-revoke': {
    about: `Removes ${PERMSET} from the agent user`,
    expect: '[SECURITY] Privileged access changed · LOW (revoked)',
    run: () => {
      const id = findAssignment();
      if (!id) return console.log('   not assigned — run perm-grant first');
      sf(['data', 'delete', 'record', '-o', ORG_ALIAS, '--sobject', 'PermissionSetAssignment', '--record-id', id]);
      console.log(`   removed ${PERMSET} from ${AGENT_USERNAME}`);
    },
  },
};

function findAssignment() {
  const r = sf([
    'data', 'query', '-o', ORG_ALIAS, '-q',
    `SELECT Id FROM PermissionSetAssignment WHERE Assignee.Username = '${AGENT_USERNAME}' AND PermissionSet.Name = '${PERMSET}'`,
  ]);
  return r.records[0]?.Id ?? null;
}

const stories = {
  story: ['flow-risky', 'vr-change', 'formula-change', 'apex-change'],
  'story-fix': ['flow-fix', 'flow-normal'],
  'story-deploy': ['deploy-ok', 'deploy-fail'],
};

function help() {
  console.log('Usage: npm run demo -- <scenario> [<scenario> …]\n\nScenarios:');
  for (const [name, s] of Object.entries(scenarios)) console.log(`  ${name.padEnd(15)} ${s.about}\n  ${''.padEnd(15)} → ${s.expect}`);
  for (const [name, list] of Object.entries(stories)) console.log(`  ${name.padEnd(15)} runs: ${list.join(', ')}`);
}

const requested = process.argv.slice(2).flatMap((n) => stories[n] ?? [n]);
if (requested.length === 0 || requested.includes('--help')) {
  help();
  process.exit(0);
}
const unknown = requested.filter((n) => !scenarios[n]);
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(', ')}\n`);
  help();
  process.exit(1);
}

try {
  const org = assertDemoOrg();
  console.log(`Demo org ${org.id} (${org.instanceUrl}) as ${org.username}\n`);
  for (const name of requested) {
    console.log(`▶ ${name}: ${scenarios[name].about}`);
    scenarios[name].run();
    console.log(`  expected in Slack: ${scenarios[name].expect}\n`);
  }
  console.log('Alerts arrive at the next 10-minute cycle — or ask “@AuditDelta run a change check now” to see them immediately.');
} catch (error) {
  console.error(`\n✖ ${error.message}`);
  process.exit(1);
}
