import path from 'path';
import fs from 'fs';

export const REPORTS_DIR = path.join('/tmp', 'auditdelta-reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
