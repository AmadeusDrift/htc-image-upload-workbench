using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    internal enum PickerGlyph { None, Back, Forward, Up, Close, Computer, Desktop, Download, Pictures, Document, Drive, Folder, Search, Grid, List, Preview, Cloud, Chevron, Check }
    internal enum ButtonStyle { Tool, Place, Primary, Secondary, Segment, Close }

    internal static class PickerPaint
    {
        internal static readonly Color Ink = Color.FromArgb(0x17, 0x30, 0x52);
        internal static readonly Color Blue = Color.FromArgb(0x2C, 0x63, 0xDF);
        internal static readonly Color Muted = Color.FromArgb(0x57, 0x6C, 0x85);
        internal static readonly Color Line = Color.FromArgb(0xCC, 0xD8, 0xE7);
        internal static readonly Color Mist = Color.FromArgb(0xF4, 0xF8, 0xFD);

        internal static GraphicsPath Rounded(RectangleF rect, float radius)
        {
            var path = new GraphicsPath();
            float diameter = Math.Min(2 * radius, Math.Min(rect.Width, rect.Height));
            if (diameter <= 0) return path;
            path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
            path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            return path;
        }

        internal static void Surface(Graphics g, Size size, float radius, Color fill, Color border, float line)
        {
            if (size.Width <= line || size.Height <= line) return;
            var bounds = new RectangleF(line / 2, line / 2, size.Width - line, size.Height - line);
            using (var outline = Rounded(bounds, radius))
            {
                if (fill.A != 0)
                    using (var brush = new SolidBrush(fill)) g.FillPath(brush, outline);
                if (border.A != 0)
                    using (var pen = new Pen(border, line)) g.DrawPath(pen, outline);
            }
        }

        static void Stroke(Graphics g, Pen pen, params PointF[] points) { g.DrawLines(pen, points); }
        static PointF P(float x, float y) { return new PointF(x, y); }
        static void Frame(Graphics g, Pen pen, float x, float y, float width, float height, float radius)
        {
            using (var path = Rounded(new RectangleF(x, y, width, height), radius)) g.DrawPath(pen, path);
        }

        internal static void Icon(Graphics g, PickerGlyph glyph, Rectangle bounds, Color color)
        {
            if (glyph == PickerGlyph.None || bounds.Width < 1 || bounds.Height < 1) return;
            float side = Math.Min(bounds.Width, bounds.Height);
            var saved = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TranslateTransform(bounds.X + (bounds.Width - side) / 2f, bounds.Y + (bounds.Height - side) / 2f);
                g.ScaleTransform(side / 24f, side / 24f);
                using (var pen = new Pen(color, 1.85f))
                {
                    pen.LineJoin = LineJoin.Round;
                    pen.StartCap = pen.EndCap = LineCap.Round;
                    switch (glyph)
                    {
                        case PickerGlyph.Back:
                            Stroke(g, pen, P(10, 5.5f), P(3.5f, 12), P(10, 18.5f));
                            g.DrawLine(pen, 4, 12, 20, 12); break;
                        case PickerGlyph.Forward:
                            Stroke(g, pen, P(14, 5.5f), P(20.5f, 12), P(14, 18.5f));
                            g.DrawLine(pen, 4, 12, 20, 12); break;
                        case PickerGlyph.Up:
                            Stroke(g, pen, P(5.5f, 10.5f), P(12, 4), P(18.5f, 10.5f));
                            g.DrawLine(pen, 12, 4.5f, 12, 20); break;
                        case PickerGlyph.Close:
                            g.DrawLine(pen, 6, 6, 18, 18); g.DrawLine(pen, 18, 6, 6, 18); break;
                        case PickerGlyph.Computer:
                            Frame(g, pen, 2, 5, 13.5f, 10.5f, 1.3f);
                            g.DrawLine(pen, 8.7f, 15.5f, 8.7f, 19); g.DrawLine(pen, 5, 19, 12.5f, 19);
                            Frame(g, pen, 18, 4, 4, 15, 1.2f); g.DrawLine(pen, 19.6f, 15.75f, 20.4f, 15.75f); break;
                        case PickerGlyph.Desktop:
                            Frame(g, pen, 2.5f, 4.5f, 19, 12.5f, 1.6f);
                            g.DrawLine(pen, 12, 17, 12, 20); g.DrawLine(pen, 7.5f, 20, 16.5f, 20); break;
                        case PickerGlyph.Download:
                            g.DrawLine(pen, 12, 3.5f, 12, 14.5f);
                            Stroke(g, pen, P(7.5f, 10.5f), P(12, 15), P(16.5f, 10.5f));
                            Stroke(g, pen, P(4, 15), P(4, 19.5f), P(20, 19.5f), P(20, 15)); break;
                        case PickerGlyph.Pictures:
                            Frame(g, pen, 3, 3.5f, 18, 17, 2);
                            g.DrawEllipse(pen, 6.5f, 7, 2.8f, 2.8f);
                            Stroke(g, pen, P(3.5f, 17.5f), P(8.5f, 12.5f), P(11.3f, 15.3f), P(15.6f, 10.8f), P(20.5f, 15.5f)); break;
                        case PickerGlyph.Document:
                            Stroke(g, pen, P(6, 3), P(13.5f, 3), P(18.5f, 8), P(18.5f, 21), P(5.5f, 21), P(5.5f, 3), P(6, 3));
                            Stroke(g, pen, P(13, 3.5f), P(13, 8.5f), P(18, 8.5f));
                            g.DrawLine(pen, 8.5f, 12.5f, 15.5f, 12.5f); g.DrawLine(pen, 8.5f, 16, 14.3f, 16); break;
                        case PickerGlyph.Drive:
                            Stroke(g, pen, P(3, 13), P(6.5f, 5), P(17.5f, 5), P(21, 13));
                            Frame(g, pen, 3, 12.5f, 18, 6.5f, 1.6f);
                            g.DrawLine(pen, 15, 16, 17.5f, 16); break;
                        case PickerGlyph.Folder:
                            using (var folder = new GraphicsPath())
                            {
                                folder.AddLine(3, 8, 3, 6);
                                folder.AddBezier(3, 6, 3, 4.8f, 3.7f, 4.2f, 5, 4.2f);
                                folder.AddLine(5, 4.2f, 9, 4.2f); folder.AddLine(9, 4.2f, 11.6f, 7);
                                folder.AddLine(11.6f, 7, 19, 7);
                                folder.AddBezier(19, 7, 20.3f, 7, 21, 7.7f, 21, 9);
                                folder.AddLine(21, 9, 21, 17.8f);
                                folder.AddBezier(21, 17.8f, 21, 19.1f, 20.2f, 19.8f, 19, 19.8f);
                                folder.AddLine(19, 19.8f, 5, 19.8f);
                                folder.AddBezier(5, 19.8f, 3.7f, 19.8f, 3, 19.1f, 3, 17.8f);
                                folder.CloseFigure(); g.DrawPath(pen, folder);
                            }
                            break;
                        case PickerGlyph.Search:
                            g.DrawEllipse(pen, 3.5f, 3.5f, 12.7f, 12.7f);
                            g.DrawLine(pen, 14.6f, 14.6f, 20, 20); break;
                        case PickerGlyph.Grid:
                            Frame(g, pen, 3.5f, 3.5f, 6.5f, 6.5f, 1);
                            Frame(g, pen, 14, 3.5f, 6.5f, 6.5f, 1);
                            Frame(g, pen, 3.5f, 14, 6.5f, 6.5f, 1);
                            Frame(g, pen, 14, 14, 6.5f, 6.5f, 1); break;
                        case PickerGlyph.List:
                            for (int y = 6; y <= 18; y += 6)
                            {
                                g.DrawLine(pen, 3.5f, y, 5, y);
                                g.DrawLine(pen, 9, y, 20.5f, y);
                            }
                            break;
                        case PickerGlyph.Preview:
                            using (var eye = new GraphicsPath())
                            {
                                eye.AddBezier(2, 12, 7, 3.5f, 17, 3.5f, 22, 12);
                                eye.AddBezier(22, 12, 17, 20.5f, 7, 20.5f, 2, 12);
                                g.DrawPath(pen, eye);
                            }
                            g.DrawEllipse(pen, 9.2f, 9.2f, 5.6f, 5.6f); break;
                        case PickerGlyph.Cloud:
                            using (var cloud = new GraphicsPath())
                            {
                                cloud.AddBezier(6.1f, 18.3f, 0.7f, 18, 0.8f, 10.7f, 6, 9.9f);
                                cloud.AddBezier(6, 9.9f, 7.1f, 2.7f, 17, 2.7f, 18.7f, 10.1f);
                                cloud.AddBezier(18.7f, 10.1f, 23.6f, 10.7f, 23.3f, 18.2f, 18, 18.3f);
                                cloud.CloseFigure(); g.DrawPath(pen, cloud);
                            }
                            break;
                        case PickerGlyph.Chevron:
                            Stroke(g, pen, P(9, 5.8f), P(15.2f, 12), P(9, 18.2f)); break;
                        case PickerGlyph.Check:
                            Stroke(g, pen, P(3.8f, 12.4f), P(9.1f, 17.7f), P(20.2f, 6.8f)); break;
                    }
                }
            }
            finally { g.Restore(saved); }
        }
    }

    internal sealed class PickerButton : Button
    {
        readonly PickerGlyph glyph;
        readonly ButtonStyle style;
        readonly float scale;
        readonly bool iconOnly;
        bool selected, hovered, mousePressed, keyPressed;

        internal PickerButton(string caption, string accessibleName, PickerGlyph glyph, ButtonStyle style, float scale)
        {
            this.glyph = glyph;
            this.style = style;
            this.scale = Math.Max(0.5f, scale);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            UseVisualStyleBackColor = false;
            BackColor = Color.White;
            ForeColor = PickerPaint.Ink;
            iconOnly = String.IsNullOrEmpty(caption);
            // The Win32 UI Automation provider reads the HWND caption.
            Text = iconOnly ? accessibleName : caption;
            AccessibleName = accessibleName;
            AccessibleRole = AccessibleRole.PushButton;
            UseMnemonic = false;
            TextAlign = style == ButtonStyle.Place ? ContentAlignment.MiddleLeft : ContentAlignment.MiddleCenter;
            Margin = Padding.Empty;
            Cursor = Cursors.Hand;
        }

        internal bool Selected
        {
            get { return selected; }
            set
            {
                if (selected == value) return;
                selected = value;
                if (style == ButtonStyle.Place) AccessibleDescription = selected ? "当前位置" : null;
                Invalidate();
            }
        }

        int Px(float value) { return (int)Math.Round(value * scale); }

        void Colors(out Color fill, out Color border, out Color ink)
        {
            bool pressed = keyPressed || (mousePressed && hovered);
            fill = border = Color.Transparent;
            ink = PickerPaint.Ink;
            if (!Enabled)
            {
                ink = Color.FromArgb(155, 171, 190);
                if (style == ButtonStyle.Primary) fill = Color.FromArgb(226, 234, 248);
                if (style == ButtonStyle.Secondary) { fill = PickerPaint.Mist; border = Color.FromArgb(221, 229, 239); }
                return;
            }
            if (style == ButtonStyle.Primary)
            {
                fill = pressed ? Color.FromArgb(30, 75, 177) : hovered ? Color.FromArgb(35, 87, 202) : PickerPaint.Blue;
                ink = Color.White;
            }
            else if (style == ButtonStyle.Secondary)
            {
                fill = pressed ? Color.FromArgb(231, 239, 250) : hovered ? PickerPaint.Mist : Color.White;
                border = hovered || pressed ? Color.FromArgb(165, 188, 219) : PickerPaint.Line;
            }
            else if (style == ButtonStyle.Close)
            {
                ink = hovered || pressed ? Color.FromArgb(165, 47, 64) : PickerPaint.Muted;
                if (hovered || pressed) fill = pressed ? Color.FromArgb(246, 215, 221) : Color.FromArgb(251, 233, 237);
            }
            else
            {
                ink = selected ? PickerPaint.Blue : style == ButtonStyle.Place ? PickerPaint.Ink : PickerPaint.Muted;
                if (pressed) fill = Color.FromArgb(216, 230, 250);
                else if (selected && style == ButtonStyle.Segment)
                {
                    fill = Color.White;
                    border = Color.FromArgb(199, 213, 232);
                }
                else if (selected) fill = Color.FromArgb(226, 237, 253);
                else if (hovered) fill = Color.FromArgb(231, 239, 250);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Parent == null ? BackColor : Parent.BackColor);
            var saved = g.Save();
            try
            {
                Color fill, border, ink;
                Colors(out fill, out border, out ink);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                PickerPaint.Surface(g, ClientSize, 4.5f * scale, fill, border, Math.Max(1f, scale));
                bool hasText = !iconOnly;
                int side = Math.Min(Px(style == ButtonStyle.Close ? 16 : 18), Math.Min(Width, Height));
                int pad = Px(style == ButtonStyle.Place ? 11 : 6);
                int left = pad, textLeft = pad, gap = Px(8);
                var flags = TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis |
                    TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.PreserveGraphicsClipping;
                if (glyph != PickerGlyph.None && side > 0)
                {
                    if (!hasText) left = (Width - side) / 2;
                    else if (style != ButtonStyle.Place)
                    {
                        int room = Math.Max(0, Width - 2 * pad - side - gap);
                        int textWidth = Math.Min(room, TextRenderer.MeasureText(g, Text, Font, Size.Empty, flags).Width);
                        left = Math.Max(pad, (Width - side - gap - textWidth) / 2);
                    }
                    PickerPaint.Icon(g, glyph, new Rectangle(left, (Height - side) / 2, side, side), ink);
                    textLeft = left + side + gap;
                }
                if (hasText && Width > textLeft + pad)
                {
                    if (style != ButtonStyle.Place && glyph == PickerGlyph.None) flags |= TextFormatFlags.HorizontalCenter;
                    TextRenderer.DrawText(g, Text, Font, new Rectangle(textLeft, 0, Width - textLeft - pad, Height), ink, flags);
                }
                if (Enabled && Focused && ShowFocusCues)
                {
                    float inset = Math.Max(2, Px(2.5f));
                    if (Width > 2 * inset && Height > 2 * inset)
                        using (var ring = PickerPaint.Rounded(new RectangleF(inset, inset, Width - inset * 2, Height - inset * 2), 3 * scale))
                        using (var pen = new Pen(style == ButtonStyle.Primary ? Color.White : PickerPaint.Blue, Math.Max(1f, scale)))
                            g.DrawPath(pen, ring);
                }
            }
            finally { g.Restore(saved); }
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); hovered = true; Invalidate(); }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovered = false; Invalidate(); }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); mousePressed = e.Button == MouseButtons.Left; Invalidate(); }
        protected override void OnMouseUp(MouseEventArgs e) { mousePressed = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnMouseCaptureChanged(EventArgs e) { base.OnMouseCaptureChanged(e); if (!Capture) { mousePressed = false; Invalidate(); } }
        protected override void OnKeyDown(KeyEventArgs e) { base.OnKeyDown(e); if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { keyPressed = true; Invalidate(); } }
        protected override void OnKeyUp(KeyEventArgs e) { keyPressed = false; Invalidate(); base.OnKeyUp(e); }
        protected override void OnGotFocus(EventArgs e) { base.OnGotFocus(e); Invalidate(); }
        protected override void OnLostFocus(EventArgs e) { keyPressed = false; base.OnLostFocus(e); Invalidate(); }
        protected override void OnEnabledChanged(EventArgs e) { mousePressed = keyPressed = false; base.OnEnabledChanged(e); Invalidate(); }
    }

    internal class PickerField : Panel
    {
        readonly TextBox editor;
        readonly PickerGlyph glyph;
        readonly float scale;
        readonly string placeholder;

        internal PickerField(TextBox editor, PickerGlyph glyph, string accessibleName, string placeholder, float scale)
        {
            if (editor == null) throw new ArgumentNullException("editor");
            this.editor = editor;
            this.glyph = glyph;
            this.placeholder = placeholder ?? String.Empty;
            this.scale = Math.Max(0.5f, scale);
            Dock = DockStyle.Fill;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.White;
            Margin = Padding.Empty;
            TabStop = false;
            editor.Dock = DockStyle.None;
            editor.BorderStyle = BorderStyle.None;
            editor.Multiline = false;
            editor.AutoSize = true;
            editor.BackColor = Color.White;
            editor.ForeColor = PickerPaint.Ink;
            editor.AccessibleName = accessibleName;
            editor.HandleCreated += SetPlaceholder;
            editor.FontChanged += EditorFontChanged;
            editor.GotFocus += FocusChanged;
            editor.LostFocus += FocusChanged;
            Controls.Add(editor);
            if (editor.IsHandleCreated) SetPlaceholder(editor, EventArgs.Empty);
        }

        int Px(float value) { return (int)Math.Round(value * scale); }
        void SetPlaceholder(object sender, EventArgs e) { Native.SendMessage(editor.Handle, 0x1501, IntPtr.Zero, placeholder); }
        void EditorFontChanged(object sender, EventArgs e) { PerformLayout(); }
        void FocusChanged(object sender, EventArgs e) { Invalidate(); }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            if (editor == null || editor.Parent != this) return;
            int left = Px(glyph == PickerGlyph.None ? 10 : 34);
            int height = editor.PreferredHeight;
            var bounds = new Rectangle(left, Math.Max(0, (ClientSize.Height - height) / 2),
                Math.Max(0, ClientSize.Width - left - Px(9)), height);
            if (editor.Bounds != bounds) editor.Bounds = bounds;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Parent == null ? BackColor : Parent.BackColor);
            var saved = g.Save();
            try
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                Color border = ContainsFocus ? PickerPaint.Blue : PickerPaint.Line;
                PickerPaint.Surface(g, ClientSize, 4.5f * scale, Color.White, border, Math.Max(1f, scale * (ContainsFocus ? 1.35f : 1)));
                int side = Math.Min(Px(16), Math.Max(0, Height - Px(4)));
                PickerPaint.Icon(g, glyph, new Rectangle(Px(10), (Height - side) / 2, side, side), PickerPaint.Muted);
            }
            finally { g.Restore(saved); }
            base.OnPaint(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && editor.CanFocus) editor.Focus();
        }
        protected override void OnEnter(EventArgs e) { base.OnEnter(e); Invalidate(); }
        protected override void OnLeave(EventArgs e) { base.OnLeave(e); Invalidate(); }
    }
}
