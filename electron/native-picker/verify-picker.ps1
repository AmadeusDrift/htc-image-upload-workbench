param([string]$Picker = (Join-Path $PSScriptRoot 'ShellPicker.exe'), [string]$Snapshot, [string]$FolderSnapshot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
public static class PickerCheck {
    public static int ScreenFrames, WindowFrames;
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
    [DllImport("user32", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder caption, int capacity);
    [DllImport("dwmapi")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi")] static extern int DwmFlush();
    [DllImport("user32")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32")] static extern IntPtr WindowFromPoint(Point pt);
    [DllImport("user32")] static extern IntPtr GetAncestor(IntPtr hwnd, uint ancestor);
    [DllImport("user32")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("kernel32")] static extern uint GetCurrentThreadId();
    [DllImport("user32")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32")] static extern IntPtr SetActiveWindow(IntPtr hwnd);
    [DllImport("user32")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32")] static extern int GetPixel(IntPtr dc, int x, int y);
    struct RectangleEdges { public int x, y, right, bottom; }
    struct GuiThreadInfo { public int size, flags; public IntPtr active, focus, capture, menu, move, caret; public RectangleEdges caretBounds; }
    public static IntPtr WindowFor(int pid) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            uint id; GetWindowThreadProcessId(hwnd, out id);
            if (id != pid || !IsWindowVisible(hwnd)) return true;
            result = hwnd; return false;
        }, IntPtr.Zero);
        return result;
    }
    public static string FirstPresentation(int pid, IntPtr owner) {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 10000) {
            System.Windows.Forms.Application.DoEvents(); // Service the picker's synchronous modal-owner messages.
            var hwnd = WindowFor(pid);
            int cloak;
            if (hwnd != IntPtr.Zero && GetWindow(hwnd, 4) == owner &&
                DwmGetWindowAttribute(hwnd, 14, out cloak, sizeof(int)) == 0 && cloak == 0) {
                bool content = false, title = false, action = false;
                RectangleEdges picker; GetWindowRect(hwnd, out picker);
                EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused) {
                    if (!IsWindowVisible(child)) return true;
                    var name = new StringBuilder(128); GetClassName(child, name, name.Capacity);
                    var caption = new StringBuilder(64); GetWindowText(child, caption, caption.Capacity);
                    string text = caption.ToString();
                    RectangleEdges bounds; GetWindowRect(child, out bounds);
                    if ((name.ToString() == "SHELLDLL_DefView" || text == "正在打开文件夹…") &&
                        bounds.bottom - bounds.y > (picker.bottom - picker.y) / 4) content = true;
                    if (text == "选择图片" || text == "选择文件夹") title = true;
                    if (text == "取消") action = true;
                    return true;
                }, IntPtr.Zero);
                return title && action && content ? FirstChromeColors(hwnd, picker) : String.Format("title={0}, cancel={1}, folder view or loading surface={2}", title, action, content);
            }
            System.Threading.Thread.Sleep(1);
        }
        return "no presented picker";
    }
    static string FirstChromeColors(IntPtr hwnd, RectangleEdges r) {
        double scale = GetDpiForWindow(hwnd) / 96.0;
        int middle = (r.x + r.right) / 2;
        Point[] points = { new Point(middle, r.y + (int)(13 * scale)), new Point(r.x + (int)(5 * scale), (r.y + r.bottom) / 2), new Point(middle, r.bottom - (int)(13 * scale)) };
        Color[] colors = { Color.FromArgb(241,246,253), Color.FromArgb(246,249,254), Color.FromArgb(249,251,255) };
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 2000) {
            System.Windows.Forms.Application.DoEvents(); DwmFlush();
            // A background test must not sample an unrelated app or take the user's focus.
            if (GetForegroundWindow() != hwnd || Array.Exists(points, p => GetAncestor(WindowFromPoint(p), 2) != hwnd)) {
                using (var bitmap = new Bitmap(r.right - r.x, r.bottom - r.y)) {
                    using (var graphics = Graphics.FromImage(bitmap)) {
                        var surface = graphics.GetHdc();
                        try { if (!PrintWindow(hwnd, surface, 2)) return "could not capture the picker window"; }
                        finally { graphics.ReleaseHdc(surface); }
                    }
                    for (int i = 0; i < points.Length; i++) {
                        var actual = bitmap.GetPixel(points[i].X - r.x, points[i].Y - r.y);
                        if (!Matches(actual, colors[i])) return String.Format("window capture region {0}: {1} instead of {2}", i, actual, colors[i]);
                    }
                    WindowFrames++; return "ready";
                }
            }
            int matches = 0; var dc = GetDC(IntPtr.Zero);
            try {
                for (int i = 0; i < points.Length; i++) {
                    var pixel = ColorTranslator.FromWin32(GetPixel(dc, points[i].X, points[i].Y));
                    if (Matches(pixel, colors[i])) matches++;
                }
            } finally { ReleaseDC(IntPtr.Zero, dc); }
            if (matches == 3) { ScreenFrames++; return "ready"; }
            if (matches > 0) return "partial first painted frame (themed regions: " + matches + "/3)";
        }
        return "could not observe a foreground themed frame";
    }
    static bool Matches(Color a, Color b) { return Math.Abs(a.R-b.R) + Math.Abs(a.G-b.G) + Math.Abs(a.B-b.B) <= 4; }
    public static bool InViewport(IntPtr child, IntPtr picker) {
        RectangleEdges row; GetWindowRect(child, out row);
        for (var parent = GetParent(child); parent != IntPtr.Zero; parent = GetParent(parent)) {
            RectangleEdges clip; GetWindowRect(parent, out clip);
            if (row.y < clip.y || row.bottom > clip.bottom) return false;
            if (parent == picker) return true;
        }
        return false;
    }
    public static string TabToDrive(IntPtr picker, IntPtr editor, IntPtr target) {
        if (!IsChild(picker, editor) || !IsChild(picker, target)) return "missing picker control";
        uint pid; uint thread = GetWindowThreadProcessId(picker, out pid);
        uint ownThread = GetCurrentThreadId();
        // Join only this fixture and its picker. Background windows have no physical keyboard focus.
        if (!AttachThreadInput(ownThread, thread, true)) return "could not share fixture input";
        try {
            SetActiveWindow(picker); SetFocus(editor);
            return FollowTabs(picker, thread, target);
        } finally { AttachThreadInput(ownThread, thread, false); }
    }
    static string FollowTabs(IntPtr picker, uint thread, IntPtr target) {
        var info = new GuiThreadInfo { size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        IntPtr last = IntPtr.Zero;
        var trace = new StringBuilder();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 3000) {
            System.Windows.Forms.Application.DoEvents();
            if (!GetGUIThreadInfo(thread, ref info)) return "unavailable picker input thread";
            if (info.focus == target) {
                if (!InViewport(target, picker)) return "focused drive still clipped";
                PostMessage(target, 0x100, (IntPtr)32, (IntPtr)1);
                PostMessage(target, 0x101, (IntPtr)32, (IntPtr)1);
                return "focused";
            }
            if (info.focus != last && (info.focus == picker || IsChild(picker, info.focus))) {
                var name = new StringBuilder(64); GetClassName(info.focus, name, name.Capacity);
                if (trace.Length < 700) trace.Append(name.ToString().Split('.')[0]).Append(' ');
                PostMessage(info.focus, 0x100, (IntPtr)9, (IntPtr)1);
                PostMessage(info.focus, 0x101, (IntPtr)9, (IntPtr)1);
                last = info.focus;
            }
            System.Threading.Thread.Sleep(1);
        }
        return String.Format("foreground={0}, focus={1}, order={2}", GetForegroundWindow() == picker, info.focus != IntPtr.Zero, trace);
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
    $names = if ($script:window -and !$script:checkingDrives) { $script:window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition) | ForEach-Object { if ($_.Current.Name) { $_.Current.Name } } }
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
    $firstSurface = [PickerCheck]::FirstPresentation($script:child.Id, $ownerHwnd)
    if ($firstSurface -ne 'ready') { throw "Incomplete first visible $mode picker surface ($firstSurface)." }
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
function Check-Drives($mode) {
    $script:checkingDrives = $true
    try {
        $roots = [Environment]::GetLogicalDrives()
        # Exercise local volumes without waking removable media or reconnecting network drives.
        $testRoots = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | Select-Object -ExpandProperty Name -First 2)
        foreach ($root in $roots) {
            $label = $root.TrimEnd('\')
            [void](Await "sidebar drive $label" { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $label })
        }
        foreach ($root in $testRoots) {
            $button = Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $root.TrimEnd('\')
            if ($button.Current.ControlType -ne [Windows.Automation.ControlType]::Button -and $button.Current.ClassName -notmatch '\.BUTTON\.') { throw "Expected a drive button for $root" }
            Invoke-Element $button
            [void](Await "navigation to $root" { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $root })
        }
        for ($i = $testRoots.Count - 1; $i -ge 0; --$i) {
            $target = if ($i -gt 0) { $testRoots[$i - 1] } else { $fixture }
            Invoke-Element (Element 'back')
            [void](Await "back to $target" { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $target })
        }
        if ($testRoots.Count) {
            $size = $script:window.Current.BoundingRectangle
            $resize = $script:window.GetCurrentPattern([Windows.Automation.TransformPattern]::Pattern)
            $resize.Resize($size.Width, $size.Height / 2)
            $target = $testRoots[-1]
            $button = Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $target.TrimEnd('\')
            $keyTarget = [IntPtr]$button.Current.NativeWindowHandle
            $edit = [PickerCheck]::SearchEdit($script:hwnd)
            $tabResult = [PickerCheck]::TabToDrive($script:hwnd,$edit,$keyTarget)
            if ($tabResult -ne 'focused') { throw "Tab could not reach $target ($tabResult)" }
            [void](Await 'keyboard drive activation' { Find-Element ([Windows.Automation.AutomationElement]::NameProperty) $target })
            $resize.Resize($size.Width, $size.Height)
            Invoke-Element (Element 'back'); [void](Item 'Folder A')
        }
        "PASS $mode sidebar enumerated $($roots -join ', '), opened $($testRoots -join ', '), supported the keyboard in a short window and returned to the fixture"
    } finally { $script:checkingDrives = $false }
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
    Check-Drives 'files'
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
    Check-Drives 'folders'
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
    "PASS first visible picker surfaces with completed chrome ($([PickerCheck]::ScreenFrames) foreground frames, $([PickerCheck]::WindowFrames) window-only captures)"
} finally {
    if ($script:child) { if (!$script:child.HasExited) { $script:child.Kill(); $script:child.WaitForExit() }; Write-Host $script:child.StandardError.ReadToEnd(); $script:child.Dispose() }
    $ownerForm.Dispose()
    $absoluteFixture = [IO.Path]::GetFullPath($fixture)
    if ([IO.Path]::GetDirectoryName($absoluteFixture) -eq $tempBase -and [IO.Path]::GetFileName($absoluteFixture) -match '^yuntu-picker-check-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $absoluteFixture)) {
        Remove-Item -LiteralPath $absoluteFixture -Recurse -Force
    }
}
