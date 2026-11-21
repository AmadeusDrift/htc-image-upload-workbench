param([string]$Picker = (Join-Path $PSScriptRoot 'ShellPicker.exe'), [string]$Snapshot, [string]$FolderSnapshot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerCheck {
    public delegate bool WindowCallback(IntPtr hwnd, IntPtr unused);
    [DllImport("user32")] static extern bool EnumWindows(WindowCallback callback, IntPtr unused);
    [DllImport("user32")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr unused);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int capacity);
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wp, string text);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32")] static extern bool PrintWindow(IntPtr window, IntPtr hdc, uint flags);
    [DllImport("user32")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32")] static extern bool GetWindowRect(IntPtr window, out RectangleEdges rect);
    struct RectangleEdges { public int x, y, right, bottom; }
    public static IntPtr WindowFor(int pid) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            uint id; GetWindowThreadProcessId(hwnd, out id);
            if (id != pid || !IsWindowVisible(hwnd)) return true;
            result = hwnd; return false;
        }, IntPtr.Zero);
        return result;
    }
    public static IntPtr SearchEdit(IntPtr window) {
        RectangleEdges owner; GetWindowRect(window, out owner);
        int rightmost = -1; IntPtr result = IntPtr.Zero;
        EnumChildWindows(window, delegate(IntPtr hwnd, IntPtr unused) {
            var name = new StringBuilder(128); GetClassName(hwnd, name, name.Capacity);
            if (!name.ToString().Contains(".EDIT.")) return true;
            RectangleEdges bounds; GetWindowRect(hwnd, out bounds);
            if (bounds.y > owner.y + (owner.bottom - owner.y) / 4) return true;
            if (bounds.x > rightmost) { rightmost = bounds.x; result = hwnd; }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static void SetText(IntPtr hwnd, string text) { SendMessage(hwnd, 0xC, IntPtr.Zero, text); }
    public static IntPtr FilenameEdit(IntPtr window) {
        RectangleEdges owner; GetWindowRect(window, out owner);
        IntPtr result=IntPtr.Zero;
        EnumChildWindows(window, delegate(IntPtr hwnd,IntPtr unused) {
            var name=new StringBuilder(128); GetClassName(hwnd,name,name.Capacity);
            RectangleEdges bounds; GetWindowRect(hwnd,out bounds);
            if (name.ToString().Contains(".EDIT.") && bounds.y > owner.y+(owner.bottom-owner.y)*2/3) {result=hwnd;return false;}
            return true;
        },IntPtr.Zero);
        return result;
    }
    public static bool HasThumbnails(IntPtr hwnd, string saveAs) {
        RectangleEdges rect; GetWindowRect(hwnd, out rect);
        using (var image = new Bitmap(rect.right - rect.x, rect.bottom - rect.y)) {
            if (!String.IsNullOrEmpty(saveAs)) {
                if (GetForegroundWindow() != hwnd) { SetForegroundWindow(hwnd); return false; }
                using (var screen = Graphics.FromImage(image)) screen.CopyFromScreen(rect.x, rect.y, 0, 0, image.Size);
                if (GetForegroundWindow() != hwnd) return false;
                image.Save(saveAs, System.Drawing.Imaging.ImageFormat.Png);
                return true;
            }
            using (var graphics = Graphics.FromImage(image)) {
                var hdc = graphics.GetHdc();
                try { if (!PrintWindow(hwnd, hdc, 2)) return false; }
                finally { graphics.ReleaseHdc(hdc); }
            }
            int pink = 0, green = 0;
            for (int y = 0; y < image.Height; y += 4)
                for (int x = 0; x < image.Width; x += 4) {
                    var color = image.GetPixel(x, y);
                    if (Math.Abs(color.R - 238) + Math.Abs(color.G - 48) + Math.Abs(color.B - 99) < 15) pink++;
                    if (Math.Abs(color.R - 44) + Math.Abs(color.G - 200) + Math.Abs(color.B - 123) < 15) green++;
                }
            if (pink <= 12 || green <= 12) return false;
            return true;
        }
    }
}
'@

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixture = Join-Path $tempBase ('yuntu-picker-check-' + [Guid]::NewGuid().ToString('N'))
$ownerForm = New-Object Windows.Forms.Form
$ownerHwnd = $ownerForm.Handle
$script:child = $null
$script:window = $null
$script:hwnd = [IntPtr]::Zero

function Await($what, [scriptblock]$probe) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        [Windows.Forms.Application]::DoEvents()
        if ($script:child -and $script:child.HasExited) { throw "Picker exited during $what. $($script:child.StandardError.ReadToEnd())" }
        $value = & $probe
        if ($value) { return $value }
        Start-Sleep -Milliseconds 90
    } while ($watch.Elapsed.TotalSeconds -lt 10)
    $names = if ($script:window) { $script:window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { if ($_.Current.Name) { $_.Current.Name } } }
    throw "Timed out waiting for $what. Visible elements: $($names -join ', ')"
}
function Start-Picker($mode, $startFolder = $fixture) {
    $script:modeName = if ($mode -eq 'files') { '打开' } else { '选择文件夹' }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Picker
    $start.Arguments = "$mode $($ownerHwnd.ToInt64()) `"$startFolder`""
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8; $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $script:child = [Diagnostics.Process]::Start($start)
    $script:hwnd = Await 'owned picker window' { $candidate = [PickerCheck]::WindowFor($script:child.Id); if ($candidate -ne [IntPtr]::Zero) { $candidate } }
    $script:window = [Windows.Automation.AutomationElement]::FromHandle($script:hwnd)
    if ([PickerCheck]::GetWindow($script:hwnd, 4) -ne $ownerHwnd -or [PickerCheck]::IsWindowEnabled($ownerHwnd)) { throw 'Picker did not own its modal relationship.' }
}
function Find-Element($property, $value) {
    $condition = New-Object Windows.Automation.PropertyCondition($property, $value)
    return $script:window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}
function Element($id) {
    $label = @{back='后退'; forward='前进'; up='上一级'; confirm=$script:modeName; cancel='取消'; thumbnails='缩略图'; details='详细信息'; previewToggle='预览'}[$id]
    Await $id {
        $item = Find-Element ([Windows.Automation.AutomationElement]::AutomationIdProperty) $id
        if (!$item) {
            $byName = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$label)
            $item = $script:window.FindAll([Windows.Automation.TreeScope]::Descendants,$byName) | Where-Object {
                $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -or $_.Current.ClassName -match '\.BUTTON\.'
            } | Select-Object -First 1
        }
        if ($item -and $item.Current.IsEnabled) { $item }
    }
}
function Item($name) {
    # Explorer can show or hide extensions independently of the selected file's parsing name.
    Await $name {
        $item = Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $name
        if (!$item) { $item = Find-Element ([Windows.Automation.AutomationElement]::NameProperty) ([IO.Path]::GetFileNameWithoutExtension($name)) }
        $item
    }
}
function Invoke-Element($element) {
    $invoke = $null
    if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke(); return }
    # Classic owner-drawn WinForms buttons can expose only a native HWND through UIA.
    if ($element.Current.NativeWindowHandle) { [void][PickerCheck]::PostMessage([IntPtr]$element.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero); return }
    throw "No native action for $($element.Current.Name)"
}
function Choose($name, $add = $false) {
    $selection = (Item $name).GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($add) { $selection.AddToSelection() } else { $selection.Select() }
}
function Finish($expected) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (!$script:child.HasExited -and $watch.Elapsed.TotalSeconds -lt 10) { [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 60 }
    if (!$script:child.HasExited) {
        $labels=$script:window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | ForEach-Object {if ($_.Current.Name) {$_.Current.Name}}
        if ($Snapshot) { [void][PickerCheck]::HasThumbnails($script:hwnd,[IO.Path]::Combine([IO.Path]::GetDirectoryName($Snapshot),'picker-check-failure.png')) }
        throw "Picker did not return. Visible elements: $($labels -join ', ')"
    }
    $json = $script:child.StandardOutput.ReadToEnd()
    $errorOutput = $script:child.StandardError.ReadToEnd()
    if ($script:child.ExitCode -ne 0 -or $errorOutput) { throw "Unexpected picker error: $errorOutput" }
    [string[]]$paths = ConvertFrom-Json -InputObject $json
    if ($paths.Count -ne $expected.Count -or ($expected.Count -and (Compare-Object @($expected | Sort-Object) @($paths | Sort-Object)))) { throw "Expected $($expected.Count) paths, got $($paths.Count): $json" }
    if (![PickerCheck]::IsWindowEnabled($ownerHwnd)) { throw 'Picker left its owner disabled.' }
    $script:child.Dispose(); $script:child = $null
}
function Photo($name, $color) {
    $bitmap = New-Object Drawing.Bitmap(120, 100)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear($color)
        $bitmap.Save((Join-Path $fixture $name), [Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
    [void][IO.Directory]::CreateDirectory($fixture)
    $firstFolder = Join-Path $fixture 'Folder A'; $secondFolder = Join-Path $fixture 'Folder B'
    [void][IO.Directory]::CreateDirectory($firstFolder); [void][IO.Directory]::CreateDirectory($secondFolder)
    $first = 'Photo ' + [char]0x6843 + '.png'; $second = 'Other.PNG'
    Photo $first ([Drawing.Color]::FromArgb(238, 48, 99))
    Photo $second ([Drawing.Color]::FromArgb(44, 200, 123))
    [IO.File]::WriteAllText((Join-Path $fixture 'Unsupported.txt'), 'fixture')

    Start-Picker 'files'
    [void](Item $first); [void](Item $second)
    if ((Find-Element ([Windows.Automation.AutomationElement]::NameProperty) 'Unsupported.txt') -or (Find-Element ([Windows.Automation.AutomationElement]::NameProperty) 'Unsupported')) { throw 'File filter included a text file.' }
    [void](Await 'native photo thumbnails' { [PickerCheck]::HasThumbnails($script:hwnd, $null) })
    $searchEdit = [PickerCheck]::SearchEdit($script:hwnd)
    if ($searchEdit -eq [IntPtr]::Zero) { throw 'Missing search edit.' }
    [PickerCheck]::SetText($searchEdit, 'Other')
    [void](Await 'native search filter' { (Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $second) -and !(Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $first) })
    [PickerCheck]::SetText($searchEdit, ''); [void](Item $first)
    Choose $first; Choose $second $true
    Invoke-Element (Element 'confirm')
    Finish @((Join-Path $fixture $first), (Join-Path $fixture $second))
    'PASS native thumbnails, image filter, search, Unicode paths and multi-selection'

    Start-Picker 'folders'
    [void](Item 'Folder A')
    if ((Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $second) -or (Find-Element ([Windows.Automation.AutomationElement]::NameProperty) 'Other')) { throw 'Folder filter included an image.' }
    Invoke-Element (Item 'Folder A')
    [void](Await 'folder navigation' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $firstFolder })
    Invoke-Element (Element 'back'); [void](Item 'Folder A')
    Invoke-Element (Element 'forward'); [void](Await 'forward navigation' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $firstFolder })
    Invoke-Element (Element 'up'); [void](Item 'Folder B')
    Choose 'Folder A'; Choose 'Folder B' $true; Invoke-Element (Element 'confirm')
    Finish @($firstFolder, $secondFolder)
    'PASS folder filter, navigation history, up and multi-folder selection'

    Start-Picker 'folders'; [void](Item 'Folder A'); Invoke-Element (Element 'confirm'); Finish @($fixture)
    Start-Picker 'files'; Invoke-Element (Item $first); Finish @((Join-Path $fixture $first))
    Start-Picker 'files'; [void](Item $first)
    Invoke-Element (Element 'details')
    [void](Await 'detail columns' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) '名称' })
    Invoke-Element (Element 'thumbnails')
    Invoke-Element (Element 'previewToggle')
    [void](Await 'closed preview pane' { !(Find-Element ([Windows.Automation.AutomationElement]::NameProperty) '图片预览') })
    Invoke-Element (Element 'previewToggle'); Choose $first
    [void](Await 'real selected image preview' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) 'PNG 图片' })
    $nameEdit = [PickerCheck]::FilenameEdit($script:hwnd)
    if ($nameEdit -eq [IntPtr]::Zero) { throw 'Missing file name editor' }
    [PickerCheck]::SetText($nameEdit,$second)
    [void][PickerCheck]::PostMessage($nameEdit,0x100,[IntPtr]13,[IntPtr]1)
    Finish @((Join-Path $fixture $second))
    'PASS filename entry, preview pane, thumbnail and detail view switching'
    Start-Picker 'files'; [void](Item $first)
    [void][PickerCheck]::PostMessage($script:hwnd, 0x100, [IntPtr]27, [IntPtr]1); Finish @()
    'PASS current folder, default image activation, Escape, UTF-8 protocol and modal ownership'
    if ($Snapshot -or $FolderSnapshot) {
        $gallery = Join-Path $fixture '素材库\夏季拍摄\场景参考'
        $folders = @('补充素材','已入选')
        foreach ($name in $folders) { [void][IO.Directory]::CreateDirectory((Join-Path $gallery $name)) }
        $samples = @('ThemeC\img28.jpg','ThemeC\img29.jpg','ThemeC\img30.jpg','ThemeC\img31.jpg','ThemeD\img34.jpg','ThemeD\img33.jpg')
        for ($i = 0; $i -lt $samples.Length; ++$i) {
            $photoPath = Join-Path $env:WINDIR ('Web\Wallpaper\' + $samples[$i])
            $destination = Join-Path $gallery ('场景 {0:00}.jpg' -f ($i+1))
            if (Test-Path -LiteralPath $photoPath -PathType Leaf) { Copy-Item -LiteralPath $photoPath -Destination $destination }
            else { Copy-Item -LiteralPath (Join-Path $fixture $first) -Destination $destination }
        }
        if ($Snapshot) {
            Start-Picker 'files' $gallery
            Choose '场景 01.jpg'; [void](Item '场景 06.jpg')
            [void](Await 'selected image metadata' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) 'JPEG 图片' })
            Start-Sleep -Milliseconds 450
            [void](Await 'file window screenshot' { [PickerCheck]::HasThumbnails($script:hwnd,$Snapshot) })
            Invoke-Element (Element 'confirm'); Finish @((Join-Path $gallery '场景 01.jpg'))
        }
        if ($FolderSnapshot) {
            Start-Picker 'folders' $gallery
            Choose $folders[0]
            Start-Sleep -Milliseconds 200
            [void](Await 'folder window screenshot' { [PickerCheck]::HasThumbnails($script:hwnd,$FolderSnapshot) })
            Invoke-Element (Element 'confirm'); Finish @((Join-Path $gallery $folders[0]))
        }
    }
} finally {
    if ($script:child) { if (!$script:child.HasExited) { $script:child.Kill(); $script:child.WaitForExit() }; Write-Host $script:child.StandardError.ReadToEnd(); $script:child.Dispose() }
    $ownerForm.Dispose()
    $absoluteFixture = [IO.Path]::GetFullPath($fixture)
    if ([IO.Path]::GetDirectoryName($absoluteFixture) -eq $tempBase -and [IO.Path]::GetFileName($absoluteFixture) -match '^yuntu-picker-check-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $absoluteFixture)) {
        Remove-Item -LiteralPath $absoluteFixture -Recurse -Force
    }
}
