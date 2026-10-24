using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ReelEdit;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        Log.Write("start " + string.Join(" ", args));
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Fatal(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Fatal(e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) => { Log.Write("unobserved: " + e.Exception); e.SetObserved(); };
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm(args));
        Log.Write("exit");
    }
    static void Fatal(Exception ex)
    {
        Log.Write("FATAL: " + ex);
        MessageBox.Show("Reel Edit hit an unexpected error:\n\n" + ex?.Message + "\n\nDetails were written to " + Log.FilePath, "Reel Edit", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

static class Log
{
    public static readonly string FilePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReelEdit", "log.txt");
    public static void Write(string msg)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
            if (File.Exists(FilePath) && new FileInfo(FilePath).Length > 1_000_000) File.Delete(FilePath);
            File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {msg}{Environment.NewLine}");
        }
        catch { }
    }
}

/// <summary>
/// Native shell for the Reel Edit web app. Hosts it in WebView2 (the Edge/Chromium engine) on a
/// secure https origin so WebCodecs, hardware decode/encode and the GPU path are always available,
/// turns off background throttling so proxies and exports keep full speed when minimised, and swaps
/// browser downloads for native Save dialogs.
/// </summary>
sealed class MainForm : Form
{
    const string Host = "reeledit.local";
    const string FileHost = "files.reeledit.local"; // not folder-mapped, so WebResourceRequested owns it
    // REELEDIT_DATA_DIR lets a second (test) instance run with its own engine profile and storage
    static readonly string DataDir = Environment.GetEnvironmentVariable("REELEDIT_DATA_DIR") is { Length: > 0 } d ? d
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ReelEdit");

    readonly WebView2 web = new();
    readonly List<string> pendingOpen;
    readonly Dictionary<string, string> served = new(); // token → local file path, for files opened from Explorer
    readonly bool devTools;
    string lastSaveDir;

