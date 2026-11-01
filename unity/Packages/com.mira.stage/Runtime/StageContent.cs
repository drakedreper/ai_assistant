// Where the stage finds the files the daemon's locators name, and how it turns a locator into one of them.
//
// The daemon only keeps METADATA: a catalog entry says "bases/vrm1/composed.vrm" and nothing else (the repository holds no
// binary models). The files live in the content pack on the PC, in a folder the owner chooses, so the stage maps a locator
// onto that folder. The mapping is the only place a manifest on disk (untrusted) reaches the file system, so it does two
// checks: the locator must pass AssetLocator.Validate (the same rules as the daemon), and the full path that comes out
// must still lie inside the content folder after the OS has resolved it (".." and mixed separators cannot get past it).
using System;
using System.IO;

namespace Mira.Stage
{
    public sealed class AssetResolution
    {
        public bool Ok { get; private set; }
        /// <summary>The full path of the file, only when Ok. The file may not exist: that is for the loader to report.</summary>
        public string Path { get; private set; }
        public string Reason { get; private set; }
        /// <summary>True for a remote (https) locator, which this stage does not fetch yet.</summary>
        public bool Remote { get; private set; }

        internal static AssetResolution Success(string path) => new AssetResolution { Ok = true, Path = path };
        internal static AssetResolution Fail(string reason, bool remote = false) => new AssetResolution { Ok = false, Reason = reason, Remote = remote };
    }

    public static class StageContent
    {
        public const string ContentDirVariable = "MIRA_CONTENT_DIR";

        /// <summary>
        /// MIRA_CONTENT_DIR (an absolute path), else a "Mira/content" folder in the user's home (%USERPROFILE% on Windows, $HOME
        /// elsewhere). Null when neither exists, so the caller can say "set MIRA_CONTENT_DIR" instead of guessing a path.
        /// The folder is not created here. The environment can be replaced for tests.
        /// </summary>
        public static string ResolveRoot(Func<string, string> env = null, bool? isWindows = null)
        {
            env = env ?? Environment.GetEnvironmentVariable;
            var windows = isWindows ?? (Path.DirectorySeparatorChar == '\\');
            var configured = env(ContentDirVariable);
            if (!string.IsNullOrWhiteSpace(configured))
            {
                var dir = configured.Trim();
                return IsAbsolute(dir, windows) ? dir : null;
            }
            var home = env(windows ? "USERPROFILE" : "HOME");
            if (string.IsNullOrWhiteSpace(home) || !IsAbsolute(home.Trim(), windows)) return null;
            return Path.Combine(home.Trim(), "Mira", "content");
        }

        private static bool IsAbsolute(string p, bool windows)
        {
            if (!windows) return p.StartsWith("/", StringComparison.Ordinal);
            return (p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) || p.StartsWith("\\\\", StringComparison.Ordinal);
        }

        /// <summary>
        /// The file a locator names, inside contentRoot. A locator is a path INSIDE the content folder ("bases/vrm1/x.vrm",
        /// "asset:props/chair", "pack:main/hair"): absolute paths are refused (the daemon never sends one), and so is a
        /// locator that is unsafe by the daemon's own rules. Percent-escapes are NOT decoded here: a name is literal, so
        /// "My%20Chair" is a folder called exactly that. Symbolic links inside the folder are the owner's business and are not
        /// resolved.
        /// </summary>
        public static AssetResolution Resolve(string contentRoot, string locator)
        {
            if (string.IsNullOrWhiteSpace(contentRoot) || !Path.IsPathRooted(contentRoot)) return AssetResolution.Fail("the content folder is not set (set " + ContentDirVariable + " to an absolute path)");
            var check = AssetLocator.Validate(locator);
            if (!check.Ok) return AssetResolution.Fail("unsafe locator: " + check.Reason);

            string rel;
            switch (check.Kind)
            {
                case LocatorKind.Relative:
                    rel = check.Normalized;
                    break;
                case LocatorKind.Url:
                    var colon = check.Normalized.IndexOf(':');
                    if (string.Equals(check.Normalized.Substring(0, colon), "https", StringComparison.Ordinal)) return AssetResolution.Fail("remote (https) locators are not loaded by this stage yet", remote: true);
                    rel = check.Normalized.Substring(colon + 1);
                    break;
                default:
                    return AssetResolution.Fail("a locator is a path inside the content folder, not an absolute path");
            }

            var root = Path.GetFullPath(contentRoot);
            var rootWithSeparator = root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal) ? root : root + Path.DirectorySeparatorChar;
            var full = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
            var comparison = Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!full.StartsWith(rootWithSeparator, comparison)) return AssetResolution.Fail("the locator resolves outside the content folder");
            return AssetResolution.Success(full);
        }
    }
}
