import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-update-test-'));
process.env.MASTER_CODE_CONFIG_DIR = dir;
