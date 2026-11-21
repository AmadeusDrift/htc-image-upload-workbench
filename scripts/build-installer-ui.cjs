const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates', 'nsis');
const output = path.join(root, 'build', 'setup-view');
const source = path.join(root, 'installer');

function customizeTemplates() {
  const read = name => fs.readFileSync(path.join(templates, name), 'utf8').replace(/\r\n/g, '\n');
  const section = read('installSection.nsh');
  const extraction = read('include/extractAppPackage.nsh');
  // electron-builder exposes no hook around the one-click banner or the archive callback.
  // Keep its one-click, app-in-use, rollback, shortcut and silent-install logic verbatim.
  const bannerStart = '    !ifdef HEADER_ICO\n      SpiderBanner::Show';
  const bannerEnd = '    StrCpy $1 $hwndparent';
  const start = section.indexOf(bannerStart);
  const end = section.indexOf(bannerEnd, start);
  const extract = 'Nsis7z::Extract "${FILE}"';
  if (start < 0 || end < 0 || extraction.split(extract).length !== 3) {
    throw new Error('The installed NSIS templates changed. Check the one-click banner and both extraction paths before building.');
  }
  const customSection = section.slice(0, start) + '    HideWindow\n' + section.slice(end);
  if (customSection.includes('SpiderBanner::')) throw new Error('An unhandled one-click banner remains.');
  return {
    'installSection.nsh': customSection,
    'extractAppPackage.nsh': extraction.replaceAll(extract, '!insertmacro YuntuExtract "${FILE}"'),
  };
}

function prepare() {
  if (process.platform !== 'win32') throw new Error('Build the Windows installation view on Windows.');
  const generated = customizeTemplates();
  fs.mkdirSync(output, { recursive: true });
  for (const [name, text] of Object.entries(generated)) fs.writeFileSync(path.join(output, name), text);
  const framework = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const args = [
    '/nologo', '/noconfig', '/codepage:65001', '/utf8output', '/optimize+', '/platform:x64', '/target:winexe',
    ...['System', 'System.Core', 'System.Xml', 'System.Xaml'].map(lib => '/reference:' + path.join(framework, lib + '.dll')),
    ...['WindowsBase', 'PresentationCore', 'PresentationFramework'].map(lib => '/reference:' + path.join(framework, 'WPF', lib + '.dll')),
    '/reference:' + path.join(framework, 'System.Drawing.dll'),
    '/resource:' + path.join(source, 'ProgressWindow.xaml') + ',Yuntu.Setup.ProgressWindow.xaml',
    '/resource:' + path.join(root, 'assets', 'app.png') + ',Yuntu.Setup.Brand.png',
    '/win32manifest:' + path.join(source, 'ProgressWindow.manifest'),
    '/win32icon:' + path.join(root, 'assets', 'app.ico'),
    '/out:' + path.join(output, 'YuntuSetupView.exe'),
    path.join(source, 'ProgressWindow.cs'),
  ];
  const result = spawnSync(path.join(framework, 'csc.exe'), args, { cwd: source, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Failed to build the installation view.');
}

module.exports = { customizeTemplates, prepare };
if (require.main === module) prepare();
