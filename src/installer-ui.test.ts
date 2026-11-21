import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const config = require('../package.json').build.nsis;
const { customizeTemplates } = require('../scripts/build-installer-ui.cjs');
const hooks = readFileSync(config.include, 'utf8');

describe('Windows installation view', () => {
  it('replaces the one-click banner on the regular installer path', () => {
    expect(config.oneClick).toBe(true);
    const section = customizeTemplates()['installSection.nsh'];
    expect(section).not.toContain('SpiderBanner::');
    for (const step of ['CHECK_APP_RUNNING', 'uninstallOldVersion SHELL_CONTEXT', 'installApplicationFiles', 'registryAddInstallInfo', 'addDesktopLink', 'customInstall', 'doStartApp']) {
      expect(section).toContain('!insertmacro ' + step);
    }
  });

  it('reports real extraction progress on the primary and retry paths and keeps silent installs headless', () => {
    const extract = customizeTemplates()['extractAppPackage.nsh'];
    expect(extract.match(/!insertmacro YuntuExtract/g)).toHaveLength(2);
    expect(extract).toContain('CopyFiles /SILENT');
    expect(hooks).toMatch(/Function YuntuOpenInstallView\s+IfSilent done/);
    expect(hooks).toMatch(/!macro YuntuExtract archive\s+\$\{If\} \$\{Silent\}\s+Nsis7z::Extract "/);
    expect(hooks).toMatch(/GetFunctionAddress \$R9 YuntuReportExtraction\s+Nsis7z::ExtractWithCallback/);
    expect(hooks).not.toContain('SetSilent');
  });
});
