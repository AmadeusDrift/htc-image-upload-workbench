using System;
using System.Globalization;
using System.IO;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Windows.Forms;

namespace Yuntu.Picker
{
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                long window;
                if ((args.Length != 2 && args.Length != 3) || (args[0] != "files" && args[0] != "folders") ||
                    !Int64.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out window))
                    throw new ArgumentException("Expected: ShellPicker.exe files|folders ownerHwnd [initialDirectory]");
                var owner = window == 0 ? null : new OwnerWindow(new IntPtr(window));
                if (owner != null && !owner.Alive()) throw new ArgumentException("The owner window no longer exists.");
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string[] result;
                using (var picker = new PickerWindow(args[0] == "folders", owner, args.Length == 3 ? args[2] : null))
                {
                    bool disableOwner = owner != null && Native.IsWindowEnabled(owner.Handle);
                    try
                    {
                        if (disableOwner) Native.EnableWindow(owner.Handle, false);
                        if (owner == null) picker.ShowDialog(); else picker.ShowDialog(owner);
                        if (picker.Failure != null) throw picker.Failure;
                        result = picker.Paths;
                    }
                    finally
                    {
                        if (disableOwner && owner.Alive()) { Native.EnableWindow(owner.Handle, true); Native.SetForegroundWindow(owner.Handle); }
                    }
                }
                using (var output = Console.OpenStandardOutput())
                {
                    var serializer = new DataContractJsonSerializer(typeof(string[]), new DataContractJsonSerializerSettings { MaxItemsInObjectGraph = Int32.MaxValue });
                    serializer.WriteObject(output, result);
                    output.Flush();
                }
                return 0;
            }
            catch (Exception error)
            {
                using (var writer = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false))) writer.WriteLine(error.GetBaseException().Message);
                return 1;
            }
        }
    }
}
