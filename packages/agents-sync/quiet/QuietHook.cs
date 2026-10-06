// Windows-subsystem hook launcher. A bare path is CreateProcess'd by Grok with no cmd window.
// /target:winexe allocates no console; node is started with CREATE_NO_WINDOW.
// The file name picks the script: quiet-session-start.exe runs ../hooks/session-start.mjs.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

class QuietHook {
  const uint CREATE_NO_WINDOW = 0x08000000;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(
    string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir,
    ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static int Main() {
    try { return Run(); }
    catch (Exception ex) { return Fail(ex.Message); }
  }

  static int Run() {
    string exe = Process.GetCurrentProcess().MainModule.FileName;
    string name = Path.GetFileNameWithoutExtension(exe);
    if (!name.StartsWith("quiet-")) return Fail("launcher name does not start with quiet-");
    string scriptName = name.Substring("quiet-".Length) + ".mjs";
    string script = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(exe), "..", "hooks", scriptName));
    if (!File.Exists(script)) return Fail("hook script missing: " + script);
    string node = FindNode();
    if (node == null) return Fail("node.exe is not on PATH");
    return Exec(node, script);
  }

  static string FindNode() {
    string path = Environment.GetEnvironmentVariable("PATH") ?? "";
    string[] dirs = path.Split(';');
    for (int i = 0; i < dirs.Length; i++) {
      string dir = dirs[i].Trim();
      if (dir.Length == 0) continue;
      string candidate = Path.Combine(dir, "node.exe");
      if (File.Exists(candidate)) return candidate;
    }
    return null;
  }

  static bool Valid(IntPtr h) {
    return h != IntPtr.Zero && h != new IntPtr(-1);
  }

  static void Inherit(IntPtr h) {
    if (Valid(h)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  }

  static string Quote(string s) {
    return "\"" + s.Replace("\"", "\\\"") + "\"";
  }

  static int Exec(string node, string script) {
    IntPtr hin = GetStdHandle(-10);
    IntPtr hout = GetStdHandle(-11);
    IntPtr herr = GetStdHandle(-12);
    Inherit(hin);
    Inherit(hout);
    Inherit(herr);
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    if (Valid(hin) && Valid(hout) && Valid(herr)) {
      si.dwFlags = STARTF_USESTDHANDLES;
      si.hStdInput = hin;
      si.hStdOutput = hout;
      si.hStdError = herr;
    }
    PROCESS_INFORMATION pi;
    string cmd = Quote(node) + " " + Quote(script);
    if (!CreateProcess(node, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi))
      return Fail("CreateProcess node failed (" + Marshal.GetLastWin32Error() + ")");
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return (int)code;
  }

  static int Fail(string msg) {
    try { Console.Error.WriteLine("quiet launcher failed: " + msg); } catch { }
    return 1;
  }
}