    public MainForm(string[] args)
    {
        devTools = args.Contains("--devtools");
        pendingOpen = args.Where(File.Exists).Select(Path.GetFullPath).ToList();
        Text = "Reel Edit";
        BackColor = Color.FromArgb(12, 13, 16);
        try { Icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath); } catch { }
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1600, 960);
        MinimumSize = new Size(1000, 640);
        WindowState = FormWindowState.Maximized;
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = BackColor;
        Controls.Add(web);
        Load += async (_, _) =>
        {
            try { await InitAsync(); }
            catch (Exception ex) { Log.Write("init failed: " + ex); MessageBox.Show(this, "Reel Edit couldn't start its browser engine:\n\n" + ex.Message, "Reel Edit", MessageBoxButtons.OK, MessageBoxIcon.Error); Close(); }
        };
        FormClosed += (_, e) => Log.Write("closed: " + e.CloseReason);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int on = 1; // dark title bar to match the app
        DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int));
    }

    async Task InitAsync()
    {
        var webDir = Path.Combine(DataDir, "web");
        Directory.CreateDirectory(webDir);
        ExtractPage(webDir);

        var flags = new List<string>
        {
            "--disable-background-timer-throttling",   // exports/proxies keep going when minimised
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--enable-gpu-rasterization",
            "--enable-zero-copy",
            "--ignore-gpu-blocklist",
            "--autoplay-policy=no-user-gesture-required",
            "--js-flags=--max-old-space-size=8192",      // room for in-RAM proxies on long projects
        };
        var dbgPort = Environment.GetEnvironmentVariable("REELEDIT_DEBUG_PORT");
        if (!string.IsNullOrEmpty(dbgPort)) flags.Add("--remote-debugging-port=" + dbgPort);

        CoreWebView2Environment env;
        try
        {
            env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"),
                new CoreWebView2EnvironmentOptions(string.Join(" ", flags)));
            await web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            if (MessageBox.Show(this, "Reel Edit needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\nOpen the download page now?",
                    "Reel Edit", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
            Close();
            return;
        }

        var cw = web.CoreWebView2;
        var s = cw.Settings;
        s.AreDefaultContextMenusEnabled = devTools;   // the app draws its own menus
        s.AreBrowserAcceleratorKeysEnabled = false;   // Ctrl+S/O/E/P etc. go to the editor, not the browser
        s.IsZoomControlEnabled = false;               // Ctrl+wheel zooms the timeline, not the page
        s.IsPinchZoomEnabled = false;
        s.IsStatusBarEnabled = false;
        s.IsSwipeNavigationEnabled = false;
        s.IsGeneralAutofillEnabled = false;
        s.IsPasswordAutosaveEnabled = false;
        s.AreDevToolsEnabled = devTools;

        cw.SetVirtualHostNameToFolderMapping(Host, webDir, CoreWebView2HostResourceAccessKind.Allow);
        cw.AddWebResourceRequestedFilter($"https://{FileHost}/*", CoreWebView2WebResourceContext.All);
        cw.WebResourceRequested += ServeOpenedFile;
        cw.DownloadStarting += OnDownloadStarting;
        cw.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var u) && (u.Scheme == "https" || u.Scheme == "http"))
                Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
        };
        cw.NavigationStarting += (_, e) =>
        {   // never navigate away from the app (e.g. a file dropped outside the drop zones)
            if (!e.Uri.StartsWith($"https://{Host}/", StringComparison.OrdinalIgnoreCase)) e.Cancel = true;
        };
        cw.NavigationCompleted += (_, e) => { Log.Write("page loaded: " + e.IsSuccess + " " + e.WebErrorStatus); if (e.IsSuccess) SendPendingFiles(); };
        cw.ProcessFailed += (_, e) =>
        {
            Log.Write($"webview process failed: {e.ProcessFailedKind} {e.Reason} exit={e.ExitCode} {e.ProcessDescription}");
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                BeginInvoke(() =>
                {
                    if (MessageBox.Show(this, "The editor's browser engine stopped (" + e.ProcessFailedKind + ").\nYour timeline is autosaved. Reload now?", "Reel Edit", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    { try { web.CoreWebView2.Reload(); } catch { Application.Restart(); } }
                });
        };
        Log.Write("webview ready " + env.BrowserVersionString);
        cw.Navigate($"https://{Host}/index.html");
    }

    static void ExtractPage(string webDir)
    {
        using var res = Assembly.GetExecutingAssembly().GetManifestResourceStream("ReelEdit.html");
        using var ms = new MemoryStream();
        res.CopyTo(ms);
        var bytes = ms.ToArray();
        var target = Path.Combine(webDir, "index.html");
        if (!File.Exists(target) || !File.ReadAllBytes(target).AsSpan().SequenceEqual(bytes))
            File.WriteAllBytes(target, bytes);
    }

    /* ---------- files passed on the command line / dropped on the exe ---------- */
    void SendPendingFiles()
    {
        if (pendingOpen.Count == 0) return;
        var files = pendingOpen.Select(p =>
        {
            var token = Guid.NewGuid().ToString("N");
            served[token] = p;
            return new { url = $"https://{FileHost}/{token}", name = Path.GetFileName(p) };
        }).ToList();
        pendingOpen.Clear();
        Log.Write("open " + files.Count + " file(s)");
        web.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "open", files }));
    }

    void ServeOpenedFile(object sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var token = e.Request.Uri.Split('/').Last();
        Log.Write("serve " + token + " " + (served.TryGetValue(token, out var lp) ? lp : "?"));
        if (!served.TryGetValue(token, out var path) || !File.Exists(path))
        {
            e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", $"Access-Control-Allow-Origin: https://{Host}");
            return;
        }
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 20, FileOptions.SequentialScan);
        e.Response = web.CoreWebView2.Environment.CreateWebResourceResponse(fs, 200, "OK",
            $"Content-Type: application/octet-stream\r\nContent-Length: {fs.Length}\r\nAccess-Control-Allow-Origin: https://{Host}");
    }

    /* ---------- downloads → native Save dialog ---------- */
    void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
    {
        var deferral = e.GetDeferral();
        var suggested = Path.GetFileName(e.ResultFilePath);
        BeginInvoke(() =>
        {
            using (deferral)
            {
                var ext = Path.GetExtension(suggested).ToLowerInvariant();
                using var dlg = new SaveFileDialog
                {
                    FileName = suggested,
                    InitialDirectory = lastSaveDir ?? Environment.GetFolderPath(ext == ".json" ? Environment.SpecialFolder.MyDocuments : ext == ".png" ? Environment.SpecialFolder.MyPictures : Environment.SpecialFolder.MyVideos),
                    Filter = ext switch
                    {
                        ".mp4" => "MP4 video (*.mp4)|*.mp4",
                        ".webm" => "WebM video (*.webm)|*.webm",
                        ".json" => "Reel Edit project (*.reel.json)|*.reel.json;*.json",
                        ".png" => "PNG image (*.png)|*.png",
                        _ => "All files (*.*)|*.*",
                    },
                    OverwritePrompt = true,
                    Title = ext == ".json" ? "Save project" : ext == ".png" ? "Save frame" : "Save exported video",
                };
                if (dlg.ShowDialog(this) == DialogResult.OK)
                {
                    e.ResultFilePath = dlg.FileName;
                    e.Handled = true; // no browser download bubble
                    lastSaveDir = Path.GetDirectoryName(dlg.FileName);
                }
                else e.Cancel = true;
            }
        });
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
