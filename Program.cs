using System;
using System.Windows.Forms;

namespace WinFormSocketClient
{
    internal static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SocketServerForm());
        }
    }
}