using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    internal sealed class PreviewPane : Panel
    {
        static readonly Color Paper = Color.FromArgb(248, 250, 254), Ink = Color.FromArgb(23, 48, 82),
            Muted = Color.FromArgb(86, 108, 137), Line = Color.FromArgb(216, 228, 243);
        readonly float scale;
        readonly int thumbnailPixels;
        readonly Font bodyFont, strongFont;
        readonly Label heading, count, filename, typeLabel, typeValue, sizeLabel, sizeValue;
        readonly ToolTip tip = new ToolTip();
        readonly System.Windows.Forms.Timer resultTimer = new System.Windows.Forms.Timer { Interval = 40 };
        readonly object gate = new object();
        Thread worker;
        string selectedPath, requestedPath, placeholder;
        int selectedCount;
        long revision;
        bool closed, initialized;
        PreviewResult ready;
        Rectangle imageBounds;
        Bitmap image;

        internal PreviewPane(float scale)
        {
            this.scale = scale > 0 ? scale : 1f;
            thumbnailPixels = Math.Min(512, Px(220));
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Name = "previewPane"; AccessibleName = "图片预览"; AccessibleRole = AccessibleRole.Pane;
            BackColor = Paper; ForeColor = Ink; Dock = DockStyle.Fill; Margin = Padding.Empty; TabStop = false;
            bodyFont = new Font("Microsoft YaHei UI", 9f);
            strongFont = new Font(bodyFont.FontFamily, 9.5f, FontStyle.Bold);
            Font = bodyFont;
            heading = Caption("previewTitle", "图片预览", strongFont, Ink);
            count = Caption("previewCount", "", bodyFont, Muted);
            count.TextAlign = ContentAlignment.MiddleRight;
            filename = Caption("previewFilename", "", strongFont, Ink);
            typeLabel = Caption("previewTypeLabel", "类型", bodyFont, Muted);
            typeValue = Caption("previewType", "", bodyFont, Ink);
            sizeLabel = Caption("previewSizeLabel", "大小", bodyFont, Muted);
            sizeValue = Caption("previewSize", "", bodyFont, Ink);
            resultTimer.Tick += delegate { ApplyReady(); };
            initialized = true;
            UpdateSelection();
        }

        int Px(int value) { return (int)Math.Round(value * scale); }

        Label Caption(string name, string text, Font font, Color color)
        {
            var label = new Label { Name = name, Text = text, Font = font, ForeColor = color,
                TextAlign = ContentAlignment.MiddleLeft, UseMnemonic = false, AutoEllipsis = true,
                AutoSize = false, BackColor = Paper, Margin = Padding.Empty };
            Controls.Add(label);
            return label;
        }

        // Selection notifications arrive on the picker's UI thread. Changing just
        // the count keeps the same first image and its in-flight thumbnail request.
        internal void ShowSelection(string path, int selectedCount)
        {
            if (closed) return;
            this.selectedCount = Math.Max(0, selectedCount);
            count.Text = this.selectedCount > 1 ? String.Format("已选 {0:N0} 项", this.selectedCount) : "";
            path = this.selectedCount == 0 || String.IsNullOrEmpty(path) ? null : path;
            if (path != null && String.Equals(path, selectedPath, StringComparison.Ordinal)) return;
            selectedPath = path;
            UpdateSelection();
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (initialized && !closed) UpdateSelection();
        }

        void UpdateSelection()
        {
            resultTimer.Stop();
            if (image != null) { image.Dispose(); image = null; }
            bool hasPath = selectedPath != null;
            filename.Visible = typeLabel.Visible = typeValue.Visible = sizeLabel.Visible = sizeValue.Visible = hasPath;
            filename.Text = hasPath ? Path.GetFileName(selectedPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) : "";
            if (hasPath && filename.Text.Length == 0) filename.Text = selectedPath;
            tip.SetToolTip(filename, selectedPath);
            typeValue.Text = hasPath ? FileType(selectedPath) : "";
            sizeValue.Text = "—";
            placeholder = hasPath ? "正在读取预览…" : selectedCount > 0 ? "选择单张图片查看预览" : "选择图片后可预览";
            lock (gate)
            {
                ++revision;
                if (ready != null) { ready.Dispose(); ready = null; }
                requestedPath = Visible ? selectedPath : null;
                if (requestedPath != null)
                {
                    if (worker == null)
                    {
                        worker = new Thread(ReadSelections) { Name = "Shell thumbnail preview", IsBackground = true };
                        worker.SetApartmentState(ApartmentState.STA);
                        worker.Start();
                    }
                    Monitor.Pulse(gate);
                    resultTimer.Start();
                }
            }
            Invalidate();
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            if (!initialized) return;
            int inset = Px(16), width = Math.Max(0, ClientSize.Width - 2 * inset);
            int headingWidth = Math.Min(width, Px(77));
            heading.SetBounds(inset, Px(11), headingWidth, Px(23));
            count.SetBounds(inset + headingWidth, Px(11), width - headingWidth, Px(23));
            int top = Px(44);
            int height = Math.Max(0, Math.Min(Math.Min(width, Px(220)), ClientSize.Height - top - Px(98)));
            imageBounds = new Rectangle(inset, top, width, height);
            int textTop = imageBounds.Bottom + Px(12), keyWidth = Math.Min(Px(45), width);
            filename.SetBounds(inset, textTop, width, Px(23));
            typeLabel.SetBounds(inset, textTop + Px(30), keyWidth, Px(21));
            typeValue.SetBounds(inset + keyWidth, textTop + Px(30), width - keyWidth, Px(21));
            sizeLabel.SetBounds(inset, textTop + Px(55), keyWidth, Px(21));
            sizeValue.SetBounds(inset + keyWidth, textTop + Px(55), width - keyWidth, Px(21));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (var border = new Pen(Line))
            {
                e.Graphics.DrawLine(border, 0, 0, 0, Height);
                var box = imageBounds;
                if (box.Width < 2 || box.Height < 2) return;
                e.Graphics.FillRectangle(Brushes.White, box);
                e.Graphics.DrawRectangle(border, box.Left, box.Top, box.Width - 1, box.Height - 1);
                if (image != null)
                {
                    float factor = Math.Min(1f, Math.Min((box.Width - 2f) / image.Width, (box.Height - 2f) / image.Height));
                    int w = Math.Max(1, (int)Math.Round(image.Width * factor)), h = Math.Max(1, (int)Math.Round(image.Height * factor));
                    e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    e.Graphics.DrawImage(image, new Rectangle(box.Left + (box.Width - w) / 2, box.Top + (box.Height - h) / 2, w, h));
                }
                else
                {
                    int x = box.Left + box.Width / 2, y = box.Top + box.Height / 2;
                    if (box.Height >= Px(80))
                    {
                        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        using (var pen = new Pen(Color.FromArgb(146, 169, 196), Math.Max(1f, scale * 1.4f)))
                        {
                            e.Graphics.DrawRectangle(pen, x - Px(13), y - Px(21), Px(26), Px(20));
                            e.Graphics.DrawEllipse(pen, x - Px(7), y - Px(17), Px(4), Px(4));
                            e.Graphics.DrawLines(pen, new[] { new Point(x - Px(9), y - Px(4)), new Point(x - Px(2), y - Px(10)),
                                new Point(x + Px(2), y - Px(7)), new Point(x + Px(6), y - Px(12)), new Point(x + Px(10), y - Px(6)) });
                        }
                        box = new Rectangle(box.Left, y + Px(5), box.Width, Px(23));
                    }
                    TextRenderer.DrawText(e.Graphics, placeholder, bodyFont, box, Muted, TextFormatFlags.HorizontalCenter |
                        TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
                }
            }
        }

        // One STA, one replaceable request and one result. No bitmap is captured
        // by a posted window callback that might never run after the picker closes.
        void ReadSelections()
        {
            bool ole = OleInitialize(IntPtr.Zero) >= 0;
            try
            {
                for (;;)
                {
                    string path;
                    long version;
                    lock (gate)
                    {
                        while (!closed && requestedPath == null) Monitor.Wait(gate);
                        if (closed) return;
                        path = requestedPath; requestedPath = null; version = revision;
                    }
                    var result = Read(path, ole, thumbnailPixels);
                    lock (gate)
                    {
                        if (closed || version != revision) result.Dispose();
                        else { ready = result; }
                    }
                }
            }
            finally { if (ole) OleUninitialize(); }
        }

        void ApplyReady()
        {
            PreviewResult result;
            lock (gate)
            {
                if (ready == null) return;
                result = ready; ready = null;
            }
            resultTimer.Stop();
            image = result.Image;
            typeValue.Text = result.Kind;
            sizeValue.Text = result.Size;
            placeholder = result.Message;
            Invalidate(imageBounds);
        }

        sealed class PreviewResult : IDisposable
        {
            internal Bitmap Image;
            internal string Kind, Size = "—", Message = "暂无可用预览";
            public void Dispose() { if (Image != null) Image.Dispose(); }
        }

        static string FileType(string path)
        {
            switch (Path.GetExtension(path).ToLowerInvariant())
            {
                case ".jpg": case ".jpeg": return "JPEG 图片";
                case ".png": return "PNG 图片";
                case ".webp": return "WebP 图片";
                default: return "文件";
            }
        }

        static string FormatSize(long bytes)
        {
            if (bytes < 1024) return bytes.ToString(CultureInfo.InvariantCulture) + " B";
            double size = bytes / 1024d;
            string unit = " KB";
            if (size >= 1024) { size /= 1024; unit = " MB"; }
            if (size >= 1024 && unit == " MB") { size /= 1024; unit = " GB"; }
            return size.ToString("0.#", CultureInfo.InvariantCulture) + unit;
        }

        static PreviewResult Read(string path, bool ole, int pixels)
        {
            var result = new PreviewResult { Kind = FileType(path) };
            try
            {
                var entry = new FileInfo(path);
                if (!entry.Exists && Directory.Exists(path)) { result.Kind = "文件夹"; result.Message = "文件夹"; return result; }
                result.Size = FormatSize(entry.Length);
                if (ole && result.Kind != "文件") result.Image = ShellThumbnail(path, pixels, result.Kind != "JPEG 图片");
            }
            catch (IOException) { result.Message = "暂时无法读取该文件"; }
            catch (UnauthorizedAccessException) { result.Message = "暂时无法读取该文件"; }
            catch (COMException) { }
            catch (InvalidCastException) { }
            catch (ArgumentException) { }
            catch (ExternalException) { }
            return result;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ThumbnailSize { internal int Width, Height; }

        [ComImport, Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItemImageFactory
        {
            [PreserveSig] int GetImage(ThumbnailSize size, uint flags, out IntPtr bitmap);
        }

        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
        [StructLayout(LayoutKind.Sequential)]
        struct GdiBitmap
        {
            internal int Type, Width, Height, Stride;
            internal ushort Planes, BitsPerPixel;
            internal IntPtr Bits;
        }
        [StructLayout(LayoutKind.Sequential, Size = 40)]
        struct BitmapHeader
        {
            internal uint Size;
            internal int Width, Height;
            internal ushort Planes, BitsPerPixel;
        }
        [DllImport("gdi32.dll", EntryPoint = "GetObjectW")]
        static extern int GetBitmapObject(IntPtr bitmap, int size, out GdiBitmap value);
        [DllImport("gdi32.dll")]
        static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint first, uint lines, [Out] int[] pixels, ref BitmapHeader format, uint usage);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
        [DllImport("ole32.dll")] static extern void OleUninitialize();

        static Bitmap ShellThumbnail(string path, int pixels, bool preserveAlpha)
        {
            IShellItem item = null;
            IntPtr bitmap = IntPtr.Zero;
            try
            {
                var iid = typeof(IShellItem).GUID;
                Native.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
                var factory = (IShellItemImageFactory)item;
                const uint thumbnailOnly = 8;
                int status = factory.GetImage(new ThumbnailSize { Width = pixels, Height = pixels }, thumbnailOnly, out bitmap);
                return status >= 0 && bitmap != IntPtr.Zero ? CopyThumbnail(bitmap, pixels, preserveAlpha) : null;
            }
            finally
            {
                if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
                if (item != null) Marshal.ReleaseComObject(item);
            }
        }

        static Bitmap CopyThumbnail(IntPtr handle, int limit, bool preserveAlpha)
        {
            GdiBitmap native;
            if (GetBitmapObject(handle, Marshal.SizeOf(typeof(GdiBitmap)), out native) == 0 ||
                native.Width <= 0 || native.Width > limit || native.Height <= 0 || native.Height > limit) return null;
            if (!preserveAlpha || native.BitsPerPixel != 32) return Image.FromHbitmap(handle);

            // FromHbitmap discards alpha on 32-bit Shell bitmaps. Request a top-down
            // BGRA copy of the thumbnail so transparent product images keep their edges.
            var header = new BitmapHeader { Size = 40, Width = native.Width, Height = -native.Height, Planes = 1, BitsPerPixel = 32 };
            var bgra = new int[native.Width * native.Height];
            IntPtr dc = GetDC(IntPtr.Zero);
            if (dc == IntPtr.Zero) return Image.FromHbitmap(handle);
            try
            {
                if (GetDIBits(dc, handle, 0, (uint)native.Height, bgra, ref header, 0) != native.Height)
                    return Image.FromHbitmap(handle);
            }
            finally { ReleaseDC(IntPtr.Zero, dc); }
            bool anyAlpha = false, anyColor = false;
            foreach (int pixel in bgra)
            {
                if ((pixel & unchecked((int)0xff000000)) != 0) { anyAlpha = true; break; }
                anyColor |= pixel != 0;
            }
            if (!anyAlpha && anyColor) return Image.FromHbitmap(handle); // RGB thumbnail with an unused alpha byte.
            var result = new Bitmap(native.Width, native.Height, PixelFormat.Format32bppPArgb);
            try
            {
                var data = result.LockBits(new Rectangle(0, 0, native.Width, native.Height), ImageLockMode.WriteOnly, result.PixelFormat);
                try
                {
                    for (int y = 0; y < native.Height; ++y)
                        Marshal.Copy(bgra, y * native.Width, IntPtr.Add(data.Scan0, y * data.Stride), native.Width);
                }
                finally { result.UnlockBits(data); }
                return result;
            }
            catch { result.Dispose(); throw; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !closed)
            {
                resultTimer.Dispose();
                lock (gate)
                {
                    closed = true; requestedPath = null;
                    if (ready != null) { ready.Dispose(); ready = null; }
                    Monitor.PulseAll(gate);
                }
                if (image != null) { image.Dispose(); image = null; }
                tip.Dispose();
                base.Dispose(true);
                strongFont.Dispose(); bodyFont.Dispose();
                return;
            }
            base.Dispose(disposing);
        }
    }
}
