using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32.SafeHandles;

[assembly: AssemblyTitle("云图工作台安装进度")]
[assembly: AssemblyProduct("云图工作台")]

namespace Yuntu.Setup
{
    internal enum Stage { Preparing = 1, Extracting, Writing, Finished, Close }

    internal static class Native
    {
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll")] internal static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll")] internal static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] internal static extern bool IsWindowEnabled(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] internal static extern IntPtr GetLastActivePopup(IntPtr window);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetProp(IntPtr window, string name);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool SetProp(IntPtr window, string name, IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr RemoveProp(IntPtr window, string name);
    }

    internal sealed class SetupHost : IDisposable
    {
        private const string Ready = "Yuntu.Setup.Ready";
        private readonly IntPtr window;
        private readonly uint parentPid;
        private readonly SafeWaitHandle process;
        private readonly IntPtr viewPid = new IntPtr((long)Native.GetCurrentProcessId());

        internal SetupHost(IntPtr window)
        {
            this.window = window;
            Native.GetWindowThreadProcessId(window, out parentPid);
            const uint synchronize = 0x100000;
            process = Native.OpenProcess(synchronize, false, parentPid);
        }

        internal bool IsAlive
        {
            get
            {
                uint currentPid;
                const uint waitTimeout = 258;
                return !process.IsInvalid && Native.WaitForSingleObject(process, 0) == waitTimeout &&
                    Native.GetWindowThreadProcessId(window, out currentPid) != 0 && currentPid == parentPid;
            }
        }

        internal bool HasModalWindow
        {
            get
            {
                IntPtr popup = Native.GetLastActivePopup(window);
                return !Native.IsWindowEnabled(window) ||
                    (popup != IntPtr.Zero && popup != window && Native.IsWindowVisible(popup));
            }
        }

        internal Stage ReadStage()
        {
            long value = Native.GetProp(window, "Yuntu.Setup.Stage").ToInt64();
            return value >= (int)Stage.Preparing && value <= (int)Stage.Close ? (Stage)value : Stage.Preparing;
        }

        internal int ReadPercent()
        {
            long encoded = Native.GetProp(window, "Yuntu.Setup.Percent").ToInt64();
            return encoded >= 1 && encoded <= 101 ? (int)encoded - 1 : -1;
        }

        internal bool SignalReady() { return Native.SetProp(window, Ready, viewPid); }

        public void Dispose()
        {
            if (IsAlive && Native.GetProp(window, Ready) == viewPid) Native.RemoveProp(window, Ready);
            process.Dispose();
        }
    }

    internal sealed class ProgressView
    {
        internal readonly Window Window;
        private readonly SetupHost host;
        private readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(100) };
        private readonly string[] headlines;
        private readonly ContentControl[] steps;
        private readonly Border[] lines;
        private readonly TextBlock headline, percent, metricCaption;
        private readonly ProgressBar progress;
        private Stage displayedStage;
        private int displayedPercent = -1;
        private bool ready, closing, hiddenForModal;

        private T Element<T>(string name) where T : class { return (T)Window.FindName(name); }

        internal ProgressView(SetupHost host, string version, bool update, string destination)
        {
            this.host = host;
            Assembly assembly = typeof(ProgressView).Assembly;
            using (Stream markup = assembly.GetManifestResourceStream("Yuntu.Setup.ProgressWindow.xaml"))
                Window = (Window)XamlReader.Load(markup);
            using (Stream logo = assembly.GetManifestResourceStream("Yuntu.Setup.Brand.png"))
            {
                BitmapFrame brand = BitmapFrame.Create(logo, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                brand.Freeze();
                Window.Icon = brand;
                Element<Image>("Brand").Source = brand;
            }
            Window.MaxWidth = Math.Max(1, SystemParameters.WorkArea.Width - 24);
            string mode = update ? "更新程序" : "安装程序";
            Window.Title = "云图工作台" + mode;
            Element<TextBlock>("Mode").Text = mode;
            Element<TextBlock>("Version").Text = "版本 " + version;
            TextBlock location = Element<TextBlock>("Destination");
            try { location.Text = Path.GetFullPath(destination); }
            catch (PathTooLongException) { location.Text = destination; }
            location.ToolTip = location.Text;
            headlines = new[] {
                update ? "正在准备更新" : "正在准备安装",
                update ? "正在解压更新文件" : "正在解压安装文件",
                update ? "正在写入更新文件" : "正在写入程序文件",
                update ? "更新完成" : "安装完成"
            };
            headline = Element<TextBlock>("Headline");
            percent = Element<TextBlock>("Percent");
            metricCaption = Element<TextBlock>("MetricCaption");
            progress = Element<ProgressBar>("Progress");
            steps = new[] { Element<ContentControl>("PrepareStep"), Element<ContentControl>("ExtractStep"),
                            Element<ContentControl>("WriteStep"), Element<ContentControl>("FinishStep") };
            lines = new[] { Element<Border>("PrepareLine"), Element<Border>("ExtractLine"), Element<Border>("WriteLine") };

            Stage initial = host.ReadStage();
            if (initial != Stage.Close) RenderStage(initial, initial == Stage.Extracting ? host.ReadPercent() : -1);
            Element<Grid>("DragArea").MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e)
            {
                if (e.LeftButton == MouseButtonState.Pressed) Window.DragMove();
            };
            Element<Button>("Minimize").Click += delegate { Window.WindowState = WindowState.Minimized; };
            Window.ContentRendered += OnRendered;
            Window.Closing += OnClosing;
            Application.Current.SessionEnding += delegate { closing = true; };
            SystemParameters.StaticPropertyChanged += OnSystemSettingChanged;
            timer.Tick += delegate { Refresh(); };
            Window.Closed += delegate {
                timer.Stop();
                SystemParameters.StaticPropertyChanged -= OnSystemSettingChanged;
            };
        }

        private void OnRendered(object sender, EventArgs args)
        {
            if (ready) return;
            if (!host.IsAlive || host.ReadStage() == Stage.Close || !host.SignalReady())
            {
                CloseFromHost();
                return;
            }
            ready = true;
            timer.Start();
            Refresh();
        }

        private void Refresh()
        {
            if (!host.IsAlive) { CloseFromHost(); return; }
            Stage stage = host.ReadStage();
            if (stage == Stage.Close) { CloseFromHost(); return; }
            int value = stage == Stage.Extracting ? host.ReadPercent() : -1;
            if (displayedStage != stage || displayedPercent != value) RenderStage(stage, value);
            bool modal = host.HasModalWindow;
            if (modal == hiddenForModal) return;
            hiddenForModal = modal;
            if (modal) Window.Hide(); else Window.Show();
        }

        private void RenderStage(Stage stage, int value)
        {
            int index = (int)stage - 1;
            if (stage != displayedStage)
            {
                headline.Text = headlines[index];
                for (int i = 0; i < steps.Length; i++)
                {
                    bool done = i < index || stage == Stage.Finished;
                    steps[i].Tag = done ? "done" : (i == index ? "current" : null);
                    AutomationProperties.SetItemStatus(steps[i], done ? "已完成" : (i == index ? "当前阶段" : "待开始"));
                    if (i < lines.Length)
                        lines[i].Background = (Brush)Window.FindResource(done ? "CompletedLine" : "UpcomingLine");
                }
            }
            displayedStage = stage;
            displayedPercent = value;
            bool measured = stage == Stage.Extracting && value >= 0;
            percent.Text = measured ? value.ToString(CultureInfo.InvariantCulture) + "%" : "";
            percent.Visibility = metricCaption.Visibility = measured ? Visibility.Visible : Visibility.Collapsed;
            progress.Value = stage == Stage.Finished ? 100 : Math.Max(0, value);
            bool waiting = !measured && stage != Stage.Finished;
            if (progress.IsIndeterminate != waiting)
            {
                progress.IsIndeterminate = waiting;
                UpdateMotion();
            }
        }

        private void OnSystemSettingChanged(object sender, PropertyChangedEventArgs args)
        {
            if (string.IsNullOrEmpty(args.PropertyName) || args.PropertyName == "ClientAreaAnimation") UpdateMotion();
        }

        private void UpdateMotion()
        {
            DoubleAnimation pulse = null;
            if (progress.IsIndeterminate && SystemParameters.ClientAreaAnimation)
                pulse = new DoubleAnimation(0.66, 1, TimeSpan.FromSeconds(1.2)) {
                    AutoReverse = true, RepeatBehavior = RepeatBehavior.Forever
                };
            progress.BeginAnimation(UIElement.OpacityProperty, pulse);
        }

        private void OnClosing(object sender, CancelEventArgs args)
        {
            if (closing || !host.IsAlive || host.ReadStage() == Stage.Close) return;
            // The view cannot cancel an installation. The taskbar can restore it at any time.
            args.Cancel = true;
            Window.WindowState = WindowState.Minimized;
        }

        private void CloseFromHost() { closing = true; Window.Close(); }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            long hwnd;
            if (args.Length != 4 || !long.TryParse(args[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out hwnd) ||
                hwnd == 0 || (args[2] != "install" && args[2] != "update") || string.IsNullOrWhiteSpace(args[3])) return 2;
            try
            {
                using (var host = new SetupHost(new IntPtr(hwnd)))
                {
                    if (!host.IsAlive) return 2;
                    if (host.ReadStage() == Stage.Close) return 0;
                    AppContext.SetSwitch("Switch.System.Windows.DoNotScaleForDpiChanges", false);
                    var app = new Application();
                    var view = new ProgressView(host, args[1], args[2] == "update", args[3]);
                    return app.Run(view.Window);
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.GetBaseException().Message);
                return 1;
            }
        }
    }
}
