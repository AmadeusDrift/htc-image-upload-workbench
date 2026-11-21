using System;
using System.Runtime.InteropServices;

namespace Yuntu.Picker
{
    // Interface slots follow the Windows SDK (ShObjIdl_core.h). Only used slots
    // have managed signatures. The others must stay in SDK order for COM.
    [ComImport, Guid("DFD3B6B5-C10C-4BE9-85F6-A66969F402F6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IExplorerBrowser
    {
        void Initialize(IntPtr parent, ref NativeRect bounds, ref FolderSettings settings);
        void Destroy();
        void SetRect(IntPtr deferredWindowPositions, NativeRect bounds);
        void SetPropertyBag([MarshalAs(UnmanagedType.LPWStr)] string name);
        void SetEmptyText([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFolderSettings(ref FolderSettings settings);
        void Advise(IExplorerBrowserEvents events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void BrowseToIDList(IntPtr pidl, uint flags);
        void BrowseToObject([MarshalAs(UnmanagedType.IUnknown)] object item, uint flags);
    }

    [ComImport, Guid("FC4801A3-2BA9-11CF-A229-00AA003D7352"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IObjectWithSite
    {
        void SetSite([MarshalAs(UnmanagedType.IUnknown)] object site);
        void GetSite(ref Guid iid, out IntPtr site);
    }

    [ComImport, Guid("68284FAA-6A48-11D0-8C78-00C04FD918B4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IInputObject
    {
        [PreserveSig] int UIActivateIO([MarshalAs(UnmanagedType.Bool)] bool active, IntPtr message);
        [PreserveSig] int HasFocusIO();
        [PreserveSig] int TranslateAcceleratorIO(ref NativeMessage message);
    }

    [ComImport, Guid("000214E3-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellView
    {
        void GetWindow(out IntPtr window);
        void ContextSensitiveHelp();
        void TranslateAccelerator();
        void EnableModeless();
        void UIActivate(uint state);
        void Refresh();
    }

    [ComImport, Guid("1AF3A467-214F-4298-908E-06B03E0B39F9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFolderView2
    {
        void GetCurrentViewMode();
        void SetCurrentViewMode();
        void GetFolder(ref Guid iid, out IntPtr folder);
        void Item();
        [PreserveSig] int ItemCount(uint flags, out int count);
        void Items();
        void GetSelectionMarkedItem();
        void GetFocusedItem();
        void GetItemPosition();
        void GetSpacing();
        void GetDefaultSpacing();
        void GetAutoArrange();
        void SelectItem(int index, uint flags);
        void SelectAndPositionItems();
        void SetGroupBy();
        void GetGroupBy();
        void SetViewProperty();
        void GetViewProperty();
        void SetTileViewProperties();
        void SetExtendedTileViewProperties();
        void SetText();
        void SetCurrentFolderFlags();
        void GetCurrentFolderFlags();
        void GetSortColumnCount();
        void SetSortColumns();
        void GetSortColumns();
        [PreserveSig] int GetItem(int index, ref Guid iid, out IShellItem item);
        void GetVisibleItem();
        [PreserveSig] int GetSelectedItem(int startAfter, out int index);
        [PreserveSig] int GetSelection([MarshalAs(UnmanagedType.Bool)] bool useFolder, out IShellItemArray items);
        void GetSelectionState();
        void InvokeVerbOnSelection();
        void SetViewModeAndIconSize(int mode, int pixels);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler();
        void GetParent();
        [PreserveSig] int GetDisplayName(uint format, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint value);
    }

    [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemArray
    {
        void BindToHandler();
        void GetPropertyStore();
        void GetPropertyDescriptionList();
        void GetAttributes();
        void GetCount(out uint count);
        void GetItemAt(uint index, out IShellItem item);
    }

    [ComImport, Guid("C0A651F5-B48B-11D2-B5ED-006097C686F6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFolderFilterSite
    {
        void SetFilter([MarshalAs(UnmanagedType.IUnknown)] object filter);
    }

    [ComVisible(true), Guid("9CC22886-DC8E-11D2-B1D0-00C04F8EEB3E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFolderFilter
    {
        [PreserveSig] int ShouldShow(IntPtr folder, IntPtr absoluteFolder, IntPtr child);
        [PreserveSig] int GetEnumFlags(IntPtr folder, IntPtr absoluteFolder, IntPtr window, out uint flags);
    }

    [ComVisible(true), Guid("361BBDC7-E6EE-4E13-BE58-58E2240C810F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IExplorerBrowserEvents
    {
        [PreserveSig] int OnNavigationPending(IntPtr folder);
        [PreserveSig] int OnViewCreated(IntPtr view);
        [PreserveSig] int OnNavigationComplete(IntPtr folder);
        [PreserveSig] int OnNavigationFailed(IntPtr folder);
    }

    [ComVisible(true), Guid("6D5140C1-7436-11CE-8034-00AA006009FA"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellServiceProvider
    {
        [PreserveSig] int QueryService(ref Guid service, ref Guid iid, out IntPtr result);
    }

    [ComVisible(true), Guid("000214F1-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICommDlgBrowser
    {
        [PreserveSig] int OnDefaultCommand(IntPtr view);
        [PreserveSig] int OnStateChange(IntPtr view, uint change);
        [PreserveSig] int IncludeObject(IntPtr view, IntPtr child);
    }

    [ComVisible(true), Guid("10339516-2894-11D2-9039-00C04F8EEB3E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICommDlgBrowser2
    {
        [PreserveSig] int OnDefaultCommand(IntPtr view);
        [PreserveSig] int OnStateChange(IntPtr view, uint change);
        [PreserveSig] int IncludeObject(IntPtr view, IntPtr child);
        [PreserveSig] int Notify(IntPtr view, uint notification);
        [PreserveSig] int GetDefaultMenuText(IntPtr view, IntPtr text, int capacity);
        [PreserveSig] int GetViewFlags(out uint flags);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct FolderSettings { public int Mode; public uint Flags; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeMessage
    {
        public IntPtr Window;
        public uint Message;
        public IntPtr WParam, LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct FindData
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint SizeHigh, SizeLow, Reserved0, Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
    }

    internal static class Native
    {
        internal static readonly Guid BrowserClass = new Guid("71F96385-DDD6-48D3-A0C1-AE06E8B055FB");
        internal static Guid ShellItemId = typeof(IShellItem).GUID;
        internal static Guid ShellFolderId = new Guid("000214E6-0000-0000-C000-000000000046");
        internal const uint FileSystemPath = 0x80058000, AbsoluteParsingName = 0x80028000;
        internal const uint Folder = 0x20000000, Stream = 0x00400000;
        internal const string Computer = "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}";

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        internal static extern void SHCreateItemFromParsingName(string name, IntPtr context, ref Guid iid, out IShellItem item);
        [DllImport("shell32.dll")] internal static extern int SHCreateItemWithParent(IntPtr absoluteParent, IntPtr folder, IntPtr child, ref Guid iid, out IShellItem item);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern int SHGetNameFromIDList(IntPtr pidl, uint format, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, [MarshalAs(UnmanagedType.LPWStr)] out string path);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        internal static extern int SHGetDataFromIDListW(IntPtr folder, IntPtr child, int format, out FindData data, int size);
        [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsChild(IntPtr parent, IntPtr child);
        [DllImport("user32.dll")] internal static extern bool IsWindowEnabled(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool EnableWindow(IntPtr window, bool enable);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool ReleaseCapture();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string value);
        [DllImport("user32.dll")] internal static extern int GetMessageTime();
        [DllImport("user32.dll")] internal static extern uint GetMessagePos();
    }
}
