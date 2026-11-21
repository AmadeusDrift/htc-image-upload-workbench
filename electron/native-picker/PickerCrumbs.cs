using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    // The text editor beneath this control remains available through Ctrl+L,
    // Tab and a click on the current folder or the empty part of the address bar.
    internal sealed class PickerCrumbs : Control
    {
        sealed class Crumb
        {
            internal string Label, Path;
            internal Rectangle Hit;
        }

        readonly float scale;
        readonly Action<string> navigate;
        readonly Action edit;
        readonly List<Crumb> trail = new List<Crumb>();
        readonly List<Crumb> visible = new List<Crumb>();
        readonly Color ink = Color.FromArgb(44, 66, 99);
        Crumb hovered;

        internal PickerCrumbs(float scale, Action<string> navigate, Action edit)
        {
            this.scale = scale;
            this.navigate = navigate;
            this.edit = edit;
            TabStop = false;
            BackColor = Color.White;
            AccessibleRole = AccessibleRole.Link;
            SetStyle(ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        }

        int Px(int value) { return (int)Math.Round(value * scale); }

        internal void SetPath(string path)
        {
            trail.Clear();
            hovered = null;
            if (!String.IsNullOrEmpty(path) && path != Native.Computer)
            {
                for (var dir = new DirectoryInfo(path); dir != null; dir = dir.Parent)
                {
                    string name = dir.Parent == null ? dir.FullName.TrimEnd(Path.DirectorySeparatorChar) : dir.Name;
                    trail.Insert(0, new Crumb { Label = name, Path = dir.FullName });
                }
            }
            else trail.Add(new Crumb { Label = "此电脑", Path = Native.Computer });
            AccessibleName = path == Native.Computer ? "此电脑" : path;
            Invalidate();
        }

        int WidthFor(Crumb crumb)
        {
            return TextRenderer.MeasureText(crumb.Label, Font, Size.Empty, TextFormatFlags.NoPadding).Width + Px(10);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            visible.Clear();
            if (trail.Count == 0 || Width <= Px(4)) return;
            int separator = Px(14), available = Width;
            int first = trail.Count - 1;
            int used = Math.Min(WidthFor(trail[first]), available);
            while (first > 0 && trail.Count - first < 3)
            {
                int needed = WidthFor(trail[first - 1]) + separator;
                if (used + needed + (first > 1 ? Px(34) : 0) > available) break;
                used += needed;
                first--;
            }
            if (first > 0 && available - used >= Px(34))
                visible.Add(new Crumb { Label = "…", Path = trail[first - 1].Path });
            visible.AddRange(trail.GetRange(first, trail.Count - first));
            int x = 0;
            for (int i = 0; i < visible.Count; i++)
            {
                Crumb part = visible[i];
                int width = Math.Min(WidthFor(part), Math.Max(0, Width - x));
                var box = new Rectangle(x, 0, width, Height);
                part.Hit = box;
                if (hovered != null && part.Path == hovered.Path)
                    using (var fill = new SolidBrush(Color.FromArgb(234, 242, 255))) e.Graphics.FillRectangle(fill, box);
                box.Inflate(-Px(4), 0);
                if (box.Width > 0)
                    TextRenderer.DrawText(e.Graphics, part.Label, Font, box, ink,
                        TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
                x += width;
                if (i < visible.Count - 1)
                {
                    PickerPaint.Icon(e.Graphics, PickerGlyph.Chevron,
                        new Rectangle(x + Px(2), (Height - Px(10)) / 2, Px(10), Px(10)), Color.FromArgb(144, 165, 190));
                    x += separator;
                }
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            var part = visible.Find(c => c.Hit.Contains(e.Location));
            Cursor = part != null && part.Path != trail[trail.Count-1].Path ? Cursors.Hand : Cursors.IBeam;
            if ((hovered == null ? null : hovered.Path) != (part == null ? null : part.Path)) { hovered = part; Invalidate(); }
        }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); hovered = null; Invalidate(); }
        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button != MouseButtons.Left) return;
            var part = visible.Find(c => c.Hit.Contains(e.Location));
            if (part == null || part.Path == trail[trail.Count-1].Path) edit();
            else navigate(part.Path);
        }
    }
}
