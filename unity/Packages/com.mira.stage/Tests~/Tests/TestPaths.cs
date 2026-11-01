using System;
using System.IO;
using System.Linq;

namespace Mira.Stage.Tests
{
    internal static class TestPaths
    {
        public static string RepoRoot
        {
            get
            {
                var d = new DirectoryInfo(AppContext.BaseDirectory);
                while (d != null && !File.Exists(Path.Combine(d.FullName, "pnpm-workspace.yaml"))) d = d.Parent;
                if (d == null) throw new InvalidOperationException("the repository root (pnpm-workspace.yaml) was not found above " + AppContext.BaseDirectory);
                return d.FullName;
            }
        }

        public static string Golden => Path.Combine(RepoRoot, "unity", "Packages", "com.mira.stage", "Tests~", "golden");

        public static string[] GoldenFiles(string dir, string pattern = "*.json") =>
            Directory.GetFiles(Path.Combine(Golden, dir), pattern).OrderBy(f => f, StringComparer.Ordinal).ToArray();

        public static string ReadGolden(string relative) => File.ReadAllText(Path.Combine(Golden, relative.Replace('/', Path.DirectorySeparatorChar)));
    }
}
