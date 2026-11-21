using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class FolderBrowser : IExplorerBrowserEvents, IShellServiceProvider, ICommDlgBrowser, ICommDlgBrowser2, IFolderFilter, IDisposable
    {
        static readonly HashSet<string> ImageTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".jpg", ".jpeg", ".png", ".webp" };
        static readonly int FindDataSize = Marshal.SizeOf(typeof(FindData));
        readonly Panel host;
        readonly bool foldersOnly;
        readonly int thumbnailPixels;
        IExplorerBrowser browser;
        object view;
        IntPtr viewFolder;
        uint cookie;
        bool initialized, hasNativeFilter, disposed, selectionNotificationQueued, details;
        volatile string searchText = String.Empty;
        internal event Action<string> Navigated, Message;
        internal event Action NavigationFailed, SelectionChanged, Activated;
        internal string Current { get; private set; }

        internal FolderBrowser(Panel host, bool foldersOnly, int thumbnailPixels)
        {
            this.host = host;
            this.foldersOnly = foldersOnly;
            this.thumbnailPixels = thumbnailPixels;
        }

        internal void Initialize()
        {
            browser = (IExplorerBrowser)Activator.CreateInstance(Type.GetTypeFromCLSID(Native.BrowserClass, true));
            ((IObjectWithSite)browser).SetSite(this);
            // EBO_NOBORDER is consumed when Initialize creates the ExplorerBrowserControl HWND.
            // The workbench owns navigation history and does not change Explorer's saved view settings.
            browser.SetOptions(0x08 | 0x40 | 0x80);
            var bounds = Bounds();
            // FWF_NOHEADERINALLVIEWS lets the Shell show its sortable header only in details mode.
            const uint headerOnlyInDetails = 0x01000000;
            var settings = new FolderSettings { Mode = foldersOnly ? 4 : 1, Flags = headerOnlyInDetails | 0x00112201 };
            browser.Initialize(host.Handle, ref bounds, ref settings);
            initialized = true;
            browser.Advise(this, out cookie);
            var filterSite = browser as IFolderFilterSite;
            if (filterSite != null)
            {
                filterSite.SetFilter(this);
                hasNativeFilter = true;
            }
            host.Resize += Resize;
        }

        NativeRect Bounds() { return new NativeRect { Right = host.ClientSize.Width, Bottom = host.ClientSize.Height }; }
        void Resize(object sender, EventArgs args) { if (!disposed && initialized) browser.SetRect(IntPtr.Zero, Bounds()); }

        internal void Navigate(string path)
        {
            IShellItem item;
            Native.SHCreateItemFromParsingName(path, IntPtr.Zero, ref Native.ShellItemId, out item);
            try { browser.BrowseToObject(item, 1); } // SBSP_SAMEBROWSER
            finally { Marshal.ReleaseComObject(item); }
        }

        internal void FocusView()
        {
            if (view != null) ((IShellView)view).UIActivate(2); // SVUIA_ACTIVATE_FOCUS
        }

        internal bool Translate(ref System.Windows.Forms.Message message)
        {
            var input = browser as IInputObject;
            if (input == null) return false;
            uint position = Native.GetMessagePos();
            var native = new NativeMessage { Window = message.HWnd, Message = (uint)message.Msg, WParam = message.WParam, LParam = message.LParam,
                Time = (uint)Native.GetMessageTime(), X = (short)position, Y = (short)(position >> 16) };
            return input.TranslateAcceleratorIO(ref native) == 0;
        }

        internal void SetDetails(bool showDetails)
        {
            details = showDetails;
            if (view != null) ((IFolderView2)view).SetViewModeAndIconSize(details ? 4 : 1, details ? -1 : thumbnailPixels);
        }

        internal void Search(string filter)
        {
            if (view == null || searchText == filter) return;
            searchText = filter;
            ((IShellView)view).Refresh();
        }

        internal int SelectionCount()
        {
            int count;
            return view != null && ((IFolderView2)view).ItemCount(1, out count) >= 0 ? count : 0;
        }

        internal string FirstSelectedPath()
        {
            var folder = view as IFolderView2;
            int index;
            if (folder == null || folder.GetSelectedItem(-1, out index) != 0) return null;
            IShellItem item;
            if (folder.GetItem(index, ref Native.ShellItemId, out item) < 0 || item == null) return null;
            try
            {
                string path;
                return item.GetDisplayName(Native.FileSystemPath, out path) >= 0 && !String.IsNullOrEmpty(path) ? path : null;
            }
            finally { Marshal.ReleaseComObject(item); }
        }

        // Request only the selection. Listing, thumbnails and incremental enumeration all stay in the Shell.
        internal string[] Selection(bool openFolder)
        {
            if (view == null) return null;
            if (SelectionCount() == 0)
            {
                if (!openFolder && foldersOnly && Current != null && Current != Native.Computer) return new[] { Current };
                return null;
            }
            IShellItemArray items;
            Marshal.ThrowExceptionForHR(((IFolderView2)view).GetSelection(false, out items));
            if (items == null) return null;
            try
            {
                uint count;
                items.GetCount(out count);
                var paths = new List<string>((int)count);
                for (uint i = 0; i < count; ++i)
                {
                    IShellItem item;
                    items.GetItemAt(i, out item);
                    try
                    {
                        string path;
                        uint attributes;
                        item.GetAttributes(Native.Folder | Native.Stream, out attributes);
                        bool folder = (attributes & (Native.Folder | Native.Stream)) == Native.Folder;
                        if (item.GetDisplayName(Native.FileSystemPath, out path) < 0 || String.IsNullOrEmpty(path))
                            throw new InvalidOperationException("请选择磁盘上的图片或文件夹。");
                        if (folder && count == 1 && (openFolder || !foldersOnly))
                        {
                            Navigate(path);
                            return null;
                        }
                        if (folder != foldersOnly || (!folder && !ImageTypes.Contains(Path.GetExtension(path))))
                            throw new InvalidOperationException(foldersOnly ? "请选择文件夹。" : "请选择 JPG、PNG 或 WebP 图片。");
                        paths.Add(path);
                    }
                    finally { Marshal.ReleaseComObject(item); }
                }
                return paths.Count == 0 ? null : paths.ToArray();
            }
            finally { Marshal.ReleaseComObject(items); }
        }

        public int QueryService(ref Guid service, ref Guid iid, out IntPtr result)
        {
            result = IntPtr.Zero;
            if (service == typeof(ICommDlgBrowser).GUID)
            {
                if (iid == typeof(ICommDlgBrowser).GUID) result = Marshal.GetComInterfaceForObject(this, typeof(ICommDlgBrowser));
                if (iid == typeof(ICommDlgBrowser2).GUID) result = Marshal.GetComInterfaceForObject(this, typeof(ICommDlgBrowser2));
            }
            return result == IntPtr.Zero ? unchecked((int)0x80004002) : 0;
        }

        // Defer user actions until the Shell has returned from its COM callback.
        void Post(Action action)
        {
            if (!disposed && action != null && host.IsHandleCreated) host.BeginInvoke((MethodInvoker)delegate { if (!disposed) action(); });
        }

        public int OnDefaultCommand(IntPtr shellView) { Post(Activated); return 0; }
        public int OnStateChange(IntPtr shellView, uint change)
        {
            if (change == 2 && !selectionNotificationQueued)
            {
                selectionNotificationQueued = true;
                Post(delegate { selectionNotificationQueued = false; if (SelectionChanged != null) SelectionChanged(); });
            }
            return 0;
        }
        public int Notify(IntPtr shellView, uint notification) { return 0; }
        public int GetDefaultMenuText(IntPtr shellView, IntPtr text, int capacity) { return unchecked((int)0x80004001); }
        // CDB2GVF_NOINCLUDEITEM would bypass IFolderFilter as well as IncludeObject.
        public int GetViewFlags(out uint flags) { flags = 0; return 0; }
        public int IncludeObject(IntPtr shellView, IntPtr child) { return ShouldShow(viewFolder, IntPtr.Zero, child); }
        public int GetEnumFlags(IntPtr folder, IntPtr absoluteFolder, IntPtr window, out uint flags)
        {
            flags = foldersOnly ? 0x20u : 0x60u; // SHCONTF_FOLDERS [| SHCONTF_NONFOLDERS]
            return 0;
        }
        public int ShouldShow(IntPtr folder, IntPtr absoluteFolder, IntPtr child)
        {
            // The standard filesystem Shell folder supplies cached WIN32_FIND_DATA for a child PIDL.
            // Do not open/stat every file while browsing a large directory.
            FindData data;
            string term = searchText;
            if (folder == IntPtr.Zero) return 0;
            if (Native.SHGetDataFromIDListW(folder, child, 1, out data, FindDataSize) < 0)
            {
                if (term.Length == 0) return 0;
                IShellItem item;
                if (Native.SHCreateItemWithParent(IntPtr.Zero, folder, child, ref Native.ShellItemId, out item) < 0) return 1;
                try { string name; return item.GetDisplayName(0, out name) >= 0 && name.IndexOf(term, StringComparison.CurrentCultureIgnoreCase) >= 0 ? 0 : 1; }
                finally { Marshal.ReleaseComObject(item); }
            }
            if ((data.Attributes & 0x10) == 0 && (foldersOnly || !ImageTypes.Contains(Path.GetExtension(data.Name)))) return 1;
            return term.Length == 0 || data.Name.IndexOf(term, StringComparison.CurrentCultureIgnoreCase) >= 0 ? 0 : 1;
        }

        public int OnNavigationPending(IntPtr pidl)
        {
            string name;
            if (Native.SHGetNameFromIDList(pidl, Native.FileSystemPath, out name) < 0 || String.IsNullOrEmpty(name))
            {
                if (Native.SHGetNameFromIDList(pidl, Native.AbsoluteParsingName, out name) < 0 || !String.Equals(name, Native.Computer, StringComparison.OrdinalIgnoreCase)) return unchecked((int)0x80070005);
            }
            if (!String.Equals(name, Current, StringComparison.OrdinalIgnoreCase)) searchText = String.Empty;
            return 0;
        }
        public int OnViewCreated(IntPtr shellView)
        {
            try
            {
                ReleaseView();
                view = Marshal.GetObjectForIUnknown(shellView);
                ((IFolderView2)view).GetFolder(ref Native.ShellFolderId, out viewFolder);
                SetDetails(details);
                return 0;
            }
            catch (Exception error) { Post(delegate { if (Message != null) Message(error.Message); }); return Marshal.GetHRForException(error); }
        }
        public int OnNavigationComplete(IntPtr pidl)
        {
            string path;
            if (Native.SHGetNameFromIDList(pidl, Native.FileSystemPath, out path) < 0 || String.IsNullOrEmpty(path)) path = Native.Computer;
            Current = path;
            Post(delegate { if (Navigated != null) Navigated(path); });
            return 0;
        }
        public int OnNavigationFailed(IntPtr pidl) { Post(NavigationFailed); return 0; }

        void ReleaseView()
        {
            if (viewFolder != IntPtr.Zero) { Marshal.Release(viewFolder); viewFolder = IntPtr.Zero; }
            if (view != null) { Marshal.ReleaseComObject(view); view = null; }
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            host.Resize -= Resize;
            if (browser == null) return;
            try
            {
                if (cookie != 0) browser.Unadvise(cookie);
                if (hasNativeFilter) ((IFolderFilterSite)browser).SetFilter(null);
                ((IObjectWithSite)browser).SetSite(null);
            }
            finally
            {
                ReleaseView();
                try { if (initialized) browser.Destroy(); }
                finally { Marshal.ReleaseComObject(browser); browser = null; }
            }
        }
    }
}
