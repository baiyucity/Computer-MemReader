using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static partial class MemreaderLauncher
{
    [STAThread]
    private static int Main(string[] arguments)
    {
        string executable = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, RelativeExecutable));
        string directory = Path.GetDirectoryName(executable);
        bool complete = File.Exists(executable)
            && File.Exists(Path.Combine(directory, "resources", "app.asar"))
            && File.Exists(Path.Combine(directory, "resources.pak"))
            && File.Exists(Path.Combine(directory, "icudtl.dat"));

        // Build verification resolves the same relative bundle without opening a window.
        if (arguments.Length == 1 && arguments[0] == "--check-path") return complete ? 0 : 1;

        if (!complete)
        {
            MessageBox.Show(
                "找不到完整的 Memreader 程序。\n\n请保留本启动文件与 release 文件夹的相对位置，或重新打包应用。\n\n预期位置：\n" + executable,
                "Memreader", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }

        try
        {
            ProcessStartInfo start = new ProcessStartInfo(executable);
            start.WorkingDirectory = directory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            using (Process process = Process.Start(start)) { }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show("无法启动 Memreader。\n\n" + error.Message,
                "Memreader", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
