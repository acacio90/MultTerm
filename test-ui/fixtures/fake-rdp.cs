// Cliente RDP falso para os testes de interface. Imita o wfreerdp no modo encaixado:
// - lê a senha da entrada padrão (/from-stdin:force);
// - cria uma janela Win32 WS_CHILD | WS_BORDER filha da janela de /parent-window (wf_client.c);
// - perde a entrada ao receber WM_KILLFOCUS e volta a aceitá-la só com WM_SETFOCUS
//   (FreeRDP_SuspendInput em wf_event.c), para teclado e mouse;
// - num gancho de teclado de baixo nível, só aceita teclas quando o foco da thread em primeiro
//   plano é a janela-pai (wf_ll_kbd_proc).
// Registra tudo em FAKE_RDP_LOG para o teste conferir.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class FakeRdp
{
    delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClassEx
    {
        public int cbSize, style;
        public WndProc lpfnWndProc;
        public int cbClsExtra, cbWndExtra;
        public IntPtr hInstance, hIcon, hCursor, hbrBackground;
        public string lpszMenuName, lpszClassName;
        public IntPtr hIconSm;
    }
    [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr hwnd; public uint message; public IntPtr w, l; public uint time; public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)]
    struct GuiThreadInfo
    {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public Rect rcCaret;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassEx(ref WndClassEx c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(int ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out Msg m, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg m);
    [DllImport("user32.dll")] static extern IntPtr SetCapture(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint tid);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("gdi32.dll")] static extern IntPtr CreateSolidBrush(int color);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    static IntPtr parent;
    static volatile bool suspended; // FreeRDP_SuspendInput
    static StreamWriter log;
    static readonly object gate = new object();
    static WndProc procRef;
    static HookProc hookRef;

    static void Log(string line)
    {
        lock (gate)
        {
            log.WriteLine(line);
            log.Flush();
        }
    }

    static bool ParentFocused()
    {
        uint pid;
        uint tid = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        var info = new GuiThreadInfo();
        info.cbSize = Marshal.SizeOf(info);
        return GetGUIThreadInfo(tid, ref info) && info.hwndFocus == parent;
    }

    static IntPtr Proc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l)
    {
        switch (msg)
        {
            case 0x0007: // WM_SETFOCUS
                suspended = false;
                Log("focus-in");
                return IntPtr.Zero;
            case 0x0008: // WM_KILLFOCUS
                suspended = true;
                Log("focus-out");
                return IntPtr.Zero;
            case 0x0201: // WM_LBUTTONDOWN
                SetCapture(hwnd);
                Log(suspended ? "clique-suspenso" : "clique");
                return IntPtr.Zero;
            case 0x0202: // WM_LBUTTONUP
                ReleaseCapture();
                return IntPtr.Zero;
            case 0x0232: // WM_EXITSIZEMOVE: o wfreerdp pede a resolução nova ao servidor
                Log("exitsizemove");
                return IntPtr.Zero;
        }
        return DefWindowProc(hwnd, msg, w, l);
    }

    static IntPtr Hook(int code, IntPtr w, IntPtr l)
    {
        if (code == 0 && (int)w == 0x100) // WM_KEYDOWN
        {
            int vk = Marshal.ReadInt32(l);
            if (!ParentFocused()) Log("tecla-ignorada-foco " + vk);
            else if (suspended) Log("tecla-ignorada-suspensa " + vk);
            else Log("tecla " + vk);
        }
        return CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    static void KeyboardThread()
    {
        hookRef = Hook;
        SetWindowsHookEx(13, hookRef, GetModuleHandle(null), 0); // WH_KEYBOARD_LL
        Msg m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessage(ref m); }
    }

    [STAThread]
    static void Main(string[] args)
    {
        int width = 800, height = 600;
        foreach (var a in args)
        {
            if (a.StartsWith("/parent-window:")) parent = new IntPtr(long.Parse(a.Substring(15)));
            if (a.StartsWith("/size:"))
            {
                var p = a.Substring(6).Split('x');
                width = int.Parse(p[0]);
                height = int.Parse(p[1]);
            }
        }
        log = new StreamWriter(Environment.GetEnvironmentVariable("FAKE_RDP_LOG"), true);
        Log("args " + string.Join(" ", args));
        Log("senha " + Console.In.ReadLine());

        procRef = Proc;
        var cls = new WndClassEx
        {
            cbSize = Marshal.SizeOf(typeof(WndClassEx)), lpfnWndProc = procRef, hInstance = GetModuleHandle(null),
            hbrBackground = CreateSolidBrush(0x0032CD32), lpszClassName = "FakeFreeRDP",
        };
        RegisterClassEx(ref cls);
        var hwnd = CreateWindowEx(0, "FakeFreeRDP", "", 0x40000000 | 0x00800000, // WS_CHILD | WS_BORDER (invisível, como o wfreerdp)
            0, 0, width, height, parent, IntPtr.Zero, GetModuleHandle(null), IntPtr.Zero);
        new Thread(KeyboardThread) { IsBackground = true }.Start();
        // Ao conectar, o wfreerdp mostra a janela com SW_NORMAL (WM_FREERDP_SHOWWINDOW em wf_client.c).
        ShowWindow(hwnd, 1);
        // Pior caso: a janela do cliente chega a ter o foco; ao perdê-lo, a entrada fica suspensa
        // até um WM_SETFOCUS (o contêiner do MultTerm precisa devolver isso).
        SetFocus(hwnd);
        // Servidor moderno: o canal de ajuste de resolução abre logo depois de conectar.
        if (Environment.GetEnvironmentVariable("FAKE_RDP_DISP") == "1")
        {
            Console.Out.WriteLine("[DEBUG][com.freerdp.channels.drdynvc.client] - listener Microsoft::Windows::RDS::DisplayControl created new channel 3");
            Console.Out.Flush();
        }
        Log("hwnd " + hwnd.ToInt64());
        Msg msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessage(ref msg); }
    }
}
