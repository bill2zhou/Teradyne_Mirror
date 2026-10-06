using System;

namespace WinFormSocketClient
{
    /// <summary>
    /// 通用工具类（与业务、UI解耦）
    /// </summary>
    public static class CommonUtils
    {
        /// <summary>
        /// 忽略大小写比较两个字符串
        /// </summary>
        public static bool AreStringsEqualIgnoreCase(string str1, string str2)
        {
            if (str1 == null && str2 == null) return true;
            if (str1 == null || str2 == null) return false;
            return string.Compare(str1, str2, StringComparison.OrdinalIgnoreCase) == 0;
        }
    }
}