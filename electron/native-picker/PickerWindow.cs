using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    internal sealed class OwnerWindow : IWin32Window
    {
        public IntPtr Handle { get; private set; }
        readonly uint processId;
        internal OwnerWindow(IntPtr handle)
        {
            Handle = handle;
            Native.GetWindowThreadProcessId(handle, out processId);
        }
        internal bool Alive()
        {
            uint current;
            return Native.IsWindow(Handle) && Native.GetWindowThreadProcessId(Handle, out current) != 0 && current == processId;
        }
    }

    internal sealed class PickerWindow : Form, IMessageFilter
    {
        static readonly Color Ink = Color.FromArgb(23, 48, 82), Muted = Color.FromArgb(87, 106, 132),
            Line = Color.FromArgb(216, 228, 243), Mist = Color.FromArgb(246, 249, 254);
        readonly bool folders;
        readonly string initial, pictures;
        readonly OwnerWindow owner;
        readonly float scale;
        readonly Panel host = new Panel();
        readonly TextBox address = new TextBox(), search = new TextBox(), filename = new TextBox();
        readonly PickerButton back, forward, up, confirm, thumbnails, details, previewToggle;
        readonly PickerCrumbs crumbs;
        readonly TableLayoutPanel body, driveList;
        readonly Label driveHeading, loading;
        readonly PreviewPane preview;
        readonly Label status = new Label();
        readonly ToolTip tips = new ToolTip();
        readonly Timer searchDelay = new Timer { Interval = 250 }, ownerCheck = new Timer { Interval = 600 };
        readonly List<string> history = new List<string>();
        readonly List<PickerButton> places = new List<PickerButton>();
        readonly PickerButton[] driveButtons = new PickerButton[26];
        uint driveMask;
        int historyIndex = -1, requestedIndex = -1, locationRequest;
        bool navigating, resolving, accepting, settingFilename, typedName, wantsPreview, presented, cloaked;
        FolderBrowser browser;
        internal string[] Paths { get; private set; }
        internal Exception Failure { get; private set; }

        internal PickerWindow(bool folders, OwnerWindow owner, string initial)
        {
            this.folders = folders;
            this.owner = owner;
            this.initial = initial;
            wantsPreview = !folders;
            Paths = new string[0];
            using (var graphics = Graphics.FromHwnd(IntPtr.Zero)) scale = graphics.DpiX / 96f;
            Text = folders ? "选择文件夹" : "选择图片";
            Font = new Font("Microsoft YaHei UI", 9.25f);
            ForeColor = Ink;
            BackColor = Line;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = owner == null;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            var area = owner == null ? Screen.PrimaryScreen.WorkingArea : Screen.FromHandle(owner.Handle).WorkingArea;
            Size = new Size(Math.Min(Px(940), area.Width), Math.Min(Px(568), area.Height));
            MinimumSize = new Size(Math.Min(Px(635), area.Width), Math.Min(Px(350), area.Height));
            var center = area;
            NativeRect ownerBounds;
            if (owner != null && Native.GetWindowRect(owner.Handle, out ownerBounds)) center = Rectangle.FromLTRB(ownerBounds.Left, ownerBounds.Top, ownerBounds.Right, ownerBounds.Bottom);
            Location = new Point(Math.Max(area.Left, Math.Min(area.Right - Width, center.Left + (center.Width - Width) / 2)),
                Math.Max(area.Top, Math.Min(area.Bottom - Height, center.Top + (center.Height - Height) / 2)));

            Padding = new Padding(1);
            var layout = Grid(1, 6);
            layout.BackColor = Color.White;
            layout.RowStyles.Add(Absolute(32));
            layout.RowStyles.Add(Absolute(50));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
            layout.RowStyles.Add(Absolute(86));
            Controls.Add(layout);
            layout.Controls.Add(Rule(), 0, 2);
            layout.Controls.Add(Rule(), 0, 4);

            var header = Grid(3, 1);
            header.BackColor = Color.FromArgb(241, 246, 253);
            header.Padding = new Padding(Px(12), 0, Px(5), 0);
            header.ColumnStyles.Add(Fixed(27)); header.ColumnStyles.Add(Flex()); header.ColumnStyles.Add(Fixed(34));
            var mark = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, AccessibleRole = AccessibleRole.Graphic };
            mark.Paint += delegate(object sender, PaintEventArgs e) {
                PickerPaint.Icon(e.Graphics, PickerGlyph.Cloud, new Rectangle(Px(1), (mark.Height - Px(18)) / 2, Px(18), Px(18)), Color.FromArgb(46, 100, 225));
            };
            var title = new Label { Dock = DockStyle.Fill, Margin = Padding.Empty, Text = Text, TextAlign = ContentAlignment.MiddleLeft,
                Font = new Font(Font.FontFamily, 10f, FontStyle.Bold) };
            var close = Button("", "关闭", PickerGlyph.Close, ButtonStyle.Close, Close);
            close.Margin = new Padding(0, Px(2), 0, Px(2));
            header.Controls.Add(mark, 0, 0); header.Controls.Add(title, 1, 0); header.Controls.Add(close, 2, 0);
            foreach (Control drag in new Control[] { header, title, mark }) drag.MouseDown += DragHeader;
            layout.Controls.Add(header, 0, 0);

            var bar = Grid(8, 1);
            bar.Padding = new Padding(Px(9), Px(8), Px(12), Px(8));
            bar.BackColor = Color.White;
            bar.ColumnStyles.Add(Fixed(30)); bar.ColumnStyles.Add(Fixed(30)); bar.ColumnStyles.Add(Fixed(33));
            bar.ColumnStyles.Add(Flex()); bar.ColumnStyles.Add(Fixed(151)); bar.ColumnStyles.Add(Fixed(31));
            bar.ColumnStyles.Add(Fixed(31)); bar.ColumnStyles.Add(Fixed(folders ? 0 : 84));
            back = Button("", "后退", PickerGlyph.Back, ButtonStyle.Tool, delegate { Travel(-1); });
            forward = Button("", "前进", PickerGlyph.Forward, ButtonStyle.Tool, delegate { Travel(1); });
            up = Button("", "上一级", PickerGlyph.Up, ButtonStyle.Tool, GoUp);
            back.Name = "back"; forward.Name = "forward"; up.Name = "up";
            tips.SetToolTip(back, "后退 (Alt+←)"); tips.SetToolTip(forward, "前进 (Alt+→)"); tips.SetToolTip(up, "上一级 (Alt+↑)");
            bar.Controls.Add(back, 0, 0); bar.Controls.Add(forward, 1, 0); bar.Controls.Add(up, 2, 0);

            var location = new PickerField(address, PickerGlyph.Folder, "目录路径", "输入文件夹路径", scale);
            location.Margin = new Padding(Px(5), 0, Px(5), 0);
            crumbs = new PickerCrumbs(scale, delegate(string path) { Go(path, -1); }, EditAddress);
            location.Controls.Add(crumbs);
            location.Layout += delegate {
                var box = address.Bounds;
                crumbs.Bounds = new Rectangle(box.Left, Px(3), box.Width, Math.Max(0, location.ClientSize.Height - Px(6)));
            };
            address.GotFocus += delegate { crumbs.Visible = false; };
            address.LostFocus += delegate { ShowCrumbs(); };
            address.KeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; TypedAddress(); }
            };
            crumbs.BringToFront();
            tips.SetToolTip(crumbs, "点击路径可返回上级目录，按 Ctrl+L 编辑地址");
            bar.Controls.Add(location, 3, 0);
            var searchBox = new PickerField(search, PickerGlyph.Search, "搜索此文件夹", "搜索此文件夹", scale);
            searchBox.Margin = new Padding(Px(2), 0, Px(9), 0);
            address.Name = "address"; search.Name = "search";
            bar.Controls.Add(searchBox, 4, 0);
            search.TextChanged += delegate { searchDelay.Stop(); if (!navigating) searchDelay.Start(); };
            searchDelay.Tick += delegate { searchDelay.Stop(); Guard(delegate { browser.Search(search.Text.Trim()); }); };

            thumbnails = Button("", "缩略图", PickerGlyph.Grid, ButtonStyle.Segment, delegate { SetView(false); });
            details = Button("", "详细信息", PickerGlyph.List, ButtonStyle.Segment, delegate { SetView(true); });
            thumbnails.Name = "thumbnails"; details.Name = "details";
            thumbnails.Selected = !folders; details.Selected = folders;
            bar.Controls.Add(thumbnails, 5, 0); bar.Controls.Add(details, 6, 0);
            previewToggle = Button("预览", "预览窗格", PickerGlyph.Preview, ButtonStyle.Segment, delegate { wantsPreview = !wantsPreview; LayoutPreview(); });
            previewToggle.Name = "previewToggle"; previewToggle.Visible = !folders;
            previewToggle.Margin = new Padding(Px(6), 0, 0, 0);
            bar.Controls.Add(previewToggle, 7, 0);
            layout.Controls.Add(bar, 0, 1);

            body = Grid(5, 1);
            body.ColumnStyles.Add(Fixed(143)); body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 1));
            body.ColumnStyles.Add(Flex()); body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 1)); body.ColumnStyles.Add(Fixed(222));
            var sideScroll = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Mist, AutoScroll = true };
            var sidebar = SidebarRows();
            sidebar.Padding = new Padding(Px(8), Px(12), Px(8), Px(6));
            sideScroll.Controls.Add(sidebar);
            sidebar.Controls.Add(Section("位置", 0));
            Place(sidebar, "此电脑", Native.Computer, PickerGlyph.Computer);
            Place(sidebar, "桌面", KnownPath(Environment.SpecialFolder.DesktopDirectory), PickerGlyph.Desktop);
            string downloads;
            var downloadsId = new Guid("374DE290-123F-4565-9164-39C4925E467B");
            const uint dontVerify = 0x4000; // Redirected known folders may be offline.
            if (Native.SHGetKnownFolderPath(ref downloadsId, dontVerify, IntPtr.Zero, out downloads) >= 0) Place(sidebar, "下载", downloads, PickerGlyph.Download);
            pictures = KnownPath(Environment.SpecialFolder.MyPictures);
            Place(sidebar, "图片", pictures, PickerGlyph.Pictures);
            Place(sidebar, "文档", KnownPath(Environment.SpecialFolder.MyDocuments), PickerGlyph.Document);
            driveHeading = Section("驱动器", 9); driveHeading.Visible = false;
            sidebar.Controls.Add(driveHeading);
            driveList = SidebarRows(); driveList.RowCount = driveButtons.Length;
            sidebar.Controls.Add(driveList);
            RefreshDrives();
            body.Controls.Add(sideScroll, 0, 0); body.Controls.Add(Rule(), 1, 0);
            var viewArea = new Panel { Dock = DockStyle.Fill, Margin = new Padding(Px(7), Px(7), Px(5), Px(4)), BackColor = Color.White };
            host.Dock = DockStyle.Fill; host.TabStop = true; host.Visible = false; host.BackColor = Color.White;
            host.Enter += delegate { if (browser != null) Guard(browser.FocusView); };
            loading = new Label { Dock = DockStyle.Fill, Text = "正在打开文件夹…", TextAlign = ContentAlignment.MiddleCenter, BackColor = Color.White, ForeColor = Muted };
            viewArea.Controls.Add(host); viewArea.Controls.Add(loading);
            body.Controls.Add(viewArea, 2, 0);
            body.Controls.Add(Rule(), 3, 0);
            preview = new PreviewPane(scale) { Dock = DockStyle.Fill, Margin = Padding.Empty };
            body.Controls.Add(preview, 4, 0);
            layout.Controls.Add(body, 0, 3);

            var foot = Grid(1, 2);
            foot.BackColor = Color.FromArgb(249, 251, 255);
            foot.Padding = new Padding(Px(14), Px(9), Px(14), Px(9));
            foot.RowStyles.Add(new RowStyle(SizeType.Percent, 50)); foot.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
            var names = Grid(2, 1);
            names.ColumnStyles.Add(Fixed(58)); names.ColumnStyles.Add(Flex());
            names.Controls.Add(new Label { Text = folders ? "文件夹" : "文件名", Margin = Padding.Empty, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft }, 0, 0);
            var nameBox = new PickerField(filename, PickerGlyph.None, folders ? "文件夹名称" : "文件名", folders ? "输入路径或选择文件夹" : "输入文件名或在上方选择图片", scale);
            nameBox.Margin = new Padding(0, 0, 0, Px(3));
            filename.Name = "filename";
            filename.TextChanged += delegate { if (!settingFilename) { typedName = true; SelectionChanged(); } };
            filename.KeyDown += delegate(object sender, KeyEventArgs e) {
                if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Accept(false); }
            };
            names.Controls.Add(nameBox, 1, 0);
            foot.Controls.Add(names, 0, 0);

            var actions = Grid(3, 1);
            actions.ColumnStyles.Add(Flex()); actions.ColumnStyles.Add(Fixed(folders ? 107 : 88)); actions.ColumnStyles.Add(Fixed(80));
            status.Dock = DockStyle.Fill; status.Margin = Padding.Empty; status.TextAlign = ContentAlignment.MiddleLeft;
            status.Font = new Font(Font.FontFamily, 8.5f); status.AutoEllipsis = true; status.ForeColor = Muted;
            confirm = Button(folders ? "选择文件夹" : "打开", folders ? "选择文件夹" : "打开", PickerGlyph.None, ButtonStyle.Primary, delegate { Accept(false); });
            var cancel = Button("取消", "取消", PickerGlyph.None, ButtonStyle.Secondary, Close);
            confirm.Name = "confirm"; cancel.Name = "cancel"; status.Name = "status";
            confirm.Margin = new Padding(0, Px(3), Px(4), 0); cancel.Margin = new Padding(Px(4), Px(3), 0, 0);
            actions.Controls.Add(status, 0, 0); actions.Controls.Add(confirm, 1, 0); actions.Controls.Add(cancel, 2, 0);
            foot.Controls.Add(actions, 0, 1); layout.Controls.Add(foot, 0, 5);
            ActiveControl = host;
            Resize += delegate { LayoutPreview(); };
            LayoutPreview();
            ownerCheck.Tick += delegate { if (owner != null && !owner.Alive()) Close(); };
        }

        int Px(int pixels) { return (int)Math.Round(pixels * scale); }
        RowStyle Absolute(int height) { return new RowStyle(SizeType.Absolute, Px(height)); }
        ColumnStyle Fixed(int width) { return new ColumnStyle(SizeType.Absolute, Px(width)); }
        static ColumnStyle Flex() { return new ColumnStyle(SizeType.Percent, 100); }
        static TableLayoutPanel Grid(int columns, int rows)
        {
            var grid = new TableLayoutPanel { ColumnCount = columns, RowCount = rows, Margin = Padding.Empty, Padding = Padding.Empty, Dock = DockStyle.Fill };
            if (rows == 1) grid.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            if (columns == 1) grid.ColumnStyles.Add(Flex());
            return grid;
        }
        static Panel Rule() { return new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty, BackColor = Line }; }
        PickerButton Button(string caption, string name, PickerGlyph icon, ButtonStyle style, Action action)
        {
            var button = new PickerButton(caption, name, icon, style, scale) { Dock = DockStyle.Fill, Margin = Padding.Empty };
            button.Click += delegate { action(); };
            tips.SetToolTip(button, name);
            return button;
        }
        static string KnownPath(Environment.SpecialFolder folder)
        {
            return Environment.GetFolderPath(folder, Environment.SpecialFolderOption.DoNotVerify);
        }
        static TableLayoutPanel SidebarRows()
        {
            var rows = new TableLayoutPanel { ColumnCount = 1, Dock = DockStyle.Top, AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink, Margin = Padding.Empty, Padding = Padding.Empty, BackColor = Mist };
            rows.ColumnStyles.Add(Flex());
            return rows;
        }
        Label Section(string label, int top)
        {
            return new Label { Text = label, Dock = DockStyle.Top, Height = Px(22), TextAlign = ContentAlignment.TopLeft,
                Margin = new Padding(Px(9), Px(top), 0, Px(3)), Font = new Font(Font.FontFamily, 8.5f), ForeColor = Muted };
        }
        PickerButton Place(TableLayoutPanel panel, string label, string path, PickerGlyph glyph, int row = -1)
        {
            if (String.IsNullOrEmpty(path)) return null;
            var button = Button(label, label, glyph, ButtonStyle.Place, delegate {
                if (glyph == PickerGlyph.Drive) OpenLocation(path, false); else Go(path, -1);
            });
            button.Tag = path; button.Dock = DockStyle.Top; button.Height = Px(32);
            button.Margin = new Padding(0, 0, 0, Px(2));
            if (row < 0) panel.Controls.Add(button); else panel.Controls.Add(button, 0, row);
            places.Add(button);
            return button;
        }
        [DllImport("kernel32.dll")] static extern uint GetLogicalDrives();
        void RefreshDrives()
        {
            // This mask covers assigned letters, including removable media and mapped shares, without accessing any volume.
            uint mask = GetLogicalDrives();
            if (mask == driveMask) return;
            driveList.SuspendLayout();
            for (int i = 0; i < driveButtons.Length; i++)
            {
                uint bit = 1u << i;
                if (((mask ^ driveMask) & bit) == 0) continue;
                if ((mask & bit) != 0)
                {
                    string letter = (char)('A' + i) + ":";
                    var drive = Place(driveList, letter, letter + "\\", PickerGlyph.Drive, i);
                    drive.Name = "drive" + letter[0]; drive.TabIndex = i;
                    tips.SetToolTip(drive, letter + "\\"); driveButtons[i] = drive;
                }
                else
                {
                    var drive = driveButtons[i];
                    places.Remove(drive); tips.SetToolTip(drive, null);
                    drive.Dispose(); driveButtons[i] = null;
                }
            }
            driveMask = mask;
            driveHeading.Visible = mask != 0;
            driveList.ResumeLayout(true);
            if (browser != null && browser.Current != null) SelectPlace(browser.Current);
        }
        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (driveList != null) RefreshDrives();
        }
        void LayoutPreview()
        {
            bool show = wantsPreview && !folders && ClientSize.Width >= Px(740);
            preview.Visible = show;
            previewToggle.Selected = show;
            previewToggle.Enabled = !folders && ClientSize.Width >= Px(740);
            body.ColumnStyles[3].Width = show ? 1 : 0;
            body.ColumnStyles[4].Width = show ? Px(222) : 0;
            if (browser != null) SelectionChanged();
        }
        void SetView(bool useDetails)
        {
            if (browser == null) return;
            Guard(delegate {
                browser.SetDetails(useDetails);
                details.Selected = useDetails; thumbnails.Selected = !useDetails;
            });
        }
        void EditAddress() { crumbs.Visible = false; address.Focus(); address.SelectAll(); }
        void ShowCrumbs()
        {
            if (browser == null || String.IsNullOrEmpty(browser.Current)) return;
            crumbs.SetPath(browser.Current);
            crumbs.Visible = true; crumbs.BringToFront();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try
            {
                browser = new FolderBrowser(host, folders, Px(96));
                browser.Navigated += EnteredFolder;
                browser.NavigationFailed += CannotNavigate;
                browser.Activated += delegate { Accept(true); };
                browser.SelectionChanged += delegate { if (!filename.Focused) typedName = false; SelectionChanged(); };
                browser.Message += ShowMessage;
                Application.AddMessageFilter(this);
                if (owner != null) ownerCheck.Start();
                browser.SetDetails(folders);
                browser.Initialize();
                Buttons(); confirm.Enabled = false;
                // Compose the custom chrome and its opaque loading surface before the first visible frame.
                PaintTree(Handle);
                DwmFlush();
                presented = true;
                if (cloaked) { int off = 0; Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(Handle, DwmCloak, ref off, sizeof(int))); }
                else Opacity = 1;
                Native.SetForegroundWindow(Handle);
                OpenLocation(initial, true);
            }
            catch (Exception error) { Failure = error; Close(); }
        }

        async void OpenLocation(string path, bool initialLocation)
        {
            if (browser == null || navigating) return;
            int request = ++locationRequest;
            resolving = true; confirm.Enabled = false;
            if (historyIndex < 0) loading.Text = "正在打开文件夹…";
            else ShowMessage("正在打开 " + path);
            // Probe only the requested drive. Unplugged media and offline shares can block a filesystem call.
            string destination = await Task.Run(delegate {
                if (!String.IsNullOrEmpty(path) && Directory.Exists(path)) return path;
                if (!initialLocation) return null;
                return !String.Equals(pictures, path, StringComparison.OrdinalIgnoreCase) && Directory.Exists(pictures) ? pictures : Native.Computer;
            });
            if (IsDisposed || Disposing || request != locationRequest) return;
            resolving = false;
            if (destination == null) { CannotNavigate(); return; }
            Go(destination, -1);
        }

        void EnteredFolder(string path)
        {
            ++locationRequest; resolving = false;
            searchDelay.Stop(); search.Clear(); searchDelay.Stop();
            if (requestedIndex >= 0 && String.Equals(history[requestedIndex], path, StringComparison.OrdinalIgnoreCase)) historyIndex = requestedIndex;
            else if (historyIndex < 0 || !String.Equals(history[historyIndex], path, StringComparison.OrdinalIgnoreCase))
            {
                if (historyIndex + 1 < history.Count) history.RemoveRange(historyIndex + 1, history.Count - historyIndex - 1);
                history.Add(path); historyIndex = history.Count - 1;
            }
            navigating = false; requestedIndex = -1;
            address.Text = path == Native.Computer ? "此电脑" : path;
            ShowCrumbs();
            SelectPlace(path);
            if (loading.Visible)
            {
                host.Visible = true; loading.Visible = false;
                PaintTree(host.Handle);
            }
            typedName = false;
            Buttons(); SelectionChanged(); Guard(browser.FocusView);
        }
        void SelectPlace(string path)
        {
            PickerButton active = places[0];
            int longest = 0;
            foreach (var place in places)
            {
                string target = (string)place.Tag;
                string prefix = target.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                if (target.Length >= longest && (String.Equals(path, target, StringComparison.OrdinalIgnoreCase) || path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)))
                { active = place; longest = target.Length; }
            }
            foreach (var place in places) place.Selected = place == active;
        }
        void CannotNavigate()
        {
            navigating = false; requestedIndex = -1;
            if (historyIndex < 0) loading.Text = "无法打开该位置，请选择左侧其他位置。";
            Buttons(); SelectionChanged(); ShowMessage("无法打开该位置，请检查驱动器连接或访问权限。");
        }
        void Buttons()
        {
            back.Enabled = !navigating && historyIndex > 0;
            forward.Enabled = !navigating && historyIndex >= 0 && historyIndex + 1 < history.Count;
            up.Enabled = !navigating && browser.Current != null && browser.Current != Native.Computer;
        }
        void Travel(int direction)
        {
            int index = historyIndex + direction;
            if (index >= 0 && index < history.Count) Go(history[index], index);
        }
        void GoUp()
        {
            if (browser == null || browser.Current == Native.Computer || browser.Current == null) return;
            Guard(delegate { var parent = Directory.GetParent(browser.Current); Go(parent == null ? Native.Computer : parent.FullName, -1); });
        }
        void TypedAddress()
        {
            string path = Environment.ExpandEnvironmentVariables(address.Text.Trim().Trim('"'));
            if (path == "此电脑") { Go(Native.Computer, -1); return; }
            Guard(delegate {
                if (!Path.IsPathRooted(path) && browser.Current != null && browser.Current != Native.Computer) path = Path.Combine(browser.Current, path);
                if (!Directory.Exists(path)) { ShowMessage("找不到这个文件夹，请检查路径。"); return; }
                Go(Path.GetFullPath(path), -1);
            });
        }
        void Go(string path, int index)
        {
            if (browser == null || navigating) return;
            ++locationRequest; resolving = false;
            if (String.Equals(path, browser.Current, StringComparison.OrdinalIgnoreCase)) { SelectionChanged(); Guard(browser.FocusView); return; }
            navigating = true; requestedIndex = index; Buttons(); confirm.Enabled = false;
            try { browser.Navigate(path); }
            catch (Exception error) { CannotNavigate(); ShowMessage(error.Message); }
        }
        void SelectionChanged()
        {
            if (resolving || navigating || accepting || browser == null) return;
            Guard(delegate {
                int count = browser.SelectionCount();
                string first = count > 0 ? browser.FirstSelectedPath() : null;
                bool currentFolder = folders && browser.Current != Native.Computer && browser.Current != null;
                if (!typedName)
                {
                    string file = first ?? (currentFolder ? browser.Current : "");
                    string label = Path.GetFileName(file.TrimEnd(Path.DirectorySeparatorChar));
                    string display = String.IsNullOrEmpty(label) ? file : label;
                    if (count > 1) display = String.Format("{0} 等 {1:N0} 项", display, count);
                    settingFilename = true;
                    try { if (filename.Text != display) filename.Text = display; }
                    finally { settingFilename = false; }
                }
                confirm.Enabled = typedName ? !String.IsNullOrWhiteSpace(filename.Text) : count > 0 || currentFolder;
                if (!folders && preview.Visible) preview.ShowSelection(first, count);
                ShowMessage(count > 0 ? String.Format("已选 {0:N0} 项", count) : folders ? "可选择当前文件夹，或按 Ctrl / Shift 多选" : "JPG、PNG、WebP   ·   按 Ctrl / Shift 多选");
            });
        }

        string[] TypedSelection()
        {
            string value = filename.Text.Trim();
            var names = new List<string>();
            if (value.StartsWith("\""))
            {
                var parts = System.Text.RegularExpressions.Regex.Matches(value, "\\G\\s*\"([^\"]+)\"\\s*");
                int consumed = 0;
                foreach (System.Text.RegularExpressions.Match part in parts) { names.Add(part.Groups[1].Value); consumed += part.Length; }
                if (consumed != value.Length) throw new IOException("多个文件名请分别用双引号括起。");
            }
            else names.Add(value);
            var result = new List<string>();
            foreach (string name in names)
            {
                string file = Environment.ExpandEnvironmentVariables(name);
                if (!Path.IsPathRooted(file))
                {
                    if (browser.Current == Native.Computer || browser.Current == null) throw new IOException("请输入完整路径。");
                    file = Path.Combine(browser.Current, file);
                }
                file = Path.GetFullPath(file);
                if (Directory.Exists(file))
                {
                    if (folders) result.Add(file);
                    else if (names.Count == 1) { Go(file, -1); return null; }
                    else throw new IOException("请选择图片文件。");
                }
                else
                {
                    if (folders || !File.Exists(file)) throw new IOException("找不到所选项目，请检查名称或路径。");
                    string extension = Path.GetExtension(file).ToLowerInvariant();
                    if (extension != ".jpg" && extension != ".jpeg" && extension != ".png" && extension != ".webp")
                        throw new IOException("请选择 JPG、PNG 或 WebP 图片。");
                    result.Add(file);
                }
            }
            return result.ToArray();
        }
        void Accept(bool openFolder)
        {
            if (accepting || resolving || navigating || browser == null) return;
            accepting = true;
            try
            {
                var result = typedName && !openFolder ? TypedSelection() : browser.Selection(openFolder);
                if (result != null) { Paths = result; DialogResult = DialogResult.OK; Close(); }
            }
            catch (Exception error) { ShowMessage(error.Message); }
            finally { accepting = false; }
        }
        void Guard(Action action) { try { action(); } catch (Exception error) { ShowMessage(error.GetBaseException().Message); } }
        void ShowMessage(string message) { status.Text = message; tips.SetToolTip(status, message); }

        public bool PreFilterMessage(ref Message m)
        {
            const int KeyDown = 0x100, SysKeyDown = 0x104;
            if (m.Msg < KeyDown || m.Msg > 0x109 || !IsHandleCreated || (m.HWnd != Handle && !Native.IsChild(Handle, m.HWnd))) return false;
            bool inView = m.HWnd == host.Handle || Native.IsChild(host.Handle, m.HWnd);
            if (m.Msg == KeyDown || m.Msg == SysKeyDown)
            {
                Keys key = (Keys)m.WParam.ToInt32() | ModifierKeys;
                if (key == Keys.Escape && address.Focused) { ShowCrumbs(); Guard(browser.FocusView); return true; }
                if (key == Keys.Escape) { Close(); return true; }
                if (key == (Keys.Alt | Keys.Left)) { Travel(-1); return true; }
                if (key == (Keys.Alt | Keys.Right)) { Travel(1); return true; }
                if (key == (Keys.Alt | Keys.Up) || (inView && key == Keys.Back)) { GoUp(); return true; }
                if (key == (Keys.Control | Keys.L) || key == Keys.F4) { EditAddress(); return true; }
                if (key == (Keys.Alt | Keys.P) && previewToggle.Enabled) { wantsPreview = !wantsPreview; LayoutPreview(); return true; }
                if (key == (Keys.Control | Keys.F)) { search.Focus(); search.SelectAll(); return true; }
                if (inView && key == Keys.Enter) { Accept(true); return true; }
                if (inView && (key == Keys.Tab || key == (Keys.Shift | Keys.Tab)))
                {
                    SelectNextControl(host, key == Keys.Tab, true, true, true); return true;
                }
            }
            return inView && browser != null && browser.Translate(ref m);
        }
        void DragHeader(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture(); Native.SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmFlush();
        [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr hwnd, IntPtr rect, IntPtr region, uint flags);
        const int DwmCloak = 13;
        static void PaintTree(IntPtr hwnd) { RedrawWindow(hwnd, IntPtr.Zero, IntPtr.Zero, 0x01 | 0x04 | 0x80 | 0x100); } // Invalidate, erase and synchronously paint all child HWNDs.
        protected override CreateParams CreateParams
        {
            get { var parameters = base.CreateParams; parameters.Style |= 0x00040000; return parameters; } // WS_THICKFRAME
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x83 && message.WParam != IntPtr.Zero) { message.Result = IntPtr.Zero; return; }
            base.WndProc(ref message);
            if (message.Msg == 0x219 && driveList != null && !Disposing && !IsDisposed) RefreshDrives(); // WM_DEVICECHANGE
            if (message.Msg != 0x84 || message.Result != (IntPtr)1) return;
            int coords = unchecked((int)message.LParam.ToInt64());
            var point = PointToClient(new Point(unchecked((short)coords), unchecked((short)(coords >> 16))));
            int edge = Math.Max(3, Px(5));
            bool left = point.X < edge, right = point.X >= ClientSize.Width - edge;
            if (point.Y < edge) message.Result = (IntPtr)(left ? 13 : right ? 14 : 12);
            else if (point.Y >= ClientSize.Height - edge) message.Result = (IntPtr)(left ? 16 : right ? 17 : 15);
            else if (left || right) message.Result = (IntPtr)(left ? 10 : 11);
        }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!presented)
            {
                int on = 1;
                cloaked = DwmSetWindowAttribute(Handle, DwmCloak, ref on, sizeof(int)) >= 0;
                if (!cloaked) Opacity = 0;
            }
            int corners = 3, border = ColorTranslator.ToWin32(Line);
            DwmSetWindowAttribute(Handle, 33, ref corners, sizeof(int));
            DwmSetWindowAttribute(Handle, 34, ref border, sizeof(int));
        }
        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            ++locationRequest;
            ownerCheck.Stop(); searchDelay.Stop();
            Application.RemoveMessageFilter(this);
            if (browser != null) browser.Dispose();
            base.OnFormClosed(e);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) { ownerCheck.Dispose(); searchDelay.Dispose(); tips.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
