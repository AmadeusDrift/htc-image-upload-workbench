const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

if (process.platform !== 'win32') throw new Error('ShellPicker must be built on Windows.');
const root = resolve(__dirname, '..');
const compiler = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const folder = join(root, 'electron', 'native-picker');
const sources = ['ShellInterop.cs', 'FolderBrowser.cs', 'PickerControls.cs', 'PickerCrumbs.cs', 'PreviewPane.cs', 'PickerWindow.cs', 'Program.cs'];

// The in-box .NET Framework compiler predates /deterministic. With debug symbols
// disabled it varies the COFF timestamp and the sole GUID in the CLI metadata (MVID).
function normalizeBuild(image) {
  const pe = image.readUInt32LE(0x3c);
  const metadata = image.indexOf(Buffer.from('BSJB\x01\0\x01\0', 'latin1'));
  const guidEntry = image.indexOf(Buffer.from('#GUID\0'), metadata);
  if (image.toString('ascii', pe, pe + 4) !== 'PE\0\0' || metadata < 0 || guidEntry < metadata + 8 ||
      guidEntry > metadata + 256 || image.readUInt32LE(guidEntry - 4) !== 16) {
    throw new Error('Unexpected ShellPicker PE/metadata format.');
  }
  const guid = metadata + image.readUInt32LE(guidEntry - 8);
  if (guid + 16 > image.length) throw new Error('Invalid ShellPicker GUID stream.');
  image.writeUInt32LE(0, pe + 8);
  image.fill(0, guid, guid + 16);
  const hash = createHash('sha256').update(image).digest();
  hash.copy(image, guid, 0, 16);
  return image;
}

const tempFolder = fs.mkdtempSync(join(tmpdir(), 'yuntu-picker-build-'));
const compiled = join(tempFolder, 'ShellPicker.exe');
const target = join(folder, 'ShellPicker.exe');
try {
  const result = spawnSync(compiler, [
    '/nologo', '/noconfig', '/codepage:65001', '/utf8output', '/optimize+', '/platform:x64', '/target:winexe',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    '/reference:System.Xml.dll', '/reference:System.Runtime.Serialization.dll', '/win32manifest:ShellPicker.manifest',
    `/win32icon:${join(root, 'assets', 'app.ico')}`, `/out:${compiled}`, ...sources,
  ], { cwd: folder, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ShellPicker compilation failed (${result.status}).`);
  const binary = normalizeBuild(fs.readFileSync(compiled));
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(binary)) {
    const staging = `${target}.${process.pid}.tmp`;
    try { fs.writeFileSync(staging, binary, { flag: 'wx' }); fs.renameSync(staging, target); }
    finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
  }
} finally {
  if (fs.existsSync(compiled)) fs.unlinkSync(compiled);
  fs.rmdirSync(tempFolder);
}
